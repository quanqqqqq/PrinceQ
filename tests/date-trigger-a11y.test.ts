/**
 * 日期选择器触发器的键盘可访问性：静态源码断言。
 *
 * GoalDateField 与 TaskDateTimeField 的触发器都是 `<PopoverTrigger asChild>`
 * 包一个 `<Button>`，渲染出来是原生 `<button>`——可聚焦，Enter/Space 原生就会
 * 触发 click，Radix 的 PopoverTrigger 接着把弹层打开。所以这里要钉住的不是
 * "有没有写键盘处理"，恰恰相反：**不能**有自定义 onKeyDown 去 preventDefault
 * 掉 Enter/Space，否则会把原生 button 白送的键盘打开行为破坏掉。
 *
 * 仓库没有 DOM 测试环境（不引 jsdom / react 渲染），所以读源码文本做静态断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const componentsDir = path.resolve(here, '..', 'src', 'components');
const sourceOf = (file: string): string =>
  fs.readFileSync(path.join(componentsDir, file), 'utf8');

/** 两个日期控件共用同一套触发器结构，用同一组断言逐个过。 */
const FIELDS = [
  { file: 'GoalDateField.tsx', clearLabel: '清除目标日期', placeholder: '选择目标日期' },
  { file: 'TaskDateTimeField.tsx', clearLabel: '清除截止时间', placeholder: '选择截止时间' },
] as const;

/**
 * 取 `<PopoverTrigger asChild>` 到 `</PopoverTrigger>` 之间的那段源码。
 * 后续所有断言都只看这一段，免得把弹层里的 Input 当成触发器。
 */
function triggerBlock(source: string): string {
  const start = source.indexOf('<PopoverTrigger asChild>');
  assert.notEqual(start, -1, '触发器必须用 <PopoverTrigger asChild> 包裹');
  const end = source.indexOf('</PopoverTrigger>', start);
  assert.notEqual(end, -1, '<PopoverTrigger> 必须闭合');
  return source.slice(start, end);
}

for (const field of FIELDS) {
  test(`${field.file}: 触发器是 PopoverTrigger asChild 包的原生 button`, () => {
    const block = triggerBlock(sourceOf(field.file));

    // asChild + <Button> ⇒ 渲染成原生 <button>，自带 focus 与 Enter/Space 激活。
    assert.match(block, /<Button\b/, '触发器必须是 <Button>（渲染为原生 button）');
    // 显式 type="button"：它在表单里，默认的 submit 类型会误提交。
    assert.match(block, /type="button"/, '触发器必须显式 type="button"');
    // 没被换成 div/span 之类无语义容器。
    assert.doesNotMatch(
      block,
      /<(div|span)[^>]*\srole="button"[^>]*>\s*<CalendarIcon/,
      '触发器不能用 div/span + role=button 冒充按钮',
    );
  });

  test(`${field.file}: 触发器有可访问名`, () => {
    const block = triggerBlock(sourceOf(field.file));

    // 可访问名来自按钮内的展示文案 span：有值时是格式化日期，无值时是 placeholder。
    assert.match(block, /<span\b/, '触发器内必须有展示文案的 span 提供可访问名');
    const hasAccessibleName =
      block.includes('aria-label') || block.includes(field.placeholder);
    assert.ok(
      hasAccessibleName,
      `触发器必须有可访问名（aria-label 或展示文案 "${field.placeholder}"）`,
    );
  });

  test(`${field.file}: 触发器内没有自定义 onKeyDown 破坏 Enter/Space`, () => {
    const block = triggerBlock(sourceOf(field.file));

    // 关键断言：触发器这一段不能出现 onKeyDown。原生 button 的 Enter/Space →
    // click → PopoverTrigger 开弹层；任何自定义 keydown + preventDefault 都会
    // 把这条链路切断，键盘用户就打不开日历了。
    assert.doesNotMatch(block, /onKeyDown/, '触发器不能有自定义 onKeyDown');
  });

  test(`${field.file}: 清除按钮只吞点击，不抢键盘焦点`, () => {
    const block = triggerBlock(sourceOf(field.file));

    // 清除控件嵌在触发器内部：必须 stopPropagation（否则清值顺带开弹层），
    // 且 tabIndex={-1} 让 Tab 序列里只有外层那一个真按钮。
    assert.ok(
      block.includes(field.clearLabel),
      `清除控件必须有 aria-label="${field.clearLabel}"`,
    );
    assert.match(block, /stopPropagation\(\)/, '清除控件的点击必须 stopPropagation');
    assert.match(block, /tabIndex=\{-1\}/, '清除控件必须 tabIndex={-1}，不进 Tab 序列');
  });
}

test('键盘输入通道上的 onKeyDown 只在弹层里，不在触发器上', () => {
  // GoalDateField 弹层里那个手输日期的 Input 确实有 onKeyDown（Enter 提交），
  // 这是对的——它在 PopoverContent 内，跟触发器的键盘行为互不干扰。
  const source = sourceOf('GoalDateField.tsx');
  const contentStart = source.indexOf('<PopoverContent');
  assert.notEqual(contentStart, -1, 'GoalDateField 必须有 PopoverContent');
  assert.match(
    source.slice(contentStart),
    /onKeyDown/,
    '手输日期的 Input 的 Enter 提交应留在 PopoverContent 内',
  );
});
