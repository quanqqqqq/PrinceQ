/** Display-only priority bands; never changes queue scores or ranking. */
const QUEUE_PRIORITY_BANDS = [
  { minimum: 75, label: '高优先', range: '75 分及以上', tone: 'high',
    className: 'border-red-200 bg-red-50 text-red-700' },
  { minimum: 60, label: '较高优先', range: '60–74.9 分', tone: 'elevated',
    className: 'border-orange-200 bg-orange-50 text-orange-800' },
  { minimum: 40, label: '常规优先', range: '40–59.9 分', tone: 'normal',
    className: 'border-blue-200 bg-blue-50 text-blue-700' },
  { minimum: Number.NEGATIVE_INFINITY, label: '较低优先', range: '低于 40 分', tone: 'low',
    className: 'border-slate-200 bg-slate-50 text-slate-600' },
] as const;

export function queuePriorityBand(score: number | null | undefined) {
  if (score == null || !Number.isFinite(score)) return null;
  // Match the one-decimal badge so a rounded 60.0 never receives the <60 colour.
  const displayedScore = Number(score.toFixed(1));
  return QUEUE_PRIORITY_BANDS.find(band => displayedScore >= band.minimum) ?? null;
}
