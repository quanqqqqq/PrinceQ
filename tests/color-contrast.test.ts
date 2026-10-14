/**
 * UX-20：设计 token 的颜色对比度静态测试。
 *
 * 这里的 HSL/RGB 值与 src/tailwind-theme.css 里的 token 一一对应。
 * 普通正文 / 辅助文本要求 ≥4.5:1（WCAG AA）。任何把辅助灰调浅、或把关键信息
 * 交给低对比灰字的改动都会让这些断言失败——从而把对比度问题挡在合并前。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, contrastRatioHsl, hslToRgb, type Rgb } from '../shared/color-contrast.ts';

// ── 与 tailwind-theme.css 同步的 token ──────────────────────────────────────
const background = { h: 0, s: 0, l: 1 }; // hsl(0 0% 100%)
const card = { h: 0, s: 0, l: 1 }; // hsl(0 0% 100%)
const muted = { h: 220, s: 0.14, l: 0.96 }; // hsl(220 14% 96%)
const foreground = { h: 220, s: 0.14, l: 0.14 }; // hsl(220 14% 14%)
const mutedForeground = { h: 220, s: 0.09, l: 0.43 }; // hsl(220 9% 43%) ← UX-20 调深
const primary = { h: 221, s: 0.83, l: 0.53 }; // hsl(221 83% 53%)
const primaryForeground = { h: 220, s: 0.14, l: 0.98 }; // hsl(220 14% 98%)
const destructive = { h: 2, s: 0.84, l: 0.48 }; // hsl(2 84% 48%) ← UX-20 调深（原 62% 仅 3.5:1）

// Tailwind 固定色板（STATUS_CLASSES 用到的 pastel 状态色）。
const amber700: Rgb = { r: 180, g: 83, b: 9 }; // #b45309
const amber50: Rgb = { r: 255, g: 251, b: 235 }; // #fffbeb
const emerald700: Rgb = { r: 4, g: 120, b: 87 }; // #047857
const emerald50: Rgb = { r: 236, g: 253, b: 245 }; // #ecfdf5

const AA_NORMAL = 4.5;

test('辅助灰字（muted-foreground）在白底与浅灰底上都 ≥4.5:1', () => {
  const onWhite = contrastRatioHsl(mutedForeground, background);
  const onMuted = contrastRatioHsl(mutedForeground, muted);
  assert.ok(onWhite >= AA_NORMAL, `白底辅助灰 ${onWhite.toFixed(2)}:1 < 4.5`);
  assert.ok(onMuted >= AA_NORMAL, `浅灰底辅助灰 ${onMuted.toFixed(2)}:1 < 4.5`);
});

test('主正文（foreground）在卡片 / 页面背景上远超 4.5:1', () => {
  assert.ok(contrastRatioHsl(foreground, background) >= AA_NORMAL);
  assert.ok(contrastRatioHsl(foreground, card) >= AA_NORMAL);
});

test('主按钮：primary 文字在 primary 底色上 ≥4.5:1', () => {
  const ratio = contrastRatioHsl(primary, primaryForeground);
  assert.ok(ratio >= AA_NORMAL, `primary 按钮 ${ratio.toFixed(2)}:1 < 4.5`);
});

test('逾期/危险提示：destructive 在白底 ≥4.5:1', () => {
  assert.ok(contrastRatioHsl(destructive, background) >= AA_NORMAL);
});

test('状态色：受阻(amber-700 on amber-50) 与 完成(emerald-700 on emerald-50) ≥4.5:1', () => {
  assert.ok(
    contrastRatio(amber700, amber50) >= AA_NORMAL,
    `受阻状态 ${contrastRatio(amber700, amber50).toFixed(2)}:1 < 4.5`,
  );
  assert.ok(
    contrastRatio(emerald700, emerald50) >= AA_NORMAL,
    `完成状态 ${contrastRatio(emerald700, emerald50).toFixed(2)}:1 < 4.5`,
  );
});

test('对比度函数自洽：与浅色先后顺序无关、白对白=1', () => {
  const a = contrastRatioHsl(mutedForeground, background);
  const b = contrastRatioHsl(background, mutedForeground);
  assert.equal(Math.round(a * 100), Math.round(b * 100));
  assert.equal(Math.round(contrastRatioHsl(background, background) * 100), 100);
  void hslToRgb;
});

// ── 任务详情抽屉与「详情」入口（统一现有浅色 token） ────────────────────────
//
// TaskDetailDrawer 的 SheetContent 显式声明 bg-background / text-foreground /
// border-border，TaskCard 的「详情」按钮是 ghost + text-muted-foreground 落在
// bg-card 上。下面三条就是这三处实际用到的「文字 on 背景」组合——任何把抽屉底色
// 调深、或把这两处文字改成更浅的灰的改动，都会在这里失败。

test('详情抽屉：正文 foreground 在抽屉底色 background（白）上 ≥4.5:1', () => {
  const ratio = contrastRatioHsl(foreground, background);
  assert.ok(ratio >= AA_NORMAL, `抽屉正文 ${ratio.toFixed(2)}:1 < 4.5`);
});

test('详情抽屉：辅助说明文字 mutedForeground 在 background 上 ≥4.5:1', () => {
  const ratio = contrastRatioHsl(mutedForeground, background);
  assert.ok(ratio >= AA_NORMAL, `抽屉辅助文字 ${ratio.toFixed(2)}:1 < 4.5`);
});

test('「详情」按钮：mutedForeground 文字在卡片底色 card（白）上 ≥4.5:1', () => {
  const ratio = contrastRatioHsl(mutedForeground, card);
  assert.ok(ratio >= AA_NORMAL, `详情按钮文字 ${ratio.toFixed(2)}:1 < 4.5`);
});
