import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MIN_SCHEDULE_INTERVAL_SECONDS } from '../config.ts';

const execFileAsync = promisify(execFile);

export const LAUNCHD_LABEL = 'com.auto-fix-clash.heal';

export function launchAgentsDir(): string {
  return join(homedir(), 'Library', 'LaunchAgents');
}

export function plistPath(): string {
  return join(launchAgentsDir(), `${LAUNCHD_LABEL}.plist`);
}

export function logDir(): string {
  return join(homedir(), 'Library', 'Logs', 'afc');
}

export function logPath(): string {
  return join(logDir(), 'heal.log');
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface PlistOptions {
  /** node 可执行文件路径。 */
  nodePath: string;
  /** afc 入口脚本路径。 */
  cliPath: string;
  intervalSeconds: number;
  /** 工作目录（让 ./afc.config.yaml 能被找到）。 */
  workingDirectory: string;
  /** 显式配置文件路径（可选）。 */
  configPath?: string;
  logDir: string;
}

/** 生成 launchd plist：一次性短命进程，按 StartInterval 触发。 */
export function buildPlist(options: PlistOptions): string {
  const args = [options.nodePath, options.cliPath, 'fix', '--all', '--quiet'];
  if (options.configPath) args.push('--config', options.configPath);
  const argsXml = args
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(options.workingDirectory)}</string>
  <key>StartInterval</key>
  <integer>${options.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(options.logDir, 'heal.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(options.logDir, 'heal.err.log'))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

async function launchctl(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('launchctl', args, { timeout: 15000 });
    return { ok: true, out: stdout, err: stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: e.stdout ?? '', err: e.stderr ?? e.message ?? '未知错误' };
  }
}

export interface InstallResult {
  plistPath: string;
  logPath: string;
  loaded: boolean;
  message: string;
}

/** 安装（幂等）：先卸载旧的，再载入新的，随后立即试跑一次。 */
export async function installSchedule(options: PlistOptions): Promise<InstallResult> {
  if (process.platform !== 'darwin') {
    throw new Error(`计划任务目前只支持 macOS（当前平台：${process.platform}）。`);
  }
  if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < MIN_SCHEDULE_INTERVAL_SECONDS) {
    throw new Error(`间隔必须是 >= ${MIN_SCHEDULE_INTERVAL_SECONDS} 秒的整数。`);
  }
  mkdirSync(launchAgentsDir(), { recursive: true });
  mkdirSync(options.logDir, { recursive: true });

  // 幂等：先尽力卸载已存在的同名任务，失败不阻断。
  await launchctl(['bootout', `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]);

  const path = plistPath();
  writeFileSync(path, buildPlist(options), 'utf8');

  const uid = process.getuid?.() ?? 0;
  const boot = await launchctl(['bootstrap', `gui/${uid}`, path]);
  if (!boot.ok) {
    // 不留半安装状态
    rmSync(path, { force: true });
    throw new Error(
      `载入计划任务失败（launchctl bootstrap）：${boot.err.trim() || '未知错误'}\n` +
      '已回滚删除刚写入的 plist。请确认你在图形登录会话中（而不是仅 SSH），或尝试用 launchctl 手动载入。',
    );
  }

  const kick = await launchctl(['kickstart', `gui/${uid}/${LAUNCHD_LABEL}`]);
  return {
    plistPath: path,
    logPath: logPath(),
    loaded: true,
    message: kick.ok ? '已载入并触发一次试跑。' : `已载入，但试跑触发失败：${kick.err.trim()}`,
  };
}

export interface UninstallResult {
  removed: string[];
  bootedOut: boolean;
  message: string;
}

/** 卸载（幂等）：从调度器移除、删除 plist 与自有日志。 */
export async function uninstallSchedule(removeLogs = true): Promise<UninstallResult> {
  const uid = process.getuid?.() ?? 0;
  const boot = await launchctl(['bootout', `gui/${uid}/${LAUNCHD_LABEL}`]);
  const removed: string[] = [];
  const path = plistPath();
  if (existsSync(path)) {
    rmSync(path, { force: true });
    removed.push(path);
  }
  if (removeLogs) {
    const dir = logDir();
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir)) removed.push(join(dir, entry));
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return {
    removed,
    bootedOut: boot.ok,
    message: boot.ok
      ? '已从调度器移除。'
      : `调度器中未找到该任务（可能本来就没安装）：${boot.err.trim().slice(0, 200)}`,
  };
}

export interface ScheduleStatus {
  installed: boolean;
  loaded: boolean;
  intervalSeconds?: number;
  lastExitStatus?: string;
  plistPath: string;
  logPath: string;
  lastLogLine?: string;
}

/** 查询计划任务状态。 */
export async function scheduleStatus(): Promise<ScheduleStatus> {
  const path = plistPath();
  const installed = existsSync(path);
  const result: ScheduleStatus = { installed, loaded: false, plistPath: path, logPath: logPath() };

  if (installed) {
    const text = readFileSyncSafe(path);
    const match = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text);
    if (match?.[1]) result.intervalSeconds = Number(match[1]);
  }

  const uid = process.getuid?.() ?? 0;
  const printed = await launchctl(['print', `gui/${uid}/${LAUNCHD_LABEL}`]);
  if (printed.ok) {
    result.loaded = true;
    const interval = /interval = (\d+)/.exec(printed.out);
    if (interval?.[1]) result.intervalSeconds = Number(interval[1]);
    const exit = /last exit code = (\d+)/.exec(printed.out);
    if (exit?.[1]) result.lastExitStatus = exit[1];
  }

  const log = logPath();
  if (existsSync(log)) {
    const lines = readFileSyncSafe(log).trim().split('\n').filter((l) => l.trim() !== '');
    const last = lines.at(-1);
    if (last) result.lastLogLine = last;
  }

  return result;
}

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export interface ProgramIdentity {
  program: string;
  /** 执行程序的代码签名主体。macOS 的后台项列表用它归类，而不是我们的任务名。 */
  authority?: string;
  /** 系统界面里实际显示的短名称（从签名主体还原）。 */
  displayName: string;
}

/**
 * 把签名主体还原成系统界面里显示的短名称。
 * 签名里是 `Developer ID Application: Node.js Foundation (HX7739G8FX)`，
 * 但通知与设置界面显示的是 `Node.js Foundation`。
 */
export function shortIdentityName(authority: string | undefined, fallback: string): string {
  if (!authority) return fallback;
  return authority
    .replace(/^(Developer ID Application|Developer ID Installer|Apple Development|Mac Developer):\s*/i, '')
    .replace(/\s*\([A-Z0-9]{10}\)\s*$/, '')
    .trim() || fallback;
}

/**
 * 读取计划任务实际执行的那个程序的身份信息。
 *
 * 为什么要读而不是写死：系统「App 后台活动」里显示的名字来自被执行程序的签名主体
 * （我们执行的是 node，签名主体是 Node.js Foundation），不读就无法给出准确解释。
 */
export function describeProgramIdentity(program: string = process.execPath): ProgramIdentity {
  const result = spawnSync('codesign', ['-dv', '--verbose=2', program], { encoding: 'utf8' });
  const text = `${result.stderr ?? ''}${result.stdout ?? ''}`;
  const authority = /Authority=([^\n]+)/.exec(text)?.[1]?.trim();
  const base = program.split('/').pop() ?? program;
  return {
    program,
    ...(authority ? { authority } : {}),
    displayName: shortIdentityName(authority, base),
  };
}

