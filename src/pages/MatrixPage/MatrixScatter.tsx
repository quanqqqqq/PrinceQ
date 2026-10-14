/**
 * `/matrix` 上半部分：真正的二维散点图。
 *
 * 横轴 = 紧急程度 0..100，纵轴 = 重要程度 0..100，50 处的中线把平面切成四个
 * 象限。几条硬性约束：
 *
 * - 分值绝不改动：不加随机抖动、不重新缩放，点就画在它的真实坐标上。
 * - 遮挡问题靠 **聚合** 解决：按屏幕距离把靠得太近的点合成一个簇并标注真实
 *   任务数；缩放后重新计算，所以放大就能把它们分开。
 * - 簇不跨象限，因此图上每象限的任务数永远等于下方四列的计数。
 * - 完全同分的点无论怎么放大都分不开，点击该簇会列出全部任务供选择。
 * - 默认只显示短编号，不显示标题；悬停或点击才给出完整信息。
 *
 * 缩放只有 **一个** 状态来源：坐标轴恒为 0..100，视窗完全由 `dataZoom` 表达
 * （见 `./viewport`）。按钮与重置通过受控的 `start`/`end` 写回同一份状态，
 * slider 与拖拽的事件则解析回来——两边改的是同一个 `viewport`，不存在轴 min/max
 * 与 dataZoom 叠加造成的双重裁剪。
 *
 * 滚轮的分工由 **修饰键 + 指针位置** 共同决定：只有按住 Command（Mac）/ Alt
 * （Windows）并且指针落在绘图区内（容器 rect 减去 `GRID` 四边留白之后的那个
 * 矩形）时才吃掉事件、按指针双轴缩放。不按修饰键的普通滚轮一律不拦——哪怕指
 * 针就停在图上，也不 `preventDefault`、不缩放，页面照常翻页；按住 Command/Alt
 * 但指针落在绘图区外（轴标签、两条 slider、容器留白、标题栏）同样放行。于是图
 * 表不会再"抢"普通滚轮与触控板双指滚动；未接管的 ctrlKey wheel 由浏览器处理。
 *
 * ECharts 自带的滚轮缩放必须保持关掉（`zoomOnMouseWheel: false`、
 * `moveOnMouseWheel: false`），否则同一次 wheel 会被 ECharts 和这里各处理一次，
 * 缩放量翻倍。缩放由容器上一个自己注册的 `wheel` 监听器处理——必须
 * `passive: false` 才能 `preventDefault`，React 的 `onWheel` 在根节点上是被动的，
 * 拿不到这个能力。
 *
 * 图表是**直接命令式**用的：`echarts.init` / `setOption` / `dispose` 全由这里自己
 * 调，不经 `echarts-for-react`。那层包装除了多一层生命周期之外，还把 `init` 的
 * 时机交给了 React 的渲染节奏——而 `init` 必须发生在一个**已经量到非零宽高**的
 * 节点上：手机端外层页签是 `display:none` / `block` 切换，lazy 路由下数据到达的
 * 时序也不稳，`init` 一旦跑在 0×0 的节点上就会建出一块永远没有宽高的画布，按钮、
 * 帮助都在，图区却空白且 console 不报错，之后 `resize()` 也救不回来。
 *
 * 所以挂载判据就是容器的真实宽高（纯函数 `shouldInitChart`），测量放在
 * `useLayoutEffect` 里**同步** `getBoundingClientRect()` 做一次：DOM 已提交、浏览
 * 器还没绘制，这时拿到的就是真实布局，够尺寸当场 `init`。不能只等
 * ResizeObserver——它的首次回调要等一帧，而「等回调才 init」让 init 反过来依赖回
 * 调，硬刷新 `/#/matrix` 时就卡成死锁。ResizeObserver 退回成后续变化（窄屏旋转、
 * 页签 display 切换）的跟踪者：量到尺寸而实例还不存在时，它只负责催一次重测，
 * 真正的 init 仍走同一条同步路径。两边都不靠 setTimeout 猜时机。
 *
 * 实例活着的期间只有一处写入：`option` 变了就 `setOption(option, true)`，整份替换
 * 而不是增量合并——视窗（dataZoom 的 `start`/`end`）、聚合后的散点、标注开关全在
 * 这一份 option 里，替换掉就不会和上一份残留状态叠加。卸载时 `dispose()`。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import type {
  DataZoomComponentOption,
  EChartsOption,
  ECElementEvent,
  ScatterSeriesOption,
  TooltipComponentFormatterCallbackParams,
} from 'echarts';
import { Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import type { Quadrant } from '@shared/types';
import { MATRIX_HIGH_THRESHOLD } from '@shared/types';
import {
  clusterMatrixPoints,
  escapeHtml,
  resolveMatrixPlacement,
  type MatrixCluster,
  type MatrixPoint,
} from '@shared/matrix-view';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MatrixHelpDialog } from '@/pages/MatrixPage/MatrixHelpDialog';
import type { TaskWithMatrix } from '@/lib/api';
import {
  MATRIX_SCORE_SOURCE_LABELS,
  QUADRANT_TITLES,
  STATUS_LABELS,
  demoText,
  formatMatrixScore,
} from '@/lib/format';
import {
  AXIS_MAX,
  AXIS_MIN,
  DATA_ZOOM_IDS,
  FULL_VIEWPORT,
  MIN_SPAN,
  clampWheelFactor,
  isFullViewport,
  isOffsetInsidePlot,
  plotAnchorFromOffset,
  projectToPixel,
  shouldInitChart,
  shouldWheelZoom,
  viewportFromDataZoomOption,
  viewportsEqual,
  wheelZoomFactor,
  zoomViewport,
  zoomViewportAt,
  type Viewport,
  type ZoomAnchor,
} from '@/pages/MatrixPage/viewport';

/** 屏幕聚合半径（像素）。约等于两个点直径，肉眼刚好分不开。 */
const CLUSTER_RADIUS_PX = 18;

