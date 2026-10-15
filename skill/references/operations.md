# PrinceQ Skill 操作合同 v2

## 当前能力与数据

`GET /api/skills/princeq` 返回机器可读 operation 清单与每项 payload_schema；以服务返回为准。`GET /api/skills/princeq/context?session_id=...` 返回当前会话全部历史、所有任务/目标、依赖、领取记录、队列评分和完整个人设置。不提供 session_id 时不包含会话历史。`GET /api/skills/princeq/previews` 查询未处理预览，`GET /api/skills/princeq/previews/:token` 查询状态与动作。

任务/目标查询仍使用 /api/tasks、/api/tasks/:id、/api/goals、/api/goals/:id；过滤、队列解释、历史与评分语义见 API 参考。目标单项查询默认排除已归档任务；需要全部关联任务时使用 tasks --goal-id 或完整上下文。

## 统一修改流程

请求 `POST /api/skills/princeq/previews`：
```json
{"summary":"调整复盘任务的截止时间","actions":[{"action":"skill_operation","operation":"task.update","target_id":"t_123","payload":{"deadline":"2026-10-15","expected_version":3}}]}
```
返回 token、actions、result（可在普通助手面板确认）、session 和 review_url。此阶段只保存预览与对话，不改任务/目标。每份 1–20 项；个人设置写单独提交，不能和任务/目标或其他设置混批。

向用户展示完整预览后，用户点击 PrinceQ 界面确认；外部 Agent 也可在用户明确确认后调用 `POST /api/skills/princeq/previews/:token/confirm`，body 为 `{"confirmed":true}`。取消用同路径 `/cancel`、body `{}`。记录幂等键，网络结果不确定时用相同键重试。客户端：
```bash
python3 /path/to/personal-work-queue/scripts/pwq_client.py skill-context
python3 /path/to/personal-work-queue/scripts/pwq_client.py skill-propose --json '{"actions":[{"action":"skill_operation","operation":"goal.create","payload":{"title":"完成季度复盘","description":"汇总本季度成果"}}]}'
# 先把返回预览给用户；获得对这份预览的确认之后：
python3 /path/to/personal-work-queue/scripts/pwq_client.py skill-confirm pa_TOKEN --confirmed
```

## 操作范围

| operation | 内容 |
|---|---|
| task.create / task.update / task.delete | 完整公开字段的增改与永久删除 |
| task.action | claim/release/start/block/unblock/complete/archive/restore/reopen |
| task.dependency.add / task.dependency.remove | 依赖增删（禁止循环） |
| task.matrix.score | 连续评分、原因、来源、置信度 |
| task.quadrant.confirm / task.quadrant.resuggest | 确认评分 / 本地规则重建议 |
| task.rescoring.request | 指定目标象限或复评轴 |
| rescoring.submit / confirm / cancel | 提交、接受、取消复评 |
| goal.create / goal.update / goal.delete | 目标公开字段增改、状态、永久删除 |
| goal.decomposition.confirm | 接受已有拆分草稿，支持选择和编辑 |
| queue.recalculate | 重新计算队列 |
| settings.conversion.update / reset | 耗时换算 |
| settings.explicit.create / update / enabled | 明确习惯 |
| settings.constraint.create / update / enabled | 工作约束 |
| settings.inferred.enabled / adopt | 推断习惯启停、采纳 |
| settings.weights.save | 偏好类型、时段、排序权重 |

路径参数使用 target_id，具体字段和枚举从 manifest 的 payload_schema 获取；nullable 字段填 null 清空。不能直接给 status 改任务，须走状态机。外部 Skill 客户端新建目标后需先确认取得 ID，再批量创建关联任务；PrinceQ embedded Agent 可用 `create_goal_with_tasks` 把新目标与第一批任务放入同一份确认预览。task.create 支持 description、goal_id、deadline、estimated_minutes、duration_value/unit、task_type、cognitive_load、manual_priority、matrix_score、depends_on。

预览自动绑定任务/目标版本与依赖、拆分/复评状态；数据改变后确认拒绝，旧预览仍未执行。批量任务/目标操作的 SQL、队列、日志和预览状态在同一事务中，失败全部回滚。个人设置使用已有版本检查与原子文件写入，单独确认；文件写与 SQLite 之间没有跨存储事务保证。

