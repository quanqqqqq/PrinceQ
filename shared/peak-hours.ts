import type { TaskType } from './types.ts';
export type TaskTypePeakHours = Partial<Record<TaskType, number[]>>;

/** Missing means inherit; an explicitly empty list means no peak hours. */
export function peakHoursFor(taskType: TaskType | null, common: number[], overrides: TaskTypePeakHours = {}): number[] {
  return taskType && Object.hasOwn(overrides, taskType) ? overrides[taskType]! : common;
}

export function setTypePeakHours(current: TaskTypePeakHours, type: TaskType, hours: number[] | undefined): TaskTypePeakHours {
  const next = { ...current };
  if (hours === undefined) delete next[type];
  else next[type] = [...new Set(hours)].sort((a, b) => a - b);
  return next;
}

export function sameTypePeakHours(a: TaskTypePeakHours = {}, b: TaskTypePeakHours = {}): boolean {
  const keys = Object.keys(a).sort();
  if (keys.join(',') !== Object.keys(b).sort().join(',')) return false;
  return keys.every(key => {
    const lhs = [...new Set(a[key as TaskType] ?? [])].sort((x,y) => x-y);
    const rhs = [...new Set(b[key as TaskType] ?? [])].sort((x,y) => x-y);
    return lhs.join(',') === rhs.join(',');
  });
}
