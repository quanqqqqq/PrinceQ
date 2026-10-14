/**
 * 守住 `/matrix` 操作说明的文案与实际手势一致这条回归。
 *
 * MatrixScatter 的滚轮分工看 **修饰键 + 指针位置**：只有按住 Command（Mac）/
 * Alt（Windows）且指针落在绘图区内才吃掉事件按指针缩放，不按修饰键的普通滚轮
 * 一律只是翻页——哪怕指针就停在图上。文案一度写成「在图上直接滚动即可缩放」，
 * 照着做会以为图表坏了。
 *
 * 文案没有纯函数可测，这里静态读源码断言：两处提示都把 Command / Alt 写成必需
 * 条件，且不再出现「不按键就能缩放」的说法。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const matrixDir = path.resolve(here, '..', 'src', 'pages', 'MatrixPage');

/** 源码里的「说明文案」部分：剥掉块注释，只留真正渲染给用户的字符串。 */
const copyOf = (file: string): string =>
  fs.readFileSync(path.join(matrixDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('帮助弹窗把 Command / Alt 写成滚轮缩放的必需修饰键', () => {
  const copy = copyOf('MatrixHelpDialog.tsx');
  assert.match(copy, /Command/, '文案应点明 Mac 的 Command 键');
  assert.match(copy, /Alt/, '文案应点明 Windows 的 Alt 键');
  // 「按住 Command / Alt 再滚动」正是现在要求的说法。
  assert.match(copy, /按住 Command \/ Alt 再/, '应写成「按住 Command / Alt 再滚动」');
});

test('帮助弹窗不再声称不按修饰键也能缩放', () => {
  const copy = copyOf('MatrixHelpDialog.tsx');
  assert.doesNotMatch(copy, /直接滚动/, '不应再说「直接滚动」就能缩放');
  assert.doesNotMatch(copy, /不用配合任何按键/, '不应再说不需要按键');
  assert.doesNotMatch(copy, /只看指针位置/, '缩放不再只取决于指针位置');
});

test('帮助弹窗讲清了需按住修饰键缩放、普通滚轮翻页', () => {
  const copy = copyOf('MatrixHelpDialog.tsx');
  assert.match(copy, /绘图区内/, '应点明还要「绘图区内」才缩放');
  assert.match(copy, /指针位置缩放/, '应点明按指针位置缩放');
  assert.match(copy, /翻页/, '应说明不按修饰键时是正常翻页');
  // 既有的平移 / 滑块 / 重置说明不能在改文案时被顺手删掉。
  assert.match(copy, /按住拖动即可平移/, '平移说明应保留');
  assert.match(copy, /「重置」回到完整的 0\.\.100 视图/, '重置说明应保留');
  assert.match(copy, /两条滑块可单独缩放某一轴/, '滑块说明应保留');
});

test('帮助弹窗给出触屏兜底：没有键盘修饰键就用按钮 / 滑块 / 重置', () => {
  const copy = copyOf('MatrixHelpDialog.tsx');
  assert.match(copy, /触屏/, '应有触屏说明');
  assert.match(copy, /没有键盘修饰键/, '应说明触屏没有键盘修饰键');
  assert.match(copy, /「放大」「缩小」按钮/, '应指向头部的放大 / 缩小按钮');
  assert.match(copy, /窄屏同样可见可点/, '应说明这些控件在窄屏可用');
});

test('图头部的短提示同样强调 Command / Alt', () => {
  const copy = copyOf('MatrixScatter.tsx');
  // 短提示那一行：按住修饰键才缩放，普通滚动翻页，触屏用按钮。
  assert.match(
    copy,
    /按住 Command（Mac）\/ Alt（Windows）再滚动滚轮，可按指针缩放双轴；普通滚动即翻页。/,
  );
  // 不得残留「在图上直接滚动滚轮…即可缩放」这种不按键就缩放的说法。
  assert.doesNotMatch(copy, /直接滚动滚轮/);
});
