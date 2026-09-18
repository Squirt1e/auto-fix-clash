import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * 平台相关的路径与候选位置。
 *
 * 全部做成「吃 ctx、返回路径」的纯函数，这样测试可以直接塞一个假平台，
 * 不需要真的在 Windows 上跑（CI 矩阵也会跑一次真机，但单测不该依赖平台）。
 */

export type PlatformId = 'darwin' | 'linux' | 'win32';

export interface PlatformContext {
  platform: PlatformId;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** 把任意字符串收敛成我们支持的三个平台 id（未知平台按 linux 处理）。 */
export function normalizePlatform(value: string): PlatformId {
  if (value === 'darwin' || value === 'win32') return value;
  return 'linux';
}

export function currentPlatform(env: NodeJS.ProcessEnv = process.env): PlatformContext {
  return {
    platform: normalizePlatform(process.platform),
    home: homedir(),
    env,
  };
}

/**
 * 按 base 路径自身的风格拼接子路径。
 *
 * 合成目录（XDG、AppData 等）用 joinFor(ctx) 决定风格；而已经存在于本机的路径
 * （内核 -d 工作目录、订阅档案文件）必须跟随它自己的风格，否则会出现
 * "C:\Users\...\profiles" 拼在 POSIX 路径上这类混搭，随后 readdir 直接失败。
 */
export function joinLike(base: string, ...parts: string[]): string {
  const looksWindows =
    /^[a-zA-Z]:[\\/]/.test(base) || base.startsWith('\\\\') || base.includes('\\');
  return looksWindows ? win32.join(base, ...parts) : posix.join(base, ...parts);
}

export function isWindows(ctx: PlatformContext): boolean {
  return ctx.platform === 'win32';
}

/**
 * 按**目标平台**拼路径。
 *
 * 不能用 path.join：它按宿主平台选分隔符，在 macOS 上构造 Windows 路径会混出
 * `C:\Users\x/afc/logs` 这种半截路径。这里显式选 posix/win32。
 */
export function joinFor(ctx: PlatformContext): (...parts: string[]) => string {
  return isWindows(ctx) ? win32.join : posix.join;
}

/** XDG 基准目录（Linux 用，macOS 也接受显式设置）。 */
function xdgConfigHome(ctx: PlatformContext): string {
  const j = joinFor(ctx);
  return ctx.env['XDG_CONFIG_HOME'] ?? j(ctx.home, '.config');
}

function xdgStateHome(ctx: PlatformContext): string {
  const j = joinFor(ctx);
  return ctx.env['XDG_STATE_HOME'] ?? j(ctx.home, '.local', 'state');
}

function xdgDataHome(ctx: PlatformContext): string {
  const j = joinFor(ctx);
  return ctx.env['XDG_DATA_HOME'] ?? j(ctx.home, '.local', 'share');
}

function appData(ctx: PlatformContext): string | undefined {
  return ctx.env['APPDATA'];
}

function localAppData(ctx: PlatformContext): string | undefined {
  return ctx.env['LOCALAPPDATA'];
}

/** afc 自己的配置目录。 */
export function afcConfigDir(ctx: PlatformContext): string {
  const j = joinFor(ctx);
  if (isWindows(ctx)) {
    const base = appData(ctx) ?? j(ctx.home, 'AppData', 'Roaming');
    return j(base, 'afc');
  }
  return j(xdgConfigHome(ctx), 'afc');
}

/** afc 的配置文件名（找配置与写配置都用它）。 */
export function afcConfigPath(ctx: PlatformContext): string {
  const j = joinFor(ctx);
  return j(afcConfigDir(ctx), 'config.yaml');
}

/** afc 写日志与运行状态的目录。 */
export function afcStateDir(ctx: PlatformContext): string {
  const j = joinFor(ctx);
  if (ctx.platform === 'darwin') return j(ctx.home, 'Library', 'Logs', 'afc');
  if (isWindows(ctx)) {
    const base = localAppData(ctx) ?? j(ctx.home, 'AppData', 'Local');
    return j(base, 'afc', 'logs');
  }
  return j(xdgStateHome(ctx), 'afc');
}

/** Clash Party 的数据目录候选。 */
export function clashPartyDataDirs(ctx: PlatformContext): string[] {
  const j = joinFor(ctx);
  if (ctx.platform === 'darwin') return [j(ctx.home, 'Library', 'Application Support', 'mihomo-party')];
  if (isWindows(ctx)) {
    // 环境变量缺失时（精简环境、CI）仍要给出一个可用的位置，否则候选集为空，
    // clashPartyDataDir() 取 [0] 会变成 undefined。
    const candidates = [
      appData(ctx) ? j(appData(ctx)!, 'mihomo-party') : undefined,
      localAppData(ctx) ? j(localAppData(ctx)!, 'mihomo-party') : undefined,
    ].filter((p): p is string => p !== undefined);
    return candidates.length > 0 ? candidates : [j(ctx.home, 'AppData', 'Roaming', 'mihomo-party')];
  }
  return [j(xdgConfigHome(ctx), 'mihomo-party'), j(xdgDataHome(ctx), 'mihomo-party')];
}

/** Clash Verge (Rev) 的数据目录候选。 */
export function clashVergeDataDirs(ctx: PlatformContext): string[] {
  const j = joinFor(ctx);
  const ids = ['io.github.clash-verge-rev.clash-verge-rev', 'clash-verge', 'clash-verge-rev'];
  if (ctx.platform === 'darwin') {
    return ids.map((id) => j(ctx.home, 'Library', 'Application Support', id));
  }
  if (isWindows(ctx)) {
    const roaming = appData(ctx);
    const local = localAppData(ctx);
    const candidates = [
      roaming ? j(roaming, 'io.github.clash-verge-rev.clash-verge-rev') : undefined,
      local ? j(local, 'io.github.clash-verge-rev.clash-verge-rev') : undefined,
      roaming ? j(roaming, 'clash-verge') : undefined,
    ].filter((p): p is string => p !== undefined);
    return candidates.length > 0
      ? candidates
      : [j(ctx.home, 'AppData', 'Roaming', 'io.github.clash-verge-rev.clash-verge-rev')];
  }
  return [
    j(xdgConfigHome(ctx), 'io.github.clash-verge-rev.clash-verge-rev'),
    j(xdgDataHome(ctx), 'io.github.clash-verge-rev.clash-verge-rev'),
    j(xdgConfigHome(ctx), 'clash-verge'),
    j(xdgConfigHome(ctx), 'clash-verge-rev'),
  ];
}

/** 订阅档案可能所在的子目录名（不同前端叫法不一）。 */
export const PROFILE_SUBDIR_NAMES = ['profiles', 'profile', 'subscriptions'] as const;

/** 内核二进制候选路径（按优先级）。 */
export function kernelCandidates(ctx: PlatformContext): string[] {
  const j = joinFor(ctx);
  const exe = isWindows(ctx) ? 'mihomo.exe' : 'mihomo';
  const out: string[] = [];

  if (ctx.platform === 'darwin') {
    out.push(
      '/Applications/Clash Party.app/Contents/Resources/sidecar/mihomo',
      j(clashPartyDataDirs(ctx)[0]!, 'sidecar', 'mihomo'),
      '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo',
      '/Applications/ClashX Meta.app/Contents/Resources/mihomo',
      '/opt/homebrew/bin/mihomo',
      '/usr/local/bin/mihomo',
      j(ctx.home, '.config', 'mihomo', 'mihomo'),
    );
  } else if (isWindows(ctx)) {
    const local = localAppData(ctx);
    const roaming = appData(ctx);
    const programFiles = ctx.env['PROGRAMFILES'];
    const programFilesX86 = ctx.env['PROGRAMFILES(X86)'];
    for (const base of [local && j(local, 'Programs'), programFiles, programFilesX86]) {
      if (!base) continue;
      out.push(
        j(base, 'Clash Verge', 'verge-mihomo.exe'),
        j(base, 'Clash Party', 'resources', 'sidecar', 'mihomo.exe'),
        j(base, 'Clash Party', 'sidecar', 'mihomo.exe'),
        j(base, 'mihomo', 'mihomo.exe'),
      );
    }
    if (roaming) out.push(j(roaming, 'mihomo', exe));
  } else {
    out.push(
      '/usr/bin/mihomo',
      '/usr/local/bin/mihomo',
      '/usr/bin/clash-meta',
      '/usr/local/bin/clash-meta',
      '/opt/mihomo/mihomo',
      j(ctx.home, '.local', 'bin', 'mihomo'),
      j(xdgConfigHome(ctx), 'mihomo', 'mihomo'),
    );
  }
  // 裸命令名不在这里处理：PATH 查找由 findKernelBinary 用 which/where 负责。
  return [...new Set(out)];
}

/** 用于在 PATH 里查找内核的命令名。 */
export function kernelExecutableNames(ctx: PlatformContext): string[] {
  return isWindows(ctx) ? ['verge-mihomo', 'mihomo', 'clash-meta'] : ['mihomo', 'verge-mihomo', 'clash-meta'];
}

/** 枚举套接字文件的目录（POSIX）。Windows 上返回空数组，改用命名管道候选。 */
export function socketDirs(ctx: PlatformContext): string[] {
  const j = joinFor(ctx);
  if (isWindows(ctx)) return [];
  const runtime = ctx.env['XDG_RUNTIME_DIR'];
  return [...new Set(['/tmp', '/var/run', '/var/tmp', runtime].filter((d): d is string => Boolean(d)))];
}

/**
 * 命名管道候选（Windows）。Clash Verge 用的是 `\\.\pipe\verge-mihomo`；
 * 其余几个是常见命名，找不到时可用 --controller pipe:<名字> 显式指定。
 */
export function pipeCandidates(ctx: PlatformContext): string[] {
  const j = joinFor(ctx);
  if (!isWindows(ctx)) return [];
  return [
    '\\\\.\\pipe\\verge-mihomo',
    '\\\\.\\pipe\\mihomo-party',
    '\\\\.\\pipe\\mihomo',
    '\\\\.\\pipe\\clash-verge',
  ];
}

/** 系统计划任务机制的显示名（用于报告与错误提示）。 */
export function scheduleBackendName(ctx: PlatformContext): string {
  if (ctx.platform === 'darwin') return 'launchd';
  if (isWindows(ctx)) return '任务计划程序（schtasks）';
  return 'systemd 用户定时器';
}
