import type { NodeProbeResult } from '../probe/engine.ts';

export type RepairAction = 'keep' | 'switch' | 'no-candidate';

export interface RepairPlan {
  action: RepairAction;
  /** 切换前的节点名（仅 switch 时有值）。 */
  from?: string;
  /** 切换后的节点名（仅 switch 时有值）。 */
  to?: string;
  /** 人类可读的决策依据。 */
  reason: string;
  /** 本次实际用到的最佳候选（便于报告选择依据）。 */
  chosen?: NodeProbeResult;
}

export interface PlanInput {
  current?: string;
  /** 对当前选中成员的探测结果；未探测则为 undefined。 */
  currentResult?: NodeProbeResult;
  /** 对候选成员的探测结果。仅在需要替换时提供。 */
  candidateResults?: NodeProbeResult[];
}

/** 按「先快后慢」排序可用候选；耗时未知的排在已知的后面，保持原有相对顺序。 */
export function rankUsable(results: NodeProbeResult[]): NodeProbeResult[] {
  return results
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => r.verdict === 'ok')
    .sort((a, b) => {
      const at = a.r.ttfbMs ?? Number.POSITIVE_INFINITY;
      const bt = b.r.ttfbMs ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      return a.index - b.index;
    })
    .map(({ r }) => r);
}

function describeProbe(result: NodeProbeResult): string {
  const parts: string[] = [];
  if (result.statusCode !== undefined) parts.push(`${result.statusCode}`);
  if (result.country) parts.push(`出口 ${result.country}`);
  if (result.ttfbMs !== undefined) parts.push(`${result.ttfbMs}ms`);
  return parts.length > 0 ? `${result.reason}（${parts.join('，')}）` : result.reason;
}

/**
 * 粘性修复决策（纯函数，便于测试）。
 *
 * 规则：
 *   1. 当前成员可用 → 保持不动（这是「仅当当前节点不可用时才切换」的核心）
 *   2. 当前成员不可用/不存在 → 选耗时最低的可用候选
 *   3. 没有可用候选 → 不做改动
 */
export function planRepair(input: PlanInput): RepairPlan {
  const { current, currentResult } = input;

  if (current !== undefined && currentResult?.verdict === 'ok') {
    return {
      action: 'keep',
      to: current,
      reason: `当前节点可用：${describeProbe(currentResult)}`,
      chosen: currentResult,
    };
  }

  const usable = rankUsable(input.candidateResults ?? []);
  const best = usable[0];
  if (best) {
    const why = current === undefined
      ? '当前没有选中成员'
      : currentResult === undefined
        ? '当前选中成员不是可探测的真实节点'
        : `当前节点不可用：${currentResult.reason}`;
    return {
      action: 'switch',
      ...(current === undefined ? {} : { from: current }),
      to: best.node,
      reason: `${why}；切换到实测可用节点 ${best.node}（${describeProbe(best)}）`,
      chosen: best,
    };
  }

  return {
    action: 'no-candidate',
    ...(current === undefined ? {} : { from: current }),
    reason:
      current === undefined
        ? '没有可用候选节点'
        : `当前节点不可用（${currentResult?.reason ?? '无法探测'}），且没有其它可用候选节点`,
  };
}
