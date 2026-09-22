import { afcStateDir, joinFor, type PlatformContext } from '../platform.ts';

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
  const args = ['fix', '--scheduled', '--quiet'];
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

/**
 * 隐藏启动器的路径（Windows 专用）。
 *
 * 为什么需要它：`schtasks` 创建的交互式任务在用户会话里运行，而 `node.exe` 是**控制台子系统**
 * 程序 —— 每跑一次就会弹出一个控制台窗口（默认每 5 分钟一次，很打扰）。
 * 用一个由 `wscript.exe`（GUI 子系统，本身不建控制台）执行的 .vbs 去拉起命令，
 * 并把窗口状态设为 0（隐藏），就完全没有窗口了。
 */
export function scheduleLauncherPath(ctx: PlatformContext, dir = scheduleLogDir(ctx)): string {
  return joinFor(ctx)(dir, 'run-hidden.vbs');
}

/** 生成隐藏启动器的内容（纯函数，便于测试）。 */
export function buildHiddenLauncherScript(command: string): string {
  // VBS 字符串里的双引号要写两遍
  const escaped = command.replace(/"/g, '""');
  return [
    "' 由 afc 生成：用 wscript 拉起下面的命令，窗口状态 0 = 隐藏，避免每次运行都弹控制台。'",
    "' 第三个参数 True 表示等待子进程结束并把退出码带回去 —— 这样任务计划程序里的'",
    "' “上次运行结果” 仍然是 afc 的真实退出码（0 成功 / 2 没有可用节点 / 3 环境故障）。'",
    'Set sh = CreateObject("WScript.Shell")',
    `code = sh.Run "${escaped}", 0, True`,
    'WScript.Quit code',
    '',
  ].join('\r\n');
}

/** 计划任务的日志文件：主日志与错误日志。 */
export function scheduleLogFiles(ctx: PlatformContext, dir = scheduleLogDir(ctx)): { out: string; err: string } {
  // 按目标平台拼：不能用宿主平台的 path.join，否则在别的平台上生成的定义文件路径会变形
  const j = joinFor(ctx);
  return { out: j(dir, 'heal.log'), err: j(dir, 'heal.err.log') };
}

// 间隔下限只有一处定义（配置校验也用它），这里只是转发
export { MIN_SCHEDULE_INTERVAL_SECONDS as SCHEDULE_MIN_INTERVAL_SECONDS } from '../config.ts';
