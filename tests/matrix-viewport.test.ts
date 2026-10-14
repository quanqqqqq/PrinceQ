/**
 * Unit tests for the scatter chart's single zoom state: axis windows stay
 * inside 0..100, the button/reset maths, and — the bug this module exists for —
 * parsing ECharts' `dataZoom` payload in both its shapes (`{ batch: [...] }`
 * and a single object) plus reading the real window back from the option.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AXIS_MAX,
  AXIS_MIN,
  DATA_ZOOM_IDS,
  FULL_VIEWPORT,
  MIN_SPAN,
  applyDataZoomEntries,
  axisOfEntry,
  axisWindowFromEntry,
  clampAxisWindow,
  clampViewport,
  clampWheelFactor,
  isFullViewport,
  isOffsetInsidePlot,
  normalizeDataZoomEntries,
  projectToPixel,
  shouldInitChart,
  shouldWheelZoom,
  viewportFromDataZoomOption,
  viewportsEqual,
  wheelZoomFactor,
  zoomAxisWindow,
  zoomViewport,
  type Viewport,
} from '../src/pages/MatrixPage/viewport.ts';

test('the full viewport is exactly the 0..100 axis', () => {
  assert.deepEqual(FULL_VIEWPORT, { xMin: 0, xMax: 100, yMin: 0, yMax: 100 });
  assert.equal(AXIS_MIN, 0);
  assert.equal(AXIS_MAX, 100);
  assert.ok(isFullViewport(FULL_VIEWPORT));
  assert.ok(!isFullViewport({ xMin: 10, xMax: 100, yMin: 0, yMax: 100 }));
});

test('clampAxisWindow keeps the window inside the axis', () => {
  assert.deepEqual(clampAxisWindow({ min: -30, max: 160 }), { min: 0, max: 100 });
  assert.deepEqual(clampAxisWindow({ min: 20, max: 60 }), { min: 20, max: 60 });
});

test('clampAxisWindow normalises a reversed window', () => {
  assert.deepEqual(clampAxisWindow({ min: 80, max: 20 }), { min: 20, max: 80 });
});

test('clampAxisWindow enforces the minimum span', () => {
  const window = clampAxisWindow({ min: 50, max: 50 });
  assert.equal(window.max - window.min, MIN_SPAN);
  assert.deepEqual(window, { min: 50 - MIN_SPAN / 2, max: 50 + MIN_SPAN / 2 });
});

test('clampAxisWindow pushes a too-small window at the edges inward', () => {
  assert.deepEqual(clampAxisWindow({ min: 0, max: 0 }), { min: 0, max: MIN_SPAN });
  assert.deepEqual(clampAxisWindow({ min: 100, max: 100 }), { min: 100 - MIN_SPAN, max: 100 });
});

test('zoomAxisWindow zooms around the centre', () => {
  assert.deepEqual(zoomAxisWindow({ min: 0, max: 100 }, 0.6), { min: 20, max: 80 });
  assert.deepEqual(zoomAxisWindow({ min: 20, max: 80 }, 0.5), { min: 35, max: 65 });
});

test('zoomAxisWindow clamps a zoom-out back to the full axis', () => {
  assert.deepEqual(zoomAxisWindow({ min: 20, max: 80 }, 10), { min: 0, max: 100 });
});

test('zoomAxisWindow never shrinks below the minimum span', () => {
  const window = zoomAxisWindow({ min: 48, max: 52 }, 0.01);
  assert.equal(window.max - window.min, MIN_SPAN);
});

test('zoomAxisWindow keeps an off-centre window inside the axis', () => {
  const window = zoomAxisWindow({ min: 90, max: 100 }, 4);
  assert.ok(window.min >= 0 && window.max <= 100);
  assert.equal(window.max - window.min, 40);
});

test('zoomViewport zooms both axes together', () => {
  assert.deepEqual(zoomViewport(FULL_VIEWPORT, 0.6), {
    xMin: 20,
    xMax: 80,
    yMin: 20,
    yMax: 80,
  });
});

test('zooming in then out by the inverse factor returns to the full viewport', () => {
  const zoomedIn = zoomViewport(FULL_VIEWPORT, 0.6);
  assert.deepEqual(zoomViewport(zoomedIn, 1 / 0.6), FULL_VIEWPORT);
});

test('clampViewport clamps both axes', () => {
  assert.deepEqual(clampViewport({ xMin: -5, xMax: 120, yMin: 70, yMax: 30 }), {
    xMin: 0,
    xMax: 100,
    yMin: 30,
    yMax: 70,
  });
});

test('viewportsEqual compares every edge', () => {
  assert.ok(viewportsEqual(FULL_VIEWPORT, { ...FULL_VIEWPORT }));
  assert.ok(!viewportsEqual(FULL_VIEWPORT, { ...FULL_VIEWPORT, yMax: 99 }));
});

// ── dataZoom payload parsing ────────────────────────────────────────────────

test('normalizeDataZoomEntries reads the batch form', () => {
  const entries = normalizeDataZoomEntries({
    type: 'datazoom',
    batch: [
      { dataZoomId: DATA_ZOOM_IDS.insideX, start: 10, end: 40 },
      { dataZoomId: DATA_ZOOM_IDS.insideY, start: 20, end: 60 },
    ],
  });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].dataZoomId, DATA_ZOOM_IDS.insideX);
  assert.equal(entries[1].end, 60);
});

test('normalizeDataZoomEntries reads the single-object form', () => {
  const entries = normalizeDataZoomEntries({
    type: 'datazoom',
    dataZoomId: DATA_ZOOM_IDS.sliderX,
    start: 25,
    end: 75,
  });
  assert.deepEqual(entries, [{ dataZoomId: DATA_ZOOM_IDS.sliderX, start: 25, end: 75 }]);
});

test('normalizeDataZoomEntries tolerates junk payloads', () => {
  assert.deepEqual(normalizeDataZoomEntries(null), []);
  assert.deepEqual(normalizeDataZoomEntries(undefined), []);
  assert.deepEqual(normalizeDataZoomEntries('datazoom'), []);
  assert.deepEqual(normalizeDataZoomEntries({ type: 'datazoom' }), []);
  assert.deepEqual(normalizeDataZoomEntries({ batch: [null, 7, {}] }), []);
});

test('normalizeDataZoomEntries drops non-finite window numbers', () => {
  const [entry] = normalizeDataZoomEntries({
    dataZoomId: DATA_ZOOM_IDS.insideX,
    start: Number.NaN,
    end: 50,
  });
  assert.equal(entry.start, undefined);
  assert.equal(entry.end, 50);
});

test('axisOfEntry resolves by id for inside and slider zooms', () => {
  assert.equal(axisOfEntry({ dataZoomId: DATA_ZOOM_IDS.insideX }), 'x');
  assert.equal(axisOfEntry({ dataZoomId: DATA_ZOOM_IDS.sliderX }), 'x');
  assert.equal(axisOfEntry({ dataZoomId: DATA_ZOOM_IDS.insideY }), 'y');
  assert.equal(axisOfEntry({ dataZoomId: DATA_ZOOM_IDS.sliderY }), 'y');
  assert.equal(axisOfEntry({ id: DATA_ZOOM_IDS.sliderY }), 'y');
});

test('axisOfEntry falls back to the dataZoom index order', () => {
  assert.equal(axisOfEntry({ dataZoomIndex: 0 }), 'x');
  assert.equal(axisOfEntry({ dataZoomIndex: 1 }), 'y');
  assert.equal(axisOfEntry({ dataZoomIndex: 2 }), 'x');
  assert.equal(axisOfEntry({ dataZoomIndex: 3 }), 'y');
  assert.equal(axisOfEntry({ dataZoomIndex: 9 }), null);
  assert.equal(axisOfEntry({ start: 0, end: 10 }), null);
});

test('axisWindowFromEntry prefers the explicit values', () => {
  assert.deepEqual(
    axisWindowFromEntry({ start: 10, end: 90, startValue: 30, endValue: 70 }),
    { min: 30, max: 70 },
  );
});

test('axisWindowFromEntry treats percentages as values on the 0..100 axis', () => {
  assert.deepEqual(axisWindowFromEntry({ start: 25, end: 75 }), { min: 25, max: 75 });
});

test('axisWindowFromEntry fills a missing edge from the axis bounds', () => {
  assert.deepEqual(axisWindowFromEntry({ end: 40 }), { min: 0, max: 40 });
  assert.deepEqual(axisWindowFromEntry({ start: 60 }), { min: 60, max: 100 });
  assert.equal(axisWindowFromEntry({ dataZoomId: DATA_ZOOM_IDS.insideX }), null);
});

test('applyDataZoomEntries only touches the axes the payload mentions', () => {
  const current: Viewport = { xMin: 10, xMax: 90, yMin: 30, yMax: 70 };
  const next = applyDataZoomEntries(current, [
    { dataZoomId: DATA_ZOOM_IDS.insideX, start: 40, end: 60 },
  ]);
  assert.deepEqual(next, { xMin: 40, xMax: 60, yMin: 30, yMax: 70 });
});

test('applyDataZoomEntries handles a two-axis wheel batch', () => {
  const entries = normalizeDataZoomEntries({
    batch: [
      { dataZoomId: DATA_ZOOM_IDS.insideX, start: 30, end: 70 },
      { dataZoomId: DATA_ZOOM_IDS.insideY, start: 35, end: 65 },
    ],
  });
  assert.deepEqual(applyDataZoomEntries(FULL_VIEWPORT, entries), {
    xMin: 30,
    xMax: 70,
    yMin: 35,
    yMax: 65,
  });
});

test('applyDataZoomEntries clamps what the chart reports', () => {
  const next = applyDataZoomEntries(FULL_VIEWPORT, [
    { dataZoomId: DATA_ZOOM_IDS.insideX, start: -10, end: 130 },
    { dataZoomId: DATA_ZOOM_IDS.insideY, start: 50, end: 50 },
  ]);
  assert.deepEqual(next.xMin, 0);
  assert.deepEqual(next.xMax, 100);
  assert.equal(next.yMax - next.yMin, MIN_SPAN);
});

test('applyDataZoomEntries ignores entries it cannot place', () => {
  const current: Viewport = { xMin: 10, xMax: 90, yMin: 30, yMax: 70 };
  assert.deepEqual(applyDataZoomEntries(current, [{ start: 0, end: 5 }]), current);
});

test('the last entry for an axis wins', () => {
  const next = applyDataZoomEntries(FULL_VIEWPORT, [
    { dataZoomId: DATA_ZOOM_IDS.insideX, start: 10, end: 20 },
    { dataZoomId: DATA_ZOOM_IDS.sliderX, start: 60, end: 80 },
  ]);
  assert.deepEqual(next, { xMin: 60, xMax: 80, yMin: 0, yMax: 100 });
});

test('viewportFromDataZoomOption reads the real window off the option', () => {
  const option = [
    { id: DATA_ZOOM_IDS.insideX, start: 20, end: 80 },
    { id: DATA_ZOOM_IDS.insideY, start: 25, end: 75 },
    { id: DATA_ZOOM_IDS.sliderX, start: 20, end: 80 },
    { id: DATA_ZOOM_IDS.sliderY, start: 25, end: 75 },
  ];
  assert.deepEqual(viewportFromDataZoomOption(option, FULL_VIEWPORT), {
    xMin: 20,
    xMax: 80,
    yMin: 25,
    yMax: 75,
  });
});

test('viewportFromDataZoomOption falls back when the option is missing', () => {
  const fallback: Viewport = { xMin: 5, xMax: 95, yMin: 5, yMax: 95 };
  assert.deepEqual(viewportFromDataZoomOption(undefined, fallback), fallback);
  assert.deepEqual(viewportFromDataZoomOption([], fallback), fallback);
});

// ── pixel projection (clustering input) ─────────────────────────────────────

test('projectToPixel maps the window onto the plot width', () => {
  assert.equal(projectToPixel(0, 0, 100, 800), 0);
  assert.equal(projectToPixel(50, 0, 100, 800), 400);
  assert.equal(projectToPixel(100, 0, 100, 800), 800);
});

test('a zoomed window spreads nearby scores further apart on screen', () => {
  const wide = projectToPixel(52, 0, 100, 800) - projectToPixel(50, 0, 100, 800);
  const tight = projectToPixel(52, 40, 60, 800) - projectToPixel(50, 40, 60, 800);
  assert.ok(tight > wide, `expected ${tight} > ${wide}`);
});

test('projectToPixel is defensive about a degenerate window', () => {
  assert.equal(projectToPixel(50, 50, 50, 800), 0);
});

// ── init 判据：容器量到的宽高 ───────────────────────────────────────────────

test('shouldInitChart only inits once both dimensions are non-zero', () => {
  // 真实布局：init。
  assert.equal(shouldInitChart(900, 460), true);
  // 亚像素宽高也算真实尺寸——容器确实被布局了。
  assert.equal(shouldInitChart(0.5, 0.5), true);
});

test('shouldInitChart refuses a 0×0 container (the blank-plot root cause)', () => {
  // `echarts.init` 跑在这三种尺寸上都会建出永远没有宽高的画布。
  assert.equal(shouldInitChart(0, 0), false);
  // 手机页签 display:none：两个方向都是 0；只缺一个方向同样不 init。
  assert.equal(shouldInitChart(900, 0), false);
  assert.equal(shouldInitChart(0, 460), false);
});

test('shouldInitChart treats negative and non-finite sizes as not ready', () => {
  assert.equal(shouldInitChart(-10, 460), false);
  assert.equal(shouldInitChart(Number.NaN, 460), false);
  assert.equal(shouldInitChart(900, Number.NaN), false);
  assert.equal(shouldInitChart(Number.POSITIVE_INFINITY, 460), false);
});

// ── 滚轮：哪里算"图上"，一格滚多少 ──────────────────────────────────────────

/** 与 `MatrixScatter` 的 `GRID` 和 `CHART_HEIGHT` 一致的一组真实几何。 */
const SIZE = { width: 900, height: 460 };
const INSETS = { left: 58, right: 54, top: 24, bottom: 78 };

