# 使用 DSH 执行四步 Workflow

## 运行前提

在 Linux Pod 中准备可用的 vLLM 和 ASU FAKE 后端、安装了 PyYAML 的 Python、与当前 DSH 版本兼容的 Node.js，以及已获准调用的 Anthropic 兼容模型网关。

测试需要一张已分配的空闲 NPU。每次运行使用独立缓存目录，测试引擎默认监听 18000。可通过 `UCM_TEST_PORT` 指定其他空闲端口。

## 在 Pod 中运行

确认 `dsh` 在 `PATH` 中，也可以用 `UCM_DSH_BIN` 指定可执行文件路径。将下方占位值替换为实际配置。

```bash
cd /path/to/inference-regression &&
git pull --ff-only origin main &&
(
  set -e
  export UCM_TEST_NPU='<已分配的空闲 NPU 编号>'
  export UCM_DSH_UPSTREAM='<获准调用的完整 /v1/messages 地址>'
  export UCM_DSH_MODEL='<网关模型 ID>'
  read -rs -p '请输入网关 API Key: ' UCM_DSH_API_KEY
  printf '\n'
  export UCM_DSH_API_KEY
  node examples/existing-vllm/run-dsh.mjs
)
```

启动入口在本机回环地址上分配临时端口，使用本次运行专用的代理密钥连接 DSH 和代理。上游 API Key 从环境变量读取。代理缓冲响应，为缺少事件名的 Anthropic SSE 事件补齐 `event:` 行。收到 HTTP 200、SSE 响应头且响应体为零字节时，代理补发一次。

## 查看结果

Workflow 依次启动引擎、写入缓存、重启引擎并回读缓存。DSH 提出下一步决策，框架负责校验依赖、执行任务和清理引擎。

验收时确认四个步骤均成功，最终退出码为 `0`，清理状态为 `clean`，且最后一条决策为 `finish`。

| 文件 | 内容 |
| --- | --- |
| `runs/<运行编号>/result.json` | 步骤状态、退出码和清理结果 |
| `runs/<运行编号>/decision-*.json` | DSH 的逐步决策 |
| `runs/<运行编号>/output/write/test-report.json` | 缓存写入报告 |
| `runs/<运行编号>/output/readback/test-report.json` | 缓存回读报告 |
| `DSH_GATEWAY_EVIDENCE` 指向的目录 | 代理请求结果与兼容处理记录 |

## 用 script 模式对照

在同一环境中，设置相同的 `UCM_TEST_NPU` 和测试端口后运行：

```bash
node cli.mjs run script success --config examples/existing-vllm/managed-config.json
```

## 验证进度

仓库一键入口已在 Linux ARM64 昇腾 Pod 上实测通过。真实 DSH 完成启动、写入、重启和回读，写入 3/3、回读 5/5，最终退出码为 `0`，框架报告清理状态为 `clean`。

异常路径也已在昇腾 Pod 上实测，三轮的框架清理状态均为 `clean`。

| 场景 | 决策来源 | 结果 |
| --- | --- | --- |
| 受控写入失败 | 真实 DSH | 写入失败，重启和回读因依赖失败跳过，退出 `1` |
| 非法决策 | 模拟决策进程 | 引擎启动后请求提前回读，控制器拒绝并记录依赖违规，退出 `3` |
| 决策超时 | 模拟决策进程 | 引擎启动后决策超时，运行状态为 `incomplete`，退出 `2` |

每日定时触发、报告的 Pod 外留存、失败通知，以及 DSH 根据日志自主诊断和重试仍待验收。
