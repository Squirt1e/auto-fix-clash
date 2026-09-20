import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { isWindows, type PlatformContext } from '../platform.ts';

/**
 * Windows 命名管道枚举。
 *
 * 为什么需要枚举而不是写死名字：Clash Verge Rev 新版的管道名带有「按用户 SID 派生的 hash」
 * （`\\.\pipe\verge-mihomo-sidecar-release-<sha256>`），Clash Party 用的是「子目录」形式
 * （`\\.\pipe\MihomoParty\mihomo`）——写死的名字表一定会漏。
 * 系统里实际存在的管道名单是权威且廉价的，先枚举再挑，比猜可靠得多。
 */

/** 名字像 mihomo 客户端的管道（含子目录名）。 */
const PIPE_NAME_PATTERN = /(mihomo|clash|verge|party)/i;
/** 兜底：名字里带 meta 的也看一眼（例如自建内核给管道起的名）。 */
const WEAK_PIPE_NAME_PATTERN = /meta/i;

export const WINDOWS_PIPE_ROOT = '\\\\.\\pipe\\';

/**
 * 把枚举到的管道名整理成候选路径。
 *
 * `names` 里既可能是扁平名（`verge-mihomo`），也可能是「子目录」形式
 * （`MihomoParty\mihomo`，来自枚举时向下看一层）。同名去重，强匹配排在前面。
 */
export function pipePathsFromNames(names: readonly string[]): string[] {
  const strong: string[] = [];
  const weak: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim().replace(/^\\+/, '');
    if (!name || seen.has(name.toLowerCase())) continue;
    const path = `${WINDOWS_PIPE_ROOT}${name}`;
    if (PIPE_NAME_PATTERN.test(name)) {
      seen.add(name.toLowerCase());
      strong.push(path);
    } else if (WEAK_PIPE_NAME_PATTERN.test(name)) {
      seen.add(name.toLowerCase());
      weak.push(path);
    }
  }
  return [...strong, ...weak];
}

/** 直接读 `\\.\pipe\` 目录（Node 把管道命名空间当目录读；某些版本会报 ENOTDIR，故必须 try）。 */
function readPipeNamesViaFs(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(WINDOWS_PIPE_ROOT);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const name of entries) {
    names.push(name);
    // 管道可以再分一层目录：\\.\pipe\MihomoParty\mihomo
    if (!PIPE_NAME_PATTERN.test(name)) continue;
    try {
      for (const child of readdirSync(`${WINDOWS_PIPE_ROOT}${name}`)) names.push(`${name}\\${child}`);
    } catch {
      // 不是子目录 / 没权限，忽略
    }
  }
  return names;
}

/** 兜底：用 .NET 的目录 API 枚举（Node 的 readdir 在某些版本对管道命名空间不工作）。 */
function readPipeNamesViaPowerShell(): string[] {
  const script =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
    '$out=New-Object System.Collections.ArrayList; ' +
    "foreach($e in [System.IO.Directory]::GetFileSystemEntries('\\\\.\\pipe\\')){" +
    '[void]$out.Add($e); ' +
    'if([System.IO.Directory]::Exists($e)){foreach($c in [System.IO.Directory]::GetFileSystemEntries($e)){[void]$out.Add($c)}}}; ' +
    '$out -join [char]10';
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    try {
      const raw = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim().replace(/^\\\\\.\\pipe\\/i, ''))
        .filter((line) => line !== '');
    } catch {
      // 换下一个解释器
    }
  }
  return [];
}

let pipeCache: string[] | undefined;

/** 清掉管道枚举缓存（测试用）。 */
export function clearWindowsPipeCache(): void {
  pipeCache = undefined;
}

/** 系统里实际存在的、看起来像 mihomo 控制端点的命名管道。 */
export function listWindowsPipes(ctx: PlatformContext): string[] {
  if (!isWindows(ctx)) return [];
  if (pipeCache) return pipeCache;
  const names = readPipeNamesViaFs();
  const found = names.length > 0 ? names : readPipeNamesViaPowerShell();
  pipeCache = pipePathsFromNames(found);
  return pipeCache;
}