const inside = (x: number, y: number): boolean => isOffsetInsidePlot(x, y, SIZE, INSETS);

test('isOffsetInsidePlot accepts the plot area itself', () => {
  // 绘图区中心：唯一该缩放的区域。
  assert.ok(inside(SIZE.width / 2, SIZE.height / 2));
  // 紧贴四边之内也算。
  assert.ok(inside(INSETS.left + 1, INSETS.top + 1));
  assert.ok(inside(SIZE.width - INSETS.right - 1, SIZE.height - INSETS.bottom - 1));
});

test('isOffsetInsidePlot rejects the axis labels, sliders and padding', () => {
  // 左侧纵轴标签与轴名。
  assert.ok(!inside(20, SIZE.height / 2));
  // 底部横轴标签。
  assert.ok(!inside(SIZE.width / 2, SIZE.height - INSETS.bottom + 20));
  // 底部 slider 条（bottom 余量内，贴着容器下沿）。
  assert.ok(!inside(SIZE.width / 2, SIZE.height - 10));
  // 右侧 slider 条。
  assert.ok(!inside(SIZE.width - 10, SIZE.height / 2));
  // 顶部留白。
  assert.ok(!inside(SIZE.width / 2, 10));
});

test('isOffsetInsidePlot excludes the boundary itself and anything outside', () => {
  // 边界像素不算绘图区，避免贴着轴线滚动时两种行为来回抖。
  assert.ok(!inside(INSETS.left, SIZE.height / 2));
  assert.ok(!inside(SIZE.width - INSETS.right, SIZE.height / 2));
  assert.ok(!inside(SIZE.width / 2, INSETS.top));
  assert.ok(!inside(SIZE.width / 2, SIZE.height - INSETS.bottom));
  // 容器之外（指针已经离开图）。
  assert.ok(!inside(-5, SIZE.height / 2));
  assert.ok(!inside(SIZE.width + 5, SIZE.height / 2));
  assert.ok(!inside(SIZE.width / 2, -5));
  assert.ok(!inside(SIZE.width / 2, SIZE.height + 5));
  // 非有限坐标一律当作图外。
  assert.ok(!inside(Number.NaN, SIZE.height / 2));
});

