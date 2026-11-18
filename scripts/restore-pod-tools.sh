#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${HARNESS_TOOLS_ROOT:?Set HARNESS_TOOLS_ROOT to a writable tools directory}"
mkdir -p "$HARNESS_TOOLS_ROOT"
tools=$(cd "$HARNESS_TOOLS_ROOT" && pwd)
version=v24.22.3
case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo 'Unsupported CPU architecture'; exit 2 ;;
esac
archive="node-$version-linux-$arch.tar.gz"
node_home="$tools/node-$version-linux-$arch"
download=$(mktemp -d "$tools/download.XXXXXX")
curl_args=(-fL --connect-timeout 20 --max-time 900 --retry 2)
if [ "${HARNESS_ALLOW_INSECURE_TLS:-0}" = 1 ]; then
  echo 'Explicit option enabled: TLS certificate verification skipped for downloads'
  curl_args+=(-k)
fi
if [ ! -x "$node_home/bin/node" ]; then
  curl "${curl_args[@]}" -o "$download/$archive" "https://nodejs.org/dist/$version/$archive"
  curl "${curl_args[@]}" -o "$download/SHASUMS256.txt" "https://nodejs.org/dist/$version/SHASUMS256.txt"
  (cd "$download"; grep "  $archive$" SHASUMS256.txt > selected.sha256; sha256sum -c selected.sha256)
  tar -xzf "$download/$archive" -C "$tools"
fi
export PATH="$node_home/bin:$tools/dsh/node_modules/.bin:$PATH"
export DSH_HOME="$tools/dsh-home"
node --version
npm_config_engine_strict=true npm_config_strict_ssl=$([ "${HARNESS_ALLOW_INSECURE_TLS:-0}" = 1 ] && echo false || echo true) npm install --prefix "$tools/dsh" --registry "${HARNESS_NPM_REGISTRY:-https://registry.npmjs.org}" @deepseek-ai/dsh@0.2.2-rc.1
dsh --version
printf 'export PATH=%q:%q:"$PATH"\nexport DSH_HOME=%q\n' "$node_home/bin" "$tools/dsh/node_modules/.bin" "$DSH_HOME" > "$tools/env.sh"
printf '\nRESTORE_OK\n'
printf 'Load environment: source %q\n' "$tools/env.sh"
printf 'Downloaded installation files: %s\n' "$download"
