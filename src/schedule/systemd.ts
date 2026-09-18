import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { currentPlatform, joinFor, type PlatformContext } from '../platform.ts';
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

/** systemd 用户级单元名（不带 .service/.timer 后缀）。 */
export const SYSTEMD_UNIT = 'afc-heal';
/** cron 兜底时插入到 crontab 的标记，便于精确移除。 */
export const CRON_MARKER = '# auto-fix-clash: 代理组节点体检与修复（本行由 afc schedule 管理）';

function unitDir(ctx: PlatformContext): string {
  const j = joinFor(ctx);
  const base = ctx.env['XDG_CONFIG_HOME'] ?? j(ctx.home, '.config');
  return j(base, 'systemd', 'user');
}

export function servicePath(ctx: PlatformContext = currentPlatform()): string {
  return joinFor(ctx)(unitDir(ctx), `${SYSTEMD_UNIT}.service`);
}

export function timerPath(ctx: PlatformContext = currentPlatform()): string {
  return joinFor(ctx)(unitDir(ctx), `${SYSTEMD_UNIT}.timer`);
}

/** 生成 systemd user service 单元（纯函数，便于测试）。 */
export function buildServiceUnit(options: ScheduleOptions): string {
  const logs = scheduleLogFiles({ platform: 'linux', home: '/home/x', env: {} }, options.logDir);
  const args = scheduleCliArgs(options);
  const exec = [options.nodePath, options.cliPath, ...args]
    .map((token) => (token.includes(' ') ? `"${token}"` : token))
    .join(' ');
  return `[Unit]
Description=auto-fix-clash: 体检代理组并修复不可用节点

[Service]
Type=oneshot
WorkingDirectory=${options.workingDirectory}
ExecStart=${exec}
StandardOutput=append:${logs.out}
StandardError=append:${logs.err}
`;
}

/** 生成 systemd user timer 单元（纯函数，便于测试）。 */
export function buildTimerUnit(intervalSeconds: number): string {
  return `[Unit]
Description=定时运行 auto-fix-clash

[Timer]
# 开机 1 分钟后先跑一次，之后按间隔重复；错过的执行会在唤醒后补跑
OnBootSec=1min
OnUnitActiveSec=${intervalSeconds}s
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** cron 兜底：生成要写进 crontab 的两行（标记 + 计划）。 */
export function buildCronEntry(options: ScheduleOptions): string[] {
  const logs = scheduleLogFiles({ platform: 'linux', home: '/home/x', env: {} }, options.logDir);
  const args = scheduleCliArgs(options);
  const command = [options.nodePath, options.cliPath, ...args]
    .map((token) => (token.includes(' ') ? `"${token.replace(/"/g, '\\"')}"` : token))
    .join(' ');
  const minutes = Math.max(1, Math.round(options.intervalSeconds / 60));
  return [
    CRON_MARKER,
    `*/${minutes} * * * * cd "${options.workingDirectory}" && ${command} >> "${logs.out}" 2>> "${logs.err}"`,
  ];
}

async function runCommand(cmd: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 20000 });
    return { ok: true, out: stdout, err: stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: e.stdout ?? '', err: e.stderr ?? e.message ?? '未知错误' };
  }
}

/** systemctl 是否可用（决定用 systemd 还是退回 cron）。 */
export async function systemctlAvailable(): Promise<boolean> {
  const which = await runCommand('sh', ['-c', 'command -v systemctl || true']);
  if (!which.out.trim()) return false;
  const probe = await runCommand('systemctl', ['--user', 'is-system-running']);
  // 只要不是"命令不存在"就认为可用（degraded/offline 也能用用户级定时器）
  return !/not found|Failed to connect|No such file/i.test(probe.err);
}

/** systemd 用户定时器后端。 */
export class SystemdBackend implements ScheduleBackend {
  readonly name = 'systemd 用户定时器';
  private readonly ctx: PlatformContext;

  constructor(ctx: PlatformContext = currentPlatform()) {
    this.ctx = ctx;
  }

  preview(options: ScheduleOptions): string {
    return `# ${servicePath(this.ctx)}\n${buildServiceUnit(options)}\n# ${timerPath(this.ctx)}\n${buildTimerUnit(
      options.intervalSeconds,
    )}`;
  }

