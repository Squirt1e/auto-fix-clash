import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { findGroupName, loadConfig, targetGroupNames } from '../src/config.ts';
import { ConfigError } from '../src/config.ts';
import { findNodeDefinitions } from '../src/paths.ts';

/** 造一个假的客户端数据目录：work/config.yaml（无内联节点）+ profiles/*.yaml（订阅档案） */
function fakeClientDir(options: { runtimeProxies?: string[]; profiles?: { name: string; nodes: string[] }[] }): string {
  const dir = mkdtempSync(join(tmpdir(), 'afc-defs-'));
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  writeFileSync(
    join(work, 'config.yaml'),
    stringifyYaml({
      'external-controller': '127.0.0.1:9090',
      proxies: (options.runtimeProxies ?? []).map((name) => ({ name, type: 'socks5', server: '127.0.0.1', port: 1080 })),
      'proxy-providers': options.runtimeProxies === undefined
        ? { sub: { type: 'http', url: 'https://example.com/sub', path: './providers/sub.yaml' } }
        : {},
    }),
    'utf8',
  );
  if (options.profiles) {
    const profiles = join(dir, 'profiles');
    mkdirSync(profiles, { recursive: true });
    for (const profile of options.profiles) {
      writeFileSync(
        join(profiles, `${profile.name}.yaml`),
        stringifyYaml({
          proxies: profile.nodes.map((name) => ({ name, type: 'socks5', server: '127.0.0.1', port: 1080 })),
        }),
        'utf8',
      );
    }
  }
  return dir;
}

test('别名匹配：不同订阅的组名不同也能命中', () => {
  const config = loadConfig(join(import.meta.dirname, 'fixtures', 'minimal.yaml'));
  const gpt = config.targets[0]!;
  // 不写死完整别名列表（以后还会扩充），只校验关键性质
  const names = targetGroupNames(gpt);
  assert.equal(names[0], 'GPT', '主名必须排在第一位');
  assert.ok(names.includes('ChatGPT'), '应包含常见别名');
  assert.ok(names.length > 1);
  assert.equal(findGroupName(gpt, ['Proxy', 'ChatGPT', 'Netflix']), 'ChatGPT');
  assert.equal(findGroupName(gpt, ['Proxy', 'Netflix']), undefined);
  // 主名优先于别名
  assert.equal(findGroupName(gpt, ['ChatGPT', 'GPT']), 'GPT');
});

test('同名组被多个目标声明时配置被拒绝（含别名冲突）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-cfg-'));
  try {
    const path = join(dir, 'conflict.yaml');
    writeFileSync(
      path,
      stringifyYaml({
        targets: [
          { name: 'GPT', aliases: ['AI', 'ChatGPT'], probe: { url: 'https://a.example.com/', expectedStatus: [200] } },
          { name: 'Netflix', aliases: ['ChatGPT'], probe: { url: 'https://b.example.com/', expectedStatus: [200] } },
        ],
      }),
      'utf8',
    );
    assert.throws(() => loadConfig(path), (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match((err as ConfigError).message, /被多个目标使用/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('运行时配置里有内联节点时直接使用它', () => {
  const dir = fakeClientDir({ runtimeProxies: ['节点A', '节点B'] });
  try {
    const source = findNodeDefinitions({
      runtimeConfigPath: join(dir, 'work', 'config.yaml'),
      neededNodeNames: ['节点A'],
    });
    assert.equal(source.kind, 'runtime-config');
    assert.deepEqual(source.nodeNames, ['节点A', '节点B']);
    assert.equal(source.usesProxyProviders, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('运行时配置无内联节点时，从订阅档案里按重合度找到正确的那份', () => {
  const dir = fakeClientDir({
    runtimeProxies: undefined, // 节点由 proxy-providers 下发
    profiles: [
      { name: 'other-subscription', nodes: ['别的节点1', '别的节点2'] },
      { name: 'current-subscription', nodes: ['香港 01', '日本 01', '日本 02'] },
    ],
  });
  try {
    const source = findNodeDefinitions({
      runtimeConfigPath: join(dir, 'work', 'config.yaml'),
      neededNodeNames: ['日本 01', '日本 02'],
    });
    assert.equal(source.kind, 'profile-file');
    assert.match(source.path, /current-subscription\.yaml$/);
    assert.deepEqual(source.nodeNames, ['香港 01', '日本 01', '日本 02']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('找不到任何匹配的节点定义时给出可诊断的错误', () => {
  const dir = fakeClientDir({ runtimeProxies: undefined, profiles: [{ name: 'x', nodes: ['无关节点'] }] });
  try {
    assert.throws(
      () => findNodeDefinitions({
        runtimeConfigPath: join(dir, 'work', 'config.yaml'),
        neededNodeNames: ['日本 01'],
      }),
      /找不到可用的节点定义/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('没有指定所需节点名时，退回「取第一个有节点的文件」', () => {
  const dir = fakeClientDir({ runtimeProxies: ['节点A'] });
  try {
    const source = findNodeDefinitions({ runtimeConfigPath: join(dir, 'work', 'config.yaml') });
    assert.equal(source.kind, 'runtime-config');
    assert.equal(source.nodeNames.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
