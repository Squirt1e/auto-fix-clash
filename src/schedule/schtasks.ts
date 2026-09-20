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
  // CSV + 按列解析：表头与状态文字会本地化，列的位置不会
  return ['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/V'];
}

/** 查询任务状态：PowerShell 结构化输出优先，拿不到就用 schtasks 的退出码 + 按列解析。 */
export async function queryTaskState(): Promise<TaskState> {
  const script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
    `$t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; ` +
    'if ($null -eq $t) { \'{"installed":false}\' } else { ' +
    '$i = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue; ' +
    '[pscustomobject]@{ installed=$true; state=[string]$t.State; ' +
    'lastResult=[string]$i.LastTaskResult; lastRun=[string]$i.LastRunTime; ' +
    'nextRun=[string]$i.NextRunTime } | ConvertTo-Json -Compress }';
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    try {
      const { stdout } = await execFileAsync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 30000,
        windowsHide: true,
        encoding: 'utf8',
      });
      const parsed = parseScheduledTaskJson(stdout);
      if (parsed) return parsed;
    } catch {
      // 换下一个解释器
    }
  }

  // 兜底：schtasks 的退出码与语言无关（0 = 找到，非 0 = 没找到）
  const query = await schtasks(buildQueryArgs());
  if (!query.ok) return { installed: false, source: 'schtasks-csv' };
  return { installed: true, source: 'schtasks-csv', ...parseQueryCsv(query.out) };
}

/** 任务状态（判定结果与来源）。 */
export interface TaskState {
  installed: boolean;
  state?: string;
  lastResult?: string;
  lastRun?: string;
  nextRun?: string;
  /** 这次判定是怎么来的，排查时有用。 */
  source: 'powershell' | 'schtasks-csv' | 'none';
}

/**
 * 解析 PowerShell `Get-ScheduledTask` 的结构化输出（纯函数）。
 *
 * 为什么不用 `schtasks /Query` 的文字输出：它的**标签会随系统语言变化**，而且中文 Windows
 * 上输出是 GBK，按 UTF-8 解码后连"任务名"三个字都变成乱码 —— 之前就是这样导致
 * 任何非英文 Windows 上 status 都误报"未安装"（英文 CI 永远测不出来）。
 * 这里的字段名是 cmdlet 的属性名，与语言无关。
 */
export function parseScheduledTaskJson(raw: string): TaskState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim().replace(/^\uFEFF/, '') || 'null');
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const rec = parsed as Record<string, unknown>;
  const str = (v: unknown): string | undefined => {
    if (typeof v === 'number') return String(v);
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim();
    // 计划任务从未运行时，这些字段是 null 或 1601 年的占位值
    if (trimmed === '' || trimmed === 'null') return undefined;
    if (trimmed.startsWith('1601-01-01')) return undefined;
    return trimmed;
  };
  const installed = rec['installed'] === true;
  return {
    installed,
    source: 'powershell',
    ...(str(rec['state']) ? { state: str(rec['state']) } : {}),
    ...(str(rec['lastResult']) ? { lastResult: str(rec['lastResult']) } : {}),
    ...(str(rec['lastRun']) ? { lastRun: str(rec['lastRun']) } : {}),
    ...(str(rec['nextRun']) ? { nextRun: str(rec['nextRun']) } : {}),
  };
}

/**
 * 解析 `schtasks /Query /FO CSV /V` 的输出（纯函数，PowerShell 不可用时的兜底）。
 *
 * 表头文字是本地化的，所以**只看列的位置**：CSV 各列的次序与语言无关，
 * SCHTASKS 的 /V 输出固定是 主机名,任务名,下次运行时间,状态,登录模式,上次运行时间,上次运行结果,…
 * （任务名是 ASCII，不会被 GBK 乱码影响。）
 */
export function parseQueryCsv(raw: string): { nextRun?: string; state?: string; lastRun?: string; lastResult?: string } {
  const row = raw.split(/\r?\n/).find((line) => /"\\.?auto-fix-clash-heal"/i.test(line.replace(/""/g, '"')))
    ?? raw.split(/\r?\n/).find((line) => line.trim().startsWith('"'));
  if (!row) return {};
  const fields = row.match(/"[^"]*"/g)?.map((f) => f.slice(1, -1)) ?? [];
  const pick = (index: number): string | undefined => {
    const value = fields[index]?.trim();
    return value && value !== 'N/A' ? value : undefined;
  };
  return {
    ...(pick(2) ? { nextRun: pick(2) } : {}),
    ...(pick(3) ? { state: pick(3) } : {}),
    ...(pick(5) ? { lastRun: pick(5) } : {}),
    ...(pick(6) ? { lastResult: pick(6) } : {}),
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

    const replaced = (await queryTaskState()).installed;

    const create = await schtasks(buildCreateArgs(options));
    if (!create.ok) {
      throw new Error(
        `创建计划任务失败：${(create.err || create.out).trim() || '未知错误'}\n` +
        `可以手动试一次：schtasks ${buildCreateArgs(options).join(' ')}`,
      );
    }

    // 核验：schtasks 打印成功不等于任务真的在里面，装完立刻查一次，
    // 免得"装过了但 status 说没有"这种悬案（中文 Windows 上曾经就是这样）
    const verify = await queryTaskState();
    if (!verify.installed) {
      throw new Error(
        '任务创建后核验失败：schtasks 报告成功，但查不到该任务。\n' +
        `可以手动试一次：schtasks ${buildCreateArgs(options).join(' ')}`,
      );
    }

    const run = await schtasks(['/Run', '/TN', TASK_NAME]);
    const stateText = verify.state ? `（状态 ${verify.state}）` : '';
    return {
      backend: this.name,
      definitions: [],
      loaded: true,
      replaced,
      message: run.ok
        ? `已创建计划任务并核验存在${stateText}，已立即试跑一次。`
        : `已创建计划任务并核验存在${stateText}；试跑失败：${run.err.trim()}`,
      logPath: scheduleLogFiles(this.ctx, options.logDir).out,
    };
  }

  async uninstall(removeLogs = true): Promise<UninstallResult> {
    const del = await schtasks(buildDeleteArgs());
    const stillThere = (await queryTaskState()).installed;
    const removed: string[] = [];
    if (del.ok && !stillThere) removed.push(`计划任务 ${TASK_NAME}`);
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
      message: del.ok && !stillThere
        ? '已删除计划任务（并核验已不存在）。'
        : stillThere
          ? `删除后任务仍在，可能需要在管理员权限下重试：schtasks ${buildDeleteArgs().join(' ')}`
          : `删除任务时报错（可能本来就没安装）：${del.err.trim().split('\n')[0] ?? '未知错误'}`,
    };
  }

  async status(): Promise<ScheduleStatus> {
    const state = await queryTaskState();
    const status: ScheduleStatus = {
      backend: this.name,
      installed: state.installed,
      loaded: state.installed,
      definitions: state.installed ? [`计划任务 ${TASK_NAME}${state.state ? `（${state.state}）` : ''}`] : [],
      logPath: scheduleLogFiles(this.ctx).out,
    };
    if (state.lastResult) status.lastExitStatus = state.lastResult;
    if (existsSync(status.logPath)) {
      const lines = readFileSync(status.logPath, 'utf8').trim().split('\n').filter((l) => l.trim() !== '');
      const last = lines.at(-1);
      if (last) status.lastLogLine = last;
    }
    return status;
  }
}
