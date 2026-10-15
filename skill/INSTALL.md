# 安装 PrinceQ Skill

将本目录导入支持 Skill ZIP 安装的 Agent，或在本目录中运行：

```sh
python3 scripts/install_skill.py
```

脚本将当前目录注册到当前用户的 Codex 与 Claude Code Skill 目录。请将解压后的目录保留在固定位置，因为安装使用目录链接。

安装后启动 PrinceQ 应用，让 Agent 使用 `personal-work-queue` Skill。Skill 客户端需要 Python 3，默认连接本机 `http://127.0.0.1:28642`；在独立环境中运行的 Agent 需要通过 `PWQ_API_BASE` 配置它能访问的 PrinceQ API 地址。

在源码仓库中可直接运行 `python3 skill/scripts/install_skill.py`。应用右侧助手下方的下载按钮每次读取当前仓库的 `skill/` 目录并生成 ZIP。
