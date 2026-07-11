---
name: e2b-official-sdk-mvp-41
description: Use when users need to run, explain, troubleshoot, or batch benchmark the standalone official e2b==2.24.0 SDK MVP regression against AIOS 41; scripts are stored under script/ and do not require the aios-sandbox-server repo.
---

# E2B Official SDK MVP Standalone Test - AIOS 41

## 执行规则

所有测试逻辑都通过 `script/` 目录下的脚本执行，不要把大段 bash/python 代码直接复制到回复里。

以本 `SKILL.md` 所在目录为工作目录时，统一调用方式：

```bash
bash script/<脚本名>.sh
```

如果用户只需要查看或复制脚本，直接告知对应文件路径；不要重新内联生成脚本。

## 能力边界

**本 skill 只支持 AIOS 41 环境的官方 Python SDK `e2b==2.24.0` MVP 回归、日志解释和低并发基准测试。**

禁止行为：
- 不要在文档、命令或日志中写入明文 API key。
- 不要要求测试人员拉取 `aios-sandbox-server` 仓库，也不要依赖项目 `dist`、`.env` 或历史脚本。
- 不要默认执行高并发压测；批量测试必须从低并发开始，逐步升高，避免压垮 41 环境。
- 不要把本 skill 扩展到非 AIOS 41 环境；如需其他环境，应先让用户确认 Control Plane、Data Plane、Template、CA 和授权。
- 不要手写临时替代脚本；需要测试时只使用“脚本速查”中列出的文件。

涉及实际访问 AIOS 41、创建或销毁 sandbox 前，必须确认用户具备该环境授权。

## 脚本速查

| 用户意图 | 脚本命令 | 说明 |
|---------|---------|------|
| Windows Git Bash 执行 MVP 回归 | `bash script/run_windows_git_bash.sh` | 创建 venv、安装 `e2b==2.24.0`、复制 CA/测试脚本、执行生命周期/命令/文件/Agent E2E 测试 |
| Linux Bash 执行 MVP 回归 | `bash script/run_linux_bash.sh` | 同上，使用 `python3` 和 Linux venv 路径 |
| 执行批量性能测试 | `bash script/run_benchmark.sh` | 复用或创建运行目录，执行低并发创建/ready/命令/文件读写/销毁统计 |
| 生命周期/命令/文件测试源码 | `script/e2b_mvp_lifecycle_command_files.py` | 由回归脚本复制到运行目录后执行 |
| Agent E2E 测试源码 | `script/e2b_mvp_agent_e2e.py` | 由回归脚本复制到运行目录后执行 |
| 批量性能测试源码 | `script/e2b_mvp_benchmark.py` | 由 benchmark 脚本复制到运行目录后执行 |
| Data Plane CA 公钥证书 | `script/ca.crt` | 运行时复制为 `$RUN_DIR/ca.crt` 并设置 `SSL_CERT_FILE` |
| Shell 常量配置 | `script/constants.sh` | 集中维护 SDK 版本、AIOS 端点、模板、运行目录、日志文件名和 benchmark 默认值 |

## 可替换常量说明

固定值已集中到两类位置，方便迁移或替换：

1. Shell 入口脚本公共常量：`script/constants.sh`
2. Python 测试脚本顶部 `# Constants` 区域

### `script/constants.sh`

