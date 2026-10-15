# Windows 适配与后续优化交接

目标环境为 Windows 11 x64、Node.js 24、Edge 或 Chrome。当前代码已完成跨平台改造；本地 macOS 检查不代表 Windows 实机验收通过。Windows ARM64 的本地语音暂未验证。

## 改造范围与代码入口

本次适配保持本地 Web + Node API 架构，业务数据仍使用 Node 内置 SQLite。无需为 Windows 重写任务、目标和队列逻辑。下表列出后续排查时应优先查看的文件，路径均相对仓库根目录。

| 改造点 | 实现与边界 | 主要文件 |
| --- | --- | --- |
| 运行时与启动 | 固定 Node 24；安装、开发、构建和测试前检查版本；提供 Windows 前台启动器 | `package.json`、`scripts/check-node.mjs`、`Start-PrinceQ.cmd` |
| CLI 入口 | 检测 Windows `.exe` / `.cmd`；官方 npm shim 解析为对应包 JS，由 Node 直接执行；保持参数独立传递 | `server/agent/detect.ts`、`server/lib/process-launch.ts`、`server/agent/health.ts` |
| 子进程环境 | 保留白名单，补用户目录、AppData、SystemRoot、临时目录；Windows 变量名去重且不区分大小写过滤危险项 | `server/agent/cli-exec.ts` |
| 进程清理 | Windows 使用 `taskkill.exe /T /F`；POSIX 使用独立进程组；服务退出清理已跟踪的 CLI、模型和语音进程 | `server/lib/process-launch.ts`、`server/index.ts`、`server/agent/model-catalog.ts` |
| 路径 | 表单接受盘符与 UNC 形式，按路径片段判断上跳；服务端用相对路径判断项目目录边界 | `shared/filesystem-path.ts`、`src/lib/agent-runtime-contract.ts`、`server/agent/runtime-config.ts` |
| 配置落盘 | 同目录临时文件写入、fsync、原子重命名；Windows 短暂文件锁有限重试，失败保留原文件 | `server/lib/atomic-file.ts`、`server/domain/habits.ts`、`server/agent/provider-connections.ts` |
| 语音运行时 | 保留 Apple Silicon MLX；新增 PyTorch ASR/TTS 分环境方案、UTF-8 JSONL、关闭后再打开的临时音频、内存 WAV 合成 | `server/voice/qwen-runtime.ts`、`server/voice/qwen_worker.py`、`server/voice/requirements-*.txt` |
| 语音安装与提示 | Node 安装脚本代替 shell 主流程；依赖状态接口；申请麦克风和合成前检查依赖 | `scripts/setup-qwen-voice.mjs`、`server/http/routes.ts`、`src/lib/agent-voice-client.ts`、`src/components/AgentPanel.tsx` |
| Skill | Windows 默认复制安装并可更新受管理副本；不覆盖无归属目录；客户端 UTF-8 通信 | `skill/scripts/install_skill.py`、`skill/scripts/pwq_client.py`、`skill/INSTALL.md` |
| 测试与换行 | 假 CLI 改用 Node 子进程；Windows 目录链接测试用 junction；CI 三平台；`.cmd` 使用 CRLF、`.sh` 使用 LF | `tests/fixtures/cli.ts`、`tests/windows-compat.test.ts`、`tests/python/test_windows_portability.py`、`.github/workflows/compatibility.yml`、`.gitattributes` |

循环任务、任务内助手及其语音等并行开发的业务功能不属于本次 Windows 适配提交；接入这些功能后需补做对应交互回归。

## 首次安装

安装 Git 和 Node.js 24 x64，重新打开 PowerShell：

```powershell
node --version
git clone https://github.com/quanqqqqq/PrinceQ.git
Set-Location PrinceQ
npm.cmd ci
npm.cmd run db:setup
npm.cmd run dev
```

打开 <http://127.0.0.1:28641>。保留终端，按 Ctrl+C 停止。PowerShell 若阻止 `npm.ps1`，直接使用上面的 `npm.cmd`，无需更改系统执行策略。若使用 nvm-windows，请按其安装方式切换 Node 24；macOS 的 nvm 安装命令不适用于它。

