import { currentPlatform, type PlatformContext } from '../platform.ts';
import { CronBackend } from './cron.ts';
import { LaunchdBackend } from './launchd.ts';
import { SchtasksBackend } from './schtasks.ts';
import { SystemdBackend, systemctlAvailable } from './systemd.ts';
import type { ScheduleBackend } from './types.ts';

export type BackendChoice = 'auto' | 'launchd' | 'systemd' | 'cron' | 'schtasks';

export const BACKEND_CHOICES: readonly BackendChoice[] = ['auto', 'launchd', 'systemd', 'cron', 'schtasks'];

export function isBackendChoice(value: string): value is BackendChoice {
  return (BACKEND_CHOICES as readonly string[]).includes(value);
}

/**
 * 选一个定时任务后端。
 *
 * - darwin  → launchd
 * - win32   → 任务计划程序（schtasks）
 * - linux   → 有 systemd 就用 user timer，否则退回 cron
 * `--backend` 可以强制指定（例如容器里没有 systemd 时用 cron）。
 */
export async function getScheduleBackend(
  choice: BackendChoice = 'auto',
  ctx: PlatformContext = currentPlatform(),
): Promise<ScheduleBackend> {
  switch (choice) {
    case 'launchd':
      return new LaunchdBackend(ctx);
    case 'systemd':
      return new SystemdBackend(ctx);
    case 'cron':
      return new CronBackend(ctx);
    case 'schtasks':
      return new SchtasksBackend(ctx);
    case 'auto':
      break;
  }

  if (ctx.platform === 'darwin') return new LaunchdBackend(ctx);
  if (ctx.platform === 'win32') return new SchtasksBackend(ctx);
  return (await systemctlAvailable()) ? new SystemdBackend(ctx) : new CronBackend(ctx);
}

/** 当前平台默认会用哪个后端（用于提示信息，不触碰系统）。 */
export function defaultBackendName(ctx: PlatformContext = currentPlatform()): string {
  if (ctx.platform === 'darwin') return 'launchd';
  if (ctx.platform === 'win32') return '任务计划程序（schtasks）';
  return 'systemd 用户定时器（没有 systemd 时自动退回 cron）';
}

export * from './types.ts';
export { systemctlAvailable };