| 常量 | 默认值 | 说明 | 覆盖环境变量 |
|------|--------|------|--------------|
| `DEFAULT_E2B_SDK_VERSION` | `2.24.0` | 官方 E2B Python SDK 版本 | `E2B_SDK_VERSION` |
| `DEFAULT_E2B_API_URL` | `http://10.50.6.41:30082` | AIOS 41 Control Plane | `E2B_API_URL` |
| `DEFAULT_E2B_SANDBOX_URL` | `https://10.50.6.41:30083` | AIOS 41 Data Plane | `E2B_SANDBOX_URL` |
| `DEFAULT_CUBE_TEMPLATE_ID` | `code-interpreter` | sandbox 模板 ID/名称 | `CUBE_TEMPLATE_ID` |
| `DEFAULT_RUN_DIR_NAME` | `e2b-official-sdk-mvp-41-run` | 默认运行产物目录名 | `E2B_RUN_DIR` |
| `CA_CERT_FILE` | `ca.crt` | CA 证书文件名 | 修改常量 |
| `LIFECYCLE_SCRIPT_FILE` | `e2b_mvp_lifecycle_command_files.py` | 生命周期测试脚本名 | 修改常量 |
| `AGENT_E2E_SCRIPT_FILE` | `e2b_mvp_agent_e2e.py` | Agent E2E 测试脚本名 | 修改常量 |
| `BENCHMARK_SCRIPT_FILE` | `e2b_mvp_benchmark.py` | benchmark 测试脚本名 | 修改常量 |
| `DEFAULT_E2B_BENCH_ITERATIONS` | `10` | benchmark 正式次数 | `E2B_BENCH_ITERATIONS` |
| `DEFAULT_E2B_BENCH_CONCURRENCY` | `1` | benchmark 并发数 | `E2B_BENCH_CONCURRENCY` |
| `DEFAULT_E2B_BENCH_MAX_CONCURRENCY` | `5` | benchmark 最大并发保护 | `E2B_BENCH_MAX_CONCURRENCY` |
| `DEFAULT_E2B_BENCH_WARMUP` | `1` | benchmark 预热次数 | `E2B_BENCH_WARMUP` |
| `DEFAULT_E2B_BENCH_READY_ATTEMPTS` | `12` | benchmark ready 重试次数 | `E2B_BENCH_READY_ATTEMPTS` |
| `DEFAULT_E2B_BENCH_READY_INTERVAL_SECONDS` | `1` | benchmark ready 重试间隔 | `E2B_BENCH_READY_INTERVAL_SECONDS` |
| `DEFAULT_E2B_BENCH_COMMAND` | `printf bench-command-ok` | benchmark 命令 | `E2B_BENCH_COMMAND` |

### Python 测试脚本常量

| 脚本 | 常量/环境变量 | 说明 |
|------|---------------|------|
| `e2b_mvp_lifecycle_command_files.py` | `E2B_READY_ATTEMPTS` / `E2B_READY_INTERVAL_SECONDS` | ready 重试次数和间隔 |
| `e2b_mvp_lifecycle_command_files.py` | `E2B_COMMAND_TIMEOUT_SECONDS` / `E2B_CONNECT_TIMEOUT_SECONDS` | 命令和连接超时 |
| `e2b_mvp_lifecycle_command_files.py` | `E2B_READY_CHECK_COMMAND` | ready 检测命令 |
| `e2b_mvp_lifecycle_command_files.py` | `E2B_LIFECYCLE_NORMAL_COMMAND` / `E2B_LIFECYCLE_NORMAL_EXPECTED_STDOUT` | 正常命令和期望输出 |
| `e2b_mvp_lifecycle_command_files.py` | `E2B_LIFECYCLE_NONZERO_COMMAND` / `E2B_LIFECYCLE_NONZERO_EXPECTED_EXIT_CODE` / `E2B_LIFECYCLE_NONZERO_EXPECTED_STDERR` | 非 0 exit 验证 |
| `e2b_mvp_lifecycle_command_files.py` | `E2B_TEST_WORKSPACE_DIR` / `E2B_LIFECYCLE_TEST_FILE_NAME` / `E2B_LIFECYCLE_TEST_FILE_CONTENT` | 文件系统测试路径和内容 |
| `e2b_mvp_agent_e2e.py` | `E2B_AGENT_READY_CHECK_COMMAND` / `E2B_SANDBOX_PYTHON_BIN` | Agent ready 检测和 sandbox Python 命令 |
| `e2b_mvp_agent_e2e.py` | `E2B_AGENT_NAME` / `E2B_AGENT_INPUT_FILE_NAME` / `E2B_AGENT_TASK_FILE_NAME` / `E2B_AGENT_RESULT_FILE_NAME` | Agent E2E 名称和文件名 |
| `e2b_mvp_benchmark.py` | `E2B_COMMAND_TIMEOUT_SECONDS` / `E2B_BENCH_READY_CHECK_COMMAND` | benchmark 命令超时和 ready 检测命令 |
| `e2b_mvp_benchmark.py` | `E2B_BENCH_FILE_PREFIX` / `E2B_BENCH_FILE_CONTENT_PREFIX` | benchmark 文件路径前缀和内容前缀 |

替换建议：优先通过环境变量覆盖；只有要发布新环境专用 skill 时，才修改 `script/constants.sh` 或 Python 脚本顶部常量默认值。

## 运行前置条件

### Windows Git Bash

1. 安装 Python 3，并确保 Git Bash 中 `python --version` 有输出。
2. 安装 Git Bash。
3. 能访问目标 Control Plane 和 Data Plane。
4. 能通过 pip 安装 Python 包，或已配置可用 pip 镜像。

### Linux Bash

