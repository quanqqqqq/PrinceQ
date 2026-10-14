# PrinceQ 模型选项

GET /api/agent/models?provider=claude|codex，refresh=1 跳过 60 秒缓存。调用方只能选择提供方，不能指定任意可执行路径。使用已保存 CLI，另一提供方使用本机检测候选；不启动线程、对话或推理。

Codex：stdio initialize → initialized → model/list，使用返回的模型标识和显示名、分页读取；失败时可使用本机 models_cache.json 的目录字段。清单可能来自 CLI 内置/缓存，不能视为账户权限验证。参考 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。

Claude：只解析安装版本 --help 的 --model 段所列别名，并合并当前 PrinceQ 模型及实际传给子进程的明确模型环境配置。没有伪造账号支持的完整型号；自定义部署保留手动输入。参考 [官方模型配置文档](https://code.claude.com/docs/en/model-config)。

选择值保存到现有 runtime model 字段，每次调用用 --model 传入；默认项清空覆盖，不改 CLI 全局模型配置。实际账号可用性仍需固定连接测试或真实对话验证。
