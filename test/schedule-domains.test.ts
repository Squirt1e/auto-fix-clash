import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as scheduleCommand from '../src/cli/commands/schedule.ts';
import { loadConfig } from '../src/config.ts';
import { EXIT_OK, EXIT_USAGE } from '../src/exit-codes.ts';
import type { PlatformContext } from '../src/platform.ts';

const { run } = scheduleCommand;

async function captureRun(positionals: string[], values: Record<string, unknown>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const oldOut = process.stdout.write.bind(process.stdout);
  const oldErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return { code: await run({ positionals, values }), out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = oldOut;
    process.stderr.write = oldErr;
  }
}

test('schedule add 首次写入时保留隐式 ChatGPT 默认目标', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-schedule-add-'));
  const path = join(dir, 'config.yaml');
  try {
    const result = await captureRun(['add', 'example.com'], { config: path });
    assert.equal(result.code, EXIT_OK);
    assert.deepEqual(loadConfig(path).domains.map((target) => target.pattern), ['*.chatgpt.com', 'example.com']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schedule remove 会归一化域名并在删除末项后留下空数组', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-schedule-remove-'));
  const path = join(dir, 'config.yaml');
  try {
    writeFileSync(path, 'domains:\n  - pattern: "*.chatgpt.com"\ntargets: []\n', 'utf8');
    const result = await captureRun(['remove', '*.CHATGPT.com.'], { config: path });
    assert.equal(result.code, EXIT_OK);
    assert.deepEqual(loadConfig(path).domains, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schedule remove 能删除配置文件中展示的隐式默认域名', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-schedule-remove-default-'));
  const path = join(dir, 'config.yaml');
  try {
    writeFileSync(path, 'targets: []\n', 'utf8');
    const listed = await captureRun(['list'], { config: path });
    assert.match(listed.out, /1\. \*\.chatgpt\.com/);

    const removed = await captureRun(['remove', '*.chatgpt.com'], { config: path });
    assert.equal(removed.code, EXIT_OK);
    assert.deepEqual(loadConfig(path).domains, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schedule remove 接受列表序号并拒绝越界序号', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-schedule-remove-index-'));
  const path = join(dir, 'config.yaml');
  try {
    writeFileSync(path, 'domains:\n  - pattern: one.example\n  - pattern: two.example\ntargets: []\n', 'utf8');
    const listed = await captureRun(['list'], { config: path });
    assert.match(listed.out, /1\. one\.example/);
    assert.match(listed.out, /2\. two\.example/);

    const removed = await captureRun(['remove', '2'], { config: path });
    assert.equal(removed.code, EXIT_OK);
    assert.deepEqual(loadConfig(path).domains.map((target) => target.pattern), ['one.example']);

    const outOfRange = await captureRun(['remove', '2'], { config: path });
    assert.equal(outOfRange.code, EXIT_USAGE);
    assert.match(outOfRange.err, /序号 2 不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schedule add 拒绝重复域名和不成对的探测参数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-schedule-invalid-'));
  const path = join(dir, 'config.yaml');
  try {
    assert.equal((await captureRun(['add', 'example.com'], { config: path, url: 'https://example.com/' })).code, EXIT_USAGE);
    assert.equal((await captureRun(['add', 'example.com'], { config: path })).code, EXIT_OK);
    const duplicate = await captureRun(['add', 'EXAMPLE.com.'], { config: path });
    assert.equal(duplicate.code, EXIT_USAGE);
    assert.match(duplicate.err, /已经登记/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schedule add 的自定义判据和国家黑名单可往返加载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-schedule-probe-'));
  const path = join(dir, 'config.yaml');
  try {
    const result = await captureRun(['add', 'api.example.com'], {
      config: path,
      url: 'https://probe.example/status',
      expect: '200,204',
      'country-deny': 'cn,hk',
    });
    assert.equal(result.code, EXIT_OK);
    const target = loadConfig(path).domains.find((item) => item.pattern === 'api.example.com')!;
    assert.deepEqual(target.probe?.expectedStatus, [200, 204]);
    assert.deepEqual(target.countryDeny, ['CN', 'HK']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schedule list 区分内置默认、显式空列表与配置文件来源', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-schedule-list-'));
  const path = join(dir, 'config.yaml');
  const oldCwd = process.cwd();
  const oldHome = process.env['HOME'];
  const oldAppData = process.env['APPDATA'];
  try {
    process.chdir(dir);
    process.env['HOME'] = dir;
    process.env['APPDATA'] = dir;
    const builtin = await captureRun(['list'], {});
    assert.equal(builtin.code, EXIT_OK);
    assert.match(builtin.out, /\*\.chatgpt\.com/);
    assert.match(builtin.out, /内置默认/);

    writeFileSync(path, 'domains: []\ntargets: []\n', 'utf8');
    const empty = await captureRun(['list'], { config: path });
    assert.match(empty.out, /没有登记/);
    assert.match(empty.out, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    process.chdir(oldCwd);
    if (oldHome === undefined) delete process.env['HOME']; else process.env['HOME'] = oldHome;
    if (oldAppData === undefined) delete process.env['APPDATA']; else process.env['APPDATA'] = oldAppData;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('schedule install dry-run 会固定到稳定配置路径但不提前创建文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-schedule-install-'));
  const path = join(dir, 'new-config.yaml');
  try {
    const result = await captureRun(['install'], { config: path, 'dry-run': true, backend: 'launchd' });
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result.out, /fix<\/string>\s*<string>--scheduled/);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('计划任务元数据记录实际配置，并能识别调用者查看了另一份配置', () => {
  assert.equal(typeof scheduleCommand.writeScheduleMetadata, 'function');
  assert.equal(typeof scheduleCommand.readScheduleMetadata, 'function');
  assert.equal(typeof scheduleCommand.configPathMismatchWarning, 'function');
  assert.equal(typeof scheduleCommand.resolveScheduleConfigArgument, 'function');
  const dir = mkdtempSync(join(tmpdir(), 'afc-schedule-meta-'));
  const ctx: PlatformContext = { platform: 'linux', home: dir, env: { XDG_STATE_HOME: dir } };
  try {
    scheduleCommand.writeScheduleMetadata(ctx, '/configs/active.yaml');
    assert.deepEqual(scheduleCommand.readScheduleMetadata(ctx), { configPath: '/configs/active.yaml' });
    assert.equal(scheduleCommand.resolveScheduleConfigArgument(undefined, ctx), '/configs/active.yaml');
    assert.equal(scheduleCommand.resolveScheduleConfigArgument('/configs/other.yaml', ctx), '/configs/other.yaml');
    assert.match(scheduleCommand.configPathMismatchWarning('/configs/active.yaml', '/configs/other.yaml') ?? '', /仍使用.*active\.yaml/);
    assert.equal(scheduleCommand.configPathMismatchWarning('/configs/active.yaml', '/configs/active.yaml'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
