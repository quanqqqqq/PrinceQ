/**
 * 业务可编辑控件的纯白底：静态源码断言。
 *
 * 为什么要 important：项目是 Tailwind v4，基组件 `src/components/ui/input.tsx`
 * 与 `native-select.tsx` 自带 `dark:bg-input/30` 之类的底色，业务侧只写
 * `bg-card` 会被基础层叠顺序压住，验收时 computed 仍是近灰。v4 的 important
 * 语法是**类名后缀** `!`（`bg-card!`，不是 v3 的 `!bg-card`），所以这里钉住的
 * 正是「带 bang 的后缀形式」——写成前缀形式在 v4 下是无效类名，静默失效。
 *
 * 同样钉住灰态走的是 `disabled:bg-muted!` / `read-only:bg-muted!`：禁用/只读时
 * 该退回灰，不能被白底 important 一路压住。
 *
 * 仓库没有 DOM 测试环境（不引 jsdom / react 渲染），所以读源码文本做静态断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'src');
const sourceOf = (relative: string): string =>
  fs.readFileSync(path.join(srcDir, relative), 'utf8');

/**
 * 每个文件声明：白底 important 至少出现几次，以及哪些 id/锚点必须落在
 * important 白底的 className 上。次数用「至少」而不是精确值，免得别的分片
 * 新增一个控件就把这里弄红。
 */
const COVERED = [
  {
    file: 'components/CreateTaskDialog.tsx',
    minWhite: 6,
    anchors: ['task-title', 'task-description', 'task-goal', 'task-type', 'task-load', 'task-priority'],
  },
  {
    file: 'components/TaskDetailDrawer.tsx',
    minWhite: 5,
    anchors: ['detail-title', 'detail-description', 'detail-goal', 'detail-type', 'detail-priority'],
  },
  { file: 'pages/GoalsPage/GoalsPage.tsx', minWhite: 2, anchors: ['goal-title', 'goal-description'] },
  {
    file: 'components/GoalDetailPanel.tsx',
    minWhite: 4,
    anchors: ['draft-title-', 'draft-description-', 'goal-edit-title', 'goal-edit-description'],
  },
  {
    file: 'pages/ActivityPage/ActivityPage.tsx',
    minWhite: 4,
    anchors: ['activity-search', 'activity-type', 'activity-from', 'activity-to'],
  },
  { file: 'components/AgentPanel.tsx', minWhite: 1, anchors: [] },
  { file: 'components/TaskDateTimeField.tsx', minWhite: 2, anchors: [] },
  { file: 'components/GoalDateField.tsx', minWhite: 1, anchors: [] },
  { file: 'components/DurationField.tsx', minWhite: 2, anchors: [] },
  { file: 'components/settings/ExplicitHabitsSection.tsx', minWhite: 1, anchors: ['habit-statement'] },
  {
    file: 'components/settings/ConversionSection.tsx',
    minWhite: 2,
    anchors: ['conversion-hours', 'conversion-days'],
  },
  {
    file: 'components/settings/ConstraintsSection.tsx',
    minWhite: 2,
    anchors: ['constraint-statement', 'constraint-minutes'],
  },
] as const;

/** `className="..."` / `className={'...'}` 里出现的所有字面量类串。 */
function classStrings(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/className=(?:"([^"]*)"|\{?'([^']*)'\}?)/g)) {
    out.push(match[1] ?? match[2] ?? '');
  }
  // 本地类名常量（SELECT_CLASS / TIME_CLASS 之类）也算控件表面。
  for (const match of source.matchAll(/^const [A-Z_]+ =\s*\n?\s*'([^']*)';/gm)) {
    out.push(match[1]);
  }
  return out;
}

const whiteCount = (source: string): number =>
  (source.match(/bg-card!/g) ?? []).length +
  (source.match(/<GoalDateField\b/g) ?? []).length *
  (sourceOf('components/GoalDateField.tsx').match(/bg-card!/g) ?? []).length;