/** 默认只显示短编号的任务数上限；超过就先关掉标注，避免糊成一片。 */
const CODE_LABEL_LIMIT = 60;

const CHART_HEIGHT = 460;

/**
 * 绘图区留白，和下面 `grid` 配置保持一致，用于把分值换算成像素。
 *
 * 下边与右边的余量同时给轴名和 slider：slider 贴在 grid 之外，所以不会压到轴
 * 标签，轴名也还有自己的 `nameGap`。
 */
const GRID = { left: 58, right: 54, top: 24, bottom: 78 };

/** 两条 slider 的几何，和 `GRID` 的余量一起保证互不遮挡。 */
const SLIDER_THICKNESS = 14;
const SLIDER_OFFSET = 8;

const QUADRANT_COLORS: Record<Quadrant, string> = {
  q1: '#b45309',
  q2: '#2563eb',
  q3: '#0f766e',
  q4: '#64748b',
};

/** 四个象限的淡色背景，克制为主。 */
const QUADRANT_BANDS: Record<Quadrant, string> = {
  q1: 'rgba(180, 83, 9, 0.05)',
  q2: 'rgba(37, 99, 235, 0.05)',
  q3: 'rgba(15, 118, 110, 0.05)',
  q4: 'rgba(100, 116, 139, 0.04)',
};

const QUADRANT_KEYS: Quadrant[] = ['q1', 'q2', 'q3', 'q4'];

export interface MatrixScatterProps {
  /** 已过滤的任务，与下方四列完全一致。 */
  tasks: TaskWithMatrix[];
  codes: Map<string, string>;
  /** 当前选中的任务（来自图或列表），用于互相高亮。 */
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (taskId: string | null) => void;
  /**
   * 图上悬停的任务 id，回传给父级以高亮下方四列。单点簇给出真实 id，
   * 多点簇无法指向唯一任务，给 `null`；`mouseout` 也给 `null`。
   */
  onHoverChange?: (taskId: string | null) => void;
}

interface Detail {
  cluster: MatrixCluster;
  tasks: TaskWithMatrix[];
}

/** 散点 data 项：带上簇 key，事件里据此找回真实任务。 */
interface ClusterDatum {
  value: [number, number];
  name: string;
  symbolSize: number;
  itemStyle: Record<string, number | string>;
  label: Record<string, unknown>;
}

