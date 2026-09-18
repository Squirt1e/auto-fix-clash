import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { currentPlatform, type PlatformContext } from '../platform.ts';
import {
  SCHEDULE_MIN_INTERVAL_SECONDS,
  scheduleLogDir,
  type InstallResult,
  type ScheduleBackend,
  type ScheduleOptions,
  type ScheduleStatus,
  type UninstallResult,
} from './types.ts';
import { CRON_MARKER, buildCronEntry } from './systemd.ts';

const execFileAsync = promisify(execFile);

async function crontab(args: string[], input?: string): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const child = execFileAsync('crontab', args, { timeout: 20000 });
    if (input !== undefined) {
      child.child.stdin?.end(input);
    }
    const { stdout, stderr } = await child;
    return { ok: true, out: stdout, err: stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: e.stdout ?? '', err: e.stderr ?? e.message ?? '未知错误' };
  }
}

function stripManagedLines(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    // 标记行后面紧跟一行计划，两行一起删
    if (lines[i]!.trim() === CRON_MARKER) {
      i += 1;
      continue;
    }
    out.push(lines[i]!);
  }
  return out;
}

/** cron 后端：没有 systemd 时的兜底（也能用 --backend cron 显式指定）。 */
export class CronBackend implements ScheduleBackend {
  readonly name = 'cron';
  private readonly ctx: PlatformContext;

  constructor(ctx: PlatformContext = currentPlatform()) {
    this.ctx = ctx;
  }

  preview(options: ScheduleOptions): string {
    return `# crontab（由 afc schedule 管理，可随时移除）\n${buildCronEntry(options).join('\n')}\n`;
  }

  async install(options: ScheduleOptions): Promise<InstallResult> {
    if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < SCHEDULE_MIN_INTERVAL_SECONDS) {
      throw new Error(`间隔必须是 >= ${SCHEDULE_MIN_INTERVAL_SECONDS} 秒的整数。`);
    }
    mkdirSync(options.logDir, { recursive: true });
    const current = await crontab(['-l']);
    const existing = current.ok ? current.out : '';
    const replaced = existing.includes(CRON_MARKER);
    const next = [...stripManagedLines(existing).filter((l) => l.trim() !== '' || true), ...buildCronEntry(options)]
      .join('\n')
      .replace(/\n+$/, '');
    const write = await crontab(['-'], `${next}\n`);
    if (!write.ok) {
      throw new Error(`写入 crontab 失败：${write.err.trim() || '未知错误'}`);
    }
    const logPath = scheduleLogDir(this.ctx) + '/heal.log';
    return {
      backend: this.name,
      definitions: ['crontab'],
      loaded: true,
      replaced,
      message: '已写入 crontab（cron 会在下一个时间点执行）。',
      logPath,
    };
  }

  async uninstall(removeLogs = true): Promise<UninstallResult> {
    const current = await crontab(['-l']);
    const removed: string[] = [];
    if (current.ok && current.out.includes(CRON_MARKER)) {
      const next = stripManagedLines(current.out).join('\n').replace(/\n+$/, '');
      const write = await crontab(['-'], `${next}\n`);
      if (!write.ok) throw new Error(`移除 crontab 条目失败：${write.err.trim() || '未知错误'}`);
      removed.push('crontab 中的 afc 条目');
    }
    if (removeLogs) {
      const dir = scheduleLogDir(this.ctx);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    }
    return { backend: this.name, removed, message: '已从 crontab 移除。' };
  }

  async status(): Promise<ScheduleStatus> {
    const current = await crontab(['-l']);
    const text = current.ok ? current.out : '';
    const installed = text.includes(CRON_MARKER);
    const status: ScheduleStatus = {
      backend: this.name,
      installed,
      loaded: installed,
      definitions: installed ? ['crontab'] : [],
      logPath: scheduleLogDir(this.ctx) + '/heal.log',
    };
    const line = text.split('\n').find((l) => l.includes('afc') && l.includes('fix'));
    const every = line ? /^\*\/(\d+)/.exec(line.trim()) : null;
    if (every?.[1]) status.intervalSeconds = Number(every[1]) * 60;
    if (existsSync(status.logPath)) {
      const lines = readFileSync(status.logPath, 'utf8').trim().split('\n').filter((l) => l.trim() !== '');
      const last = lines.at(-1);
      if (last) status.lastLogLine = last;
    }
    return status;
  }
}
