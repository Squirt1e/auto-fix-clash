import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import type { MihomoClient, ProxyInfo } from '../src/controller/client.ts';
import { repairGroup } from '../src/heal/repair.ts';
import type { NodeProbeResult, ProbeEngine, ProbePolicy } from '../src/probe/engine.ts';
import { summarize } from '../src/cli/commands/fix.ts';

const ok = (node: string): NodeProbeResult => ({
  node, verdict: 'ok', reason: 'ok', attempts: 1, ttfbMs: 20,
});

interface FakeClient {
  client: MihomoClient;
  selections: { group: string; node: string }[];
}

function fakeClient(latestNow = 'A'): FakeClient {
  const selections: { group: string; node: string }[] = [];
  const graph: Record<string, ProxyInfo> = {
    GPT: { name: 'GPT', type: 'Selector', now: 'A', all: ['A', 'B'] },
    A: { name: 'A', type: 'Shadowsocks' },
    B: { name: 'B', type: 'Shadowsocks' },
  };
  return {
    selections,
    client: {
      proxies: async () => graph,
      proxy: async (name: string) => ({ ...graph[name]!, now: latestNow }),
      select: async (group: string, node: string) => { selections.push({ group, node }); },
    } as unknown as MihomoClient,
  };
}

function withRuntimeConfig(run: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'afc-repair-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, `proxies:\n  - { name: A, type: ss, server: a, port: 1, cipher: aes-128-gcm, password: x }\n  - { name: B, type: ss, server: b, port: 2, cipher: aes-128-gcm, password: x }\n`, 'utf8');
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function policy(): ProbePolicy {
  const config = loadConfig();
  return { label: 'GPT', target: config.targets[0]!, confidence: 'service' };
}

function fakeEngine(chosen?: NodeProbeResult): ProbeEngine {
  return {
    probePolicies: async (node: string) => ok(node),
    findFirstUsableForAll: async () => ({
      ...(chosen ? { result: chosen } : {}),
      screened: 1,
      ...(chosen ? {} : { lastScreened: { node: 'B', verdict: 'blocked', reason: 'blocked', attempts: 1 } }),
    }),
    close: async () => {},
  } as unknown as ProbeEngine;
}

test('--force 找到其它可用节点时切换，即使当前节点健康', async () => {
  await withRuntimeConfig(async (runtimeConfigPath) => {
    const { client, selections } = fakeClient();
    const outcome = await repairGroup({
      config: loadConfig(), groupName: 'GPT', policies: [policy()], client,
      runtimeConfigPath, force: true, engineFactory: async () => fakeEngine(ok('B')),
    });
    assert.equal(outcome.plan.action, 'switch');
    assert.equal(outcome.plan.to, 'B');
    assert.deepEqual(selections, [{ group: 'GPT', node: 'B' }]);
  });
});

test('--force 没有其它可用节点时保持原选择', async () => {
  await withRuntimeConfig(async (runtimeConfigPath) => {
    const { client, selections } = fakeClient();
    const outcome = await repairGroup({
      config: loadConfig(), groupName: 'GPT', policies: [policy()], client,
      runtimeConfigPath, force: true, engineFactory: async () => fakeEngine(),
    });
    assert.equal(outcome.plan.action, 'no-candidate');
    assert.deepEqual(selections, []);
  });
});

test('探测期间用户改了选择时不覆盖新选择', async () => {
  await withRuntimeConfig(async (runtimeConfigPath) => {
    const { client, selections } = fakeClient('USER-CHOICE');
    const outcome = await repairGroup({
      config: loadConfig(), groupName: 'GPT', policies: [policy()], client,
      runtimeConfigPath, force: true, engineFactory: async () => fakeEngine(ok('B')),
    });
    assert.equal(outcome.plan.action, 'stale');
    assert.deepEqual(selections, []);
  });
});

test('选择竞争会被明确报告为未覆盖用户操作', () => {
  const text = summarize({
    group: 'GPT', applied: false, probedNodes: 1, candidatesConsidered: 2,
    plan: { action: 'stale', from: 'A', to: 'USER-CHOICE', reason: 'changed' },
  }, false);
  assert.match(text, /选择已变化/);
  assert.match(text, /USER-CHOICE/);
});