1. 安装 `python3`。
2. 安装 `python3-venv` 或等价 venv 支持。
3. 能访问目标 Control Plane 和 Data Plane。
4. 能通过 pip 安装 Python 包，或已配置可用 pip 镜像。

### 环境参数输入

执行任何 MVP 回归或 benchmark 前，脚本会**逐个交互式确认**以下环境变量。
每个变量都可以直接回车使用默认值，或输入自定义值。

确认规则：

1. 如果用户已通过环境变量（如 `export E2B_API_KEY=...`）预先设置，脚本会先提示当前值，用户可选择直接使用或覆盖。
2. 如果用户未预设环境变量，脚本会提示默认值，直接回车使用默认值，输入其他值则使用自定义值。
3. API Key 在 `constants.sh` 中有默认占位值，用户可通过交互式确认替换为实际 key。

交互式确认的参数如下：

| 参数 | 默认值/说明 | 环境变量 |
|------|-------------|----------|
| API Key | `constants.sh` 中默认占位值，交互式确认时替换 | `E2B_API_KEY` |
| Template | `code-interpreter` | `CUBE_TEMPLATE_ID` |
| 管理侧主机 IP:Port | `http://10.50.6.41:30082` | `E2B_API_URL` |
| 数据侧主机 IP:Port | `https://10.50.6.41:30083` | `E2B_SANDBOX_URL` |
| Data Plane CA 证书 | 默认使用 `script/ca.crt` | 替换 `script/ca.crt` 或运行时设置 `SSL_CERT_FILE` |

如果用户要测试其他环境，应要求其完整提供 Template、管理侧地址、数据侧地址和 CA 证书；不要只替换其中一部分。

### API Key

运行前脚本会交互式确认 `E2B_API_KEY`。
默认占位值写在 `script/constants.sh` 中，用户在执行脚本时会被提示替换。
不建议在对话中发送明文 key。

也可在 skill 根目录放置本地凭证文件 `.e2b-env`（不会被提交）：

```text
.e2b-env
```

推荐内容格式：

```bash
export E2B_API_KEY='sk_live_替换为你的41环境凭证'
```

使用方式：

```bash
set -a
source .e2b-env
set +a
bash script/run_windows_git_bash.sh
```

`.e2b-env` 仅用于本机测试，不属于 skill 发布内容；不要打包、提交或外发该文件。

## 目标环境默认值

| 项目 | 默认值 |
|------|--------|
| 环境名称 | AIOS 41 |
| Control Plane | `http://10.50.6.41:30082` |
| Data Plane | `https://10.50.6.41:30083` |
| Template | `code-interpreter` |
| Python SDK | `e2b==2.24.0` |
| API key | 运行前通过环境变量 `E2B_API_KEY` 提供 |
| Data Plane CA | `script/ca.crt` |

脚本支持通过环境变量覆盖默认值。默认 AIOS 41 环境可不输入这些参数；其他环境需要完整自定义管理侧、数据侧、模板和 CA：

```bash
export E2B_API_URL='http://管理侧主机IP:主机Port'
export E2B_SANDBOX_URL='https://数据侧主机IP:主机Port'
export CUBE_TEMPLATE_ID='code-interpreter'
export E2B_RUN_DIR='/path/to/e2b-official-sdk-mvp-41-run'
```

如果要采用最小风险的超长过期时间方案，可在服务端配置：

```bash
export E2B_DEFAULT_TIMEOUT_SECONDS=315360000
export E2B_MAX_TIMEOUT_SECONDS=315360000
```

这表示约 10 年，不需要修改 `resolveTimeout` 代码；如果只设置 `E2B_DEFAULT_TIMEOUT_SECONDS`，但 `E2B_MAX_TIMEOUT_SECONDS` 仍为较小值，超过 max 的 timeout 会被拒绝。

## 标准流程

1. 先确认用户使用 Windows Git Bash 还是 Linux Bash。
2. 提醒用户设置 `E2B_API_KEY`，不要让用户把 key 发到对话里。
3. 让用户在 skill 根目录执行对应脚本：
   - Windows Git Bash: `bash script/run_windows_git_bash.sh`
   - Linux Bash: `bash script/run_linux_bash.sh`
4. 用户提供日志后，只分析日志结论和失败原因，不要求其重新复制大段脚本。
5. MVP 回归通过后，如用户需要性能数据，再执行 `bash script/run_benchmark.sh`。

## 运行产物目录

默认在执行目录下创建：

