import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  groupsIndexPath,
  isGroupIndexArg,
  readGroupsIndex,
  resolveGroupArg,
  writeGroupsIndex,
} from '../src/cli/groups-index.ts';
import { EXIT_OK, EXIT_USAGE } from '../src/exit-codes.ts';

const pExecFile = promisify(execFile);

/**
 * 跑真实的 CLI 子进程。
 *
 * 刻意不用「替换 process.stdout.write」那种同进程捕获：node --test 自己也往 stdout
 * 写 TAP 事件流，两边的写会互相串（第一次就是栽在这里）。子进程也顺带验证了真实入口。
 */
async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const cli = new URL('../src/cli/index.ts', import.meta.url).pathname;
  try {
    const { stdout, stderr } = await pExecFile(process.execPath, [cli, ...args], { encoding: 'utf8' });
    return { code: EXIT_OK, out: stdout, err: stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : -1, out: e.stdout ?? '', err: e.stderr ?? '' };
  }
}

/** 备份/还原真实的编号缓存，免得测试污染开发者本机的那份。 */
function withIndexBackup<T>(fn: () => T): T {
  const path = groupsIndexPath();
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  try {
    return fn();
  } finally {
    if (existing === undefined) rmSync(path, { force: true });
    else writeFileSync(path, existing, 'utf8');
  }
}

test('isGroupIndexArg 只认纯数字', () => {
  assert.equal(isGroupIndexArg('3'), true);
  assert.equal(isGroupIndexArg(' 12 '), true);
  assert.equal(isGroupIndexArg('GPT'), false);
  assert.equal(isGroupIndexArg('3a'), false);
  assert.equal(isGroupIndexArg('-1'), false);
  assert.equal(isGroupIndexArg(''), false);
});

test('编号缓存写入与读取（编号跟随打印顺序，从 1 起）', () => {
  withIndexBackup(() => {
    writeGroupsIndex('tcp:127.0.0.1:9097', [
      { name: 'GPT', type: '手动选择' },
      { name: '🤖AI网站', type: '手动选择' },
      { name: '自动选择', type: '自动测速' },
    ]);
    const index = readGroupsIndex();
    assert.ok(index);
    assert.equal(index.endpoint, 'tcp:127.0.0.1:9097');
    assert.deepEqual(index.groups.map((g) => [g.index, g.name]), [
      [1, 'GPT'],
      [2, '🤖AI网站'],
      [3, '自动选择'],
    ]);
    assert.equal(resolveGroupArg('2'), '🤖AI网站');
    assert.equal(resolveGroupArg('GPT'), 'GPT', '不是数字就原样返回');
  });
});

test('编号超范围/没有缓存时给出可执行的下一步', () => {
  withIndexBackup(() => {
    rmSync(groupsIndexPath(), { force: true });
    assert.throws(() => resolveGroupArg('1'), (err: unknown) => {
      assert.match((err as Error).message, /没有编号 1 对应的组/);
      assert.match((err as Error).message, /先运行 afc groups/);
      return true;
    });

    writeGroupsIndex('tcp:127.0.0.1:9097', [{ name: 'GPT', type: '手动选择' }]);
    assert.throws(() => resolveGroupArg('9'), (err: unknown) => {
      assert.match((err as Error).message, /编号是 1–1/);
      return true;
    });
  });
});

test('缓存文件坏掉时当作没有缓存，而不是崩掉', () => {
  withIndexBackup(() => {
    writeFileSync(groupsIndexPath(), '{ 这不是 JSON', 'utf8');
    assert.equal(readGroupsIndex(), undefined);
    assert.throws(() => resolveGroupArg('1'), /还没有可用的编号/);
  });
});

test('afc groups 打印编号、结尾给出 add 提示，并且编号能直接喂给 afc add', async () => {
  // 两个组名都带 emoji：正是「手打很麻烦」的场景
  const proxies = {
    proxies: {
      GPT: { type: 'Selector', now: '🇺🇸 美国 01', all: ['🇺🇸 美国 01', '🇯🇵 日本 02'] },
      '🤖AI网站': { type: 'Selector', now: '🇯🇵 日本 02', all: ['🇺🇸 美国 01', '🇯🇵 日本 02'] },
      '🇺🇸 美国 01': { type: 'Shadowsocks' },
      '🇯🇵 日本 02': { type: 'Shadowsocks' },
    },
  };
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/version' ? '{"meta":true,"version":"v1.19.27"}' : JSON.stringify(proxies));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法取得端口');

  const dir = mkdtempSync(join(tmpdir(), 'afc-index-'));
  const configPath = join(dir, 'afc.config.yaml');
  writeFileSync(
    configPath,
    `controller:\n  endpoint: 127.0.0.1:${address.port}\nsecret: s\n` +
    'targets: []\n',
    'utf8',
  );

  try {
    await withIndexBackupAsync(async () => {
      const groups = await runCli(['groups', '--config', configPath]);
      assert.equal(groups.code, EXIT_OK);
      assert.match(groups.out, /^#\s+组名/m, '表头应有编号列');
      // 编号 = 打印顺序，两行都要有
      const lines = groups.out.split('\n').filter((l) => /^\d+\s/.test(l));
      assert.equal(lines.length, 2, groups.out);
      assert.match(lines[0]!, /^1\s/);
      assert.match(lines[1]!, /^2\s/);
      // 结尾要有能直接抄的 add 命令
      assert.match(groups.out, /afc add \d+\s+把该组交给 afc 管理/);
      assert.match(groups.out, /afc remove \d+/);
      assert.match(groups.out, /afc fix --group \d+/);

      // 编号缓存写下来了，顺序与打印一致
      const index = readGroupsIndex();
      const cached = index?.groups ?? [];
      assert.deepEqual(cached.map((g) => g.index), [1, 2]);
      assert.deepEqual(cached.map((g) => g.name).sort(), ['GPT', '🤖AI网站']);

      // 用编号 add：组名带 emoji，这条路径就是本功能的全部意义
      const emojiIndex = cached.find((g) => g.name === '🤖AI网站')!.index;
      // 注意这里只给 --config：add 必须自己读出那份配置里的 controller 段，
      // 否则「先 afc groups 拿编号，再 afc add 编号 --config 那份配置」这条最自然的路径会连不上
      const added = await runCli(['add', String(emojiIndex), '--config', configPath]);
      assert.equal(added.code, EXIT_OK, added.err);
      assert.match(added.out, /组名：🤖AI网站/);
      assert.match(readFileSync(configPath, 'utf8'), /🤖AI网站/);

      // 编号超范围时给出提示而不是静默失败
      const bad = await runCli(['add', '9', '--config', configPath]);
      assert.equal(bad.code, EXIT_USAGE);
      assert.match(bad.err, /没有编号 9 对应的组/);
    });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 与 withIndexBackup 相同，但支持 async 回调。 */
async function withIndexBackupAsync(fn: () => Promise<void>): Promise<void> {
  const path = groupsIndexPath();
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  try {
    await fn();
  } finally {
    if (existing === undefined) rmSync(path, { force: true });
    else writeFileSync(path, existing, 'utf8');
  }
}
