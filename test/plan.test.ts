import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRepair, rankUsable } from '../src/heal/plan.ts';
import type { NodeProbeResult } from '../src/probe/engine.ts';

function result(node: string, verdict: NodeProbeResult['verdict'], ttfbMs?: number): NodeProbeResult {
  return {
    node,
    verdict,
    reason: `${verdict}`,
    attempts: 1,
    ...(ttfbMs === undefined ? {} : { ttfbMs }),
  };
}

test('当前节点可用时保持不动（粘性策略核心）', () => {
  const plan = planRepair({
    current: 'A',
    currentResult: result('A', 'ok', 900),
    candidateResults: [result('B', 'ok', 100)],
  });
  assert.equal(plan.action, 'keep');
  assert.equal(plan.to, 'A');
  assert.match(plan.reason, /当前节点可用/);
});

test('当前节点不可用时切到实测可用节点', () => {
  const plan = planRepair({
    current: 'A',
    currentResult: result('A', 'blocked'),
    candidateResults: [result('B', 'ok', 400), result('C', 'ok', 120)],
  });
  assert.equal(plan.action, 'switch');
  assert.equal(plan.from, 'A');
  assert.equal(plan.to, 'C');
  assert.match(plan.reason, /当前节点不可用/);
});

test('当前节点是死节点时同样切换', () => {
  const plan = planRepair({
    current: 'A',
    currentResult: result('A', 'dead'),
    candidateResults: [result('B', 'ok', 300)],
  });
  assert.equal(plan.action, 'switch');
  assert.equal(plan.to, 'B');
});

test('国家受限的当前节点也要被换掉', () => {
  const plan = planRepair({
    current: 'A',
    currentResult: result('A', 'country-policy'),
    candidateResults: [result('B', 'ok', 300)],
  });
  assert.equal(plan.action, 'switch');
  assert.equal(plan.to, 'B');
});

test('没有可用候选时不改动并说明原因', () => {
  const plan = planRepair({
    current: 'A',
    currentResult: result('A', 'dead'),
    candidateResults: [result('B', 'dead'), result('C', 'blocked')],
  });
  assert.equal(plan.action, 'no-candidate');
  assert.equal(plan.from, 'A');
  assert.equal(plan.to, undefined);
  assert.match(plan.reason, /没有其它可用候选/);
});

test('当前没有选中成员时直接选最优候选', () => {
  const plan = planRepair({
    candidateResults: [result('B', 'ok', 500), result('C', 'ok', 200)],
  });
  assert.equal(plan.action, 'switch');
  assert.equal(plan.from, undefined);
  assert.equal(plan.to, 'C');
});

test('当前选中成员不是可探测节点时也走切换分支', () => {
  const plan = planRepair({
    current: 'SomeGroup',
    candidateResults: [result('B', 'ok', 500)],
  });
  assert.equal(plan.action, 'switch');
  assert.equal(plan.from, 'SomeGroup');
  assert.equal(plan.to, 'B');
});

test('完全没有任何候选时报告无可用节点', () => {
  const plan = planRepair({ candidateResults: [] });
  assert.equal(plan.action, 'no-candidate');
  assert.match(plan.reason, /没有可用候选节点/);
});

test('rankUsable 按耗时升序，未知耗时排在已知之后', () => {
  const ranked = rankUsable([
    result('A', 'ok'),
    result('B', 'ok', 300),
    result('C', 'blocked', 10),
    result('D', 'ok', 100),
  ]);
  assert.deepEqual(ranked.map((r) => r.node), ['D', 'B', 'A']);
});

test('rankUsable 在耗时相同时保持原有相对顺序', () => {
  const ranked = rankUsable([result('A', 'ok', 200), result('B', 'ok', 200)]);
  assert.deepEqual(ranked.map((r) => r.node), ['A', 'B']);
});
