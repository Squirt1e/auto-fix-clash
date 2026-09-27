import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, type AfcConfig } from '../src/config.ts';
import type { MihomoClient, MihomoRule, ProxyInfo } from '../src/controller/client.ts';
import { EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE, EXIT_OK } from '../src/exit-codes.ts';
import type { GroupRepairOptions, RepairOutcome } from '../src/heal/repair.ts';
import { policyForDomain, repairDomains } from '../src/heal/domain-repair.ts';
import { formatRouteBinding } from '../src/cli/commands/fix.ts';
import { DEFAULT_DOMAIN_TARGETS, type DomainTargetConfig } from '../src/targets/domain.ts';

const rule = (index: number, type: string, payload: string, proxy: string): MihomoRule => ({
  index, type, payload, proxy, size: -1,
});

function graph(): Record<string, ProxyInfo> {
  return {
    GPT: { name: 'GPT', type: 'Selector', now: 'A', all: ['A', 'B'] },
    DEFAULT: { name: 'DEFAULT', type: 'Selector', now: 'A', all: ['A', 'B'] },
    A: { name: 'A', type: 'Shadowsocks' },
    B: { name: 'B', type: 'Shadowsocks' },
  };
}

function fakeClient(rules: MihomoRule[]): MihomoClient {
  const proxies = graph();
  return {
    configs: async () => ({ mode: 'rule' }),
    rules: async () => rules,
    proxies: async () => proxies,
  } as unknown as MihomoClient;
}

const domain = (pattern: string): DomainTargetConfig => ({
  pattern, extraProbes: [], countryAllow: [], countryDeny: [],
});

const kept = (group: string): RepairOutcome => ({
  group, applied: false, probedNodes: 1, candidatesConsidered: 2,
  plan: { action: 'keep', to: 'A', reason: 'ok' },
});

test('每个确认组只修复一次，同组的多个域名判据会合并', async () => {
  const calls: GroupRepairOptions[] = [];
  const report = await repairDomains({
    config: loadConfig(),
    targets: [domain('chatgpt.com'), domain('api.openai.com'), domain('other.example')],
    client: fakeClient([
      rule(0, 'DOMAIN', 'chatgpt.com', 'GPT'),
      rule(1, 'DOMAIN', 'api.openai.com', 'GPT'),
      rule(2, 'MATCH', '', 'DEFAULT'),
    ]),
    repairer: async (options) => { calls.push(options); return kept(options.groupName); },
  });
  assert.deepEqual(calls.map((call) => call.groupName).sort(), ['DEFAULT', 'GPT']);
  assert.equal(calls.find((call) => call.groupName === 'GPT')?.policies.length, 3);
  assert.equal(report.exitCode, EXIT_OK);
});

test('不透明规则造成退出码 3，但不隐藏此前已确认组的成功结果', async () => {
  const report = await repairDomains({
    config: loadConfig(),
    targets: [domain('api.example.com'), domain('opaque.example.com')],
    client: fakeClient([
      rule(0, 'DOMAIN', 'api.example.com', 'GPT'),
      rule(1, 'RULE-SET', 'opaque', 'DEFAULT'),
      rule(2, 'MATCH', '', 'DEFAULT'),
    ]),
    repairer: async (options) => kept(options.groupName),
  });
  assert.equal(report.outcomes.length, 1);
  assert.equal(report.outcomes[0]?.group, 'GPT');
  assert.equal(report.exitCode, EXIT_ENVIRONMENT);
  assert.equal(report.issues[0]?.kind, 'unresolved-rule');
});

test('协调器用运行时 no-resolve 证据越过私网规则并修复域名组', async () => {
  const report = await repairDomains({
    config: loadConfig(),
    targets: [domain('chatgpt.com')],
    client: fakeClient([
      rule(7, 'IPCIDR', '0.0.0.0/8', 'DIRECT'),
      rule(1903, 'DomainSuffix', 'chatgpt.com', 'GPT'),
    ]),
    runtimeRules: [
      { index: 7, type: 'IP-CIDR', payload: '0.0.0.0/8', proxy: 'DIRECT', noResolve: true },
      { index: 1903, type: 'DOMAIN-SUFFIX', payload: 'chatgpt.com', proxy: 'GPT', noResolve: false },
    ],
    repairer: async (options) => kept(options.groupName),
  });
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(report.outcomes.map((outcome) => outcome.group), ['GPT']);
  assert.deepEqual(report.issues, []);
});

test('协调器把 mihomo DNS 交给普通 IP-CIDR 路由判定', async () => {
  const client = fakeClient([
    rule(0, 'IPCIDR', '23.0.0.0/8', 'GPT'),
    rule(1, 'MATCH', '', 'DEFAULT'),
  ]) as unknown as MihomoClient & { resolveHost: (host: string) => Promise<string[]> };
  client.resolveHost = async (host) => {
    assert.equal(host, 'chatgpt.com');
    return ['23.101.24.70'];
  };
  const report = await repairDomains({
    config: loadConfig(),
    targets: [domain('chatgpt.com')],
    client,
    runtimeRules: [
      { index: 0, type: 'IP-CIDR', payload: '23.0.0.0/8', proxy: 'GPT', noResolve: false },
      { index: 1, type: 'MATCH', payload: '', proxy: 'DEFAULT', noResolve: false },
    ],
    repairer: async (options) => kept(options.groupName),
  });
  assert.equal(report.exitCode, EXIT_OK);
  assert.deepEqual(report.outcomes.map((outcome) => outcome.group), ['GPT']);
});