永久删除任务同时移除该任务的领取、依赖、复评和队列关联；其他任务保留。永久删除目标同时删除所有关联任务（包括已完成、已归档任务）及这些任务的领取、依赖、复评和队列关联；其他目标的任务和无目标任务保留。需保留历史和恢复能力时按用户意图归档任务或把目标置为 dropped。

## 分发与鉴权预留

Skill 是标准 SKILL.md + Python 客户端，可复制给任何能发 HTTP 的 Agent。默认 API 仅监听 loopback；远程调用需自行提供可达的连接（如受控端口转发），`--base`/PWQ_API_BASE 不会自动公开本机端口。

一期 auth.mode=none，没有认证身份或 scope 检查；X-PrinceQ-Agent 只记录来源。所有 Skill 接口统一经过 server/skills/access.ts 的 authorizePrinceQRequest(req, permission)，预留 read/preview/confirm/cancel 权限及 principal；后续在该入口接入 token/作用域，不改业务操作合同。客户端可预留 PWQ_API_TOKEN 发送 Bearer，但一期服务不会校验它。

Windows 默认复制安装且支持重复更新，macOS/Linux 默认链接安装；命令与更新方式见 `INSTALL.md`。

本机默认安装使用 `scripts/install_skill.py`：将同一 Skill 接入 ~/.claude/skills/personal-work-queue 和 ~/.agents/skills/personal-work-queue；应用内每轮直接注入 Skill，CLI 的自动触发与安全模式不会使其丢失。外部 Agent 的新会话可自动发现，是否加载由其 Skill 机制决定，不能保证任意厂商运行时都支持。


## 真实对话场景测试

在 PrinceQ 源码项目中运行 `npm run test:skills:conversation -- claude` 或 `npm run test:skills:conversation -- codex`。脚本自动使用独立端口、临时数据库/习惯/配置，按同一会话完成登记 → 查询 → 调整 → 删除；修改必须预览后确认，目标保留。可用 PWQ_SCENARIO_MODEL 指定从模型目录得到的标识。具体检查项见项目 docs/skill-conversation-scenario.md。此测试会真实调用模型，不能改为对现有 API 数据运行测试写入。


### 循环任务与独立任务协助（合同 v4）

- task.create.payload.recurrence 与组合目标动作中的 task.recurrence：`start_date`、`start_time`（默认09:00，仅小时有效）、`interval`（1–365）、`unit`（hour/day/week/month）、`timezone`（默认Asia/Shanghai）、`end_mode`（goal/date）、`end_date`（date模式必需）。关联目标必须已有日期；goal模式随目标日期结束。
- task.recurrence.configure：target_id为任务，payload为上述字段加任务 expected_version。task.recurrence.control：action=pause/resume/finish，expected_version为 recurrence.version。
- task.occurrence.action：date为日历键（小时含THH:mm），action=open/start/complete/skip/reopen，expected_version为当次版本（初始0），note可选，跳过必填。不能记录未来执行；只完成单次。
- task.assistance.accept：target_id为任务，payload为产出 revision、任务 expected_version。必须用户验收，不能用生成回复代替确认。
- 读取 `/api/tasks/:id/recurrence` 与 `/api/tasks/:id/assistance`；对话 `/api/tasks/:id/assistance/messages` body为message，必须带幂等键，不自动改任务。客户端提供 task-assistance、task-assist-message。

- task.recurrence.update：target_id为已有循环任务，payload与recurrenceSchema相同，加 expected_version=recurrence.version。start_date/start_time定义未来生效点；不更改时区，不覆盖生效点之后已经存在的执行记录；确认前只模拟日历并展示次数与前后日期，确认后写入计划修订，保留此前的规则与记录。
- 任务AI协助每轮注入Skill与合同，输出proposed_actions，不执行HTTP或脚本。GET /api/tasks/:id/assistance返回独立会话、previews与skill信息；POST /api/tasks/:id/assistance/previews/:token/confirm必须confirmed=true；cancel取消。确认端校验任务归属、版本与整批事务，支持幂等读回。不要在全局Agent入口确认任务会话的预览。
