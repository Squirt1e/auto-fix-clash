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

test('通配范围按规则顺序确认精确、后缀和 MATCH 的所有不同组', () => {
  const result = resolveDomainRoutes(
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

test('禁用规则不参与路由，较早的精确规则不受较晚不透明规则影响', () => {
  const result = resolveDomainRoutes(
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

test('更早的不透明规则使受影响的见证域名无法确认', () => {
  const result = resolveDomainRoutes(
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

test('多个见证域名落到同一最终组时合并且保留全部依据', () => {
  const result = resolveDomainRoutes(
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

test('DIRECT、REJECT 和自动组只报告跳过，不安排修复', () => {
  const graph = proxies({
    AUTO: { name: 'AUTO', type: 'URLTest', now: 'A', all: ['A'] },
  });
  for (const policy of ['DIRECT', 'REJECT', 'AUTO']) {
    const result = resolveDomainRoutes(
      [parseDomainPattern('example.com')],
      [rule(0, 'DOMAIN', 'example.com', policy)],
      graph,
      'rule',
    );
    assert.equal(result.bindings.length, 0, policy);
    assert.equal(result.issues[0]?.kind, 'policy-skipped', policy);
  }
});

test('非 rule 模式不会假装完成了规则解析', () => {
  for (const mode of ['global', 'direct']) {
    const result = resolveDomainRoutes(
      [parseDomainPattern('example.com')],
      [rule(0, 'MATCH', '', 'DEFAULT')],
      proxies(),
      mode,
    );
    assert.equal(result.bindings.length, 0);
    assert.equal(result.issues[0]?.kind, 'unsupported-mode');
  }
});
