import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAutoTargets } from '../src/targets/auto.ts';
import { genericTarget, matchPreset, presetToTarget } from '../src/targets/presets.ts';
import type { TargetConfig } from '../src/config.ts';
import type { ProxyInfo } from '../src/controller/client.ts';

const node = (name: string): ProxyInfo => ({ name, type: 'Shadowsocks' });
const selector = (name: string, now: string, all: string[]): ProxyInfo => ({
  name, type: 'Selector', now, all,
});

/** 造一份 /proxies 视图。 */
function proxies(...infos: ProxyInfo[]): Record<string, ProxyInfo> {
  return Object.fromEntries(infos.map((i) => [i.name, i]));
}

const GPT_TARGET: TargetConfig = {
  name: 'GPT',
  aliases: ['ChatGPT'],
  probe: { url: 'https://chatgpt.com/backend-api/codex/responses', expectedStatus: [405] },
  extraProbes: [],
  countryAllow: [],
  countryDeny: ['HK'],
};

test('配置里声明的组优先，且标为 configured', () => {
  const all = proxies(
    node('日本 01'),
    selector('GPT', '日本 01', ['日本 01']),
  );
  const { targets } = expandAutoTargets([GPT_TARGET], all);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.groupName, 'GPT');
  assert.equal(targets[0]!.source, 'configured');
  // 判据来自配置（含 countryDeny）
  assert.deepEqual(targets[0]!.target.countryDeny, ['HK']);
});

test('配置的组在当前订阅不存在时进 skipped 而不是报错', () => {
  const all = proxies(node('日本 01'), selector('Proxy', '自动选择', ['自动选择', '日本 01']));
  const { targets, skipped } = expandAutoTargets([GPT_TARGET], all);
  assert.equal(targets.length, 0);
  assert.equal(skipped[0]!.groupName, 'GPT');
  assert.match(skipped[0]!.reason, /当前订阅里没有这个组/);
});

test('指向 DIRECT / REJECT 的组绝不接管', () => {
  const all = proxies(
    node('日本 01'),
    selector('Bilibili', 'DIRECT', ['DIRECT', '日本 01']),
    selector('去广告', 'REJECT', ['REJECT']),
  );
  const { targets, skipped } = expandAutoTargets([], all);
  assert.equal(targets.length, 0);
  assert.equal(skipped.length, 2);
  for (const s of skipped) assert.match(s.reason, /尊重你的设置/);
});

test('委托给其它组的组不接管（内核自己维护）', () => {
  // 贴近真实订阅：Proxy → 自动选择（URLTest），Youtube → Proxy
  const all = proxies(
    node('日本 01'),
    { name: '自动选择', type: 'URLTest', now: '日本 01', all: ['日本 01'] },
    selector('Proxy', '自动选择', ['自动选择', '日本 01']),
    selector('Youtube', 'Proxy', ['Proxy', '日本 01']),
  );
  const { targets, skipped } = expandAutoTargets([], all);
  assert.equal(targets.length, 0);
  assert.match(skipped.find((s) => s.groupName === 'Youtube')!.reason, /委托给 Proxy/);
  assert.match(skipped.find((s) => s.groupName === 'Proxy')!.reason, /委托给 自动选择/);
  assert.match(skipped.find((s) => s.groupName === '自动选择')!.reason, /自动测速类/);
});

test('自动测速类组不接管', () => {
  const all = proxies(
    { name: '自动选择', type: 'URLTest', now: '日本 01', all: ['日本 01'] },
    { name: '故障转移', type: 'Fallback', now: '日本 01', all: ['日本 01'] },
    node('日本 01'),
  );
  const { targets, skipped } = expandAutoTargets([], all);
  assert.equal(targets.length, 0);
  assert.equal(skipped.length, 2);
  for (const s of skipped) assert.match(s.reason, /自动测速类/);
});

test('手动钉了节点且命中高可信预设 → 用预设判据', () => {
  const all = proxies(
    node('日本 01'),
    selector('🤖AI网站', '日本 01', ['日本 01']),
  );
  const { targets } = expandAutoTargets([], all);
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.source, 'preset');
  assert.equal(targets[0]!.target.probe.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.ok(targets[0]!.target.countryDeny.includes('HK'));
});

test('命中低可信预设（流媒体）不自动接管，退回通用可达性判据', () => {
  const all = proxies(
    node('美国 01'),
    selector('Netflix', '美国 01', ['美国 01']),
  );
  const { targets } = expandAutoTargets([], all);
  assert.equal(targets.length, 1);
  // 关键：不能因为组名叫 Netflix 就用"首页返回 200"这种判不出解锁的判据
  assert.equal(targets[0]!.source, 'generic');
  assert.deepEqual(targets[0]!.target.probe, genericTarget('Netflix').probe);
});

test('手动钉了节点但没有预设 → 通用可达性判据（只在彻底不通时才换）', () => {
  const all = proxies(
    node('日本 01'),
    selector('某个自定义组', '日本 01', ['日本 01']),
  );
  const { targets } = expandAutoTargets([], all);
  assert.equal(targets[0]!.source, 'generic');
  assert.match(targets[0]!.note, /只在节点彻底不通时才换/);
  // 通用判据不带国家策略：不会因为出口国家把用户特意选的节点换掉
  assert.deepEqual(targets[0]!.target.countryDeny, []);
  assert.deepEqual(targets[0]!.target.countryAllow, []);
});

test('没有选中节点的组被跳过', () => {
  const all = proxies({ name: '空组', type: 'Selector', all: ['日本 01'] }, node('日本 01'));
  const { targets, skipped } = expandAutoTargets([], all);
  assert.equal(targets.length, 0);
  assert.match(skipped[0]!.reason, /没有选中节点/);
});

test('预设匹配能吸收 emoji 前缀与大小写', () => {
  assert.equal(matchPreset('🤖AI网站')?.name, 'GPT');
  assert.equal(matchPreset('chatgpt')?.name, 'GPT');
  assert.equal(matchPreset('Telegram')?.confidence, 'high');
  assert.equal(matchPreset('🎬Netflix')?.confidence, 'low');
  assert.equal(matchPreset('完全不认识的组'), undefined);
});

test('presetToTarget 生成的组名与判据一致', () => {
  const preset = matchPreset('Telegram')!;
  const target = presetToTarget(preset, 'TG 专用');
  assert.equal(target.name, 'TG 专用');
  assert.equal(target.probe.url, preset.probe.url);
});