for (const entry of COVERED) {
  test(`${entry.file}: 控件白底用 v4 后缀 important bg-card!`, () => {
    const source = sourceOf(entry.file);

    assert.ok(
      whiteCount(source) >= entry.minWhite,
      `${entry.file} 至少要有 ${entry.minWhite} 处 bg-card!，实际 ${whiteCount(source)}`,
    );

    // v3 的前缀写法在 v4 下不是合法类名，会静默不生效。
    assert.doesNotMatch(
      source,
      /!bg-card\b/,
      `${entry.file} 不能用 v3 前缀写法 !bg-card，v4 要写成 bg-card!`,
    );
  });

  if (entry.anchors.length > 0) {
    test(`${entry.file}: 每个受控 id 都挨着 important 白底`, () => {
      const source = sourceOf(entry.file);
      for (const anchor of entry.anchors) {
        const at = source.indexOf(anchor);
        assert.notEqual(at, -1, `${entry.file} 里找不到 ${anchor}`);
        // 窗口要够长：同一个 id 往往先出现在 <Label htmlFor> 上，真正带
        // className 的控件在它后面，中间还隔着多行 onChange 回调。
        const window = source.slice(at, at + 700);
        const delegatedDate = new RegExp('<GoalDateField\\b[^>]*id="' + anchor + '"').test(window);
        const surface = delegatedDate ? sourceOf('components/GoalDateField.tsx') : window;
        assert.match(
          surface,
          /bg-card!/,
          `${anchor} 所在控件必须带 important 白底 bg-card!`,
        );
      }
    });
  }
}

test('NativeSelect 不能带 read-only:bg-muted!（CSS :read-only 对 select 恒真）', () => {
  // 这是上一轮 Select 验收出 #f3f4f6（正是 --muted）的真正原因，不是基组件的
  // dark:bg-input/30——那条在亮色下根本不生效，基组件亮色是 bg-transparent。
  //
  // CSS 的 :read-only 等价于 :not(:read-write)，而 <select> 永远不是
  // :read-write（readonly 属性对 select 无效）。所以 `read-only:bg-muted` 加在
  // NativeSelect 上是**无条件命中**的，且 `.read-only\:bg-muted:read-only` 比
  // `.bg-card` 多一个伪类、特异性更高，于是把白底压成灰。给它补 `!` 只会把这个
  // bug 焊死：两边都 important 时仍是特异性高的那条赢。
  //
  // 结论：select 的灰态只能靠 disabled:bg-muted!，绝不能写 read-only 变体。
  // （text/number/date/time 这些 input 与 textarea 不受影响——readonly 对它们
  // 有效，未设置 readonly 时它们是 :read-write，不会命中。）
  const files = [
    'components/CreateTaskDialog.tsx',
    'components/TaskDetailDrawer.tsx',
    'pages/ActivityPage/ActivityPage.tsx',
    'components/DurationField.tsx',
  ];

  for (const file of files) {
    const source = sourceOf(file);
    const lines = source.split('\n');

    lines.forEach((line, index) => {
      if (!line.includes('<NativeSelect') || line.includes('NativeSelectOption')) return;
      // 从开标签往下找这个元素自己的 className。
      const block = lines.slice(index, index + 8).join('\n');
      const className = /className="([^"]*)"/.exec(block)?.[1];
      if (!className) return;
      assert.ok(
        !className.includes('read-only:bg-muted'),
        `${file}:${index + 1} 的 NativeSelect 不能带 read-only:bg-muted（:read-only 对 select 恒真，会把白底压成灰）`,
      );
    });
  }
});

test('灰态走 important muted：disabled / read-only 不被白底压住', () => {
  // 可禁用的文本/数值/下拉控件所在文件：灰态必须同样是 important，否则
  // bg-card! 会一路压过 disabled 状态，禁用时看起来仍可编辑。
  const files = [
    'components/CreateTaskDialog.tsx',
    'components/TaskDetailDrawer.tsx',
    'pages/GoalsPage/GoalsPage.tsx',
    'components/GoalDetailPanel.tsx',
    'pages/ActivityPage/ActivityPage.tsx',
    'components/TaskDateTimeField.tsx',
    'components/DurationField.tsx',
    'components/settings/ExplicitHabitsSection.tsx',
    'components/settings/ConversionSection.tsx',
    'components/settings/ConstraintsSection.tsx',
  ];

  for (const file of files) {
    const source = sourceOf(file);
    assert.match(source, /disabled:bg-muted!/, `${file} 的禁用灰态要用 disabled:bg-muted!`);
    // 裸的（不带 bang 的）灰态会被白底 important 压过，等于没写。
    assert.doesNotMatch(
      source,
      /disabled:bg-muted(?!!)/,
      `${file} 不能留裸 disabled:bg-muted，会被 bg-card! 压住`,
    );
    assert.doesNotMatch(
      source,
      /read-only:bg-muted(?!!)/,
      `${file} 不能留裸 read-only:bg-muted，会被 bg-card! 压住`,
    );
  }
});

