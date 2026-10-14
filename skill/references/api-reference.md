# PrinceQ Skill v2 调用注意

任务、目标、队列和设置的客户端写命令现在默认返回待确认预览，不能把旧示例的命令成功当作已修改数据。确认步骤为 `skill-confirm TOKEN --confirmed`（先得到用户对该预览的确认），取消为 `skill-cancel TOKEN`；使用 [统一操作合同](operations.md) 的 skill-propose 支持全部公开字段及 null 清空。旧 agent-preview/agent-confirm 命令同样要求 --confirmed。agent-message 强制模型模式，失败不回退到直接写入的规则命令。

新命令：skill-manifest、skill-context、skill-previews、skill-propose、skill-confirm、skill-cancel、delete-task、delete-goal、remove-dependency。既有查询参数保持兼容。下面是原 API 及客户端参数参考；写入默认语义以此节为准。

# 本机 API 与 CLI 参考

基础地址 `http://127.0.0.1:28642`；`--base` 可指定隔离服务。所有命令可运行 `--help`。写操作默认打印新幂等键；重试复用 `--idempotency-key KEY`。`--stable-key` 按方法、完整路径和请求体生成键。接口通过 JSON 返回结果；完整 HTTP 细节见项目 `docs/local-api.md`。

## 查询

| 命令 | 用途 |
|---|---|
| `health` / `meta` | 服务与能力 |
| `queue` / `explain TASK_ID` | 排名和逐项依据 |
| `tasks [--active] [--status STATUS] [--goal-id ID] [--quadrant q1] [--unconfirmed]` | 任务列表 |
| `task ID` / `goal ID` / `goals` | 详情与目标进度 |
| `activity [--limit N]` / `agent-sessions [--session-id ID]` | 操作与会话记录 |
| `habits-list` / `habits-settings` / `habits-duration` | 原始习惯、设置快照、换算偏好 |

## 任务与评分

`create-task TITLE` 支持 `--description`、`--goal-id`、`--deadline`、`--estimated-minutes`、`--duration-value N --duration-unit minute|day|month`、`--cognitive-load low|medium|high`、`--task-type`、`--manual-priority`、`--depends-on ID`，以及连续评分参数。更新用 `update-task ID` 加实际修改的字段与 `--expected-version`。

```bash
python3 "$CLIENT" score-task TASK_ID --importance-score 72.5 --urgency-score 40 --reason "目标影响明确；尚无紧迫截止压力" --expected-version 3 --confidence 0.7
```

对应 `POST /api/tasks/:id/matrix-score`，两轴和理由必填，0..100、最多一位小数；理由4..2000字；置信度0..1。来源默认agent，可指定user（仅用户明确给分）。未传版本时客户端先读取任务，提交时始终带版本。创建任务提供同样评分参数时嵌套于matrix_score，无版本字段。

`task-action ID ACTION [--reason ...] [--actor-id ...]` 支持claim/release/start/block/unblock/complete/archive/restore/reopen，合法动作由任务状态和领取者决定。`dependency ID DEPENDS_ON_ID` 增加依赖。`quadrant-confirm ID` 接受建议，`quadrant-resuggest ID` 仅重新跑规则，不能冒充模型。旧quadrant/change始终拒绝。

## 改象限复评：确认前不改任务

```bash
python3 "$CLIENT" rescoring list --status pending
python3 "$CLIENT" rescoring request --task-id TASK_ID --target-quadrant q2
python3 "$CLIENT" rescoring request --task-id TASK_ID --axis urgency
python3 "$CLIENT" rescoring submit --id REQUEST_ID --urgency-score 35.5 --reason "截止压力已解除，重要程度保持原值" --agent-name "当前助手" --confidence 0.8
python3 "$CLIENT" rescoring confirm --id REQUEST_ID
python3 "$CLIENT" rescoring cancel --id REQUEST_ID
```

请求返回context、changed_axes和任务版本快照。submit只给被请求轴，服务器拒绝改动未请求轴；建议进入awaiting_confirm，用户确认后才写任务，冲突时重新读取。confirm/cancel不需要模型。

## 目标与拆分

