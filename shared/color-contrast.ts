/**
 * WCAG 2.x 相对亮度与对比度的纯函数实现（UX-20）。
 *
 * 把设计 token（HSL）转成 sRGB，再按 W3C 公式算相对亮度与对比度比。
 * 不依赖浏览器 / canvas，可在 node:test 里直接对 token 做静态断言，
 * 保证「普通正文 / 辅助文本」在其背景上的实际对比度达标。
 *
 * 参考：https://www.w3.org/WAI/GL/wiki/Relative_luminance
 */

export interface Rgb {
  /** 0..255，sRGB 通道。 */
  r: number;
  g: number;
  b: number;
}

/** CSS `hsl(H S% L%)` 的分量。 */
export interface Hsl {
  h: number; // 0..360
  s: number; // 0..1
  l: number; // 0..1
}

/** HSL → sRGB(0..255)。与 CSS `hsl()` 同语义。 */
export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/** 单个 sRGB 通道（0..255）→ 线性光（0..1）。 */
export function channelToLinear(channel255: number): number {
  const c = channel255 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 相对亮度 Y（0..1）。 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

/**
 * 两个颜色的对比度比（1..21）。
 *
 * 浅色在前、深色在后都能得到同一结果（公式已取 max/min）。
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const ya = relativeLuminance(a);
  const yb = relativeLuminance(b);
  const lighter = Math.max(ya, yb);
  const darker = Math.min(ya, yb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * 便捷重载：直接给两个 HSL，返回对比度比。
 */
export function contrastRatioHsl(a: Hsl, b: Hsl): number {
  return contrastRatio(hslToRgb(a), hslToRgb(b));
}
