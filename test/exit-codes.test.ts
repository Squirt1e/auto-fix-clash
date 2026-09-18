import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, requireTarget } from '../src/config.ts';
import { UsageError } from '../src/errors.ts';
import { GroupNotSwitchableError } from '../src/heal/repair.ts';
import { EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE, EXIT_OK, EXIT_USAGE } from '../src/exit-codes.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('退出码四个类别互不相同，便于脚本区分', () => {
  const codes = [EXIT_OK, EXIT_USAGE, EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE];
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(EXIT_OK, 0);
});

test('未配置的组名属于「用法错误」而不是「环境故障」', () => {
  const config = loadConfig(join(FIXTURES, 'minimal.yaml'));
  assert.throws(
    () => requireTarget(config, '不存在的组'),
    (err: unknown) => {
      assert.ok(err instanceof UsageError, `期望 UsageError，实际 ${(err as Error).name}`);
      assert.match((err as Error).message, /没有为代理组/);
      return true;
    },
  );
});

test('组类型不可切换也归为「用法错误」（需要用户改配置）', () => {
  const err = new GroupNotSwitchableError('GPT', 'URLTest');
  assert.ok(err instanceof UsageError);
  assert.match(err.message, /不是可稳定指定的 Selector/);
});

test('环境故障类错误不是 UsageError（走另一个退出码）', () => {
  const err = new Error('找不到 mihomo 内核二进制');
  assert.ok(!(err instanceof UsageError));
});
