import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ConfigError, DEFAULT_TARGETS, loadConfig, requireTarget, resolveConfigPath } from '../src/config.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => join(FIXTURES, name);

test('加载完整配置文件', () => {
  const config = loadConfig(fixture('minimal.yaml'));
  assert.equal(config.probe.concurrency, 1);
  assert.equal(config.probe.retries, 0);
  assert.equal(config.schedule.intervalSeconds, 120);
  assert.equal(config.targets.length, 1);
  assert.equal(config.sourcePath, fixture('minimal.yaml'));
});

test('组名命中内置预设时补齐附加判据与出口判据', () => {
  const config = loadConfig(fixture('minimal.yaml'));
  const gpt = config.targets[0]!;
  // 预设里的附加端点与出口探测被保留
  assert.equal(gpt.extraProbes.length, 1);
  assert.equal(gpt.geoProbe?.url, 'https://chatgpt.com/cdn-cgi/trace');
  assert.ok(gpt.countryDeny.includes('HK'));
  // 主判据以配置文件为准
  assert.deepEqual(gpt.probe.expectedStatus, [405]);
});

test('未找到配置文件时使用内置预设', () => {
  const config = loadConfig(fixture('minimal.yaml'));
  assert.ok(config.targets.length > 0);
  const builtin = DEFAULT_TARGETS[0]!;
  assert.equal(builtin.name, 'GPT');
  assert.deepEqual(builtin.probe.expectedStatus, [405]);
  assert.deepEqual(builtin.extraProbes[0]!.expectedStatus, [401]);
});

test('非法期望状态码会被拒绝并给出定位', () => {
  assert.throws(
    () => loadConfig(fixture('bad-status.yaml')),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.match((err as ConfigError).message, /expectedStatus/);
      return true;
    },
  );
});

test('重复组名会被拒绝', () => {
  assert.throws(() => loadConfig(fixture('duplicate-targets.yaml')), /重复的组名/);
});

test('计划任务间隔过小会被拒绝', () => {
  assert.throws(() => loadConfig(fixture('bad-schedule.yaml')), /intervalSeconds 必须是 >= 60/);
});

test('显式指定的配置文件不存在时报错', () => {
  assert.throws(() => loadConfig(fixture('nope.yaml')), /不存在/);
});

test('未配置的组会给出配置指引', () => {
  const config = loadConfig(fixture('minimal.yaml'));
  assert.throws(() => requireTarget(config, 'Netflix'), /没有为代理组 “Netflix” 配置探测目标/);
  assert.equal(requireTarget(config, 'GPT').name, 'GPT');
});

test('resolveConfigPath 在显式路径存在时返回绝对路径', () => {
  const resolved = resolveConfigPath(fixture('minimal.yaml'));
  assert.ok(resolved?.endsWith('minimal.yaml'));
});
