import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function normalizeSse(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  return text.split(/(\r?\n\r?\n)/).map(block => {
    if (/^event:/m.test(block)) return block;
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    try {
      const type = JSON.parse(data)?.type;
      return typeof type === 'string' && /^[a-z_]+$/.test(type)
        ? 'event: ' + type + newline + block : block;
    } catch {
      return block;
    }
  }).join('');
}

async function main() {
  const { UCM_DSH_API_KEY: key, UCM_DSH_UPSTREAM: url, UCM_DSH_MODEL: model,
    UCM_TEST_NPU: npu } = process.env;
  if (!key || !url || !model || !npu) {
    throw Error('Set UCM_DSH_API_KEY, UCM_DSH_UPSTREAM, UCM_DSH_MODEL and UCM_TEST_NPU');
  }
  const upstream = new URL(url);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password ||
      upstream.pathname !== '/v1/messages' || upstream.search || upstream.hash) {
    throw Error('UCM_DSH_UPSTREAM must be an HTTP(S) /v1/messages URL without credentials or query');
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = resolve(here, '../..');
  mkdirSync(join(repo, 'runs'), { recursive: true });
  const evidence = mkdtempSync(join(repo, 'runs', 'dsh-gateway.'));
  const log = (event, fields) => writeFileSync(join(evidence, 'proxy.jsonl'),
    JSON.stringify({ event, ...fields }) + '\n', { flag: 'a', mode: 0o600 });

  const proxyKey = randomBytes(32).toString('hex');
  let requestId = 0;
  const server = createServer(async (req, res) => {
    const id = ++requestId;
    const target = new URL(req.url, 'http://localhost');
    if (req.method !== 'POST' || target.pathname !== '/v1/messages') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers['x-api-key'] !== proxyKey) {
      res.writeHead(401).end();
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw Error('Request too large');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const payload = JSON.parse(body.toString());
      const headers = {
        'content-type': 'application/json', 'accept': 'text/event-stream',
        'x-api-key': key, 'anthropic-version': req.headers['anthropic-version'] ?? '2023-06-01',
      };
      if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta'];
      const endpoint = new URL(upstream);
      endpoint.search = target.search;
      for (const attempt of [1, 2]) {
        const response = await fetch(endpoint, { method: 'POST', headers, body,
          redirect: 'manual', signal: AbortSignal.timeout(60000) });
        const bytes = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
        const sse = contentType.toLowerCase().startsWith('text/event-stream');
        const retry = attempt === 1 && response.status === 200 && sse &&
          payload.stream === true && bytes.length === 0;
        const output = response.ok && sse ? Buffer.from(normalizeSse(bytes.toString())) : bytes;
        log('response', { id, attempt, status: response.status, bytes: bytes.length,
          forwardedBytes: output.length, retry });
        if (retry) continue;
        res.writeHead(response.status, { 'content-type': contentType, 'content-length': output.length });
        res.end(output);
        return;
      }
    } catch (error) {
      log('transport_error', { id, name: error.name });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { message: 'Gateway transport failed' } }));
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const patch = join(evidence, 'gateway.yml');
    const quotedModel = JSON.stringify(model);
    writeFileSync(patch, [
      '- id: llm-pi-ai', '  config:', '    providers:', '      ucm-green:',
      '        api: anthropic-messages', '        baseURL: http://127.0.0.1:' + server.address().port,
      '        apiKeyEnv: UCM_DSH_API_KEY', '        models:', '          - id: ' + quotedModel,
      '- id: agent-default-model', '  config:', '    provider: ucm-green', '    model: ' + quotedModel,
      '',
    ].join('\n'), { mode: 0o600 });

    const config = JSON.parse(readFileSync(join(here, 'managed-config.json'), 'utf8'));
    for (const name of ['taskScript', 'cleanupScript', 'workflow', 'runsDir', 'taskCwd']) {
      if (config[name]) config[name] = resolve(here, config[name]);
    }
    config.dsh = {
      execution: 'process', command: [process.env.UCM_DSH_BIN ?? 'dsh', 'headless', '--patch', patch],
      envNames: ['UCM_DSH_API_KEY', 'NO_PROXY', 'DSH_HOME'], timeoutMs: 180000, maxDecisions: 16,
    };
    const configFile = join(evidence, 'workflow-config.json');
    writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    console.log('DSH_GATEWAY_EVIDENCE=' + evidence);

    const env = { ...process.env, UCM_DSH_API_KEY: proxyKey, NO_PROXY: ['127.0.0.1', process.env.NO_PROXY].filter(Boolean).join(',') };
    const child = spawn(process.execPath, ['cli.mjs', 'run', 'dsh', 'success', '--config', configFile],
      { cwd: repo, env, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
      const [code, signal] = await once(child, 'exit');
      return code ?? (signal === 'SIGINT' ? 130 : 143);
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
