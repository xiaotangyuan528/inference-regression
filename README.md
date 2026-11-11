# 推理回归测试框架原型

控制层按 Workflow 协调环境和任务，支持确定性编排与受约束的 Agent 决策。
这是运行机制原型，尚未验收完整 UCM＋kvclient 推理缓存链路。

## 快速开始

需要 Node.js 22+、Docker 和本机已有的 Linux 镜像（包含 /bin/sh 与 awk）。
默认镜像 ucm-cpu-validation:v2 是本机实验镜像，不是公开发布依赖；其他机器请修改 config.json 的 image。
框架使用 --pull never，不会自动下载镜像。

```powershell
node cli.mjs run script success
node cli.mjs run script failed-test
node cli.mjs run script missing-report
```

可以从任意目录通过 cli.mjs 的绝对路径启动。
默认配置相对 CLI 文件定位；--config 相对调用者当前目录定位；
配置中的 taskScript、taskCwd、workflow、runsDir、mounts.source 相对配置文件所在目录定位。

| 退出码 | 含义 |
| --- | --- |
| 0 | 全部必需步骤完成、报告合法且无失败、清理确认成功 |
| 1 | 已执行测试报告包含失败断言 |
| 2 | 构建或环境失败、超时、中断、报告缺失/非法、全跳过或清理未确认 |
| 3 | 乱序、重复步骤、提前结束等编排规则被违反 |

构建命令退出 7 保留在步骤记录中，框架退出 2；它不代表已验证的业务断言失败。
存在多个问题时优先级为 3 > 2 > 1 > 0，详细原因不会被丢弃。

## 配置与任务接口

- config.json：镜像、任务脚本、超时、输出根目录与 resourceKey。
- workflow.json：任意步骤列表；needs 要求依赖成功，after 只要求依赖结束。
- tasks/：脚本接收步骤名和场景参数，向 RUN_OUTPUT 写入产物与报告。
- lib/：配置、状态、结果和 Agent 协议；adapters.mjs 负责执行与清理。

步骤按拓扑顺序配置。未指定 after 时默认等待上一项，archive 也不会提前执行。
reports 显式列出该步骤必须生成的相对报告路径。不同步骤应使用不同报告文件。
报告格式：

```json
{"checked":10,"passed":8,"failed":0,"skipped":2}
```

skipped 可省略；所有计数必须为非负安全整数，checked 等于三项之和，至少一项实际执行。
无报告的构建/归档步骤只校验退出码；测试步骤必须配置 reports，框架不能从脚本名字推断覆盖范围。

配置优先级：REGRESSION_ADAPTER、REGRESSION_IMAGE、REGRESSION_TIMEOUT_MS、REGRESSION_RUNS_DIR 环境变量 > 配置 > 默认值。
资源锁作用域为同一 runsDir 和 resourceKey；多机器必须另配统一资源协调。
Docker 任务只挂载脚本（只读）、输出目录（可写）及显式 mounts，不挂载整个项目。
镜像内工作文件默认短期存在，跨步骤制品通过 RUN_OUTPUT 传递。

## Agent / dsh 模式

此次修复改变了旧的宿主机 dsh 接口，迁移见 [设计文档](docs/design.md)。

dsh 运行在单独的决策容器中，只返回下一步 run / tail / finish 的 JSON。
控制器校验依赖后执行任务。决策容器不挂载宿主源码、报告或 Docker socket。
需先准备包含 dsh 或协议包装入口的镜像，并配置：

```json
{
  "dsh": {
    "image": "your-dsh-image:verified",
    "command": ["your-decision-entrypoint"],
    "envNames": [],
    "network": "bridge",
    "timeoutMs": 180000,
    "maxDecisions": 16
  }
}
```

command 接收最后一个参数作为提示，必须输出且只输出一行决策 JSON，例如：
`{"action":"run","step":"build"}`。可以有非 JSON 诊断行。
真实 dsh 的 CLI 参数、模型认证和输出包装须在目标镜像内联调，不承诺默认示例参数适用于任何版本。
凭据只从列入 envNames 的环境变量注入；不要写进配置。
每个决策启动独立容器，状态由控制器传入，暂不保持 Web UI 会话。

```powershell
node cli.mjs run dsh success
```

本轮已验证隔离决策协议，使用的是 Python 模拟 Agent；真实 dsh、模型 API 和 Web UI 尚未联调。
这不是把已验证的脚本运行结果等同于真实 dsh 编排通过。

## 报告与恢复

每次生成 runs/<run_id>/manifest.json、state.json、步骤记录和日志、output/、result.json。
manifest 保存本次 Workflow 与配置快照。完整日志保留在磁盘；Agent 最多收到末尾 4 KiB / 50 行，决策输出解析上限 64 KiB。

```powershell
node cli.mjs tail <run_id> build
node cli.mjs cleanup <run_id>
```

正常失败或超时会尝试清理并复查同 run_id 的容器。
SIGINT/SIGTERM 会请求停止；强制杀进程、断电不能保证 finally 执行。
确认原控制器已退出后，使用相同 --config 执行 cleanup；恢复成功才释放资源锁，记录 recovery.json，不把原失败改为成功。
没有 result.json 的运行不能视为成功。资源锁残留时不得直接删除锁后继续占用同一设备。
process 适配器只负责受控前台进程；生产任务禁止自行后台化，外部资源由任务或平台回收。

## 回归验证

```powershell
node --test tests/regression.test.mjs
node --test tests/docker.test.mjs
```

Docker 集成测试另外需要镜像内有 Python3（模拟 Agent）。
测试运行从项目外目录启动 CLI，覆盖异常分类、超时、乱序、额外步骤、强制终止后的恢复。
具体结果和边界见 [修复验证记录](docs/validation.md)。
