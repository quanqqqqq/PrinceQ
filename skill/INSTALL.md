# 安装 PrinceQ Skill

将本目录导入支持 Skill ZIP 安装的 Agent，或在本目录中运行：

```sh
python3 scripts/install_skill.py
```

Windows PowerShell 使用 `py -3 scripts/install_skill.py`，或使用已安装的 Python 3 `python` 命令。默认复制安装，无需管理员权限或开发者模式；重复运行会更新此安装器创建的副本，不覆盖不相关目录。

macOS / Linux 默认使用目录链接，请将解压目录保留在固定位置；也可用 `--mode copy` 安装副本。`--check` 只检查目标位置，不写入文件。

安装后启动 PrinceQ 应用，让 Agent 使用 `personal-work-queue` Skill。Skill 客户端需要 Python 3，默认连接本机 `http://127.0.0.1:28642`；在独立环境中运行的 Agent 需要通过 `PWQ_API_BASE` 配置它能访问的 PrinceQ API 地址。

在源码仓库中可直接运行 `python3 skill/scripts/install_skill.py`。应用右侧助手下方的下载按钮每次读取当前仓库的 `skill/` 目录并生成 ZIP。
