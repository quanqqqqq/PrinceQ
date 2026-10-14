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

## 核心能力与操作截图

以下截图来自当前版本的示例工作区。目标、任务和工作习惯均为演示内容；截图展示了桌面与窄屏下的操作界面。

### 1. 首次使用：连接 Agent 助手

首次进入会出现三步新手指引：连接助手、描述目标、描述任务。
点击「去配置助手」可直接定位到配置模块；跳过或完成后不会反复弹出，右侧「助手」下方的问号可以重新打开。

![首次进入的三步新手指引](docs/screenshots/onboarding.jpg)

在「个人设置 → PrinceQ 助手」选择已安装并登录的 Claude Code 或 Codex，点击「使用 Claude」或「使用 Codex」。模型可以先沿用 CLI 默认值；需要时再选择模型，并通过「验证」检查连接。配置会自动保存。

![Agent 助手配置与模型选择（窄屏界面）](docs/screenshots/agent-settings.jpg)

### 2. 目标：描述结果，再拆成任务

目标页面显示完成进度，以及未开始、执行中和受阻的任务数量。点击「查看目标」可查看关联任务，再用「为这个目标拟任务草稿」补齐实现目标所需的工作。

可以直接告诉助手：

> 帮我创建一个目标：月底前上线个人作品集网站。完成标准是展示 3 个项目，电脑和手机上都能正常浏览。请先给我目标和任务拆分的预览。

![目标列表与关联任务进度](docs/screenshots/goals.jpg)

### 3. 任务优先队列：知道下一步做什么

队列卡片把状态、轻重分类、截止时间、预计用时和排序依据放在一起。右上角评分用不同颜色表示优先程度；可以按优先顺序、轻重缓急或任务状态分组。

操作时先「领取」，开始处理时点「开始」，结束后点「完成」；在「更多」里处理其他状态，点「详情」查看或调整任务信息。

![任务优先队列、评分颜色和状态操作](docs/screenshots/task-queue.jpg)

### 4. 助手对话：先预览，确认后执行

助手结合历史对话、任务、目标和个人设置理解请求。可以连续说「查询刚才的任务」「把预计用时改为 45 分钟」；历史会话可从助手顶部重新打开，切换页面也能继续对话。

例如：

> 给“上线个人作品集网站”新增任务“检查作品集手机端布局”，预计 30 分钟。完成标准：首页和 3 个项目页在手机上没有横向滚动，链接正常。请先展示预览，确认前不要创建。

下面是 Claude 生成的真实待确认预览。检查名称、目标关联和用时后，再点击确认；也可以取消并继续说明需要调整的地方。

![Claude 助手生成的任务创建预览，等待用户确认](docs/screenshots/assistant-preview.jpg)

### 5. 任务分布视图：从重要和紧急两个维度看任务

横轴为紧急程度，纵轴为重要程度。散点图和四象限列表帮助你查看任务分布，点击任务可展开信息和操作。
在 Mac 上，按住 Command 再滚动鼠标滚轮可按指针位置缩放；也支持图上的放大、缩小与重置按钮。

![任务分布散点图和象限](docs/screenshots/task-distribution.jpg)

### 6. 工作偏好：把自己的节奏告诉助手

在个人设置中选择精力最好的时段、偏好的工作类型，或写下明确的工作习惯。助手会读取这些设置，安排和拆分任务时一并参考。
点选后自动保存；文字或数字填写完成后，离开输入框并静置 0.5 秒自动保存。

![工作偏好和自动保存状态（窄屏界面）](docs/screenshots/work-preferences.jpg)

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
│   ├── Layout.tsx       # 全局布局容器（含 <Outlet />）
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

## 页面入口

| 路由 | 页面 |
|------|------|
| `/goals` | 目标与关联任务 |
| `/` | 任务优先队列 |
| `/matrix` | 任务分布视图 |
| `/activity` | 操作记录 |
| `/settings` | 个人设置与 Agent 配置 |

`Layout` 提供统一导航与共享助手面板；会话、输入草稿和新手指引进度会在页面切换时保留。

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
