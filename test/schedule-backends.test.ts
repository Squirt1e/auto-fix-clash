import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCronEntry,
  buildServiceUnit,
  buildTimerUnit,
  CRON_MARKER,
} from '../src/schedule/systemd.ts';
import {
  buildCreateArgs,
  buildTaskCommand,
  intervalToMinutes,
  parseQuery,
  TASK_NAME,
} from '../src/schedule/schtasks.ts';
import {
  scheduleCliArgs,
  scheduleLogDir,
  scheduleLogFiles,
  SCHEDULE_MIN_INTERVAL_SECONDS,
  type ScheduleOptions,
} from '../src/schedule/types.ts';
import { getScheduleBackend, defaultBackendName } from '../src/schedule/index.ts';
import { currentPlatform, type PlatformContext } from '../src/platform.ts';

const OPTIONS: ScheduleOptions = {
  nodePath: '/usr/bin/node',
  cliPath: '/opt/afc/src/cli/index.ts',
  intervalSeconds: 300,
  workingDirectory: '/opt/afc',
  logDir: '/var/log/afc',
};

const ctx = (platform: 'darwin' | 'linux' | 'win32'): PlatformContext => ({
  platform,
  home: platform === 'win32' ? 'C:\\Users\\tester' : '/home/tester',
  env: platform === 'win32' ? { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' } : {},
});

test('scheduleCliArgs：固定跑 fix --all --quiet，按需带上配置文件与日志', () => {
  assert.deepEqual(scheduleCliArgs(OPTIONS), ['fix', '--all', '--quiet']);
  assert.deepEqual(scheduleCliArgs({ ...OPTIONS, configPath: '/opt/afc/afc.config.yaml' }), [
    'fix', '--all', '--quiet', '--config', '/opt/afc/afc.config.yaml',
  ]);
  assert.deepEqual(scheduleCliArgs(OPTIONS, '/var/log/afc/heal.log').slice(-2), ['--log-file', '/var/log/afc/heal.log']);
});

test('日志目录按平台落在各自约定位置', () => {
  assert.equal(scheduleLogDir(ctx('darwin')), '/home/tester/Library/Logs/afc');
  assert.equal(scheduleLogDir(ctx('linux')), '/home/tester/.local/state/afc');
  assert.equal(scheduleLogDir(ctx('win32')), 'C:\\Users\\tester\\AppData\\Local\\afc\\logs');
  assert.equal(scheduleLogFiles(ctx('linux'), '/tmp/x').out, '/tmp/x/heal.log');
});

test('systemd service 单元包含工作目录、执行命令与日志重定向', () => {
  const unit = buildServiceUnit(OPTIONS);
  assert.match(unit, /\[Service\]/);
  assert.match(unit, /Type=oneshot/);
  assert.match(unit, /WorkingDirectory=\/opt\/afc/);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/afc\/src\/cli\/index\.ts fix --all --quiet/);
  assert.match(unit, /StandardOutput=append:\/var\/log\/afc\/heal\.log/);
  assert.match(unit, /StandardError=append:\/var\/log\/afc\/heal\.err\.log/);
});

test('systemd service 会为含空格的路径加引号', () => {
  const unit = buildServiceUnit({
    ...OPTIONS,
    cliPath: '/Users/me/My Tools/src/cli/index.ts',
    workingDirectory: '/Users/me/My Tools',
  });
  assert.match(unit, /ExecStart=\/usr\/bin\/node "\/Users\/me\/My Tools\/src\/cli\/index\.ts" fix --all --quiet/);
});

test('systemd timer 单元带间隔与 Persistent', () => {
  const timer = buildTimerUnit(600);
  assert.match(timer, /OnUnitActiveSec=600s/);
  assert.match(timer, /Persistent=true/);
  assert.match(timer, /WantedBy=timers\.target/);
});

