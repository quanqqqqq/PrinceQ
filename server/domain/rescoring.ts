/**
 * 复评（rescoring）的纯逻辑：请求了哪些轴、Agent 交回来的分数怎么并回去。
 *
 * 这里一个字节都不碰数据库，也一个字节都不造分数。存在的理由只有一个：
 * **一次复评只允许动被请求的那几根轴**。
 *
 * 过去「手动移动象限」会把两轴一起写死成所选格子的 band（75/25 之类），用户点
 * 一下就凭空产生两个看起来像判断的数字。现在的约定是反过来的：
 *
 * - 请求里写明要改哪些轴（`changedAxes`）；
 * - 真实 Agent 只对这些轴给分，并给出理由；
 * - 未被请求的轴**逐位保留原值**——Agent 顺带改了也一律拒绝，而不是悄悄接受；
 * - 合并结果仍然只是建议，要等用户确认才会落库（见 `../repo/rescoring-service.ts`）。
 *
 * 任何一步都不许"兜底"成一个编出来的数：缺原值就报错，让调用方去请求那根轴。
 */
import { MATRIX_HIGH_THRESHOLD, type Quadrant } from '../../shared/types.ts';
import { badRequest } from '../lib/errors.ts';
import { validateScore } from './matrix-score.ts';

/** 矩阵的两根轴。复评一次可以动一根或两根。 */
export type RescoringAxis = 'importance' | 'urgency';

const AXIS_LABELS: Record<RescoringAxis, string> = {
  importance: '重要程度',
  urgency: '紧急程度',
};

const ALL_AXES: readonly RescoringAxis[] = ['importance', 'urgency'];

const isAxis = (value: unknown): value is RescoringAxis =>
  value === 'importance' || value === 'urgency';

/**
 * 校验「这次请求要改哪些轴」。
 *
 * 必须非空：一次不改任何轴的复评请求没有意义，而且后面 `mergeAgentScores` 会
 * 把它判成"全部保留原值"，白白走完一轮还什么都没动。重复项同样拒绝而不是去重，
 * 因为 `['importance', 'importance']` 更像是调用方拼错了，不该被静默修正。
 */
export function validateChangedAxes(axes: unknown): RescoringAxis[] {
  if (!Array.isArray(axes) || axes.length === 0) {
    throw badRequest('复评请求必须指明至少一根要重新评分的轴（importance / urgency）。');
  }
  const seen = new Set<RescoringAxis>();
  for (const axis of axes) {
    if (!isAxis(axis)) {
      throw badRequest(`复评的轴只能是 importance 或 urgency，收到了 ${JSON.stringify(axis)}。`);
    }
    if (seen.has(axis)) {
      throw badRequest(`复评请求里的轴 ${axis} 重复了，请每根轴只写一次。`);
    }
    seen.add(axis);
  }
  // 按固定顺序返回，落库的 changed_axes 文本才是稳定的。
  return ALL_AXES.filter((axis) => seen.has(axis));
}

/** 合并后的两轴分数。两根都有值，可以直接派生象限。 */
export interface MergedScores {
  importance_score: number;
  urgency_score: number;
}

/** 复评请求创建时拍下的两轴快照；`null` 表示那根轴此前从未评过分。 */
export interface CurrentScores {
  importance_score: number | null;
  urgency_score: number | null;
}

/** Agent 交回来的建议。两轴都是可选的——只该给被请求的那些。 */
export interface RescoringSubmission {
  importance_score?: unknown;
  urgency_score?: unknown;
}

const FIELDS: Record<RescoringAxis, keyof RescoringSubmission> = {
  importance: 'importance_score',
  urgency: 'urgency_score',
};

