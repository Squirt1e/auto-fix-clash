import { join } from 'node:path';
import { afcStateDir, type PlatformContext } from '../platform.ts';

/** 交给系统调度器执行的东西（各平台用同一份参数）。 */
export interface ScheduleOptions {
  /** node 可执行文件绝对路径。 */
  nodePath: string;
  /** afc CLI 入口绝对路径（源码 .ts 或安装后的 dist/cli/index.js）。 */
  cliPath: string;
  intervalSeconds: number;
  /** 工作目录（让 ./afc.config.yaml 能被找到）。 */
  workingDirectory: string;
  /** 显式配置文件路径。 */
  configPath?: string;
  logDir: string;
}

/** 计划任务要执行的命令行参数（不含 node 与入口本身）。 */
export function scheduleCliArgs(options: ScheduleOptions, logFile?: string): string[] {
  const args = ['fix', '--all', '--quiet'];
  if (options.configPath) args.push('--config', options.configPath);
  if (logFile) args.push('--log-file', logFile);
  return args;
}

export interface InstallResult {
  backend: string;
  /** 写入了哪些定义文件（Windows 上为空，任务由系统数据库管理）。 */
  definitions: string[];
  loaded: boolean;
  message: string;
  logPath: string;
  /** 变更前是否已存在旧任务（用于说明是"安装"还是"更新"）。 */
  replaced: boolean;
}

export interface UninstallResult {
  backend: string;
  removed: string[];
  message: string;
}

export interface ScheduleStatus {
  backend: string;
  installed: boolean;
  loaded: boolean;
  intervalSeconds?: number;
  lastExitStatus?: string;
  definitions: string[];
  logPath: string;
  lastLogLine?: string;
}

export interface ScheduleBackend {
  /** 后端显示名，例如 "launchd"。 */
  readonly name: string;
  install(options: ScheduleOptions): Promise<InstallResult>;
  uninstall(removeLogs?: boolean): Promise<UninstallResult>;
  status(): Promise<ScheduleStatus>;
  /** 生成将要写入的内容，供 --dry-run 展示。 */
  preview(options: ScheduleOptions): string;
}

/** 计划任务的日志目录（按平台放在各自约定的位置）。 */
export function scheduleLogDir(ctx: PlatformContext): string {
  return afcStateDir(ctx);
}

/** 计划任务的日志文件：主日志与错误日志。 */
export function scheduleLogFiles(ctx: PlatformContext, dir = scheduleLogDir(ctx)): { out: string; err: string } {
  return { out: join(dir, 'heal.log'), err: join(dir, 'heal.err.log') };
}

// 间隔下限只有一处定义（配置校验也用它），这里只是转发
export { MIN_SCHEDULE_INTERVAL_SECONDS as SCHEDULE_MIN_INTERVAL_SECONDS } from '../config.ts';