test('cron 兜底条目带标记、分钟换算与日志重定向', () => {
  const lines = buildCronEntry(OPTIONS);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], CRON_MARKER);
  assert.match(lines[1]!, /^\*\/5 \* \* \* \* /, '300 秒应换算成每 5 分钟');
  assert.match(lines[1]!, /cd "\/opt\/afc"/);
  assert.match(lines[1]!, /fix --all --quiet/);
  assert.match(lines[1]!, />> "\/var\/log\/afc\/heal\.log" 2>> "\/var\/log\/afc\/heal\.err\.log"/);
});

test('cron 条目的间隔最少 1 分钟', () => {
  assert.match(buildCronEntry({ ...OPTIONS, intervalSeconds: 60 })[1]!, /^\*\/1 /);
  assert.match(buildCronEntry({ ...OPTIONS, intervalSeconds: 90 })[1]!, /^\*\/2 /, '不足 2 分钟按四舍五入');
});

test('schtasks：/MO 按分钟换算并校验范围', () => {
  assert.equal(intervalToMinutes(60), 1);
  assert.equal(intervalToMinutes(300), 5);
  assert.equal(intervalToMinutes(3599), 60);
  assert.throws(() => intervalToMinutes(SCHEDULE_MIN_INTERVAL_SECONDS - 1), /间隔必须是/);
  assert.throws(() => intervalToMinutes(200000), /最多 1439 分钟/);
});

test('schtasks：创建参数包含任务名、命令行与覆盖标志', () => {
  const args = buildCreateArgs({ ...OPTIONS, logDir: 'C:\\afc\\logs' });
  assert.equal(args[0], '/Create');
  assert.ok(args.includes(TASK_NAME));
  assert.deepEqual(args.slice(args.indexOf('/SC'), args.indexOf('/SC') + 2), ['/SC', 'MINUTE']);
  assert.deepEqual(args.slice(args.indexOf('/MO'), args.indexOf('/MO') + 2), ['/MO', '5']);
  assert.ok(args.includes('/F'), '应带 /F 保证幂等');
});

test('schtasks：含空格的路径会被正确引用，并把日志交给 --log-file', () => {
  const command = buildTaskCommand({
    ...OPTIONS,
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    cliPath: 'C:\\afc\\dist\\cli\\index.js',
    logDir: 'C:\\afc\\logs',
  });
  assert.ok(command.startsWith('"C:\\Program Files\\nodejs\\node.exe"'), `含空格的 node 路径要加引号，实际：${command}`);
  assert.match(command, /--log-file/);
});

test('schtasks：查询输出可解析出安装状态与最近结果', () => {
  const installed = parseQuery('TaskName:       \\auto-fix-clash-heal\nNext Run Time:  2026/9/19 4:00:00\nLast Result:    0\n');
  assert.equal(installed.installed, true);
  assert.equal(installed.lastResult, '0');

  const missing = parseQuery('ERROR: The system cannot find the file specified.');
  assert.equal(missing.installed, false);
});

test('后端按平台选择，并且能强制指定', async () => {
  assert.equal((await getScheduleBackend('launchd', ctx('darwin'))).name, 'launchd');
  assert.equal((await getScheduleBackend('cron', ctx('linux'))).name, 'cron');
  assert.match((await getScheduleBackend('schtasks', ctx('win32'))).name, /schtasks/);
  assert.match((await getScheduleBackend('systemd', ctx('linux'))).name, /systemd/);
  // auto 在 darwin/win32 上是确定的（linux 取决于有没有 systemd，不在单测里断言）
  assert.equal((await getScheduleBackend('auto', ctx('darwin'))).name, 'launchd');
  assert.equal((await getScheduleBackend('auto', ctx('win32'))).name, '任务计划程序（schtasks）');
});

test('defaultBackendName 能给出当前平台默认后端的说明', () => {
  assert.equal(defaultBackendName(ctx('darwin')), 'launchd');
  assert.match(defaultBackendName(ctx('win32')), /任务计划程序/);
  assert.match(defaultBackendName(ctx('linux')), /systemd/);
  assert.ok(currentPlatform().platform.length > 0);
});