```text
e2b-official-sdk-mvp-41-run/
  ca.crt
  venv/
  e2b_mvp_lifecycle_command_files.py
  e2b_mvp_agent_e2e.py
  e2b_mvp_benchmark.py
  lifecycle_command_files.log
  agent_e2e.log
  benchmark_results.jsonl
  benchmark_summary.json
  benchmark_summary.txt
  benchmark.log
```

可通过 `E2B_RUN_DIR` 覆盖运行目录。

## 批量性能测试参数

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `E2B_BENCH_ITERATIONS` | `10` | 正式统计的执行次数 |
| `E2B_BENCH_CONCURRENCY` | `1` | 并发 worker 数 |
| `E2B_BENCH_MAX_CONCURRENCY` | `5` | 脚本允许的最大并发上限 |
| `E2B_BENCH_WARMUP` | `1` | 预热次数，不计入汇总统计 |
| `E2B_BENCH_READY_ATTEMPTS` | `12` | 等待 sandbox ready 的最大重试次数 |
| `E2B_BENCH_READY_INTERVAL_SECONDS` | `1` | ready 重试间隔秒数 |
| `E2B_BENCH_COMMAND` | `printf bench-command-ok` | 每次 sandbox 内执行的命令 |

低并发基线示例：

```bash
export E2B_BENCH_ITERATIONS=20
export E2B_BENCH_CONCURRENCY=1
export E2B_BENCH_WARMUP=2
bash script/run_benchmark.sh
```

逐步升高并发示例：

```bash
export E2B_BENCH_ITERATIONS=50
export E2B_BENCH_CONCURRENCY=3
export E2B_BENCH_MAX_CONCURRENCY=5
export E2B_BENCH_WARMUP=3
bash script/run_benchmark.sh
```

## 通过标准

看到以下关键输出即可判定 MVP 回归通过：

```text
e2b version = 2.24.0
ssl_cert_file_exists = True
list contains created: True
command stdout: 'sdk-command-ok'
command exit_code: 0
nonzero exception type: CommandExitException
nonzero exception exit_code: 7
read_content: 'hello-from-official-e2b-sdk-files'
post_remove_read_exception: InvalidArgumentException path does not exist
task exit_code: 0
"score_sum": 23
"score_avg": 7.67
"top_item": "beta"
removed verified: /workspace/agent_result.json InvalidArgumentException path does not exist
killed sandbox: True
killed: True
```

说明：`sandbox is not running` 在 sandbox 刚创建后的 readiness 阶段可能出现，只要后续出现 `ready attempt:` 并继续成功，不算失败。

## 常见问题与处理

| 现象 | 原因 | 处理 |
|------|------|------|
| `python: command not found` / `python3: command not found` | Python 未安装或未加入 PATH | 安装 Python 3，重新打开终端 |
| 创建 venv 失败 | Linux 常见为缺少 `python3-venv` | 安装 venv 支持，例如 `sudo apt-get install -y python3-venv` |
| `pip install e2b==2.24.0` 失败 | 无法访问 PyPI | 配置可用 pip 镜像后重试 |
| `401` 或 SDK 解析 401 出现 `KeyError: 'code'` | API key 未设置、失效或认证策略变化 | 确认当前 shell 的 `E2B_API_KEY` 是 41 环境有效凭证 |
| `CERTIFICATE_VERIFY_FAILED` | `ca.crt` 未被使用或 41 Data Plane 证书已更换 | 确认 `SSL_CERT_FILE` 指向运行目录的 `ca.crt`，必要时更新 `script/ca.crt` |
| `sandbox is not running` | sandbox 创建后的短暂启动状态 | 脚本内置 retry；只有 retry 耗尽才算失败 |
| Data Plane 根路径 404 | 根路径无业务处理 | 正常；官方 SDK 访问内部 RPC/文件接口路径 |
| `target cluster 1 unavailable: cluster 1 not found` | 目标集群 provider 注册异常 | 先修复目标集群注册，再执行 MVP 或 benchmark |

## 测试结论填写

```text
测试环境：AIOS 41
执行机器：
执行时间：
执行系统：Windows Git Bash / Linux Bash
SDK 版本：e2b==2.24.0
生命周期测试：通过 / 不通过
命令执行测试：通过 / 不通过
文件系统测试：通过 / 不通过
Agent E2E 测试：通过 / 不通过
批量性能测试：执行 / 未执行
批量性能配置：iterations=，concurrency=，warmup=
批量性能成功率：
批量性能 p95 total_ms：
日志目录：e2b-official-sdk-mvp-41-run/
备注：
```
