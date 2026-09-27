import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MihomoRule, ProxyInfo } from '../src/controller/client.ts';
import { resolveDomainRoutes, resolvePolicy } from '../src/routes/resolver.ts';
import { parseDomainPattern } from '../src/targets/domain.ts';

const rule = (index: number, type: string, payload: string, proxy: string, disabled = false): MihomoRule => ({
  index, type, payload, proxy, size: -1, ...(disabled ? { extra: { disabled: true } } : {}),
});

function proxies(extra: Record<string, ProxyInfo> = {}): Record<string, ProxyInfo> {
  return {
    API: { name: 'API', type: 'Selector', now: 'A', all: ['A'] },
    MEDIA: { name: 'MEDIA', type: 'Selector', now: 'A', all: ['A'] },
    DEFAULT: { name: 'DEFAULT', type: 'Selector', now: 'A', all: ['A'] },
    A: { name: 'A', type: 'Shadowsocks' },
    ...extra,
  };
}

test('通配范围按规则顺序确认精确、后缀和 MATCH 的所有不同组', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('*.example.com')],
    [
      rule(0, 'DOMAIN', 'api.example.com', 'API'),
      rule(1, 'DOMAIN-SUFFIX', 'media.example.com', 'MEDIA'),
      rule(2, 'MATCH', '', 'DEFAULT'),
    ],
    proxies(),
    'rule',
  );
  assert.deepEqual(result.bindings.map((binding) => binding.group).sort(), ['API', 'DEFAULT', 'MEDIA']);
  assert.equal(result.issues.length, 0);
  assert.ok(result.bindings.every((binding) => binding.evidence.length >= 1));
});

test('接受 mihomo API 的 DomainSuffix 规则名', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('*.example.com')],
    [rule(0, 'DomainSuffix', 'example.com', 'MEDIA')],
    proxies(),
    'rule',
  );
  assert.deepEqual(result.bindings.map((binding) => binding.group), ['MEDIA']);
  assert.equal(result.issues.length, 0);
});

test('精确规则遮住后缀裸域时仍会为后缀子域和 MATCH 分区建见证', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('*.example.com')],
    [
      rule(0, 'DOMAIN', 'media.example.com', 'API'),
      rule(1, 'DOMAIN-SUFFIX', 'media.example.com', 'MEDIA'),
      rule(2, 'MATCH', '', 'DEFAULT'),
    ],
    proxies(),
    'rule',
  );
  assert.deepEqual(result.bindings.map((binding) => binding.group).sort(), ['API', 'DEFAULT', 'MEDIA']);
  assert.equal(result.issues.length, 0);
});

test('MATCH 见证不会落入更窄的后缀分区', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('*.example.com')],
    [
      rule(0, 'DOMAIN', 'example.com', 'API'),
      rule(1, 'DOMAIN-SUFFIX', 'afc-route-probe.example.com', 'MEDIA'),
      rule(2, 'MATCH', '', 'DEFAULT'),
    ],
    proxies(),
    'rule',
  );
  assert.deepEqual(result.bindings.map((binding) => binding.group).sort(), ['API', 'DEFAULT', 'MEDIA']);
});

test('禁用规则不参与路由，较早的精确规则不受较晚不透明规则影响', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('api.example.com')],
    [
      rule(0, 'DOMAIN', 'api.example.com', 'API'),
      rule(1, 'RULE-SET', 'opaque', 'DEFAULT'),
      rule(2, 'DOMAIN', 'api.example.com', 'MEDIA', true),
    ],
    proxies(),
    'rule',
  );
  assert.deepEqual(result.bindings.map((binding) => binding.group), ['API']);
  assert.equal(result.issues.length, 0);
});

test('更早的不透明规则使受影响的见证域名无法确认', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('*.example.com')],
    [
      rule(0, 'RULE-SET', 'private', 'PRIVATE'),
      rule(1, 'DOMAIN-SUFFIX', 'example.com', 'API'),
    ],
    proxies(),
    'rule',
  );
  assert.equal(result.bindings.length, 0);
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.every((issue) => issue.kind === 'unresolved-rule'));
});

test('多个见证域名落到同一最终组时合并且保留全部依据', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('*.example.com')],
    [
      rule(0, 'DOMAIN', 'api.example.com', 'API'),
      rule(1, 'DOMAIN-SUFFIX', 'media.example.com', 'API'),
      rule(2, 'MATCH', '', 'API'),
    ],
    proxies(),
    'rule',
  );
  assert.equal(result.bindings.length, 1);
  assert.equal(result.bindings[0]!.group, 'API');
  assert.ok(result.bindings[0]!.evidence.length >= 3);
});