export function MatrixScatter({
  tasks,
  codes,
  selectedId,
  hoveredId,
  onSelect,
  onHoverChange,
}: MatrixScatterProps) {
  const [viewport, setViewport] = useState<Viewport>(FULL_VIEWPORT);
  const [showCodes, setShowCodes] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [plotSize, setPlotSize] = useState({ width: 800, height: CHART_HEIGHT });
  /** ECharts 的宿主节点：`echarts.init` 直接挂在它上面。 */
  const hostRef = useRef<HTMLDivElement>(null);
  /** 当前实例；`null` 表示还没 init（容器尚未量到尺寸）或已 dispose。 */
  const instRef = useRef<echarts.ECharts | null>(null);
  /**
   * 需要重测容器、再试一次 init 的信号。
   *
   * 只有一种情况会用到：init 那一刻容器还是 0×0（手机页签 `display:none`、
   * 布局未收敛），于是没有实例；等 ResizeObserver 带着真实尺寸来时自增一下，
   * 让下面的 `useLayoutEffect` 重跑、同步测量后当场 init。
   */
  const [initTick, setInitTick] = useState(0);

  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  /**
   * 已评分任务 → 当前视窗下的像素坐标。
   *
   * `viewport` 依赖让缩放、平移和 resize 之后都按新的屏幕距离重新聚合：放大
   * 之后原本重叠的点就会散开成独立的点。
   */
  const points = useMemo<MatrixPoint[]>(
    () =>
      tasks.flatMap((task) => {
        const placement = resolveMatrixPlacement(task);
        if (!placement) return [];
        return [
          {
            id: task.id,
            code: codes.get(task.id) ?? '',
            importance: placement.importance,
            urgency: placement.urgency,
            quadrant: placement.quadrant,
            px: projectToPixel(placement.urgency, viewport.xMin, viewport.xMax, plotSize.width),
            py: projectToPixel(
              placement.importance,
              viewport.yMin,
              viewport.yMax,
              plotSize.height,
            ),
          },
        ];
      }),
    [tasks, codes, viewport, plotSize],
  );

  const clusters = useMemo(() => clusterMatrixPoints(points, CLUSTER_RADIUS_PX), [points]);

  /** 没有已评分任务时不渲染图表容器，两个原生监听器也就无处可挂。 */
  const charted = points.length > 0;

  /**
   * 绘图区的真实像素尺寸决定聚合半径对应多大的分值跨度；同一个
   * ResizeObserver 还负责跟踪「容器还有没有尺寸」的后续变化。
   *
   * 首次 init 由下面的 `useLayoutEffect` 同步测量完成，这里管的是之后的事：
   * - 量到真实尺寸而实例还不存在（首帧量到 0、手机页签刚从 `display:none` 变回
   *   可见）→ 自增 `initTick` 催一次重测，init 仍走那条同步路径；
   * - 实例已在 → 直接 `resize()`，让画布跟上新的容器尺寸。
   *
   * 量到 0 尺寸（如手机页签 `display:none`）时什么都不做：既不动 `plotSize`
   * （留着上一次的有效值，免得聚合半径按 120px 兜底乱算），也不碰实例——
   * ECharts 实例在隐藏期间留着无妨，等尺寸回来再 `resize()` 就行。
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (!shouldInitChart(width, height)) return;
      setPlotSize({
        width: Math.max(120, width - GRID.left - GRID.right),
        height: Math.max(120, height - GRID.top - GRID.bottom),
      });
      const inst = instRef.current;
      if (inst == null) {
        // 还没 init（init 那一刻容器是 0×0）：催一次同步测量。
        setInitTick((tick) => tick + 1);
        return;
      }
      inst.resize();
    });
    observer.observe(host);
    return () => observer.disconnect();
    // `charted` 切换时容器会挂载/卸载，必须重新 observe 新的节点。
  }, [charted]);

  /**
   * 滚轮缩放双轴，**只在按住 Command（Mac）/ Alt（Windows）且指针落在绘图区内**
   * 时发生——两个条件由纯函数 `shouldWheelZoom` 合在一处判定。
   *
   * 不满足就彻底放手：不 `preventDefault`、不缩放，事件继续冒泡，页面照常翻页。
   * 所以不按修饰键的普通滚轮和触控板双指滚动哪怕停在图上也只是翻页；
   * 未接管的 ctrlKey wheel 由浏览器处理。按住 Command/Alt 但指针在图外（轴标签、两条 slider、
   * 容器留白）也一样翻页。
   *
   * 必须用原生监听器加 `{ passive: false }`：React 的 `onWheel` 挂在根容器上是
   * 被动的，调不了 `preventDefault`，而默认行为（滚页面，或 ctrlKey 时缩放整
   * 个页面）不拦住就会和图上的缩放同时发生。
   *
   * 同一帧内的多次 wheel 先把倍率累乘起来，等 rAF 回调到了才写一次 state：
   * 一长串滚动于是每帧只重算一次聚合，不会跳变也不会刷爆 render。每帧的累计
   * 倍率仍钳在单步的 `[1/1.5, 1.5]` 内，甩一大把 delta 进来也只走一步。
   */
  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    let pendingFactor = 1;
    let pendingAnchor: ZoomAnchor | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const factor = clampWheelFactor(pendingFactor);
      const anchor = pendingAnchor;
      pendingFactor = 1;
      pendingAnchor = null;
      if (anchor == null || factor === 1) return;
      setViewport((current) => {
        const next = zoomViewportAt(current, factor, anchor);
        return viewportsEqual(current, next) ? current : next;
      });
    };
    const onWheel = (event: WheelEvent) => {
      const rect = element.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const size = { width: rect.width, height: rect.height };
      const insidePlot = isOffsetInsidePlot(offsetX, offsetY, size, GRID);
      // 没按 Command/Alt，或指针在图外：完全放手，页面照滚。
      if (!shouldWheelZoom({ altKey: event.altKey, metaKey: event.metaKey, insidePlot })) return;
      event.preventDefault();
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode as 0 | 1 | 2);
      if (factor === 1) return;
      pendingFactor *= factor;
      // 锚点取这一帧最后一次事件的指针位置。
      pendingAnchor = plotAnchorFromOffset(offsetX, offsetY, size, GRID);
      if (frame === 0) frame = requestAnimationFrame(flush);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [charted]);

  const labelsOn = showCodes && points.length <= CODE_LABEL_LIMIT;

  /** 当前高亮的任务：列表悬停优先于选中。 */
  const activeId = hoveredId ?? selectedId;

  const series = useMemo<ScatterSeriesOption[]>(() => {
    const data: ClusterDatum[] = clusters.map((cluster) => {
      const highlighted = activeId != null && cluster.points.some((p) => p.id === activeId);
      const size = cluster.points.length;
      return {
        value: [cluster.urgency, cluster.importance],
        name: cluster.key,
        symbolSize: size > 1 ? Math.min(34, 14 + size * 3) : 12,
        itemStyle: {
          color: QUADRANT_COLORS[cluster.quadrant],
          opacity: highlighted ? 1 : 0.78,
          borderColor: highlighted ? '#0f172a' : 'rgba(255,255,255,0.9)',
          borderWidth: highlighted ? 2.5 : 1,
        },
        label: {
          show: labelsOn || highlighted || size > 1,
          position: 'right' as const,
          distance: 6,
          fontSize: 10,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: '#475569',
          formatter: () =>
            size > 1
              ? `${size} 项${cluster.identical ? '·同分' : ''}`
              : (cluster.points[0].code ?? ''),
        },
      };
    });

    return [
      {
        type: 'scatter',
        data,
        emphasis: { scale: 1.25 },
        z: 3,
      },
    ];
  }, [clusters, activeId, labelsOn]);

  const clusterByKey = useMemo(
    () => new Map(clusters.map((cluster) => [cluster.key, cluster])),
    [clusters],
  );

  /** 悬停/点击的提示内容。单点给全量信息，多点簇给汇总。 */
  const tooltipFor = useCallback(
    (key: string): string => {
      const cluster = clusterByKey.get(key);
      if (!cluster) return '';
      if (cluster.points.length === 1) {
        const point = cluster.points[0];
        const task = byId.get(point.id);
        if (!task) return '';
        const placement = resolveMatrixPlacement(task);
        const rows = [
          `<div style="font-weight:600;max-width:260px;white-space:normal">${escapeHtml(
            demoText(task.title, task.is_demo),
          )}</div>`,
          `<div style="color:#64748b;font-size:11px">编号 ${escapeHtml(point.code)} · ${escapeHtml(
            QUADRANT_TITLES[point.quadrant],
          )}</div>`,
          `<div style="font-size:11px">重要 ${formatMatrixScore(
            point.importance,
          )} · 紧急 ${formatMatrixScore(point.urgency)}</div>`,
          `<div style="font-size:11px">状态：${escapeHtml(STATUS_LABELS[task.status])}</div>`,
        ];
        if (task.goal_title) {
          rows.push(
            `<div style="font-size:11px">目标：${escapeHtml(
              demoText(task.goal_title, task.is_demo),
            )}</div>`,
          );
        }
        if (placement) {
          rows.push(
            `<div style="font-size:11px">来源：${escapeHtml(
              MATRIX_SCORE_SOURCE_LABELS[placement.source],
            )}${task.quadrant_confirmed ? '（已确认）' : '（待确认）'}</div>`,
          );
        }
        return rows.join('');
      }

      const listed = cluster.points.slice(0, 8);
      const rows = [
        `<div style="font-weight:600">${cluster.points.length} 个任务重叠${
          cluster.identical ? '（评分完全相同）' : ''
        }</div>`,
        `<div style="color:#64748b;font-size:11px">${escapeHtml(
          QUADRANT_TITLES[cluster.quadrant],
        )} · 点击展开选择</div>`,
      ];
      for (const point of listed) {
        const task = byId.get(point.id);
        rows.push(
          `<div style="font-size:11px;max-width:280px;white-space:normal">${escapeHtml(
            point.code,
          )} · ${escapeHtml(task ? demoText(task.title, task.is_demo) : '')}</div>`,
        );
      }
      if (cluster.points.length > listed.length) {
        rows.push(
          `<div style="color:#64748b;font-size:11px">其余 ${
            cluster.points.length - listed.length
          } 项点击后查看</div>`,
        );
      }
      return rows.join('');
    },
    [clusterByKey, byId],
  );

  /**
   * 受控的四个 dataZoom：两个 inside（拖拽平移）加两条 slider。
   *
   * `start`/`end` 直接来自 `viewport`，所以按钮和重置改 state 就等于改视窗；
   * 轴本身恒为 0..100，这里是唯一的裁剪点。
   *
   * `zoomOnMouseWheel: false` 是关键：ECharts 的 inside 型 dataZoom 只要接管
   * 滚轮就会 `preventDefault`，整页都滚不过去。缩放改由容器自己的 wheel 监听
   * 器处理——只有按住 Command/Alt 且指针在绘图区内才拦，其余一概不碰。
   */
  const dataZoom = useMemo<DataZoomComponentOption[]>(
    () => [
      {
        id: DATA_ZOOM_IDS.insideX,
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
        minValueSpan: MIN_SPAN,
        start: viewport.xMin,
        end: viewport.xMax,
        // 滚轮缩放由容器的 wheel 监听器实现（需 Command/Alt + 指针在绘图区内）。
        zoomOnMouseWheel: false,
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
        preventDefaultMouseMove: true,
      },
      {
        id: DATA_ZOOM_IDS.insideY,
        type: 'inside',
        yAxisIndex: 0,
        filterMode: 'none',
        minValueSpan: MIN_SPAN,
        start: viewport.yMin,
        end: viewport.yMax,
        zoomOnMouseWheel: false,
        moveOnMouseWheel: false,
        moveOnMouseMove: true,
        preventDefaultMouseMove: true,
      },
      {
        id: DATA_ZOOM_IDS.sliderX,
        type: 'slider',
        xAxisIndex: 0,
        filterMode: 'none',
        minValueSpan: MIN_SPAN,
        start: viewport.xMin,
        end: viewport.xMax,
        height: SLIDER_THICKNESS,
        bottom: SLIDER_OFFSET,
        left: GRID.left,
        right: GRID.right,
        borderColor: '#e2e8f0',
      },
      {
        id: DATA_ZOOM_IDS.sliderY,
        type: 'slider',
        yAxisIndex: 0,
        filterMode: 'none',
        minValueSpan: MIN_SPAN,
        start: viewport.yMin,
        end: viewport.yMax,
        width: SLIDER_THICKNESS,
        right: SLIDER_OFFSET,
        top: GRID.top,
        bottom: GRID.bottom,
        borderColor: '#e2e8f0',
      },
    ],
    [viewport],
  );

  const option = useMemo<EChartsOption>(
    () => ({
      animation: false,
      grid: { ...GRID, containLabel: false },
      tooltip: {
        trigger: 'item',
        // 悬停与点击都给提示，移动端点一下也能看到。
        triggerOn: 'mousemove|click',
        confine: true,
        borderColor: '#e2e8f0',
        backgroundColor: '#ffffff',
        textStyle: { color: '#0f172a', fontSize: 12 },
        formatter: (params: TooltipComponentFormatterCallbackParams): string => {
          const first = Array.isArray(params) ? params[0] : params;
          return typeof first?.name === 'string' ? tooltipFor(first.name) : '';
        },
      },
      // 轴永远是完整的 0..100：视窗只由 dataZoom 表达，避免双重裁剪。
      xAxis: {
        type: 'value',
        name: '紧急程度 →',
        nameLocation: 'middle',
        nameGap: 30,
        nameTextStyle: { fontSize: 11, color: '#64748b' },
        min: AXIS_MIN,
        max: AXIS_MAX,
        splitLine: { lineStyle: { color: '#f1f5f9' } },
        axisLabel: { fontSize: 10, color: '#94a3b8' },
      },
      yAxis: {
        type: 'value',
        name: '重要程度 →',
        nameLocation: 'middle',
        nameGap: 38,
        nameTextStyle: { fontSize: 11, color: '#64748b' },
        min: AXIS_MIN,
        max: AXIS_MAX,
        splitLine: { lineStyle: { color: '#f1f5f9' } },
        axisLabel: { fontSize: 10, color: '#94a3b8' },
      },
      dataZoom,
      series: [
        // 四象限淡色底与中线：用 markArea / markLine 画在散点之下。
        {
          type: 'scatter',
          data: [],
          silent: true,
          z: 1,
          markArea: {
            silent: true,
            data: QUADRANT_KEYS.map((quadrant) => {
              const xRange: [number, number] =
                quadrant === 'q1' || quadrant === 'q3'
                  ? [MATRIX_HIGH_THRESHOLD, AXIS_MAX]
                  : [AXIS_MIN, MATRIX_HIGH_THRESHOLD];
              const yRange: [number, number] =
                quadrant === 'q1' || quadrant === 'q2'
                  ? [MATRIX_HIGH_THRESHOLD, AXIS_MAX]
                  : [AXIS_MIN, MATRIX_HIGH_THRESHOLD];
              return [
                {
                  xAxis: xRange[0],
                  yAxis: yRange[0],
                  itemStyle: { color: QUADRANT_BANDS[quadrant] },
                },
                { xAxis: xRange[1], yAxis: yRange[1] },
              ];
            }),
          },
          markLine: {
            silent: true,
            symbol: 'none',
            label: { show: false },
            lineStyle: { color: '#cbd5e1', type: 'solid', width: 1 },
            data: [{ xAxis: MATRIX_HIGH_THRESHOLD }, { yAxis: MATRIX_HIGH_THRESHOLD }],
          },
        },
        ...series,
      ],
    }),
    [series, tooltipFor, dataZoom],
  );

  /** 把事件里的簇 key 换成真实任务：单点簇才有唯一 id。 */
  const taskIdOfCluster = useCallback(
    (key: unknown): string | null => {
      if (typeof key !== 'string') return null;
      const cluster = clusterByKey.get(key);
      if (!cluster || cluster.points.length !== 1) return null;
      return cluster.points[0].id;
    },
    [clusterByKey],
  );

  /**
   * 图上的四类交互，逻辑与命令式注册分开写。
   *
   * 这些回调依赖每次 render 都可能变的东西（聚合结果、父级回调、当前视窗），
   * 而 `inst.on(...)` 只在 init 那一次注册。所以下面把这份对象放进一个 ref，
   * 注册的监听器只管转发到 `handlersRef.current`——既不用因为依赖变化就反复
   * 解绑重绑，也不会读到过期的闭包。
   */
  const handlers = useMemo(
    () => ({
      /**
       * 缩放/平移之后以图上的真实窗口为准。
       *
       * 事件载荷既可能是 `{ batch: [...] }`（滚轮、联动）也可能是单个对象
       * （slider 拖动、`dispatchAction`），两种都解析；但最终取 option 里四个
       * dataZoom 的状态——那是 ECharts 联动完成后的真实 0..100 视窗。
       */
      dataZoom: () => {
        const option = instRef.current?.getOption();
        if (!option) return;
        const next = viewportFromDataZoomOption(
          (option as { dataZoom?: unknown }).dataZoom,
          viewport,
        );
        // 相等就不写回，避免 option 与事件来回触发。
        setViewport((current) => (viewportsEqual(current, next) ? current : next));
      },
      click: (params: ECElementEvent) => {
        if (typeof params.name !== 'string') return;
        const cluster = clusterByKey.get(params.name);
        if (!cluster) return;
        if (cluster.points.length === 1) {
          onSelect(cluster.points[0].id);
          setDetail(null);
          return;
        }
        // 多点簇（含完全同分）：展开成列表让用户自己挑。
        setDetail({
          cluster,
          tasks: cluster.points.flatMap((point) => {
            const task = byId.get(point.id);
            return task ? [task] : [];
          }),
        });
      },
      // 悬停不只喂 tooltip：真实 task id 回传给父级，下方四列同步高亮。
      mouseover: (params: ECElementEvent) => {
        onHoverChange?.(taskIdOfCluster(params.name));
      },
      mouseout: () => {
        onHoverChange?.(null);
      },
      globalout: () => {
        onHoverChange?.(null);
      },
    }),
    [clusterByKey, byId, onSelect, onHoverChange, taskIdOfCluster, viewport],
  );

  /**
   * 给命令式那一侧用的「最新值」两面镜子。
   *
   * init 只发生一次（见下一个 effect），但它需要当时最新的 option 与回调；而
   * 这两样每次 render 都可能变。写在一个**声明在前**的 layout effect 里同步：
   * 同类 effect 按声明顺序执行，所以首帧 init 之前这两个 ref 就已经是当前值。
   */
  const optionRef = useRef(option);
  const handlersRef = useRef(handlers);
  useLayoutEffect(() => {
    optionRef.current = option;
    handlersRef.current = handlers;
  }, [option, handlers]);

  /**
   * ECharts 的生命周期：同步测量 → `init` → 注册事件 → 卸载时 `dispose`。
   *
   * 测量必须同步：`useLayoutEffect` 在 DOM 提交后、浏览器绘制前跑，这时
   * `getBoundingClientRect()` 已经是真实布局，量到非零宽高就当场 init，ECharts
   * 从一开始就建在有尺寸的节点上。量到 0 就直接返回、不 init——那会建出一块永远
   * 没有宽高的画布（图区空白、console 无报错的根因）；等 ResizeObserver 带着真实
   * 尺寸来时自增 `initTick`，这个 effect 重跑、再同步测一次。这也是为什么不能
   * 「等 observer 回调再 init」：首次回调排在下一帧，硬刷新 `/#/matrix` 时就成了
   * 「init 等回调、回调等 init」的死锁。
   *
   * 事件只在这里绑一次，转发到 `handlersRef.current`，所以依赖变化不会反复解绑。
   * rAF 那一下是尺寸兜底：init 那一刻父级布局可能还在收敛（flex、滚动条出现），
   * 下一帧再量一次画布；回调可能排在 dispose 之后，所以 cleanup 要撤掉它。
   */
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    if (!shouldInitChart(rect.width, rect.height)) return;

    const inst = echarts.init(host, undefined, { renderer: 'canvas' });
    inst.setOption(optionRef.current, true);
    instRef.current = inst;
    const frame = requestAnimationFrame(() => inst.resize());

    inst.on('click', (params) => handlersRef.current.click(params as ECElementEvent));
    inst.on('mouseover', (params) => handlersRef.current.mouseover(params as ECElementEvent));
    inst.on('mouseout', () => handlersRef.current.mouseout());
    inst.on('globalout', () => handlersRef.current.globalout());
    inst.on('dataZoom', () => handlersRef.current.dataZoom());

    return () => {
      cancelAnimationFrame(frame);
      inst.dispose();
      instRef.current = null;
    };
    // `charted` 切换时宿主节点会挂载/卸载；`initTick` 是「容器刚量到尺寸」的重试信号。
  }, [charted, initTick]);

  /**
   * option 变了就整份替换（`notMerge = true`）。
   *
   * 视窗（dataZoom 的 `start`/`end`）、聚合后的散点、标注开关全在这一份 option
   * 里，替换掉才不会和上一份残留状态叠加——增量合并会让缩小后旧的散点留在图上。
   */
  useEffect(() => {
    instRef.current?.setOption(option, true);
  }, [option]);

  /** 以视窗中心按比例缩放，不触碰任何分值。 */
  const zoomBy = (factor: number) => setViewport((current) => zoomViewport(current, factor));

  const zoomed = !isFullViewport(viewport);

  const multi = clusters.filter((cluster) => cluster.points.length > 1).length;

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">分布散点图</h3>
          <p className="text-xs text-muted-foreground">
            横轴紧急、纵轴重要，均为 0..100，50 为中线。
            {multi > 0 ? `当前有 ${multi} 处重叠已聚合，放大可拆开。` : '当前没有重叠的点。'}
          </p>
          {/* 操作细节收进帮助弹窗，这里只留一句最短提示。 */}
          <p className="mt-1 text-xs text-muted-foreground">
            按住 Command（Mac）/ Alt（Windows）再滚动滚轮，可按指针缩放双轴；普通滚动即翻页。触屏请用放大/缩小、滑块与重置。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Switch id="matrix-codes" checked={showCodes} onCheckedChange={setShowCodes} />
            <Label htmlFor="matrix-codes" className="text-xs text-muted-foreground">
              显示编号
            </Label>
          </div>
          <MatrixHelpDialog />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" onClick={() => zoomBy(0.6)}>
                <Maximize2 />
                放大
              </Button>
            </TooltipTrigger>
            <TooltipContent>以视窗中心放大，分值不变</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" onClick={() => zoomBy(1 / 0.6)}>
                <Minimize2 />
                缩小
              </Button>
            </TooltipTrigger>
            <TooltipContent>以视窗中心缩小，分值不变</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                disabled={!zoomed}
                onClick={() => setViewport(FULL_VIEWPORT)}
              >
                <RotateCcw />
                重置
              </Button>
            </TooltipTrigger>
            <TooltipContent>回到完整的 0..100 视窗</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <div className="p-2">
        {!charted ? (
          <p className="px-2 py-16 text-center text-xs text-muted-foreground">
            当前筛选下没有已评分的任务，无法绘制分布。可通过 Skill 的评分命令让助手复评。
          </p>
        ) : (
          // 高度固定、宽度随容器：窄屏（390px）下不给固定 px 宽度，避免横向溢出。
          // 这个 div 就是 ECharts 的宿主：`echarts.init` 直接挂在它上面，React
          // 不往里渲染任何子节点。挂不挂由上面 useLayoutEffect 同步量到的宽高
          // 决定——0×0 初始化是图区空白的根因。
          <div
            ref={hostRef}
            data-testid="matrix-plot"
            className="w-full max-w-full overflow-hidden"
            style={{ height: CHART_HEIGHT, minHeight: CHART_HEIGHT }}
          />
        )}

        {!labelsOn && showCodes ? (
          <p className="px-2 pb-1 text-xs text-muted-foreground">
            任务超过 {CODE_LABEL_LIMIT} 个，已暂时隐藏编号标注以免互相遮挡；悬停或放大后仍可查看。
          </p>
        ) : null}

        {detail ? (
          <div className="m-2 rounded-md border border-primary/30 bg-primary/5 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-medium">
                {QUADRANT_TITLES[detail.cluster.quadrant]}：{detail.tasks.length} 个任务重叠
                {detail.cluster.identical
                  ? '，且两轴评分完全相同（放大也无法分开，真实坐标未作改动）'
                  : ''}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0 text-muted-foreground"
                onClick={() => setDetail(null)}
              >
                关闭
              </Button>
            </div>
            <ul className="mt-2 space-y-1">
              {detail.tasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-left text-xs hover-elevate active-elevate-2"
                    onClick={() => {
                      onSelect(task.id);
                      setDetail(null);
                    }}
                    onMouseEnter={() => onHoverChange?.(task.id)}
                    onMouseLeave={() => onHoverChange?.(null)}
                  >
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {codes.get(task.id)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {demoText(task.title, task.is_demo)}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatMatrixScore(resolveMatrixPlacement(task)?.importance ?? 0)} /{' '}
                      {formatMatrixScore(resolveMatrixPlacement(task)?.urgency ?? 0)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
