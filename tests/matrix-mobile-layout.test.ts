/**
 * Static / component-semantics tests for the `/matrix` responsive layout helper.
 *
 * These pin down the decisions the phone view makes without a browser:
 * - the fixed quadrant order shared by the tabs, the list and the stats row;
 * - which quadrant a phone user lands on by default (the busiest one, so the
 *   list is never empty on first paint);
 * - and, read straight off the source, that the chart wrapper toggles
 *   hidden/block, that MatrixScatter drives ECharts imperatively (`echarts.init`
 *   / `setOption` / `dispose`, no `echarts-for-react`) from a *synchronous*
 *   `useLayoutEffect` measurement rather than waiting on the ResizeObserver
 *   callback (waiting deadlocked a hard refresh: the init depended on a callback
 *   that only fires once something is mounted, so the plot stayed blank with
 *   zero canvases and no console error), and that it re-measures the canvas when
 *   the container goes from `display:none` back to a real size.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Quadrant } from '@shared/types';
import {
  QUADRANT_ORDER,
  pickDefaultQuadrant,
} from '../src/pages/MatrixPage/layout.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const matrixDir = path.resolve(here, '..', 'src', 'pages', 'MatrixPage');
const sourceOf = (file: string): string =>
  fs.readFileSync(path.join(matrixDir, file), 'utf8');

test('the quadrant order is the four quadrants in the Eisenhower sequence', () => {
  assert.deepEqual(QUADRANT_ORDER, ['q1', 'q2', 'q3', 'q4']);
});

test('pickDefaultQuadrant lands on the busiest quadrant', () => {
  const counts: Record<Quadrant, number> = { q1: 2, q2: 9, q3: 1, q4: 0 };
  assert.equal(pickDefaultQuadrant(counts), 'q2');
});

test('pickDefaultQuadrant falls back to q1 when everything is empty', () => {
  assert.equal(pickDefaultQuadrant({ q1: 0, q2: 0, q3: 0, q4: 0 }), 'q1');
});

test('pickDefaultQuadrant keeps the first quadrant on an exact tie (stable choice)', () => {
  const counts: Record<Quadrant, number> = { q1: 4, q2: 4, q3: 0, q4: 0 };
  // q1 beats q2 only because it is visited first in QUADRANT_ORDER — the tie is stable.
  assert.equal(pickDefaultQuadrant(counts), 'q1');
});

/**
 * 手机「分布图」页签：外层用 hidden/block 切换，所以图表容器会从
 * `display:none` 变回可见，ECharts 必须在那一刻重新量一次画布，否则 canvas
 * 停在 0×0。没有 DOM 测试框架，这里静态读源码守住这条保护。
 */
test('the chart wrapper toggles between hidden and block on phones', () => {
  const page = sourceOf('MatrixPage.tsx');
  assert.match(page, /mobileView === 'chart' \? 'block' : 'hidden'/);
});