test('委托链选择最深 Selector，并检测循环', () => {
  const delegated = proxies({
    OUTER: { name: 'OUTER', type: 'Selector', now: 'INNER', all: ['INNER', 'A'] },
    INNER: { name: 'INNER', type: 'Selector', now: 'A', all: ['A'] },
  });
  assert.equal(resolvePolicy('OUTER', delegated).group, 'INNER');

  const cyclic = proxies({
    LOOP_A: { name: 'LOOP_A', type: 'Selector', now: 'LOOP_B', all: ['LOOP_B'] },
    LOOP_B: { name: 'LOOP_B', type: 'Selector', now: 'LOOP_A', all: ['LOOP_A'] },
  });
  assert.equal(resolvePolicy('LOOP_A', cyclic).issue?.kind, 'group-cycle');
});

test('DIRECT、REJECT 和自动组只报告跳过，不安排修复', async () => {
  const graph = proxies({
    AUTO: { name: 'AUTO', type: 'URLTest', now: 'A', all: ['A'] },
  });
  for (const policy of ['DIRECT', 'REJECT', 'AUTO']) {
    const result = await resolveDomainRoutes(
      [parseDomainPattern('example.com')],
      [rule(0, 'DOMAIN', 'example.com', policy)],
      graph,
      'rule',
    );
    assert.equal(result.bindings.length, 0, policy);
    assert.equal(result.issues[0]?.kind, 'policy-skipped', policy);
  }
});

test('非 rule 模式不会假装完成了规则解析', async () => {
  for (const mode of ['global', 'direct']) {
    const result = await resolveDomainRoutes(
      [parseDomainPattern('example.com')],
      [rule(0, 'MATCH', '', 'DEFAULT')],
      proxies(),
      mode,
    );
    assert.equal(result.bindings.length, 0);
    assert.equal(result.issues[0]?.kind, 'unsupported-mode');
  }
});

test('已确认 no-resolve 的 IP 规则不会遮住后续域名规则', async () => {
  const ipRule = { ...rule(7, 'IPCIDR', '0.0.0.0/8', 'DIRECT'), noResolve: true };
  const result = await resolveDomainRoutes(
    [parseDomainPattern('chatgpt.com')],
    [ipRule, rule(1903, 'DomainSuffix', 'chatgpt.com', 'MEDIA')],
    proxies(),
    'rule',
  );
  assert.deepEqual(result.bindings.map((binding) => binding.group), ['MEDIA']);
  assert.deepEqual(result.issues, []);
});

test('IP 规则缺少运行时修饰符证据时仍保持不确定', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('chatgpt.com')],
    [rule(7, 'IPCIDR', '0.0.0.0/8', 'DIRECT'), rule(1903, 'DomainSuffix', 'chatgpt.com', 'MEDIA')],
    proxies(),
    'rule',
  );
  assert.equal(result.bindings.length, 0);
  assert.equal(result.issues[0]?.ruleIndex, 7);
  assert.match(result.issues[0]?.reason ?? '', /规则 #8/);
});

test('关键字、通配符和正则域名规则遵守首次命中顺序', async () => {
  const cases = [
    rule(0, 'DomainKeyword', 'chat', 'API'),
    rule(0, 'DomainWildcard', '*.chatgpt.com', 'API'),
    rule(0, 'DomainRegex', '^chatgpt\\.com$', 'API'),
  ];
  for (const first of cases) {
    const result = await resolveDomainRoutes(
      [parseDomainPattern(first.type === 'DomainWildcard' ? 'api.chatgpt.com' : 'chatgpt.com')],
      [first, rule(1, 'MATCH', '', 'DEFAULT')],
      proxies(),
      'rule',
    );
    assert.deepEqual(result.bindings.map((binding) => binding.group), ['API'], first.type);
  }
});

test('非法域名正则明确报告不确定而不是崩溃或跳过', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('chatgpt.com')],
    [rule(4, 'DomainRegex', '[', 'API'), rule(5, 'MATCH', '', 'DEFAULT')],
    proxies(),
    'rule',
  );
  assert.equal(result.bindings.length, 0);
  assert.equal(result.issues[0]?.ruleIndex, 4);
  assert.match(result.issues[0]?.reason ?? '', /规则 #5.*正则/);
});