test('任一组没有替代节点时聚合为退出码 2', async () => {
  const report = await repairDomains({
    config: loadConfig(), targets: [domain('example.com')],
    client: fakeClient([rule(0, 'MATCH', '', 'DEFAULT')]),
    repairer: async (options) => ({
      ...kept(options.groupName),
      plan: { action: 'no-candidate', from: 'A', reason: 'none' },
    }),
  });
  assert.equal(report.exitCode, EXIT_NO_USABLE_NODE);
});

test('探测策略优先使用显式覆盖，其次 ChatGPT 服务判据，最后通用 HTTPS 可达性', () => {
  const explicit = policyForDomain({
    ...domain('api.example.com'),
    probe: { url: 'https://probe.example/status', expectedStatus: [204] },
  }, 'api.example.com');
  assert.equal(explicit.target.probe.url, 'https://probe.example/status');
  assert.equal(explicit.confidence, 'service');

  const chatgpt = policyForDomain(domain('*.chatgpt.com'), 'chatgpt.com');
  assert.equal(chatgpt.target.probe.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(chatgpt.confidence, 'service');

  const generic = policyForDomain(domain('example.com'), 'example.com');
  assert.deepEqual(generic.target.probe, { url: 'https://example.com/', expectedStatus: [200, 399], method: 'GET' });
  assert.equal(generic.confidence, 'reachability');
});

test('域名模式要求主判据通过，并把附加端点拆成独立必需判据', async () => {
  const target = DEFAULT_DOMAIN_TARGETS[0]!;
  const calls: GroupRepairOptions[] = [];
  await repairDomains({
    config: loadConfig(), targets: [target],
    client: fakeClient([rule(0, 'MATCH', '', 'GPT')]),
    repairer: async (options) => { calls.push(options); return kept(options.groupName); },
  });
  const policies = calls[0]!.policies;
  assert.equal(policies.length, 2);
  assert.equal(policies[0]!.target.probe.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(policies[0]!.target.extraProbes, []);
  assert.equal(policies[1]!.target.probe.url, 'https://api.openai.com/v1/models');
});

test('通用通配符只探测用户给出的裸域，不探测合成路由见证', async () => {
  const calls: GroupRepairOptions[] = [];
  await repairDomains({
    config: loadConfig(), targets: [domain('*.example.com')],
    client: fakeClient([rule(0, 'MATCH', '', 'DEFAULT')]),
    repairer: async (options) => { calls.push(options); return kept(options.groupName); },
  });
  assert.deepEqual(
    [...new Set(calls.flatMap((call) => call.policies.map((policy) => policy.target.probe.url)))],
    ['https://example.com/'],
  );
});

test('无主判据的显式出口覆盖会合并到服务预设', () => {
  const policy = policyForDomain({
    ...domain('*.chatgpt.com'),
    geoProbe: { url: 'https://geo.example/trace', format: 'cloudflare-trace' },
    countryAllow: ['US'],
    countryDeny: ['CN'],
  }, 'chatgpt.com');
  assert.equal(policy.target.geoProbe?.url, 'https://geo.example/trace');
  assert.deepEqual(policy.target.countryAllow, ['US']);
  assert.deepEqual(policy.target.countryDeny, ['CN']);
});

test('协调器只读取一次实时配置、规则和代理表，并透传 force', async () => {
  const counts = { configs: 0, rules: 0, proxies: 0 };
  let seenForce = false;
  const base = fakeClient([rule(0, 'MATCH', '', 'DEFAULT')]) as unknown as Record<string, (...args: unknown[]) => unknown>;
  const client = {
    configs: async () => { counts.configs += 1; return await base['configs']!(); },
    rules: async () => { counts.rules += 1; return await base['rules']!(); },
    proxies: async () => { counts.proxies += 1; return await base['proxies']!(); },
  } as unknown as MihomoClient;
  await repairDomains({
    config: loadConfig(), targets: [domain('example.com')], client, force: true,
    repairer: async (options) => { seenForce = options.force === true; return kept(options.groupName); },
  });
  assert.deepEqual(counts, { configs: 1, rules: 1, proxies: 1 });
  assert.equal(seenForce, true);
});

test('选择竞争导致 stale 时聚合为不完整退出码 3', async () => {
  const report = await repairDomains({
    config: loadConfig(), targets: [domain('example.com')],
    client: fakeClient([rule(0, 'MATCH', '', 'DEFAULT')]),
    repairer: async (options) => ({
      ...kept(options.groupName),
      plan: { action: 'stale', from: 'A', to: 'USER', reason: 'changed' },
    }),
  });
  assert.equal(report.exitCode, EXIT_ENVIRONMENT);
});

test('路由输出包含域名、规则依据、代理组和判据可信度', async () => {
  const target = domain('example.com');
  const report = await repairDomains({
    config: loadConfig(), targets: [target],
    client: fakeClient([rule(0, 'MATCH', '', 'DEFAULT')]),
    repairer: async (options) => kept(options.groupName),
  });
  const text = formatRouteBinding(report.bindings[0]!, [target]);
  assert.match(text, /example\.com → DEFAULT/);
  assert.match(text, /规则 #0 MATCH/);
  assert.match(text, /只能证明 HTTPS 可达/);
});
