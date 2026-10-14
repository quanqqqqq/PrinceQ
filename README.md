# PrinceQ

把重要的事，排在前面。

PrinceQ 是本地优先的个人工作队列，帮助你安排任务与目标，并用 Claude / Codex 助手处理请求。

## 本机运行

需要 Node.js 24 LTS；使用外部 Agent Skill 客户端时还需要 Python 3。

```sh
npm ci
npm run db:setup
npm run dev
```

打开 `http://127.0.0.1:28641`。Node API 默认监听本机 `28642` 端口。
`db:setup` 会创建数据库、默认个人设置，并在全新数据库中放入示例任务；已有数据不会重复播种。

首次进入时，新手指引会引导你在「个人设置 → PrinceQ 助手」选择已安装并登录的 Claude Code 或 Codex CLI。
也可以点右侧「助手」下方的问号重新查看。助手创建、修改或删除任务和目标前会先展示预览，确认后执行。

仓库只保存源码、测试、示例用例和文档。本机数据库、会话历史、个人习惯、Agent 配置、日志和依赖均不提交；首次启动会在本机生成所需文件。

## 检查与联调

```sh
npm run lint
npm run build
npm test
```

真实 Claude / Codex 联调使用隔离数据库与设置，需先准备对应 CLI 的登录状态；调用会产生模型用量。

```sh
npm run test:skills:conversation -- claude
npm run test:skills:conversation -- codex
npm run test:agent:goal-drafts -- claude
npm run test:agent:goal-drafts -- codex
```

详情见 `docs/skill-conversation-scenario.md` 和 `docs/goal-decomposition-evaluation.md`。

## 项目技术规范

## 技术栈

- 前端: React 19 + TypeScript
- 样式: Tailwind CSS v4
- UI 组件: shadcn/ui `import { Button } from "@/components/ui/button";`
- 图标: lucide-react `import { SearchIcon } from "lucide-react";`
- 图表: echarts-for-react `import ReactECharts from "echarts-for-react";`
- 动画: framer-motion `import { motion } from "framer-motion";`
- 路由: react-router-dom `import { Link, useNavigate } from "react-router-dom";`

---

## 目录结构

```
src/
├── index.tsx            # 入口（勿修改）
├── app.tsx              # 路由配置（仅在 <Routes> 内增删 <Route>）
├── index.css            # 全局样式 + 主题变量
├── components/          # 基础 UI 组件（禁止存放业务组件）
│   ├── layout.tsx       # 全局布局容器（含 <Outlet />）
│   └── ui/              # shadcn/ui 内置组件（勿修改）
├── pages/               # 页面模块（每个页面一个目录）
│   ├── <PageName>/      # 页面目录示例
│   │   ├── PageName.tsx        # 页面入口文件与目录同名
│   │   └── components/         # 页面专属组件
│   └── NotFoundPage/
│       └── NotFoundPage.tsx
├── hooks/               # 自定义 Hooks
└── lib/                 # 工具函数（cn() 等）

public/                  # 静态资源（dev server 原样服务；构建后随 dist/output 同源部署）
```

---

## 模板初始状态

- `app.tsx` 首页路由指向 `pages/HomePage`（占位欢迎页）
- 开发时将 `HomePage` 替换为业务首页，或在 `pages/` 下创建新页面并调整 `index` 路由
- `layout.tsx` 为空壳容器（仅 `<Outlet />`），需根据需求实现导航和布局

---

## 禁止修改的文件

| 文件 | 原因 |
|------|------|
| `src/index.tsx` | Provider 层级 + 样式引入，由模板管理 |
| `src/components/ui/*` | shadcn/ui 内置组件，版本锁定 |

---

## 文件放置规则

| 内容类型 | 放置位置 |
|---------|---------|
| 新页面 | `src/pages/<PageName>/PageName.tsx` |
| 页面专属组件 | `src/pages/<PageName>/components/` |
| 自定义 Hooks | `src/hooks/` |
| 工具函数 | `src/lib/` |
| 静态数据文件 | `public/data/` |
| 静态图片 | `public/images/` |

---

## 导入路径

```typescript
// @/ 别名 → src/
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";

// public/ 下的静态资源通过 URL 引用（dev 与线上同源）
// <img src="/images/hero.png" />  fetch("/data/config.json")
```

---

## 路由配置

- 新增页面需在 `src/app.tsx` 的 `<Routes>` 内注册 `<Route>`
- `BrowserRouter` 已在 `index.tsx` 中配置，`app.tsx` 中**禁止**再包裹 Router

---

## 主题变量

主题色定义在 `src/index.css`，通过 `:root` CSS 变量 + `@theme inline` 注册到 Tailwind。

| 用途 | Tailwind 类 | CSS 变量 |
|------|------------|----------|
| 页面背景 | `bg-background` | `--background` |
| 主文本 | `text-foreground` | `--foreground` |
| 卡片背景 | `bg-card` | `--card` |
| 次要文本 | `text-muted-foreground` | `--muted-foreground` |
| 主色 | `bg-primary` / `text-primary` | `--primary` |
| 强调色 | `bg-accent` | `--accent` |
| 边框 | `border-border` | `--border` |
| 危险色 | `text-destructive` | `--destructive` |
| 图表色 | `bg-chart-1` ~ `bg-chart-5` | `--chart-1` ~ `--chart-5` |

HSL 格式使用**空格分隔**：`--primary: hsl(150 60% 40%);`
