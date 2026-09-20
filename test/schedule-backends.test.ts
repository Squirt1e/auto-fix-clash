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
  parseQueryCsv,
  parseScheduledTaskJson,
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

test('schtasks：状态取自 PowerShell 的结构化输出（与系统语言无关）', () => {
  const installed = parseScheduledTaskJson(
    '{"installed":true,"state":"Ready","lastResult":"0","lastRun":"2026-09-20T21:55:00","nextRun":"2026-09-20T22:00:00"}',
  );
  assert.equal(installed?.installed, true);
  assert.equal(installed?.state, 'Ready');
  assert.equal(installed?.lastResult, '0');
  assert.equal(installed?.source, 'powershell');

  // 没装：Get-ScheduledTask 返回空
  assert.equal(parseScheduledTaskJson('{"installed":false}')?.installed, false);
  // 从未运行过时这些字段是 null 或 1601 占位值，不要显示成"上次运行结果 1601..."
  const never = parseScheduledTaskJson('{"installed":true,"lastResult":null,"lastRun":"1601-01-01T00:00:00","nextRun":"2026-09-20T22:00:00"}');
  assert.equal(never?.lastResult, undefined);
  assert.equal(never?.lastRun, undefined);
  assert.equal(never?.nextRun, '2026-09-20T22:00:00');
  // 坏输入不该崩
  assert.equal(parseScheduledTaskJson('不是 JSON'), undefined);
  assert.equal(parseScheduledTaskJson(''), undefined);
});

test('schtasks：PowerShell 不可用时按列解析 CSV（中文/GBK 输出也能认出来）', () => {
  // 真实的中文 Windows 输出（表头与状态都是本地化文字，且按 GBK 编码）——只看列位置
  const csv = '"主机名","任务名","下次运行时间","状态","登录模式","上次运行时间","上次运行结果"\r\n' +
    '"DESKTOP-ABC","\\auto-fix-clash-heal","2026/9/20 22:00:00","就绪","交互式","2026/9/20 21:55:00","0"\r\n';
  const parsed = parseQueryCsv(csv);
  assert.equal(parsed.lastResult, '0');
  assert.equal(parsed.state, '就绪');
  assert.equal(parsed.nextRun, '2026/9/20 22:00:00');
  // 乱码的表头/状态也不影响按列取值（任务名是 ASCII，永远认得出）
  assert.equal(parseQueryCsv('"DESKTOP-ABC","\\auto-fix-clash-heal","x","\uFFFD\uFFFD","y","z","0"').lastResult, '0');
  assert.deepEqual(parseQueryCsv('没有任何行'), {});
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
