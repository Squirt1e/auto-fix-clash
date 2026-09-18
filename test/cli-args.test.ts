import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli/index.ts';
import { EXIT_OK, EXIT_USAGE } from '../src/exit-codes.ts';

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

test('--version 与 -V 都打印版本号，且与 version 子命令一致', async () => {
  const long = await capture(['--version']);
  const short = await capture(['-V']);
  const sub = await capture(['version']);
  for (const result of [long, short, sub]) {
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out.trim(), /^\d+\.\d+\.\d+$/);
  }
  assert.equal(long.out, sub.out);
  assert.equal(short.out, sub.out);
});

test('--help 与 help 子命令输出用法', async () => {
  for (const argv of [['--help'], ['-h'], ['help'], []]) {
    const result = await capture(argv);
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /用法：afc <命令>/);
    // 帮助里应当写明退出码与关键选项
    assert.match(result.out, /--version/);
    assert.match(result.out, /--verbose/);
  }
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