以后也可双击仓库根目录 `Start-PrinceQ.cmd`。它检查 Node 版本，在缺少依赖时安装，初始化数据库并以前台方式启动。启动器不安装语音或 Agent，不修改开机启动设置。更新源码后请先重新执行 `npm.cmd ci`。

检查 API：

```powershell
Invoke-RestMethod http://127.0.0.1:28641/api/health
```

页面能打开但 API 返回 502 时，查看同一终端中的 API 日志；不要重复打开多个启动窗口。`npm run build` 仍用于生成现有前端部署产物，本地使用按上述方式启动。

## Agent

先在终端完成需要使用的 Claude/Codex CLI 安装与登录，再重新启动 PrinceQ，在个人设置中检测、选择和验证。登录状态由 CLI 自己管理。

检测支持原生 `.exe` 和官方 npm `.cmd` 入口，包括全局 npm 目录与项目 `node_modules/.bin`。npm 入口会解析到对应包的 JavaScript 文件并由 Node 执行；任意自定义 `.bat` / `.cmd` / `.ps1` 不会被当作通用命令执行。无法解析时请选择原生 `.exe`，或重新安装官方 npm 包。

工作目录须位于 PrinceQ 项目内。中文和带空格的路径会作为独立参数传递。子进程仅继承系统基础变量与显式允许的变量；取消和超时会终止其进程树。

## 本地语音

