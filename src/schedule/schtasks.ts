import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { currentPlatform, type PlatformContext } from '../platform.ts';
import {
  SCHEDULE_MIN_INTERVAL_SECONDS,
  scheduleCliArgs,
  scheduleLogDir,
  scheduleLogFiles,
  type InstallResult,
  type ScheduleBackend,
  type ScheduleOptions,
  type ScheduleStatus,
  type UninstallResult,
} from './types.ts';

const execFileAsync = promisify(execFile);

/** 计划任务在 Windows 任务计划程序里的名字。 */
export const TASK_NAME = 'auto-fix-clash-heal';
/** schtasks 的 /MO 上限（分钟）。 */
const MAX_MINUTES = 1439;

export function intervalToMinutes(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < SCHEDULE_MIN_INTERVAL_SECONDS) {
    throw new Error(`间隔必须是 >= ${SCHEDULE_MIN_INTERVAL_SECONDS} 秒的整数。`);
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes > MAX_MINUTES) {
    throw new Error(`间隔最多 ${MAX_MINUTES} 分钟（约 24 小时），收到 ${minutes} 分钟。`);
  }
  return minutes;
}

/** 用 Windows 的引号规则包一层（含空格或引号时必须包）。 */
function quoteForWindows(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * 计划任务要执行的命令行（纯函数，便于测试）。
 * 注意：Windows 的任务计划程序不做重定向，所以把日志交给 afc 自己的 --log-file。
 */
export function buildTaskCommand(options: ScheduleOptions): string {
  const logs = scheduleLogFiles({ platform: 'win32', home: 'C:\\Users\\x', env: {} }, options.logDir);
  const args = scheduleCliArgs(options, logs.out);
  return [options.nodePath, options.cliPath, ...args].map(quoteForWindows).join(' ');
}

/** schtasks /Create 的参数（纯函数）。 */
export function buildCreateArgs(options: ScheduleOptions): string[] {
  const minutes = intervalToMinutes(options.intervalSeconds);
  return [
    '/Create',
    '/TN', TASK_NAME,
    '/TR', buildTaskCommand(options),
    '/SC', 'MINUTE',
    '/MO', String(minutes),
    '/F', // 已存在则覆盖，保证幂等
  ];
}

export function buildDeleteArgs(): string[] {
  return ['/Delete', '/TN', TASK_NAME, '/F'];
}

export function buildQueryArgs(): string[] {
  return ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V'];
}

/** 解析 schtasks /Query 的输出（纯函数）。 */
export function parseQuery(text: string): { installed: boolean; lastResult?: string; nextRun?: string } {
  if (/cannot find|找不到|ERROR:|错误:/i.test(text)) return { installed: false };
  const lastResult = /Last Result:\s*(.+)/i.exec(text)?.[1]?.trim();
  const nextRun = /Next Run Time:\s*(.+)/i.exec(text)?.[1]?.trim();
  const installed = /TaskName:|Task To Run:|任务名:/i.test(text);
  return {
    installed,
    ...(lastResult ? { lastResult } : {}),
    ...(nextRun ? { nextRun } : {}),
  };
}

async function schtasks(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('schtasks', args, { timeout: 30000, windowsHide: true });
    return { ok: true, out: stdout, err: stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: e.stdout ?? '', err: e.stderr ?? e.message ?? '未知错误' };
  }
}

/** Windows 任务计划程序后端。 */
export class SchtasksBackend implements ScheduleBackend {
  readonly name = '任务计划程序（schtasks）';
  private readonly ctx: PlatformContext;

  constructor(ctx: PlatformContext = currentPlatform()) {
    this.ctx = ctx;
  }

  preview(options: ScheduleOptions): string {
    return `# schtasks ${buildCreateArgs(options)
      .map((a) => (a.includes(' ') ? `"${a}"` : a))
      .join(' ')}\n# 任务名：${TASK_NAME}\n# 日志：${scheduleLogFiles(this.ctx, options.logDir).out}\n`;
  }

  async install(options: ScheduleOptions): Promise<InstallResult> {
    intervalToMinutes(options.intervalSeconds); // 先校验，避免触碰系统
    mkdirSync(options.logDir, { recursive: true });

    const before = await schtasks(buildQueryArgs());
    const replaced = parseQuery(before.out).installed;

    const create = await schtasks(buildCreateArgs(options));
    if (!create.ok) {
      throw new Error(
        `创建计划任务失败：${(create.err || create.out).trim() || '未知错误'}\n` +
        `可以手动试一次：schtasks ${buildCreateArgs(options).join(' ')}`,
      );
    }

    const run = await schtasks(['/Run', '/TN', TASK_NAME]);
    return {
      backend: this.name,
      definitions: [],
      loaded: true,
      replaced,
      message: run.ok ? '已创建任务并立即试跑一次。' : `任务已创建，但试跑失败：${run.err.trim()}`,
      logPath: scheduleLogFiles(this.ctx, options.logDir).out,
    };
  }

  async uninstall(removeLogs = true): Promise<UninstallResult> {
    const del = await schtasks(buildDeleteArgs());
    const removed: string[] = [];
    if (del.ok) removed.push(`计划任务 ${TASK_NAME}`);
    if (removeLogs) {
      const dir = scheduleLogDir(this.ctx);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    }
    return {
      backend: this.name,
      removed,
      message: del.ok
        ? '已删除计划任务。'
        : `删除任务时报错（可能本来就没安装）：${del.err.trim().split('\n')[0] ?? '未知错误'}`,
    };
  }

  async status(): Promise<ScheduleStatus> {
    const query = await schtasks(buildQueryArgs());
    const parsed = parseQuery(query.out);
    const status: ScheduleStatus = {
      backend: this.name,
      installed: parsed.installed,
      loaded: parsed.installed,
      definitions: parsed.installed ? [`计划任务 ${TASK_NAME}`] : [],
      logPath: scheduleLogFiles(this.ctx).out,
    };
    if (parsed.lastResult) status.lastExitStatus = parsed.lastResult;
    const every = /Schedule Type:\s*(.+)/i.exec(query.out)?.[1]?.trim();
    if (every) status.intervalSeconds = undefined; // schtasks 的间隔描述是自然语言，不强行换算
    if (existsSync(status.logPath)) {
      const lines = readFileSync(status.logPath, 'utf8').trim().split('\n').filter((l) => l.trim() !== '');
      const last = lines.at(-1);
      if (last) status.lastLogLine = last;
    }
    return status;
  }
}