  async install(options: ScheduleOptions): Promise<InstallResult> {
    if (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < SCHEDULE_MIN_INTERVAL_SECONDS) {
      throw new Error(`间隔必须是 >= ${SCHEDULE_MIN_INTERVAL_SECONDS} 秒的整数。`);
    }
    mkdirSync(unitDir(this.ctx), { recursive: true });
    mkdirSync(options.logDir, { recursive: true });

    const replaced = existsSync(timerPath(this.ctx));
    writeFileSync(servicePath(this.ctx), buildServiceUnit(options), 'utf8');
    writeFileSync(timerPath(this.ctx), buildTimerUnit(options.intervalSeconds), 'utf8');

    const reload = await runCommand('systemctl', ['--user', 'daemon-reload']);
    if (!reload.ok) {
      // daemon-reload 失败通常意味着 systemd 不可用，直接给出可执行的建议
      throw new Error(
        `systemctl --user 不可用：${reload.err.trim() || '未知错误'}\n` +
        '这台机器可能没有 systemd（例如容器或老发行版）。请改用 cron 兜底：afc schedule install --backend cron',
      );
    }
    const enable = await runCommand('systemctl', ['--user', 'enable', '--now', `${SYSTEMD_UNIT}.timer`]);
    if (!enable.ok) {
      rmSync(servicePath(this.ctx), { force: true });
      rmSync(timerPath(this.ctx), { force: true });
      throw new Error(
        `载入 systemd 定时器失败：${enable.err.trim() || '未知错误'}\n` +
        '已回滚删除刚写入的单元文件。若这台机器没有 systemd，请用 --backend cron，或用 afc schedule 的 cron 兜底。',
      );
    }

    const kick = await runCommand('systemctl', ['--user', 'start', `${SYSTEMD_UNIT}.service`]);
    return {
      backend: this.name,
      definitions: [servicePath(this.ctx), timerPath(this.ctx)],
      loaded: true,
      replaced,
      message: kick.ok
        ? '已启用定时器并立即试跑一次。'
        : `定时器已启用，但试跑失败：${kick.err.trim().split('\n')[0] ?? '未知错误'}`,
      logPath: scheduleLogFiles(this.ctx, options.logDir).out,
    };
  }

  async uninstall(removeLogs = true): Promise<UninstallResult> {
    await runCommand('systemctl', ['--user', 'disable', '--now', `${SYSTEMD_UNIT}.timer`]);
    const removed: string[] = [];
    for (const path of [servicePath(this.ctx), timerPath(this.ctx)]) {
      if (existsSync(path)) {
        rmSync(path, { force: true });
        removed.push(path);
      }
    }
    await runCommand('systemctl', ['--user', 'daemon-reload']);
    if (removeLogs) {
      const dir = scheduleLogDir(this.ctx);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    }
    return { backend: this.name, removed, message: '已停用定时器。' };
  }

  async status(): Promise<ScheduleStatus> {
    const installed = existsSync(timerPath(this.ctx));
    const out = scheduleLogFiles(this.ctx).out;
    const status: ScheduleStatus = {
      backend: this.name,
      installed,
      loaded: false,
      definitions: [servicePath(this.ctx), timerPath(this.ctx)].filter((p) => existsSync(p)),
      logPath: out,
    };
    if (installed) {
      const text = readFileSync(timerPath(this.ctx), 'utf8');
      const match = /OnUnitActiveSec=(\d+)s/.exec(text);
      if (match?.[1]) status.intervalSeconds = Number(match[1]);
    }
    const active = await runCommand('systemctl', ['--user', 'is-active', `${SYSTEMD_UNIT}.timer`]);
    status.loaded = active.out.trim() === 'active';
    const show = await runCommand('systemctl', ['--user', 'show', '-p', 'ExecMainStatus', `${SYSTEMD_UNIT}.service`]);
    const exec = /ExecMainStatus=(\d+)/.exec(show.out);
    if (exec?.[1]) status.lastExitStatus = exec[1];
    if (existsSync(out)) {
      const lines = readFileSync(out, 'utf8').trim().split('\n').filter((l) => l.trim() !== '');
      const last = lines.at(-1);
      if (last) status.lastLogLine = last;
    }
    return status;
  }
}