安装 [uv](https://docs.astral.sh/uv/getting-started/installation/) 后重新打开终端，在项目目录执行：

```powershell
npm.cmd run voice:check
npm.cmd run voice:setup
Invoke-RestMethod http://127.0.0.1:28641/api/agent/voice/status
```

`voice:check` 仅显示安装方案；`voice:setup` 创建 Python 3.12 环境并安装依赖。uv 可按需下载 Python，无需向系统 Python 安装模型包。

Windows 使用 PyTorch 后端：

- ASR 环境：`.voice-asr-venv`，默认 `Qwen/Qwen3-ASR-0.6B`。
- TTS 环境：`.voice-tts-venv`，默认 `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`。
- 两者隔离，因为官方包固定了不同的 Transformers 版本。Windows 安装使用仓库中的完整依赖版本清单。
- 默认 CPU、float32、eager attention，不要求 FlashAttention。首次录音/朗读会下载权重，冷启动与 CPU 推理可能较慢；超时可取消。具体速度、内存和音质需在目标电脑验证。
- Apple Silicon 默认继续使用 MLX 和原有模型；不会自动改成 PyTorch。

状态接口仅检查解释器及包是否存在，不导入模型、不下载权重。`available=true` 表示依赖检查通过，不能作为真实推理成功的证明。缺少环境时，界面会在申请麦克风前提示安装；文字输入继续可用。

可选配置（启动服务前设置）：

```powershell
$env:PWQ_VOICE_BACKEND = 'torch'
$env:PWQ_VOICE_DEVICE = 'cpu'
# 指定已有环境时使用解释器完整路径：
# $env:PWQ_QWEN_ASR_PYTHON = 'D:\Voice ASR\Scripts\python.exe'
# $env:PWQ_QWEN_TTS_PYTHON = 'D:\Voice TTS\Scripts\python.exe'
# 本地模型目录也可通过 PWQ_QWEN_ASR_MODEL / PWQ_QWEN_TTS_MODEL 指定。
npm.cmd run dev
```

NVIDIA 加速需先按 [PyTorch 官方安装说明](https://pytorch.org/get-started/locally/) 在两个环境中安装相互匹配的 torch/torchaudio 和驱动，再设置 `PWQ_VOICE_DEVICE=cuda:0`。没有可用 CUDA 时会明确报错。仓库默认清单不承诺覆盖所有显卡。

语音识别结果仍进入可编辑输入框，手动发送；生成写操作预览后仍需确认。

### 语音配置变量

| 变量 | 用途与默认值 |
| --- | --- |
| `PWQ_VOICE_BACKEND` | `mlx` 或 `torch`；Apple Silicon 默认 `mlx`，其他平台默认 `torch` |
| `PWQ_VOICE_DEVICE` | PyTorch 设备，默认 `cpu`；CUDA 需先准备兼容运行环境 |
| `PWQ_QWEN_ASR_PYTHON` / `PWQ_QWEN_TTS_PYTHON` | 分别指定 ASR / TTS 解释器完整路径 |
| `PWQ_QWEN_PYTHON` | 两类解释器的共同回退；分环境专用变量优先 |
| `PWQ_QWEN_ASR_MODEL` / `PWQ_QWEN_TTS_MODEL` | 覆盖默认模型名或指定已下载的本地模型目录 |
| `HF_HOME` / `HF_HUB_CACHE` | 模型缓存位置；本地 worker 仅传递所需缓存变量 |

不要把 MLX 的量化模型目录直接交给 PyTorch 后端。更改后端或解释器后重启 PrinceQ，确保已有 worker 不再复用旧环境。

## Skill

解压下载的 Skill ZIP 后，在该目录运行：

```powershell
py -3 scripts/install_skill.py --check
py -3 scripts/install_skill.py
```

若没有 `py`，用 Python 3 的 `python` 替代。Windows 默认复制安装到当前用户的 `.claude/skills` 和 `.agents/skills`，不需要管理员权限或开发者模式。重复运行可更新此安装器创建的副本；已有无归属标记的目录不会被覆盖。macOS/Linux 默认保留链接安装方式，也可用 `--mode copy`。

外部客户端输出固定为 UTF-8。PowerShell 传复杂 JSON 时可通过标准输入避免参数引号差异：

```powershell
$env:PYTHONUTF8 = '1'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
'{"actions":[{"action":"skill_operation","operation":"goal.create","payload":{"title":"验证 Windows 使用流程"}}]}' | py -3 scripts/pwq_client.py skill-propose --json -
```

此命令只产生待确认预览。确认必须按 Skill 的确认流程执行。

Skill ZIP 的源码位于 `skill/`。下载接口按当前源码即时打包，因此安装器变化后需要重新下载 ZIP；应用自身运行不依赖此 ZIP。Git 保存安装器和说明源码，不保存本次聊天目录里的生成 ZIP，也不会自动改动本机已经安装的 Skill。

## 数据与迁移

依赖须在 Windows 重新安装，不要复制 macOS 的 `node_modules` 或 Python 虚拟环境。普通使用将仓库放在当前用户可写的本地目录；不要放在 `Program Files`。网络共享目录不在本次验证范围。

迁移已有数据前先停止服务，再备份并迁移 `data`、`habits`。Agent 的 `config` 中包含机器路径，应在新电脑重新检测和配置；CLI 登录状态也需在新电脑准备。配置写入遇到短暂 Windows 文件锁会有限重试，失败会保留旧文件并返回错误。

## 自动化与实机验收

`.github/workflows/compatibility.yml` 在 Linux、macOS、Windows 运行 Node 24 的类型检查、lint、构建、Node 回归和新增 Python 兼容测试。工作流文件存在不表示远端已经运行；查看实际 Actions 结果后才可确认 Windows CI 通过。

实机验收至少覆盖：全新普通账户、中文且带空格的路径、首次安装与再次启动、任务/目标增删改、设置保存、重启后数据保留、Agent 检测和对话、预览确认与取消、超时后恢复、Skill 安装与更新、语音录入与朗读，以及 Ctrl+C 后端口释放。

参考：[Node 子进程](https://nodejs.org/docs/latest-v24.x/api/child_process.html)、[Python 临时文件](https://docs.python.org/3/library/tempfile.html)、[Qwen ASR](https://github.com/QwenLM/Qwen3-ASR)、[Qwen TTS](https://github.com/QwenLM/Qwen3-TTS)。


## 开发与验证命令

在 Windows PowerShell 中：

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run build
npm.cmd test
py -3 -m unittest discover -s tests/python -p "test_*.py"
py -3 skill/scripts/test_pwq_client_settings.py
py -3 skill/scripts/test_pwq_client_merge.py
```

完整 Node 回归默认限制为两个测试文件并发，减小进程启动拥挤导致的超时。没有安装真实 CLI 时，可选的真实 CLI 检测用例可能跳过；Python 的独立安装副本对比需要设置 `PWQ_INSTALLED_CLIENT`，未设置时跳过。

仅运行关键兼容回归：

```powershell
node --disable-warning=ExperimentalWarning --test tests/windows-compat.test.ts tests/voice-client.test.ts tests/voice-runtime.test.ts
py -3 -m unittest discover -s tests/python -p "test_windows_portability.py"
```

依赖清单重生成（需要 uv，ASR 和 TTS 分别执行；修改前保留原清单用于比较）：

```powershell
uv pip compile server/voice/requirements-asr.txt --python-version 3.12 --python-platform windows --only-binary :all: -o server/voice/requirements-windows-asr.lock.txt
uv pip compile server/voice/requirements-tts.txt --python-version 3.12 --python-platform windows --only-binary :all: -o server/voice/requirements-windows-tts.lock.txt
```

解析通过仅证明依赖有可选择的安装包，不证明可以导入、加载模型或完成推理。GPU 环境变更后需执行 `uv pip check --python <对应环境的python.exe>` 并分别验证 ASR、TTS。

## 后续在 Windows 上的优化顺序

| 顺序 | 工作 | 完成依据 |
| --- | --- | --- |
| 1 | 全新普通账户安装，覆盖中文、空格路径和 PowerShell 执行策略 | 命令安装及双击启动均成功；API 健康；重启后数据保留；无需管理员权限 |
| 2 | 分别验证原生与 npm 安装的 Claude/Codex | 检测、版本、模型列表、真实对话、写入预览确认与取消正常；取消/超时后可继续请求 |
| 3 | 验证退出与故障恢复 | Ctrl+C 后无残留子进程且端口释放；持久文件锁不损坏旧配置；重复启动有明确端口错误 |
| 4 | 先验证 CPU 语音，再选择是否优化 CUDA | 实际识别与朗读成功；记录模型下载、冷启动、热启动耗时、峰值内存和显存；失败能回到文字输入 |
| 5 | 回归麦克风与会话 | 首次授权、拒绝授权、设备占用、取消、切换会话、延迟返回均不串会话；识别后仍须手动发送 |
| 6 | 核对 CI 与 Skill | GitHub Actions 三平台实际通过；普通账户复制安装、重复更新及外部客户端预览流程通过 |

CPU 速度、CUDA 版本和显存需求必须依据目标机器实测再决定，当前没有性能承诺。网络共享目录、Windows ARM64 语音、系统服务和开机自启不在本次验收范围。

## 验证记录与交付边界（2026-10-15）

此前在包含并行业务开发的原工作区完成过 Node 794/794、Python 57 项通过（1 项可选检查跳过）、前后端类型检查、lint 和生产构建。这组数字属于当时工作区，不能当作独立提交的测试总数。

本机 Chrome 模拟流程验证了：语音依赖检查、可编辑识别结果、手动发送、合成请求、旧会话取消隔离、缺少语音环境时恢复文字输入。当前 macOS 服务健康检查及语音依赖状态曾返回 200，生成的 Skill ZIP 通过独立 ZIP 校验。这些均不代替真实 Windows 验收。

本次独立提交的检查结果在提交前记录如下：

- 独立源码快照：Node 780/780 通过；Python 57 项通过、1 项可选安装副本对比跳过。
- `npm run lint`（前端、服务端类型检查及 ESLint）和 `npm run build` 通过。
- 生产构建仍有现有的大体积 bundle 提示，不影响构建完成。
- `git diff --check` 通过；Windows 依赖清单已完成仅安装包解析，尚未运行 Windows CI 或实机推理。

Windows CI 尚未远端执行。Windows CLI 登录与调用、进程树退出、双击启动、普通账户安装、真实麦克风和 CPU/CUDA 推理仍需实机确认。后续在本节追加 Windows 版本、CPU/GPU、Node/Python/CLI 版本、命令、结果与日志位置，再更新支持范围。
