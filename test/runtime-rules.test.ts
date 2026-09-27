import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MihomoRule } from '../src/controller/client.ts';
import {
  enrichLiveRules,
  loadRuntimeRuleMetadata,
  parseRuntimeRuleMetadata,
} from '../src/routes/runtime-rules.ts';

const live = (index: number, type: string, payload: string, proxy: string): MihomoRule => ({
  index, type, payload, proxy, size: -1,
});

test('运行时规则解析保留 no-resolve 并把普通规则标为 false', () => {
  assert.deepEqual(parseRuntimeRuleMetadata([
    'IP-CIDR,0.0.0.0/8,DIRECT,no-resolve',
    'IP-CIDR,1.1.1.0/24,PROXY',
  ]), [
    { index: 0, type: 'IP-CIDR', payload: '0.0.0.0/8', proxy: 'DIRECT', noResolve: true },
    { index: 1, type: 'IP-CIDR', payload: '1.1.1.0/24', proxy: 'PROXY', noResolve: false },
  ]);
});

test('规则 payload 中的逗号不会被误认成策略或修饰符', () => {
  assert.deepEqual(parseRuntimeRuleMetadata([
    'DOMAIN-REGEX,^foo,(bar|baz)$,PROXY,no-resolve',
    { unsupported: true },
  ]), [{
    index: 0,
    type: 'DOMAIN-REGEX',
    payload: '^foo,(bar|baz)$',
    proxy: 'PROXY',
    noResolve: true,
  }]);
});

test('只给索引和规范化签名完全对齐的实时规则补充修饰符', () => {
  const metadata = parseRuntimeRuleMetadata([
    'DOMAIN-SUFFIX,Example.COM,MEDIA',
    'IP-CIDR,0.0.0.0/8,DIRECT,no-resolve',
  ]);
  const enriched = enrichLiveRules([
    live(0, 'DomainSuffix', 'example.com', 'MEDIA'),
    live(1, 'IPCIDR', '0.0.0.0/8', 'DIRECT'),
    live(2, 'IPCIDR', '10.0.0.0/8', 'DIRECT'),
  ], metadata);
  assert.equal(enriched[0]?.noResolve, false);
  assert.equal(enriched[1]?.noResolve, true);
  assert.equal(enriched[2]?.noResolve, undefined);

  const mismatched = enrichLiveRules([
    live(0, 'IPCIDR', '0.0.0.0/8', 'OTHER'),
  ], metadata);
  assert.equal(mismatched[0]?.noResolve, undefined);
});

test('mihomo 把 IP-CIDR6 回报为 IPCIDR 时仍能对齐 no-resolve', () => {
  const metadata = parseRuntimeRuleMetadata([
    'IP-CIDR6,::1/128,DIRECT,no-resolve',
  ]);

  const enriched = enrichLiveRules([
    live(0, 'IPCIDR', '::1/128', 'DIRECT'),
  ], metadata);

  assert.equal(enriched[0]?.noResolve, true);
});

test('从显式运行时配置读取规则快照', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-runtime-rules-'));
  const path = join(dir, 'config.yaml');
  try {
    writeFileSync(path, 'rules:\n  - IP-CIDR,0.0.0.0/8,DIRECT,no-resolve\n', 'utf8');
    assert.deepEqual(loadRuntimeRuleMetadata(path), {
      path,
      rules: [{ index: 0, type: 'IP-CIDR', payload: '0.0.0.0/8', proxy: 'DIRECT', noResolve: true }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