test('普通 CIDR 未命中时继续到域名规则，命中时采用 CIDR 策略', async () => {
  const cidr = { ...rule(0, 'IPCIDR', '10.0.0.0/8', 'API'), noResolve: false };
  const miss = await resolveDomainRoutes(
    [parseDomainPattern('chatgpt.com')],
    [cidr, rule(1, 'DomainSuffix', 'chatgpt.com', 'MEDIA')],
    proxies(),
    'rule',
    { resolveAddresses: async () => ['23.101.24.70'] },
  );
  assert.deepEqual(miss.bindings.map((binding) => binding.group), ['MEDIA']);

  const hit = await resolveDomainRoutes(
    [parseDomainPattern('chatgpt.com')],
    [{ ...rule(0, 'IPCIDR', '23.0.0.0/8', 'API'), noResolve: false }, rule(1, 'MATCH', '', 'DEFAULT')],
    proxies(),
    'rule',
    { resolveAddresses: async () => ['23.101.24.70'] },
  );
  assert.deepEqual(hit.bindings.map((binding) => binding.group), ['API']);
});

test('多个 DNS 地址只有在最终策略一致时才确认并保留各自规则依据', async () => {
  const rules = [
    { ...rule(0, 'IPCIDR', '10.0.0.0/8', 'API'), noResolve: false },
    { ...rule(1, 'IPCIDR', '192.168.0.0/16', 'API'), noResolve: false },
    rule(2, 'MATCH', '', 'DEFAULT'),
  ];
  const result = await resolveDomainRoutes(
    [parseDomainPattern('example.com')], rules, proxies(), 'rule',
    { resolveAddresses: async () => ['10.0.0.1', '192.168.1.1'] },
  );
  assert.deepEqual(result.bindings.map((binding) => binding.group), ['API']);
  assert.deepEqual(result.bindings[0]?.evidence.map((evidence) => evidence.rule.index), [0, 1]);
});

test('多个 DNS 地址落到不同策略时保持不确定', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('example.com')],
    [
      { ...rule(0, 'IPCIDR', '10.0.0.0/8', 'API'), noResolve: false },
      { ...rule(1, 'IPCIDR', '192.168.0.0/16', 'MEDIA'), noResolve: false },
      rule(2, 'MATCH', '', 'DEFAULT'),
    ],
    proxies(), 'rule',
    { resolveAddresses: async () => ['10.0.0.1', '192.168.1.1'] },
  );
  assert.equal(result.bindings.length, 0);
  assert.match(result.issues[0]?.reason ?? '', /DNS.*不同策略/);
});

test('DNS 空结果或查询失败时保持不确定', async () => {
  for (const implementation of [
    async (): Promise<string[]> => [],
    async (): Promise<string[]> => { throw new Error('resolver down'); },
  ]) {
    let calls = 0;
    const resolveAddresses = async (): Promise<string[]> => {
      calls += 1;
      return await implementation();
    };
    const result = await resolveDomainRoutes(
      [parseDomainPattern('example.com')],
      [{ ...rule(0, 'IPCIDR', '10.0.0.0/8', 'API'), noResolve: false }, rule(1, 'MATCH', '', 'DEFAULT')],
      proxies(), 'rule', { resolveAddresses },
    );
    assert.equal(result.bindings.length, 0);
    assert.match(result.issues[0]?.reason ?? '', /DNS/);
    assert.equal(calls, 1);
  }
});

test('前序 IP 规则触发解析后，后续 no-resolve 规则使用已有地址', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('example.com')],
    [
      { ...rule(0, 'IPCIDR', '10.0.0.0/8', 'API'), noResolve: false },
      { ...rule(1, 'IPCIDR', '192.168.0.0/16', 'MEDIA'), noResolve: true },
      rule(2, 'MATCH', '', 'DEFAULT'),
    ],
    proxies(), 'rule',
    { resolveAddresses: async () => ['192.168.1.1'] },
  );
  assert.deepEqual(result.bindings.map((binding) => binding.group), ['MEDIA']);
});

test('非法 CIDR 明确报告不确定', async () => {
  const result = await resolveDomainRoutes(
    [parseDomainPattern('example.com')],
    [{ ...rule(3, 'IPCIDR', '10.0.0.0/99', 'API'), noResolve: false }, rule(4, 'MATCH', '', 'DEFAULT')],
    proxies(), 'rule',
    { resolveAddresses: async () => ['10.0.0.1'] },
  );
  assert.equal(result.bindings.length, 0);
  assert.match(result.issues[0]?.reason ?? '', /规则 #4.*CIDR/);
});
