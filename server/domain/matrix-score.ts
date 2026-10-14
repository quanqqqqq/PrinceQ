/**
 * The continuous 0..100 matrix scale.
 *
 * Both axes are plain numbers with one decimal of precision: importance from
 * goal impact / risk / responsibility, urgency from deadline pressure and
 * blocking. The quadrant is *derived* from them — never stored independently —
 * so a score change and its quadrant can never drift apart.
 *
 * Nothing here calls a model. Validation and derivation only.
 */
import {
  MATRIX_HIGH_THRESHOLD,
  MATRIX_SCORE_MAX,
  MATRIX_SCORE_MIN,
  type MatrixScoreSource,
  type Quadrant,
} from '../../shared/types.ts';
import { badRequest } from '../lib/errors.ts';

/** Derives the quadrant from two 0..100 scores. `>= 50` is high on either axis. */
export function quadrantFromScores(importanceScore: number, urgencyScore: number): Quadrant {
  const important = importanceScore >= MATRIX_HIGH_THRESHOLD;
  const urgent = urgencyScore >= MATRIX_HIGH_THRESHOLD;
  if (important && urgent) return 'q1';
  if (important) return 'q2';
  if (urgent) return 'q3';
  return 'q4';
}

/** Rounds to the one decimal the schema and the API both document. */
export const roundScore = (value: number): number => Math.round(value * 10) / 10;

/**
 * Validates one axis. Rejects non-finite values, out-of-range values and more
 * than one decimal place, rather than silently clamping — a mis-scaled score is
 * a caller bug the Agent should see.
 */
export function validateScore(axis: 'importance' | 'urgency', value: unknown): number {
  const label = axis === 'importance' ? '重要程度' : '紧急程度';
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest(`${label}评分必须是 ${MATRIX_SCORE_MIN}..${MATRIX_SCORE_MAX} 之间的数字。`);
  }
  if (value < MATRIX_SCORE_MIN || value > MATRIX_SCORE_MAX) {
    throw badRequest(
      `${label}评分 ${value} 超出范围，必须在 ${MATRIX_SCORE_MIN}..${MATRIX_SCORE_MAX} 之间。`,
    );
  }
  if (roundScore(value) !== value) {
    throw badRequest(`${label}评分 ${value} 精度过高，最多保留 1 位小数。`);
  }
  return value;
}

export interface ValidatedMatrixScore {
  importance_score: number;
  urgency_score: number;
  quadrant: Quadrant;
  reason: string;
  source: Extract<MatrixScoreSource, 'agent' | 'user'>;
  confidence: number | null;
  /** Agent judgements are suggestions; only the user confirms. */
  quadrant_confirmed: boolean;
}

export interface MatrixScoreSubmission {
  importance_score: unknown;
  urgency_score: unknown;
  reason?: unknown;
  source?: unknown;
  confidence?: unknown;
}

/**
 * Validates a submitted pair of scores and derives everything downstream of it.
 *
 * `source` defaults to `agent`, which is only ever legitimate when a real Agent
 * produced the judgement — the local keyword rules use `'rule'` and go through
 * `ruleScoreUpdate` instead, never through here.
 */
export function validateMatrixScore(input: MatrixScoreSubmission): ValidatedMatrixScore {
  const importance = validateScore('importance', input.importance_score);
  const urgency = validateScore('urgency', input.urgency_score);

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 4) {
    throw badRequest('必须提供评分理由（至少 4 个字符），说明两轴分数的依据。');
  }
  if (reason.length > 2000) {
    throw badRequest('评分理由过长，最多 2000 个字符。');
  }

  const source = input.source ?? 'agent';
  if (source !== 'agent' && source !== 'user') {
    throw badRequest("评分来源只能是 'agent'（助手判断）或 'user'（用户指定）。");
  }

  let confidence: number | null = null;
  if (input.confidence != null) {
    if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)) {
      throw badRequest('置信度必须是 0..1 之间的数字。');
    }
    if (input.confidence < 0 || input.confidence > 1) {
      throw badRequest(`置信度 ${input.confidence} 超出范围，必须在 0..1 之间。`);
    }
    confidence = Math.round(input.confidence * 100) / 100;
  }

  return {
    importance_score: importance,
    urgency_score: urgency,
    quadrant: quadrantFromScores(importance, urgency),
    reason,
    source,
    confidence,
    // An Agent score is a suggestion awaiting the user; a user-supplied score
    // is itself the decision.
    quadrant_confirmed: source === 'user',
  };
}

/**
 * Projects a 0..100 score back onto the legacy 1..5 integer column kept for
 * older clients. Monotonic, and it never crosses the old 3.5 boundary in a way
 * that would disagree with the new 50 boundary.
 */
export function legacyAxisValue(score: number): number {
  if (score >= 90) return 5;
  if (score >= MATRIX_HIGH_THRESHOLD) return 4;
  if (score >= 25) return 2;
  return 1;
}
