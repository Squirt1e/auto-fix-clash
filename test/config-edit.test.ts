import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  addTargetToConfigText,
  removeTargetFromConfigText,
  renderTargetBlock,
  writeConfigText,
} from '../src/config-edit.ts';
import { loadConfig, type TargetConfig } from '../src/config.ts';
import { parseExpectedStatus, resolveWritePath } from '../src/cli/commands/add.ts';
import { afcConfigPath, currentPlatform } from '../src/platform.ts';

const TARGET: TargetConfig = {
  name: 'Netflix',
  aliases: [],
  probe: { url: 'https://www.netflix.com/', expectedStatus: [200, 301] },
  extraProbes: [],
  geoProbe: { url: 'https://chatgpt.com/cdn-cgi/trace', format: 'cloudflare-trace' },
  countryAllow: [],
  countryDeny: ['HK'],
};

const SAMPLE = `# 顶部注释
probe:
  concurrency: 2

schedule:
  intervalSeconds: 300

targets:
  - name: GPT
    probe:
      url: https://example.com/gpt
      expectedStatus: [405]
`;

test('新条目插进 targets 段，其它段落与注释不受影响', () => {
  const out = addTargetToConfigText(SAMPLE, TARGET);
  const doc = parseYaml(out) as Record<string, unknown>;
  assert.deepEqual((doc['targets'] as { name: string }[]).map((t) => t.name), ['GPT', 'Netflix']);
  assert.equal((doc['schedule'] as { intervalSeconds: number }).intervalSeconds, 300);
  assert.equal(out.startsWith('# 顶部注释'), true, '顶部注释应保留');
  assert.equal(out.split('#').length, SAMPLE.split('#').length, '注释数量不应变化');
});

test('没有 targets 段时追加一个新段', () => {
  const out = addTargetToConfigText('probe:\n  concurrency: 2\n', TARGET);
  const doc = parseYaml(out) as Record<string, unknown>;
  assert.deepEqual((doc['targets'] as { name: string }[]).map((t) => t.name), ['Netflix']);
  assert.equal((doc['probe'] as { concurrency: number }).concurrency, 2);
});

test('targets 是空数组时先展开再插入', () => {
  const out = addTargetToConfigText('targets: []\n', TARGET);
  const doc = parseYaml(out) as Record<string, unknown>;
  assert.deepEqual((doc['targets'] as { name: string }[]).map((t) => t.name), ['Netflix']);
});

test('空配置也能写入', () => {
  const out = addTargetToConfigText('', TARGET);
  assert.deepEqual((parseYaml(out) as { targets: { name: string }[] }).targets.map((t) => t.name), ['Netflix']);
});

test('删除条目时其它条目与段落保持完整', () => {
  const withTwo = addTargetToConfigText(SAMPLE, TARGET);
  const out = removeTargetFromConfigText(withTwo, ['Netflix'])!;
  const doc = parseYaml(out) as Record<string, unknown>;
  assert.deepEqual((doc['targets'] as { name: string }[]).map((t) => t.name), ['GPT']);
  assert.equal((doc['schedule'] as { intervalSeconds: number }).intervalSeconds, 300);
});

test('删掉最后一条时写成 targets: []，不留悬空键', () => {
  const out = removeTargetFromConfigText(SAMPLE, ['GPT'])!;
  const doc = parseYaml(out) as Record<string, unknown>;
  assert.deepEqual(doc['targets'], [], 'targets 应是空数组而不是 null');
  assert.equal((doc['schedule'] as { intervalSeconds: number }).intervalSeconds, 300);
  // 空 targets 是合法配置（表示不在配置里声明任何目标）
  assert.deepEqual(doc['targets'], []);
});

test('按别名也能删除条目', () => {
  const target: TargetConfig = { ...TARGET, name: 'GPT', aliases: ['ChatGPT'] };
  const text = addTargetToConfigText('targets: []\n', target);
  const out = removeTargetFromConfigText(text, ['GPT', 'ChatGPT'])!;
  assert.deepEqual((parseYaml(out) as { targets: unknown[] }).targets, []);
});

