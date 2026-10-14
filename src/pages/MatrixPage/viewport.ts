/**
 * `/matrix` 散点图的视窗数学，与 React / ECharts 完全解耦，便于单测。
 *
 * 单一状态来源的约定：
 * - 坐标轴永远是 0..100，**不**随缩放改变 `min`/`max`；
 * - 缩放与平移完全由 `dataZoom` 表达，`Viewport` 就是 dataZoom 当前窗口；
 * - 因为轴恒为 0..100，dataZoom 的百分比 `start`/`end` 与数值
 *   `startValue`/`endValue` 在数轴上同值，两者可以互相回退。
 *
 * 这样就只有一处裁剪（dataZoom），不会出现轴 min/max 与 dataZoom 双重裁剪。
 */

/** 0..100 轴上的当前可见窗口。 */
export interface Viewport {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export const AXIS_MIN = 0;
export const AXIS_MAX = 100;

/** 完整视窗：dataZoom 处于 0%..100%。 */
export const FULL_VIEWPORT: Viewport = { xMin: 0, xMax: 100, yMin: 0, yMax: 100 };

/** 视窗最小跨度，避免无限放大。 */
export const MIN_SPAN = 4;

/** option 里每个 dataZoom 的固定 id，事件回传时用它判定所属轴。 */
export const DATA_ZOOM_IDS = {
  insideX: 'matrix-inside-x',
  insideY: 'matrix-inside-y',
  sliderX: 'matrix-slider-x',
  sliderY: 'matrix-slider-y',
} as const;

/** dataZoom 在 option 数组中的顺序，事件只带 index 时据此判定轴。 */
export const DATA_ZOOM_ORDER: readonly ('x' | 'y')[] = ['x', 'y', 'x', 'y'];

const X_IDS: readonly string[] = [DATA_ZOOM_IDS.insideX, DATA_ZOOM_IDS.sliderX];
const Y_IDS: readonly string[] = [DATA_ZOOM_IDS.insideY, DATA_ZOOM_IDS.sliderY];

/** 一个轴上的窗口。 */
export interface AxisWindow {
  min: number;
  max: number;
}

/** ECharts `dataZoom` 事件 / option 里与窗口有关的字段。 */
export interface DataZoomEntry {
  dataZoomId?: string;
  dataZoomIndex?: number;
  id?: string;
  start?: number;
  end?: number;
  startValue?: number;
  endValue?: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const clampToAxis = (value: number): number =>
  Math.min(AXIS_MAX, Math.max(AXIS_MIN, value));

/** 把一个轴窗口收进 0..100 并保证不小于 `MIN_SPAN`。 */
export function clampAxisWindow(window: AxisWindow): AxisWindow {
  let min = clampToAxis(Math.min(window.min, window.max));
  let max = clampToAxis(Math.max(window.min, window.max));
  if (max - min < MIN_SPAN) {
    const centre = (min + max) / 2;
    min = centre - MIN_SPAN / 2;
    max = centre + MIN_SPAN / 2;
    if (min < AXIS_MIN) {
      min = AXIS_MIN;
      max = AXIS_MIN + MIN_SPAN;
    }
    if (max > AXIS_MAX) {
      max = AXIS_MAX;
      min = AXIS_MAX - MIN_SPAN;
    }
  }
  return { min, max };
}

export function clampViewport(viewport: Viewport): Viewport {
  const x = clampAxisWindow({ min: viewport.xMin, max: viewport.xMax });
  const y = clampAxisWindow({ min: viewport.yMin, max: viewport.yMax });
  return { xMin: x.min, xMax: x.max, yMin: y.min, yMax: y.max };
}

/**
 * 以窗口内某个锚点按比例缩放（`factor < 1` 放大）。分值从不参与计算。
 *
 * `anchorFraction` 是锚点在当前窗口中的位置，0 对应 `min`、1 对应 `max`：
 * 按钮用 0.5（窗口中心），滚轮用鼠标所在的位置，这样指针下的那个点缩放前后
 * 留在原处。
 *
 * 碰到轴端点时**平移**窗口而不是截断它：在 90..100 上缩小一次应该得到完整的
 * 目标跨度（贴着 100 往左展开），而不是被切掉一半。
 */
export function zoomAxisWindowAt(
  window: AxisWindow,
  factor: number,
  anchorFraction: number,
): AxisWindow {
  const fraction = Math.min(1, Math.max(0, anchorFraction));
  const anchor = window.min + (window.max - window.min) * fraction;
  const span = Math.min(AXIS_MAX - AXIS_MIN, Math.max(MIN_SPAN, (window.max - window.min) * factor));
  let min = anchor - span * fraction;
  if (min < AXIS_MIN) min = AXIS_MIN;
  if (min + span > AXIS_MAX) min = AXIS_MAX - span;
  return clampAxisWindow({ min, max: min + span });
}

/** 以窗口中心缩放——放大/缩小按钮用的就是它。 */
export const zoomAxisWindow = (window: AxisWindow, factor: number): AxisWindow =>
  zoomAxisWindowAt(window, factor, 0.5);

/**
 * 绘图区内的缩放锚点，用绘图区的归一化坐标表示。
 *
 * `x` 自左向右、`y` 自**上**向下，和鼠标事件的 offset 一致；纵轴在屏幕上是倒
 * 过来的，换算放在 `zoomViewportAt` 里做。
 */
export interface ZoomAnchor {
  x: number;
  y: number;
}

/** 窗口中心，等价于放大/缩小按钮的行为。 */
export const CENTRE_ANCHOR: ZoomAnchor = { x: 0.5, y: 0.5 };

/** 两轴同步缩放，锚在绘图区的某一点上。 */
export function zoomViewportAt(
  viewport: Viewport,
  factor: number,
  anchor: ZoomAnchor,
): Viewport {
  const x = zoomAxisWindowAt({ min: viewport.xMin, max: viewport.xMax }, factor, anchor.x);
  // 屏幕 y 向下增大，数值轴向上增大，所以锚点要翻转。
  const y = zoomAxisWindowAt({ min: viewport.yMin, max: viewport.yMax }, factor, 1 - anchor.y);
  return { xMin: x.min, xMax: x.max, yMin: y.min, yMax: y.max };
}

/** 两轴同步缩放（以中心为锚点）。 */
export const zoomViewport = (viewport: Viewport, factor: number): Viewport =>
  zoomViewportAt(viewport, factor, CENTRE_ANCHOR);

export function isFullViewport(viewport: Viewport): boolean {
  return (
    viewport.xMin === FULL_VIEWPORT.xMin &&
    viewport.xMax === FULL_VIEWPORT.xMax &&
    viewport.yMin === FULL_VIEWPORT.yMin &&
    viewport.yMax === FULL_VIEWPORT.yMax
  );
}

export function viewportsEqual(a: Viewport, b: Viewport): boolean {
  return (
    a.xMin === b.xMin && a.xMax === b.xMax && a.yMin === b.yMin && a.yMax === b.yMax
  );
}

/** 一个候选对象是否像 dataZoom 条目（带任一窗口字段或定位字段）。 */
function toEntry(value: unknown): DataZoomEntry | null {
  if (value == null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const entry: DataZoomEntry = {};
  if (typeof record.dataZoomId === 'string') entry.dataZoomId = record.dataZoomId;
  if (typeof record.id === 'string') entry.id = record.id;
  if (isFiniteNumber(record.dataZoomIndex)) entry.dataZoomIndex = record.dataZoomIndex;
  if (isFiniteNumber(record.start)) entry.start = record.start;
  if (isFiniteNumber(record.end)) entry.end = record.end;
  if (isFiniteNumber(record.startValue)) entry.startValue = record.startValue;
  if (isFiniteNumber(record.endValue)) entry.endValue = record.endValue;
  const positioned =
    entry.dataZoomId != null || entry.id != null || entry.dataZoomIndex != null;
  const windowed =
    entry.start != null ||
    entry.end != null ||
    entry.startValue != null ||
    entry.endValue != null;
  return positioned || windowed ? entry : null;
}

/**
 * 归一化 `dataZoom` 事件载荷。
 *
 * ECharts 两种都会发：滚轮/拖拽多半是 `{ batch: [...] }`（一次事件里带上所有
 * 联动的 dataZoom），slider 拖动与 `dispatchAction` 则是单个对象。两种都要解析
 * 正确，否则缩放状态会丢。
 */
export function normalizeDataZoomEntries(payload: unknown): DataZoomEntry[] {
  if (payload == null || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.batch)) {
    return record.batch.flatMap((item) => {
      const entry = toEntry(item);
      return entry ? [entry] : [];
    });
  }
  const single = toEntry(record);
  return single ? [single] : [];
}

/** 条目属于哪个轴：先看 id，再退回 option 中的顺序。 */
export function axisOfEntry(entry: DataZoomEntry): 'x' | 'y' | null {
  const id = entry.dataZoomId ?? entry.id;
  if (id != null) {
    if (X_IDS.includes(id)) return 'x';
    if (Y_IDS.includes(id)) return 'y';
  }
  if (entry.dataZoomIndex != null) {
    return DATA_ZOOM_ORDER[entry.dataZoomIndex] ?? null;
  }
  return null;
}

/**
 * 从条目取出窗口。轴恒为 0..100，所以数值字段缺失时百分比可直接当数值用。
 * 两者都缺就返回 `null`，交给调用方沿用当前窗口。
 */
export function axisWindowFromEntry(entry: DataZoomEntry): AxisWindow | null {
  const min = entry.startValue ?? entry.start;
  const max = entry.endValue ?? entry.end;
  if (min == null && max == null) return null;
  return clampAxisWindow({ min: min ?? AXIS_MIN, max: max ?? AXIS_MAX });
}

/**
 * 把一批 dataZoom 条目应用到当前视窗上。
 *
 * 只覆盖条目明确给出的轴，其余轴沿用 `current`；因此 batch 里只带 x 的事件不会
 * 把 y 轴重置掉。
 */
export function applyDataZoomEntries(current: Viewport, entries: DataZoomEntry[]): Viewport {
  let x: AxisWindow = { min: current.xMin, max: current.xMax };
  let y: AxisWindow = { min: current.yMin, max: current.yMax };
  for (const entry of entries) {
    const axis = axisOfEntry(entry);
    if (axis == null) continue;
    const window = axisWindowFromEntry(entry);
    if (window == null) continue;
    if (axis === 'x') x = window;
    else y = window;
  }
  return clampViewport({ xMin: x.min, xMax: x.max, yMin: y.min, yMax: y.max });
}

/**
 * 从 `chart.getOption().dataZoom` 读出真实视窗。
 *
 * 这是缩放后的权威值：事件载荷可能只带变化的那一个 dataZoom，而 option 里四个
 * dataZoom 都是 ECharts 联动后的最终状态。
 */
export function viewportFromDataZoomOption(option: unknown, fallback: Viewport): Viewport {
  if (!Array.isArray(option)) return fallback;
  const entries = option.flatMap((item) => {
    const entry = toEntry(item);
    return entry ? [entry] : [];
  });
  return applyDataZoomEntries(fallback, entries);
}

/**
 * 容器量到这组宽高时，该不该 `echarts.init`。
 *
 * 唯一判据就是「两个方向都非零」：`echarts.init` 跑在 0×0 的节点上会建出一块
 * 永远没有宽高的画布——按钮、帮助都在，图区却空白且 console 不报错，之后再
 * `resize()` 也救不回来。所以 init 与否由真实尺寸决定，不猜时机、不用延时。
 *
 * 抽成纯函数是为了让同步测量（`useLayoutEffect` + `getBoundingClientRect`）与
 * 后续的 `ResizeObserver` 回调共用同一条判据，也便于单测直接覆盖边界。
 */
export function shouldInitChart(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return width > 0 && height > 0;
}

/** 把分值投影成绘图区内的像素坐标，用于屏幕距离聚合。 */
export function projectToPixel(
  score: number,
  min: number,
  max: number,
  sizePx: number,
): number {
  const span = max - min;
  if (span <= 0) return 0;
  return ((score - min) / span) * sizePx;
}

// ── 滚轮缩放 ────────────────────────────────────────────────────────────────

/**
 * 滚轮一次对应的缩放倍率，按指针位置缩放时用。
 *
 * 两件事必须做对，否则"一格滚到底"：
 *
 * 1. **归一化 `deltaMode`**：浏览器可能按像素（0）、按行（1）、按页（2）上报
 *    同一次滚动。先统一折算成像素级 `deltaY`（一行 ≈ 33px，一页 ≈ 120px），
 *    否则 Firefox 的行模式会比 Chrome 的像素模式慢几十倍。
 * 2. **指数平滑**：`factor = 2^(px / 400)`，即每累计 400px 恰好缩放一倍。普通
 *    滚轮一格约 100px ≈ 单次 1.19 倍率，触控板一次只有几像素，靠连续小 delta
 *    平滑累积逼近同样的手感，不会跳。
 *
 * 另外再钳一道 `[1/1.5, 1.5]`（见 `clampWheelFactor`）：某些触控板 / 鼠标驱动会
 * 一次性甩出上千像素的 delta，不钳住就一下缩到底。
 *
 * 向上滚（`px < 0`）放大（`factor < 1`），向下滚缩小（`factor > 1`）。
 */
export function wheelZoomFactor(deltaY: number, deltaMode: 0 | 1 | 2 = 0): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 120 : deltaY;
  return clampWheelFactor(Math.pow(2, px / 400));
}

/** 一次 wheel（或一帧内累乘出来的那一步）最多缩放多少倍。 */
export const WHEEL_FACTOR_MAX = 1.5;

/**
 * 把缩放倍率钳进 `[1/1.5, 1.5]`。
 *
 * 两处都要用：单次 `wheelZoomFactor`，以及调用方把同一帧里的多次 wheel 累乘成
 * 一步之后——否则一帧内攒下的乘积能突破单次上限，又变回"一长滚跳到底"。
 */
export const clampWheelFactor = (factor: number): number =>
  Math.min(WHEEL_FACTOR_MAX, Math.max(1 / WHEEL_FACTOR_MAX, factor));

/** 绘图区在容器内的内边距，用于把鼠标位置换算成归一化锚点。 */
export interface PlotInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 指针是否落在绘图区**内部**——两个方向都要落在留白之内才算。
 *
 * 这是缩放的两个必要条件之一（另一个是按住 Option/Alt，见 `shouldWheelZoom`）：
 * 落在外面（轴标签、两条 slider、容器留白）就一点都不碰，页面照常滚。边界本身
 * 不算绘图区，避免贴着轴线滚动时两种行为来回抖。
 */
export function isOffsetInsidePlot(
  offsetX: number,
  offsetY: number,
  size: { width: number; height: number },
  insets: PlotInsets,
): boolean {
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return false;
  return (
    offsetX > insets.left &&
    offsetX < size.width - insets.right &&
    offsetY > insets.top &&
    offsetY < size.height - insets.bottom
  );
}

/**
 * 把容器内的鼠标位置换算成绘图区的归一化锚点（0..1，超出则截断）。
 *
 * 截断而不是放弃：调用方已经用 `isOffsetInsidePlot` 判过指针在绘图区内，这里
 * 的截断只是对浮点误差与边界像素的兜底。
 */
export function plotAnchorFromOffset(
  offsetX: number,
  offsetY: number,
  size: { width: number; height: number },
  insets: PlotInsets,
): ZoomAnchor {
  const width = size.width - insets.left - insets.right;
  const height = size.height - insets.top - insets.bottom;
  const fraction = (offset: number, start: number, length: number): number =>
    length <= 0 ? 0.5 : Math.min(1, Math.max(0, (offset - start) / length));
  return {
    x: fraction(offsetX, insets.left, width),
    y: fraction(offsetY, insets.top, height),
  };
}

/**
 * Zoom only inside the plot with Command (metaKey) or Alt held.
 * Option/Alt stays compatible; an ordinary wheel is left to page scrolling.
 */
export function shouldWheelZoom(opts: {
  altKey: boolean;
  metaKey?: boolean;
  insidePlot: boolean;
}): boolean {
  return (opts.metaKey === true || opts.altKey) && opts.insidePlot;
}