`create-goal TITLE [--description ...] [--target-date YYYY-MM-DD] [--color ...]`；`update-goal ID` 支持标题、描述、日期、颜色、状态和版本。`decompose-preview GOAL_ID` 返回待确认草稿。`decompose-confirm GOAL_ID TOKEN [--accept TITLE]...` 先预览将创建的选定草稿，统一确认后才创建；不带accept表示接受全部，不可自动确认。`recalculate [--reason ...]` 重算队列。

## 设置

| 命令 | 参数 |
|---|---|
| `habits-explicit list` | 查询明确习惯 |
| `habits-explicit add` | `--statement ... [--kind ...] [--expected-version ...]` |
| `habits-explicit enable` | `--id ... [--disable] [--expected-version ...]` |
| `habits-explicit adopt-inferred` | `--id ... [--expected-version ...] [--expected-explicit-version ...]` |
| `habits-inferred list|enable` | 启停用`--id ... [--disable]` |
| `habits-constraints list|add|enable` | 新增需`--statement --kind --value`；启停需`--id [--disable]` |
| `habits-conversion` | `--hours-per-day N --days-per-month N`，或`--reset` |
| `habits-weights preview|save` | `--json JSON`，或六项权重参数；save支持版本 |

未显式传版本时，设置客户端先GET /api/settings读取对应versions。权重JSON必须包含六项weights，未提交的偏好字段保持现值。类型为deep_work/shallow_work/communication/admin/review/learning。

```json
{"weights":{"deadline":1,"manual_priority":1,"dependency":1,"effort":1,"habit_alignment":1,"context_switch":1},"peak_hours":[9,10,11],"task_type_peak_hours":{"deep_work":[9,10],"communication":[14,15],"admin":[]}}
```

小时为0..23整数；类型键缺失继承peak_hours，[]明确不设。恢复继承时提交完整map并移除该键。权重0..2；hours_per_day为0.5..24，days_per_month为1..31。移除是enabled=false，恢复为true，不删除历史。

旧习惯兼容命令保留：`habits-add STATEMENT [--kind ...]`、`habits-disable ID [--file explicit|inferred] [--enable]`、`habits-weights`的具体参数以当前help为准。不要直接编辑文件。

## 助手

`agent-message TEXT` 强制调用配置的模型助手，失败不回退命令写入。`agent-confirm TOKEN --confirmed [--session-id ...]`、`agent-cancel TOKEN [--session-id ...]` 使用旧目标拆分确认接口；网页模型预览使用 `agent-preview confirm|cancel TOKEN [--session-id ID]`（confirm 需 --confirmed），对应独立 `/api/agent/preview/confirm` 与 `/cancel`，不可混用token。

CLI安装检测只检查version/help，不等同模型连接。runtime-test为固定只回复OK的真实模型请求；有效回答伴警告可成功，超时、空回答、只有banner一律失败。warnings为独立中文摘要，回答不混入CLI诊断。模型配置警告不修改全局Claude配置。

错误：400参数/评分非法；404对象不存在；409版本冲突、状态/领取冲突、token已处理。设置version_conflict携带最新snapshot。命令退出1时读错误并说明，2修参数，3说明服务不可达；不要通过重试绕过冲突。

客户端默认请求超时130秒，覆盖运行时最长120秒加终止宽限期；可用PWQ_API_TIMEOUT覆盖。Claude本机支持safe-mode和no-session-persistence，运行时用它们关闭定制与CLI会话写入；Codex用exec --json，并从JSONL的completed agent_message提取回答。Codex自动推荐60秒超时，手动设置保留。

`GET /api/agent/runtime-providers`分别显示Claude/Codex候选和上次真实连接验证。`POST /api/agent/runtime-test`可在关闭助手时验证配置，或发送成对的provider与cli_path验证已检测候选；不会切换、启用助手或写业务库。证据保存在独立诊断文件，配置版本不变。切换CLI不沿用另一provider的模型/参数；自动超时Claude60秒、Codex120秒。启用后的首条消息会自动建立健康检查，不再依赖先打开设置页。

PrinceQ 网页助手每轮使用固定工作助手指令和完整只读上下文：当前会话全部已保存历史、所有状态任务/目标的完整信息、依赖与领取记录、明确/推断习惯、硬约束、偏好时段及换算设置。历史预览的真实状态单独提供，当前快照优先于旧建议。修改仍只生成待确认预览；未知动作或额外字段整条拒绝。完整上下文经 stdin 传递，超过 2 MiB 时明确报错而不截断。
