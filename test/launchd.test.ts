import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlist, LAUNCHD_LABEL, logDir, logPath, plistPath } from '../src/schedule/launchd.ts';
import { installSchedule } from '../src/schedule/launchd.ts';

const baseOptions = {
  nodePath: '/usr/local/bin/node',
  cliPath: '/Users/x/auto-fix-clash/src/cli/index.ts',
  intervalSeconds: 300,
  workingDirectory: '/Users/x/auto-fix-clash',
  logDir: '/Users/x/Library/Logs/afc',
};

test('plist 包含标签、间隔、日志与工作目录', () => {
  const plist = buildPlist(baseOptions);
  assert.match(plist, new RegExp(`<string>${LAUNCHD_LABEL}</string>`));
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>\/Users\/x\/auto-fix-clash<\/string>/);
  assert.match(plist, /heal\.log/);
  assert.match(plist, /heal\.err\.log/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

test('plist 的参数以 fix --all --quiet 运行', () => {
  const plist = buildPlist(baseOptions);
  const section = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  assert.ok(section, 'plist 中应有 ProgramArguments 数组');
  const args = [...section.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(args, [
    '/usr/local/bin/node',
    '/Users/x/auto-fix-clash/src/cli/index.ts',
    'fix',
    '--all',
    '--quiet',
  ]);
});

test('指定配置文件时会被写入计划任务（后台没有 cwd 上下文）', () => {
  const plist = buildPlist({ ...baseOptions, configPath: '/Users/x/custom.yaml' });
  assert.match(plist, /--config/);
  assert.match(plist, /\/Users\/x\/custom\.yaml/);
});

test('不带配置文件时不写入 --config', () => {
  const plist = buildPlist(baseOptions);
  assert.doesNotMatch(plist, /--config/);
});

test('路径中的特殊字符会被转义，避免破坏 plist', () => {
  const plist = buildPlist({ ...baseOptions, workingDirectory: '/tmp/a&b<c>' });
  assert.match(plist, /\/tmp\/a&amp;b&lt;c&gt;/);
});

test('间隔小于下限时在触碰调度器之前就被拒绝', async () => {
  await assert.rejects(
    () => installSchedule({ ...baseOptions, intervalSeconds: 10 }),
    /间隔必须是 >= 60 秒的整数/,
  );
});

test('计划任务与日志路径位于用户目录下', () => {
  assert.match(plistPath(), /Library\/LaunchAgents\/com\.auto-fix-clash\.heal\.plist$/);
  assert.match(logPath(), /Library\/Logs\/afc\/heal\.log$/);
  assert.match(logDir(), /Library\/Logs\/afc$/);
});