test('wheelZoomFactor zooms in on scroll up and out on scroll down', () => {
  // factor = 2^(px/400)：向上滚放大（<1），向下滚缩小（>1）。
  assert.ok(Math.abs(wheelZoomFactor(-100) - 0.8409) < 1e-4);
  assert.ok(Math.abs(wheelZoomFactor(100) - 1.1892) < 1e-4);
});

test('wheelZoomFactor normalises line and page delta modes', () => {
  // 行模式一行 ≈ 33px，所以 3 行等价于像素模式的 99px。
  assert.equal(wheelZoomFactor(3, 1), wheelZoomFactor(99, 0));
  // 页模式一页 ≈ 120px。
  assert.equal(wheelZoomFactor(1, 2), wheelZoomFactor(120, 0));
  // 同一次滚动在行模式下绝不能比像素模式慢几十倍（Firefox 的老问题）。
  assert.ok(wheelZoomFactor(3, 1) > wheelZoomFactor(3, 0));
});

test('wheelZoomFactor clamps a runaway delta', () => {
  // 某些触控板驱动一次甩出上千像素，不钳住就一下缩到底。
  assert.ok(wheelZoomFactor(2000) <= 1.5);
  assert.equal(wheelZoomFactor(2000), 1.5);
  assert.equal(wheelZoomFactor(-2000), 1 / 1.5);
});

