# 推理回归测试框架原型

[详细设计文档](docs/design.md)介绍架构、编排分工、任务接口和验证范围。

## 本机快速验证

在此目录打开 PowerShell。需要 Node.js 和已启动的 Docker Desktop。默认使用本机已有的 ucm-cpu-validation:v2 镜像作为运行环境。模拟任务只用 /bin/sh，不下载镜像、不联网。

```powershell
node cli.mjs run script success
node cli.mjs run script build-failure
node cli.mjs run script missing-report
```

每条命令输出本次目录 runs/<run_id>。打开 result.json 看最终结论，打开各步骤的 JSON 和日志核对实际调用。

| 场景 | 预期 |
| --- | --- |
| success | passed，框架退出 0 |
| build-failure | 构建退出 7，测试没有启动，归档执行，框架退出 1 |
| missing-report | 测试退出 0，最终状态 incomplete，框架退出 2 |

## 改哪里

| 文件 | 用途 |
| --- | --- |
| config.json | 选择 Docker 镜像、步骤脚本及超时。已申请的 Linux Pod 可以试用 process 执行方式 |
| workflow.json | 定义步骤顺序和依赖。原型固定使用 build、test、archive 三个步骤，最终校验仍按这三个步骤判断 |
| tasks/mock.sh | 模拟任务入口。接入真实任务时新增脚本，并修改 config.json 的 taskScript |
| adapters.mjs | 本地进程和 Docker 的执行方式。需要新的挂载或运行环境时在此扩展 |
| cli.mjs | 两种编排入口、步骤记录和最终报告校验 |

任务脚本接收步骤名和场景参数，通过 RUN_OUTPUT 取得结果目录。test 步骤写入 test-report.json，其中 checked、passed、failed 都是整数，checked 大于零且等于 passed 加 failed。Docker 各步骤使用独立容器，持久状态通过输出目录传递。真实编译如需保留 Linux 构建目录、权限或软链接，应配置持久卷或把制品导出到共享目录。

## dsh 编排

config.json 中 dsh.command 和 dsh.args 对应本机已可运行的 dsh 命令及启动参数。若使用 Node 安装的 dsh，把 command 设置为 node，把 dsh 的 bin.js 路径和已验证的启动选项填入 args。模型凭据从运行环境注入。配置会进入运行记录，args 中只填写非敏感参数。

```powershell
node cli.mjs run dsh success
node cli.mjs run dsh build-failure
node cli.mjs run dsh missing-report
```

dsh 按 Workflow 决定调用哪些步骤。外层启动 dsh、捕获 dsh.log 并检查步骤记录与报告。dsh 模式和 Web UI 关联仍待本机实测。

## 验证范围

本机已跑通 Docker 中的三种模拟场景。现有 406 项 UCM＋kvclient 模拟后端测试需要接入专用任务脚本和源码制品。真实推理缓存链路需要目标设备和后端。Genet 适配、跨机器复现以及外部调度仍待验证。

## 环境变量、日志和 Docker 清理

配置优先级为环境变量 > config.json > 内置默认值。支持 REGRESSION_ADAPTER、REGRESSION_IMAGE 和 REGRESSION_TIMEOUT_MS，生效值记录在 manifest.json。模型路径等 UCM 专属配置随真实任务接入。

完整 stdout/stderr 直接写入对应日志。dsh 默认收到步骤摘要，需要诊断时按提示调用日志预览，最多读取末尾 4 KiB 并返回末尾 50 行。提示约定不提供文件访问隔离。

```powershell
node cli.mjs run script verbose
node cli.mjs tail <run_id> build
$env:REGRESSION_TIMEOUT_MS = '2500'
node cli.mjs run script timeout
Remove-Item Env:REGRESSION_TIMEOUT_MS
```

Docker 容器按 run_id 加标签。运行结束时检查并清理同一标签的容器，结果单独记录在 result.json 的 cleanup 中。外层进程被强制终止后，确认该运行已停止，再执行下方命令，清理结果写到 recovery.json。

```powershell
node cli.mjs cleanup <run_id>
```

已在本机验证正常执行、构建失败、报告缺失、约 2.4 MB 日志写入与有界读取，以及超时容器清理。dsh 强制中断和 Genet Pod 回收仍需在对应环境验证。