/**
 * 把 Agent 的建议并回快照，得到一对完整的两轴分数。
 *
 * 三条规则，全部是"拒绝"而不是"猜"：
 *
 * 1. **被请求的轴**：必须给值，且要过 `validateScore`（0..100、最多 1 位小数）。
 *    漏给就报错——不拿原值顶上，否则一次"复评"会悄悄变成没评。
 * 2. **未被请求的轴**：给了不同的值就拒绝整次提交。Agent 越界改分是这个模块
 *    最要防的事；静默丢弃它会让 Agent 以为自己的判断被采纳了。给了相同的值
 *    （或没给）则逐位保留快照里的原值。
 * 3. **未被请求又没有原值的轴**：直接报错。没有可保留的东西，编一个就是伪评分，
 *    正确做法是把那根轴也加进 `changedAxes` 去请求真实评分。
 */
export function mergeAgentScores(
  current: CurrentScores,
  changedAxes: RescoringAxis[],
  submission: RescoringSubmission,
): MergedScores {
  const requested = new Set(validateChangedAxes(changedAxes));
  const merged = {} as Record<keyof RescoringSubmission, number>;

  for (const axis of ALL_AXES) {
    const field = FIELDS[axis];
    const submitted = submission[field];
    const original = current[field as keyof CurrentScores];

    if (requested.has(axis)) {
      if (submitted == null) {
        throw badRequest(
          `复评请求要求重新评估${AXIS_LABELS[axis]}（${axis}），但建议里没有给出该轴的分数。`,
        );
      }
      merged[field] = validateScore(axis, submitted);
      continue;
    }

    // 未被请求的轴：只能原样保留。
    if (submitted != null && submitted !== original) {
      throw badRequest(
        `未请求修改的轴 ${axis}（${AXIS_LABELS[axis]}）提交了不同值，已拒绝：` +
          `原值 ${original ?? '无'}，提交值 ${JSON.stringify(submitted)}。` +
          `如需改动这根轴，请重新发起一次包含它的复评请求。`,
      );
    }
    if (original == null) {
      throw badRequest(
        `轴 ${axis}（${AXIS_LABELS[axis]}）此前没有分数可以保留，` +
          `请把它一并列入复评请求，由真实 Agent 给出评分。`,
      );
    }
    merged[field] = original;
  }

  return { importance_score: merged.importance_score, urgency_score: merged.urgency_score };
}

/** 目标象限在每根轴上要求的那一侧：`true` 表示要高（>= 50）。 */
const WANT_HIGH: Record<RescoringAxis, (target: Quadrant) => boolean> = {
  // 重要的象限是 q1（重要且紧急）与 q2（重要不紧急）。
  importance: (target) => target === 'q1' || target === 'q2',
  // 紧急的象限是 q1（重要且紧急）与 q3（不重要但紧急）。
  urgency: (target) => target === 'q1' || target === 'q3',
};

/**
 * 「要落到目标象限，哪几根轴必须重新评分？」
 *
 * 这是把一次象限拖动翻译成一次复评请求的那一步，也是替掉旧「手动改象限」的关
 * 键：旧行为把两轴一起写成目标格子的 band，于是用户点一下就凭空得到两个数字；
 * 现在只有**真正跨线**的轴才进入 `changedAxes`，另一根原封不动留着。
 *
 * 判定按轴各自独立：当前分数 >= 50 算高，低于 50 算低，和目标象限要求的那一侧
 * 不一致就列进结果。`null`（那根轴此前从未评过分）视为没有 side，一律算不匹配
 * ——没有原值可以保留，只能请真实 Agent 给一个，绝不在这里兜一个默认分。
 *
 * 不抛错也不校验目标象限之外的东西：返回空数组是合法结果，表示当前分数已经落在
 * 目标象限里，调用方该拒绝这次请求（没有轴需要动），而不是走完一轮空复评。
 */
export function axesMismatchingQuadrant(
  current: CurrentScores,
  target: Quadrant,
): RescoringAxis[] {
  return ALL_AXES.filter((axis) => {
    const score = current[FIELDS[axis] as keyof CurrentScores];
    // 没有分数就没有 side：无从判断"已经匹配"，按不匹配处理。
    if (score == null) return true;
    return score >= MATRIX_HIGH_THRESHOLD !== WANT_HIGH[axis](target);
  });
}
