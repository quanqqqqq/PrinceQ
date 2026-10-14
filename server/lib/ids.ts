import { randomUUID } from 'node:crypto';

/** Readable prefixed ids — easier to eyeball in the activity log than bare UUIDs. */
export const newId = (prefix: string): string => `${prefix}_${randomUUID().slice(0, 12)}`;

export const nowIso = (): string => new Date().toISOString();

/** Deterministic clock seam so tests can pin "now" for deadline scoring. */
let clock: () => Date = () => new Date();

export const now = (): Date => clock();

export function setClock(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date());
}

export const round2 = (value: number): number => Math.round(value * 100) / 100;

export const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value));