test('MatrixScatter resizes echarts once the container becomes visible again', () => {
  const scatter = sourceOf('MatrixScatter.tsx');
  assert.match(scatter, /new ResizeObserver/, '后续尺寸变化靠 ResizeObserver 跟踪');
  // 0 尺寸（隐藏）与非 0 尺寸（可见）必须分开处理。
  assert.match(scatter, /shouldInitChart\(width, height\)/, '要判断容器是否真的有尺寸');
  // 实例已在时，尺寸变化要落到画布上。
  assert.match(scatter, /inst\.resize\(\)/, '尺寸变化时应调用 echarts resize()');
  // 这条兜底必须是尺寸驱动的，不能退化成「等一会儿再 resize」的猜时机写法。
  // 匹配调用而非散文：注释里提到 setTimeout 没问题，真调用才算回退。
  assert.doesNotMatch(scatter, /setTimeout\s*\(/, 'resize 时机不能用 setTimeout 猜');
});

/**
 * 图区空白（按钮/帮助都在，但 `document.querySelectorAll('canvas').length === 0`
 * 且 console 不报错）的根因是 `echarts.init` 跑在 0×0 的容器上。修法是先同步量
 * 容器，够尺寸才 init。
 */
test('图表容器带上可供验收的 testid', () => {
  const scatter = sourceOf('MatrixScatter.tsx');
  assert.match(scatter, /data-testid="matrix-plot"/, '图表容器应带 data-testid="matrix-plot"');
});

/**
 * 图表是命令式用的：`echarts.init` / `setOption` / `dispose` 全由组件自己调，
 * 不经 `echarts-for-react`。那层包装把 init 的时机交给 React 的渲染节奏，而
 * init 必须发生在已经量到非零宽高的节点上。
 */
test('MatrixScatter 直接命令式用 ECharts，不经 echarts-for-react', () => {
  const scatter = sourceOf('MatrixScatter.tsx');
  assert.match(scatter, /import \* as echarts from 'echarts'/, '应直接引入 echarts');
  // 包装库与它的 ref/props 一个都不该残留。匹配真实 import 而非散文：注释里
  // 解释「为什么不用它」是对的，真 import 才算回退。
  assert.doesNotMatch(scatter, /from 'echarts-for-react'/, '不应再 import echarts-for-react');
  assert.doesNotMatch(scatter, /<ReactECharts/, 'JSX 里不应再有 ReactECharts');
  assert.doesNotMatch(scatter, /getEchartsInstance/, '不应再走包装库的实例取法');
  assert.doesNotMatch(scatter, /onChartReady/, 'onChartReady 是包装库的半成品钩子，应删掉');
  // 宿主节点与实例各自一个 ref。
  assert.match(
    scatter,
    /const hostRef = useRef<HTMLDivElement>\(null\)/,
    '应有宿主节点的 hostRef',
  );
  assert.match(
    scatter,
    /const instRef = useRef<echarts\.ECharts \| null>\(null\)/,
    '应有实例的 instRef',
  );
  // 宿主 div 由 React 渲染，但不往里塞子节点——ECharts 自己接管内容。
  assert.match(
    scatter,
    /<div\s+ref=\{hostRef\}[\s\S]{0,300}?\/>/,
    '宿主应是一个自闭合的 div ref={hostRef}',
  );
});

test('MatrixScatter 在宿主节点上 init canvas 渲染器并整份 setOption', () => {
  const scatter = sourceOf('MatrixScatter.tsx');
  // init 挂在量过尺寸的宿主节点上，显式指定 canvas 渲染器。
  assert.match(
    scatter,
    /echarts\.init\(host, undefined, \{ renderer: 'canvas' \}\)/,
    "应 echarts.init(host, …, { renderer: 'canvas' })",
  );
  // 整份替换而非增量合并：视窗、散点、标注开关都在同一份 option 里。
  assert.match(scatter, /setOption\(optionRef\.current, true\)/, 'init 后应整份 setOption');
  assert.match(
    scatter,
    /instRef\.current\?\.setOption\(option, true\)/,
    'option 变化时应整份 setOption(option, true)',
  );
  // 卸载必须 dispose，否则换 key 重挂时旧画布与监听器会泄漏。
  assert.match(scatter, /inst\.dispose\(\)/, 'cleanup 里应 dispose() 实例');
});

test('MatrixScatter 命令式注册五类图上事件', () => {
  const scatter = sourceOf('MatrixScatter.tsx');
  assert.match(scatter, /inst\.on\('click'/, '应注册 click');
  assert.match(scatter, /inst\.on\('mouseover'/, '应注册 mouseover');
  assert.match(scatter, /inst\.on\('mouseout'/, '应注册 mouseout');
  assert.match(scatter, /inst\.on\('globalout'/, '应注册 globalout');
  assert.match(scatter, /inst\.on\('dataZoom'/, '应注册 dataZoom');
  // dataZoom 回写要读实例自己的 option，那是 ECharts 联动后的真实视窗。
  assert.match(
    scatter,
    /instRef\.current\?\.getOption\(\)/,
    'dataZoom 回写应读 instRef.current.getOption()',
  );
});

/**
 * 死锁的回归守卫：上一版只在 ResizeObserver 回调里置可见，于是「init 等回调、
 * 回调等 init」，硬刷新 `/#/matrix` 后一直停在未 init。现在首帧由
 * `useLayoutEffect` 同步 `getBoundingClientRect()` 决定。
 */
test('MatrixScatter 用 useLayoutEffect 同步测量容器，不只等 ResizeObserver', () => {
  const scatter = sourceOf('MatrixScatter.tsx');
  assert.match(scatter, /useLayoutEffect/, '应从 react 引入并使用 useLayoutEffect');
  assert.match(
    scatter,
    /useLayoutEffect\(\(\) => \{[\s\S]{0,400}?getBoundingClientRect\(\)/,
    'useLayoutEffect 里应同步调用 getBoundingClientRect() 测量容器',
  );
  // 同步测到尺寸就当场 init，不等下一帧的 observer 回调。
  assert.match(
    scatter,
    /getBoundingClientRect\(\)[\s\S]{0,300}?echarts\.init\(/,
    '同步测到非零尺寸应立刻 echarts.init()',
  );
});

/**
 * init 那一刻父级布局可能还在收敛（flex、滚动条出现），下一帧补一次 resize。
 * 必须是 rAF，而不是 setTimeout 猜时机（上面那条 doesNotMatch 已经守住后者）。
 */
test('MatrixScatter 在 init 后用 rAF 兜底 resize', () => {
  const scatter = sourceOf('MatrixScatter.tsx');
  assert.match(
    scatter,
    /requestAnimationFrame\(\(\) => inst\.resize\(\)\)/,
    'init 后应在 rAF 回调中 resize()',
  );
  // 这一帧可能排在 dispose 之后，cleanup 要撤掉它。
  assert.match(scatter, /cancelAnimationFrame\(frame\)/, 'cleanup 应 cancel 掉这一帧');
});

/**
 * 手机切页签时外层只是 hidden/block，复用的 ECharts 实例可能停在 0×0 的画布
 * 上。给 `key={mobileView}` 让它重新挂载，重走一遍同步测量。
 */
test('MatrixPage 用 key={mobileView} 让手机切页签时重新挂载图表', () => {
  const page = sourceOf('MatrixPage.tsx');
  assert.match(
    page,
    /<MatrixScatter\s[\s\S]{0,200}?key=\{mobileView\}/,
    'MatrixScatter 应带 key={mobileView}',
  );
});

/**
 * 桌面必须恒显图表：不能因为 `mobileView === 'list'`（桌面的恒定值）就不渲染
 * MatrixScatter——挂不挂 ECharts 由容器尺寸决定，不由这个手机端状态决定。
 */
test('桌面不因 mobileView 为 list 而跳过 MatrixScatter', () => {
  const page = sourceOf('MatrixPage.tsx');
  // 外层 wrapper 只切 CSS 的 hidden/block，始终把 MatrixScatter 渲染在里面。
  assert.match(
    page,
    /mobileView === 'chart' \? 'block' : 'hidden'[\s\S]{0,200}?<MatrixScatter/,
    '图表应始终渲染在只切 CSS 的 wrapper 内',
  );
  // 不得出现「list 就不渲染图表」的条件渲染。
  assert.doesNotMatch(
    page,
    /mobileView === 'chart' && [\s\S]{0,80}?<MatrixScatter/,
    '不应把 MatrixScatter 做成 mobileView==="chart" 的条件渲染',
  );
});

/**
 * 改成命令式之后，原先挂在 `ReactECharts` 上的那套交互必须一条不少。下面几条
 * 守住最容易在重写里丢掉的部分：自己注册的 wheel 监听（Command/Alt 语义 + rAF
 * 合帧）、四个 dataZoom 的配置，以及三个按钮的缩放入口。
 */
test('自注册的 wheel 监听保留 Alt 语义与 rAF 合帧', () => {
  const scatter = sourceOf('MatrixScatter.tsx');
  // 必须 passive: false，否则 preventDefault 调不动。
  assert.match(
    scatter,
    /addEventListener\('wheel', onWheel, \{ passive: false \}\)/,
    'wheel 必须是 passive: false 的原生监听器',
  );
  // 缩放的两个必要条件仍由那条纯函数判定。
  assert.match(
    scatter,
    /shouldWheelZoom\(\{ altKey: event\.altKey, metaKey: event\.metaKey, insidePlot \}\)/,
    '仍按 Command/Alt + 指针在绘图区内判定是否缩放',
  );
  // 同一帧多次 wheel 累乘后钳一次，再写一次 state。
  assert.match(scatter, /pendingFactor \*= factor/, '同帧内应累乘倍率');
  assert.match(scatter, /clampWheelFactor\(pendingFactor\)/, '累乘结果应钳回单步上限');
  assert.match(scatter, /requestAnimationFrame\(flush\)/, '应用 rAF 合帧');
});

test('四个 dataZoom 仍是两 inside 两 slider，且关掉 ECharts 自带滚轮缩放', () => {
  const scatter = sourceOf('MatrixScatter.tsx');
  // 两条 inside 负责拖拽平移，两条 slider 可单独缩放某一轴。
  assert.match(scatter, /type: 'inside'/, '应有 inside 型 dataZoom');
  assert.match(scatter, /type: 'slider'/, '应有 slider 型 dataZoom');
  assert.match(scatter, /moveOnMouseMove: true/, 'inside 应允许拖拽平移');
  // 这条是关键：ECharts 的滚轮缩放一旦打开，同一次 wheel 会被处理两次。
  assert.match(scatter, /zoomOnMouseWheel: false/, '必须关掉 ECharts 自带的滚轮缩放');
  assert.match(scatter, /moveOnMouseWheel: false/, '必须关掉 ECharts 自带的滚轮平移');
});

test('放大 / 缩小 / 重置三个按钮仍改同一份视窗状态', () => {
  const scatter = sourceOf('MatrixScatter.tsx');
  assert.match(scatter, /onClick=\{\(\) => zoomBy\(0\.6\)\}/, '放大按钮应 zoomBy(0.6)');
  assert.match(scatter, /onClick=\{\(\) => zoomBy\(1 \/ 0\.6\)\}/, '缩小按钮应 zoomBy(1 / 0.6)');
  assert.match(
    scatter,
    /onClick=\{\(\) => setViewport\(FULL_VIEWPORT\)\}/,
    '重置按钮应回到 FULL_VIEWPORT',
  );
});