test('只读文本控件声明 read-only:bg-muted!', () => {
  // 只有 Input/Textarea 吃 read-only；NativeSelect-only 的文件不强求。
  const files = [
    'components/CreateTaskDialog.tsx',
    'components/TaskDetailDrawer.tsx',
    'pages/GoalsPage/GoalsPage.tsx',
    'components/GoalDetailPanel.tsx',
    'pages/ActivityPage/ActivityPage.tsx',
    'components/TaskDateTimeField.tsx',
    'components/settings/ExplicitHabitsSection.tsx',
    'components/settings/ConstraintsSection.tsx',
  ];

  for (const file of files) {
    assert.match(
      sourceOf(file),
      /read-only:bg-muted!/,
      `${file} 的只读灰态要用 read-only:bg-muted!`,
    );
  }
});

test('可编辑控件表面不留裸 bg-background', () => {
  // 页面/容器背景用 bg-background 是对的，这里只看「带输入控件语义」的那些
  // className：凡是同一串里出现了白底 important，就不该再混 bg-background。
  const files = COVERED.map((entry) => entry.file);

  for (const file of files) {
    for (const classes of classStrings(sourceOf(file))) {
      if (!classes.includes('bg-card!')) continue;
      assert.doesNotMatch(
        classes,
        /\bbg-background\b/,
        `${file} 的控件 className 不该同时有 bg-background 与 bg-card!：${classes}`,
      );
    }
  }
});

test('AgentPanel 的 <Textarea> 自己带 bg-card!，不靠外层容器', () => {
  // 上一轮只把包裹 div 改成 bg-card!，Textarea 标签自己还留着 bg-transparent，
  // 于是 computed 背景仍是基组件那层 oklab 灰——外层白底被上面的透明控件盖住，
  // 肉眼看就是「输入框还是灰的」。所以这里只看 <Textarea 这一个标签自身的
  // className，刻意不扫整个文件，免得外层容器的 bg-card! 把断言蒙过去。
  const source = sourceOf('components/AgentPanel.tsx');

  const start = source.indexOf('<Textarea');
  assert.notEqual(start, -1, 'AgentPanel 里找不到 <Textarea');

  // 标签段 = 开标签到它的自闭合 /> 或 </Textarea> 为止。
  const selfClose = source.indexOf('/>', start);
  const closeTag = source.indexOf('</Textarea>', start);
  const candidates = [selfClose, closeTag].filter((at) => at !== -1);
  assert.ok(candidates.length > 0, '<Textarea 标签没有结束位置');
  const tag = source.slice(start, Math.min(...candidates));

  const className = /className="([^"]*)"/.exec(tag)?.[1];
  assert.ok(className, '<Textarea 标签自身没有字面量 className');
  assert.match(className, /\bbg-card!/, `<Textarea 自身 className 必须带 bg-card!：${className}`);
  assert.doesNotMatch(
    className,
    /\bbg-transparent\b/,
    `<Textarea 不能再留 bg-transparent，会透出基组件灰底：${className}`,
  );
});

test('基组件未被改动：ui/* 里不出现业务白底 important', () => {
  // 红线：白底只许加在业务侧 className，基组件保持原样，否则全局控件都会变白。
  const baseComponents = [
    'components/ui/input.tsx',
    'components/ui/native-select.tsx',
    'components/ui/textarea.tsx',
    'components/ui/button.tsx',
  ];

  for (const file of baseComponents) {
    const full = path.join(srcDir, file);
    if (!fs.existsSync(full)) continue;
    assert.doesNotMatch(
      fs.readFileSync(full, 'utf8'),
      /bg-card!/,
      `${file} 是基组件，不该被加 important 白底`,
    );
  }
});
