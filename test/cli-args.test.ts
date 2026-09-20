import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli/index.ts';
import { EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE, EXIT_OK, EXIT_USAGE } from '../src/exit-codes.ts';

/** 捕获 main() 写到 stdout/stderr 的内容。 */
async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    outChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    errChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: outChunks.join(''), err: errChunks.join('') };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

test('--version 与 -v 都打印版本号', async () => {
  const long = await capture(['--version']);
  const short = await capture(['-v']);
  for (const result of [long, short]) {
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out.trim(), /^\d+\.\d+\.\d+$/);
  }
  assert.equal(long.out, short.out);
});

test('version 子命令已被移除，只提示正确的写法', async () => {
  const result = await capture(['version']);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /未知命令：version/);
  assert.match(result.err, /afc --version 或 afc -v/);
});

test('--help 与 help 子命令输出用法', async () => {
  for (const argv of [['--help'], ['-h'], ['help'], []]) {
    const result = await capture(argv);
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /用法：afc <命令>/);
    // 顶层帮助里应当写明退出码与关键选项
    assert.match(result.out, /--version/);
    assert.match(result.out, /--verbose/);
    assert.match(result.out, /退出码：0 成功/);
  }
});

test('顶层帮助保持精简（避免一次倒出所有细节）', async () => {
  const { out } = await capture(['--help']);
  const lines = out.trimEnd().split('\n').length;
  assert.ok(lines <= 26, `顶层帮助过长：${lines} 行`);
  // 细节应放到各命令自己的帮助里
  assert.doesNotMatch(out, /--country-deny/);
  assert.doesNotMatch(out, /--interval/);
});

test('afc <命令> --help 打印该命令的用法', async () => {
  const cases: [string, RegExp][] = [
    ['add', /用法：afc add <组名\|编号>/],
    ['remove', /用法：afc remove <组名\|编号>/],
    ['groups', /用法：afc groups/],
    ['doctor', /用法：afc doctor/],
    ['fix', /用法：afc fix/],
    ['schedule', /用法：afc schedule <install\|uninstall\|status>/],
  ];
  for (const [command, pattern] of cases) {
    const result = await capture([command, '--help']);
    assert.equal(result.code, EXIT_OK, `${command} --help 应成功`);
    assert.match(result.out, pattern, `${command} --help 应打印自己的用法`);
  }
});

test('groups --help 给出 --controller 的几种端点写法', async () => {
  const { out } = await capture(['groups', '--help']);
  assert.match(out, /--controller unix:\/tmp\/mihomo-party-<uid>-<pid>\.sock/);
  // Clash Verge Rev 的默认控制端口是 9097，不是 mihomo 惯例的 9090
  assert.match(out, /--controller 127\.0\.0\.1:9097 --secret/);
  // Windows 管道示例在模板字符串里，反斜杠极容易被吃掉（\v 会变成控制字符），
  // 这里用 String.raw 断言运行时的真实字面量，锁住它不被改坏。
  assert.ok(
    out.includes(String.raw`--controller 'pipe:\\.\pipe\verge-mihomo'`),
    '管道示例应带正确的反斜杠',
  );
  // Clash Party 的管道是「子目录」形式（\\.\pipe\MihomoParty\mihomo），写错直接连不上
  assert.ok(
    out.includes(String.raw`--controller 'pipe:\\.\pipe\MihomoParty\mihomo'`),
    'Clash Party 的管道示例应带正确的反斜杠与大小写',
  );
});

test('帮助里的退出码按数字升序排列且与实现一致', async () => {
  const { out } = await capture(['--help']);
  const line = out.split('\n').find((l) => l.startsWith('退出码：'));
  assert.ok(line, '帮助里应有退出码一行');
  const codes = [...line.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(codes, [EXIT_OK, EXIT_NO_USABLE_NODE, EXIT_ENVIRONMENT, EXIT_USAGE]);
  assert.deepEqual(codes, [...codes].sort((a, b) => a - b), '应按数值升序列出');
});

test('未知命令返回用法错误退出码', async () => {
  const result = await capture(['nosuchcommand']);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /未知命令/);
});

test('未知选项返回用法错误退出码', async () => {
  const result = await capture(['doctor', '--nope']);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /参数错误/);
});

test('schedule 的未知子命令返回用法错误退出码', async () => {
  const result = await capture(['schedule', 'nosuchsub']);
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /未知的 schedule 子命令/);
});