test('删除不存在的条目返回 undefined', () => {
  assert.equal(removeTargetFromConfigText(SAMPLE, ['不存在']), undefined);
});

test('组名里含特殊字符时会被正确引用', () => {
  const block = renderTargetBlock({ ...TARGET, name: '我的组: 测试 #1' });
  const doc = parseYaml(block) as { name: string }[];
  assert.equal(doc[0]!.name, '我的组: 测试 #1');
});

test('emoji 组名无需引号也能解析', () => {
  const block = renderTargetBlock({ ...TARGET, name: '🤖AI网站' });
  assert.equal((parseYaml(block) as { name: string }[])[0]!.name, '🤖AI网站');
});

test('writeConfigText 会校验内容，非法内容不落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-edit-'));
  try {
    const path = join(dir, 'afc.config.yaml');
    const result = writeConfigText(path, addTargetToConfigText(SAMPLE, TARGET));
    assert.equal(result.created, true);
    assert.equal(loadConfig(path).targets.map((t) => t.name).join(','), 'GPT,Netflix');

    // 非法内容（targets 不是数组）应当抛错且不留文件
    const bad = join(dir, 'bad.yaml');
    assert.throws(() => writeConfigText(bad, 'targets: 不是数组\n'), /配置有误/);
    assert.equal(existsSync(bad), false, '校验失败不应创建文件');
    assert.equal(readFileSync(path, 'utf8').includes('Netflix'), true, '已有文件不应被破坏');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseExpectedStatus 支持单值、枚举与区间', () => {
  assert.deepEqual(parseExpectedStatus('200'), [200]);
  assert.deepEqual(parseExpectedStatus('200,301,302'), [200, 301, 302]);
  assert.deepEqual(parseExpectedStatus('200-299'), [200, 299]);
  assert.throws(() => parseExpectedStatus('abc'), /100–599/);
  assert.throws(() => parseExpectedStatus('299-200'), /升序/);
  assert.throws(() => parseExpectedStatus(''), /不能为空/);
});

test('写入后配置文件能被完整加载（含 probe/schedule 段）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-edit2-'));
  try {
    const path = join(dir, 'afc.config.yaml');
    writeFileSync(path, SAMPLE, 'utf8');
    writeConfigText(path, addTargetToConfigText(SAMPLE, TARGET));
    const config = loadConfig(path);
    assert.equal(config.probe.concurrency, 2);
    assert.equal(config.schedule.intervalSeconds, 300);
    assert.deepEqual(config.targets.map((t) => t.name), ['GPT', 'Netflix']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('没有现成配置时写到固定的用户级路径，而不是当前目录', () => {
  // 实测踩过的坑：按 cwd 新建会在不同目录各生成一份配置，
  // 计划任务指向哪一份变得不可预期。这里把 HOME 与 cwd 都隔离出来验证。
  // macOS 上 /var 是 /private/var 的符号链接，而 resolve() 会归一化路径，
  // 这里先把临时目录取成真实路径，避免与断言里的字符串形态不一致。
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'afc-cwd-')));
  const fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'afc-home-')));
  const oldHome = process.env['HOME'];
  const oldAppData = process.env['APPDATA'];
  const oldCwd = process.cwd();
  process.env['HOME'] = fakeHome;
  // Windows 上没有 HOME，配置位置取决于 APPDATA
  process.env['APPDATA'] = fakeHome;
  process.chdir(dir);
  try {
    // 期望值用同一条平台规则算出来，避免在 Windows 上写死 POSIX 路径
    const expected = join(afcConfigPath(currentPlatform()));
    assert.equal(resolveWritePath(), expected);
    // 当前目录已有配置时应当优先使用它（项目内管理配置的用法）
    writeFileSync(join(dir, 'afc.config.yaml'), 'targets: []\n', 'utf8');
    assert.equal(resolveWritePath(), join(dir, 'afc.config.yaml'));
    // 显式指定优先于一切
    assert.equal(resolveWritePath('/tmp/explicit.yaml'), '/tmp/explicit.yaml');
  } finally {
    if (oldHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = oldHome;
    if (oldAppData === undefined) delete process.env['APPDATA'];
    else process.env['APPDATA'] = oldAppData;
    process.chdir(oldCwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