test('wheelZoomFactor is a no-op for a zero or non-finite delta', () => {
  assert.equal(wheelZoomFactor(0), 1);
  assert.equal(wheelZoomFactor(Number.NaN), 1);
  assert.equal(wheelZoomFactor(Number.POSITIVE_INFINITY), 1);
});

test('wheelZoomFactor stays gentle for a trackpad-sized delta', () => {
  // 触控板一次只有几像素，必须是极小的一步，靠连续事件平滑累积。
  const factor = wheelZoomFactor(5);
  assert.ok(factor > 1 && factor < 1.02, `expected 1 < ${factor} < 1.02`);
});

// ── 滚轮缩放的两个必要条件：Option/Alt + 指针在图内 ─────────────────────────

test('shouldWheelZoom zooms only with Option/Alt held inside the plot', () => {
  assert.equal(shouldWheelZoom({ altKey: true, insidePlot: true }), true);
});

test('shouldWheelZoom leaves a plain wheel alone even on the plot', () => {
  // 这是本次改造的核心：不按修饰键时图表绝不拦滚轮，页面照常翻页。
  assert.equal(shouldWheelZoom({ altKey: false, insidePlot: true }), false);
});

test('shouldWheelZoom refuses to zoom outside the plot area', () => {
  // 轴标签、两条 slider、容器留白：按着 Option 也不缩放。
  assert.equal(shouldWheelZoom({ altKey: true, insidePlot: false }), false);
  assert.equal(shouldWheelZoom({ altKey: false, insidePlot: false }), false);
});

test('clampWheelFactor bounds a frame-coalesced product to one step', () => {
  // rAF 合帧会把同一帧里的多次 wheel 累乘，乘积必须仍钳在单步上限内，
  // 否则一长滚攒出的倍率会突破 wheelZoomFactor 的钳制又跳变回去。
  const product = wheelZoomFactor(100) ** 5;
  assert.ok(product > 1.5, `expected the raw product ${product} to exceed one step`);
  assert.equal(clampWheelFactor(product), 1.5);
  assert.equal(clampWheelFactor(wheelZoomFactor(-100) ** 5), 1 / 1.5);
  // 帧内只来了一次小 delta 时不该被改动。
  assert.equal(clampWheelFactor(wheelZoomFactor(5)), wheelZoomFactor(5));
  // 没有任何有效 wheel 的那一帧是精确的 1（调用方据此跳过 setViewport）。
  assert.equal(clampWheelFactor(1), 1);
});
