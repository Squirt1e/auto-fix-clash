import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isVerbose } from './verbosity.ts';
import {
  joinFor,
  joinLike,
  clashPartyDataDirs,
  clashVergeDataDirs,
  currentPlatform,
  detectWsl,
  dirnameLike,
  isWindows,
  looksLikeWindowsPath,
  kernelCandidates,
  kernelExecutableNames,
  pipeCandidates,
  socketDirs,
  type PlatformContext,
} from './platform.ts';

/** Clash Party 数据目录（按平台；可传 ctx 便于测试）。 */
export function clashPartyDataDir(ctx: PlatformContext = currentPlatform()): string {
  return clashPartyDataDirs(ctx)[0]!;
}

/** Clash Verge Rev 数据目录（按平台；仅用于发现，不写入）。 */
export function clashVergeDataDir(ctx: PlatformContext = currentPlatform()): string {
  return clashVergeDataDirs(ctx)[0]!;
}

/**
 * 这个路径能不能拿来当内核用。
 *
 * Windows 上没有可执行位（`X_OK` 在那里没有意义），所以只要求「存在且是文件」；
 * POSIX 上仍然要求可执行，免得把同名目录或数据文件当内核。
 */
function isExecutableFile(path: string, ctx: PlatformContext = currentPlatform()): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (isWindows(ctx)) return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 已知的内核二进制位置（按平台，按优先级）。 */
export function kernelPathCandidates(ctx: PlatformContext = currentPlatform()): string[] {
  return kernelCandidates(ctx);
}

/** 客户端主程序（GUI）的镜像名 —— 用它来推断内核在哪：内核就在它旁边。 */
const CLIENT_IMAGE_PATTERN = /^(clash[- ]?verge|verge|clash[- ]?party|mihomo[- ]?party)(\.exe)?$/i;
/** 客户端主程序在 POSIX 上的命令行特征。 */
const CLIENT_COMMAND_PATTERN = /(Clash Verge|Clash Party|mihomo-party)(\.app)?\//;

/**
 * 从「正在运行的进程」推断内核路径。
 *
 * 这是最可靠的一条：Verge 自己解析内核就是取 `current_exe()` 的同级文件，
 * 所以只要拿到客户端主程序的位置，内核一定在它旁边 —— 自定义目录、便携版、别的盘都能覆盖。
 * 其次，正在运行的内核进程本身的 exe 路径当然也可以直接用。
 */
export function kernelPathsFromProcesses(ctx: PlatformContext = currentPlatform()): string[] {
  const found: string[] = [];
  const remember = (path: string | undefined): void => {
    if (!path) return;
    if (!found.includes(path) && isExecutableFile(path, ctx)) found.push(path);
  };
  for (const proc of listKernelProcesses(ctx)) remember(proc.execPath);
  for (const proc of listClientProcesses(ctx)) {
    for (const path of siblingKernelPaths(proc.execPath)) remember(path);
  }
  return found;
}

/** 镜像名像不像客户端主程序（Clash Verge / Clash Party 的 GUI）。 */
export function isClientImageName(name: string): boolean {
  return name !== '' && CLIENT_IMAGE_PATTERN.test(name.trim());
}

/**
 * 命令行像不像客户端主程序。
 *
 * macOS 上内核也在 .app 里（`Contents/Resources/sidecar/mihomo`），所以还得看**可执行文件名**：
 * 名字像内核的就不是客户端主程序。
 */
export function isClientCommand(command: string): boolean {
  if (!CLIENT_COMMAND_PATTERN.test(command)) return false;
  // 名字像内核、或路径里有 sidecar 的，是内核而不是客户端主程序
  return !/[\\/](verge-)?mihomo(\s|$)|[\\/]sidecar[\\/]/i.test(command);
}

/**
 * 从客户端命令行推出 macOS 主程序路径。
 *
 * 不能简单地取"首个空格前的 token"：`/Applications/Clash Party.app/Contents/MacOS/Clash Party`
 * 里带空格，会被截断。.app 的布局是固定的，直接按 bundle 推更可靠。
 */
export function appBundleBinary(command: string): string | undefined {
  const match = /^(.*?)\.app[\\/]Contents[\\/]/.exec(command.trim());
  if (!match?.[1]) return undefined;
  const root = `${match[1]}.app`;
  const name = posixBasename(root).replace(/\.app$/, '');
  return posixJoin(root, 'Contents', 'MacOS', name);
}

function posixBasename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function posixJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/');
}

/** 正在运行的客户端主程序（Clash Verge / Clash Party 的 GUI 进程）。 */
export function listClientProcesses(ctx: PlatformContext = currentPlatform()): KernelProcess[] {
  const results: KernelProcess[] = [];
  for (const { pid, name, command, execPath } of runProcessList(ctx)) {
    if (command?.includes('afc-probe')) continue;
    const byName = isClientImageName(name);
    const byCommand = command !== undefined && isClientCommand(command);
    if (!byName && !byCommand) continue;
    // macOS 上没有 /proc：用 .app 布局推出主程序路径；其它 POSIX 用命令行首 token
    const resolved = execPath ?? (command ? appBundleBinary(command) ?? firstTokenPath(command) : undefined);
    if (!resolved) continue;
    results.push({ pid, command: command ?? name, execPath: resolved });
  }
  return results;
}

/**
 * 客户端主程序旁边可能放内核的位置。
 *
 * - Clash Verge (Rev)：`verge-mihomo(.exe)` / `verge-mihomo-alpha(.exe)` 与主程序同级
 *   （其 bundle 配置声明的 externalBin 就是 sidecar/verge-mihomo 与 sidecar/verge-mihomo-alpha）；
 * - Clash Party：`resources/sidecar/mihomo(.exe)`（macOS 上是 Contents/Resources/sidecar/mihomo）；
 * - 便携版/自定义目录同样适用：都只依赖「主程序在哪」。
 */
export function siblingKernelPaths(exePath: string | undefined): string[] {
  if (!exePath) return [];
  const dir = dirnameLike(exePath);
  const parent = dirnameLike(dir);
  // 扩展名跟随「主程序路径的风格」，不跟随当前系统：这样同一份逻辑既能处理
  // Windows 的自定义安装目录，也能处理 macOS 的 .app 布局（测试里也能造两种路径）。
  const names = looksLikeWindowsPath(exePath)
    ? ['verge-mihomo.exe', 'verge-mihomo-alpha.exe', 'mihomo.exe', 'mihomo-alpha.exe', 'clash-meta.exe']
    : ['verge-mihomo', 'verge-mihomo-alpha', 'mihomo', 'mihomo-alpha', 'clash-meta'];
  const out: string[] = [];
  for (const name of names) {
    out.push(joinLike(dir, name));
    // Clash Party 把内核放在 resources/sidecar/ 下
    out.push(joinLike(dir, 'resources', 'sidecar', name));
    // macOS：Contents/MacOS/xxx → Contents/Resources/sidecar/mihomo
    out.push(joinLike(parent, 'Resources', 'sidecar', name));
    out.push(joinLike(parent, 'Resources', name));
  }
  return out;
}

/** 在目录里有限深度地找内核文件（自定义布局的兜底）。 */
export function scanKernelInDirs(dirs: readonly string[], ctx: PlatformContext = currentPlatform(), maxDepth = 2): string[] {
  const pattern = /^(verge-)?mihomo(-alpha)?(\.exe)?$|^clash[-_]meta(\.exe)?$/i;
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = joinLike(dir, entry.name);
      if (entry.isFile()) {
        if (pattern.test(entry.name) && isExecutableFile(path, ctx)) found.push(path);
        continue;
      }
      if (entry.isDirectory() && depth > 0) walk(path, depth - 1);
    }
  };
  for (const dir of dirs) walk(dir, maxDepth);
  return found;
}

export class KernelNotFoundError extends Error {
  constructor(tried: string[], ctx: PlatformContext = currentPlatform()) {
    // 默认只留「发生了什么 + 一个能立刻执行的下一步」；完整清单交给 --verbose，
    // 否则十几行路径会把真正要看的那句话埋掉。
    const lines = [
      '找不到 mihomo 内核二进制（doctor / fix 需要它起临时实例来逐个探节点）。',
    ];
    if (detectWsl()) {
      lines.push('afc 在 WSL 里看不到 Windows 上的内核：请在 Windows 的 PowerShell / cmd 里运行 afc。');
    }
    lines.push(
      '在 afc.config.yaml 里指定它即可（路径写内核文件本身）：',
      '  probe:',
      `    kernelPath: <Clash 安装目录>${isWindows(ctx) ? '\\verge-mihomo.exe' : '/verge-mihomo'}`,
    );
    if (isVerbose()) {
      lines.push('已尝试的位置：', ...tried.map((p) => `  - ${p}`));
    } else {
      lines.push('已找过 Clash Verge / Clash Party 的常见位置、正在运行的进程与 PATH：加 --verbose 看完整清单。');
    }
    super(lines.join('\n'));
    this.name = 'KernelNotFoundError';
  }
}

/**
 * 定位 mihomo 内核二进制。
 *
 * 顺序按可靠性：显式路径 → 正在运行的进程（内核自己 / 客户端同级）→ 已知安装位置
 * → 客户端目录里有限深度扫描 → PATH。
 * 前三步覆盖了「客户端装在哪儿都能找到」，第四步是自定义布局的兜底。
 */
export function findKernelBinary(explicit?: string, ctx: PlatformContext = currentPlatform()): string {
  const tried: string[] = [];
  if (explicit) {
    if (isExecutableFile(explicit, ctx)) return explicit;
    tried.push(`${explicit}（配置中指定，不是可执行文件）`);
  }

  for (const path of kernelPathsFromProcesses(ctx)) {
    tried.push(`${path}（来自正在运行的进程）`);
    if (isExecutableFile(path, ctx)) return path;
  }

  for (const candidate of kernelPathCandidates(ctx)) {
    tried.push(candidate);
    if (isExecutableFile(candidate, ctx)) return candidate;
  }

  const clientDirs = listClientProcesses(ctx)
    .map((proc) => (proc.execPath ? dirname(proc.execPath) : undefined))
    .filter((d): d is string => d !== undefined);
  const scanned = scanKernelInDirs(clientDirs, ctx);
  for (const path of scanned) {
    tried.push(`${path}（在客户端目录里扫描到）`);
    if (isExecutableFile(path, ctx)) return path;
  }

  const lookup = isWindows(ctx) ? { cmd: 'where', args: [] } : { cmd: 'which', args: [] };
  for (const name of kernelExecutableNames(ctx)) {
    try {
      const out = execFileSync(lookup.cmd, [...lookup.args, name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      // where 可能返回多行，取第一行
      const foundOut = out.split(/\r?\n/)[0]?.trim();
      if (foundOut && isExecutableFile(foundOut, ctx)) return foundOut;
    } catch {
      tried.push(`PATH 中的 ${name}`);
    }
  }
  throw new KernelNotFoundError(tried, ctx);
}

/** 运行中的 mihomo 进程信息。 */
export interface KernelProcess {
  pid: number;
  command: string;
  /** Windows 上的镜像名（例如 verge-mihomo.exe）。 */
  name?: string;
  /** 进程可执行文件的完整路径（能拿到就用它当内核路径 —— 那正是正在运行的那个二进制）。 */
  execPath?: string;
  /** 由 -d 指定的工作目录。 */
  workDir?: string;
  /** 由 -f 指定的配置文件（Clash Verge 会显式传它，是最准确的运行时配置）。 */
  configFile?: string;
  /** 由 -ext-ctl-unix 指定的 Unix 套接字。 */
  unixSocket?: string;
  /** 由 -ext-ctl 指定的 TCP 监听地址。 */
  tcpController?: string;
  /** 由 -ext-ctl-pipe 指定的命名管道（Windows）。 */
  pipePath?: string;
}

/**
 * 解析 mihomo 的命令行参数（供端点与工作目录发现使用）。
 *
 * 注意：真实路径里常带空格（例如 `.../Application Support/mihomo-party/work`），
 * 因此不能简单地按空格切分，必须按「下一个 -flag」作为值的边界。
 */
export function parseKernelArgs(command: string): Omit<KernelProcess, 'pid' | 'command'> {
  const readFlag = (flag: string): string | undefined => {
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 值一直延伸到下一个以 - 开头的参数之前
    const pattern = new RegExp(
      `(?:^|\\s)${escaped}(?:\\s+|=)(.+?)(?=\\s+-{1,2}[A-Za-z][\\w-]*(?:\\s|=|$)|$)`,
    );
    const match = pattern.exec(command);
    const raw = match?.[1]?.trim();
    if (!raw) return undefined;
    const unquoted = raw.replace(/^["']|["']$/g, '').trim();
    return unquoted === '' ? undefined : unquoted;
  };

  const out: Omit<KernelProcess, 'pid' | 'command'> = {};
  const workDir = readFlag('-d');
  if (workDir) out.workDir = workDir;
  // Clash Verge 用 `-d <数据目录> -f <config.yaml>` 启动内核：-f 就是运行时配置本体
  const configFile = readFlag('-f');
  if (configFile) out.configFile = configFile;
  const unixSocket = readFlag('-ext-ctl-unix');
  if (unixSocket) out.unixSocket = unixSocket;
  const tcp = readFlag('-ext-ctl');
  if (tcp) out.tcpController = tcp;
  const pipe = readFlag('-ext-ctl-pipe');
  if (pipe) out.pipePath = pipe;
  return out;
}

/**
 * 内核进程的命令行里是否出现内核可执行文件名。
 * 同时兼容 POSIX（`/usr/bin/mihomo`）与 Windows（`C:\...\verge-mihomo.exe`）。
 */
const KERNEL_COMMAND_PATTERN = /(^|[\\/])(verge-mihomo|mihomo|clash-meta)(\.exe)?(["']?\s|"|'|$)/i;

/**
 * Windows 上按镜像名判断是否为 mihomo 内核。
 *
 * 为什么不用命令行：内核可能由 Clash Verge 的服务模式以 SYSTEM 身份启动，
 * 普通用户通过 WMI 读到的 CommandLine 会是空的 —— 但镜像名一定读得到。
 * 用「包含 mihomo / clash-meta」这种宽松匹配，是为了兼容自定义命名的内核
 * （误判的代价只是多探一个端口，不会出错）。
 */
const WINDOWS_KERNEL_IMAGE = /(mihomo|clash[-_]meta)/i;

export function isKernelImageName(name: string): boolean {
  const base = name.trim().replace(/\.exe$/i, '');
  if (base === '') return false;
  return WINDOWS_KERNEL_IMAGE.test(base) && !base.toLowerCase().startsWith('afc-');
}

/** Windows 进程列表条目（命令行可能缺失）。 */
export interface WindowsProcessEntry {
  pid: number;
  name: string;
  command?: string;
  /** 进程可执行文件的完整路径（WMI 的 ExecutablePath；别人的/SYSTEM 进程可能读不到）。 */
  execPath?: string;
}

/** 解析 PowerShell `Get-CimInstance Win32_Process ... | ConvertTo-Json` 的输出（单对象/数组都认）。 */
export function parseWindowsProcessJson(raw: string): WindowsProcessEntry[] {
  const entries: WindowsProcessEntry[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim().replace(/^\uFEFF/, '') || '[]');
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as { ProcessId?: unknown; Name?: unknown; CommandLine?: unknown; ExecutablePath?: unknown };
    const pid = typeof rec.ProcessId === 'number' ? rec.ProcessId : Number(rec.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const name = typeof rec.Name === 'string' ? rec.Name : '';
    const command = typeof rec.CommandLine === 'string' && rec.CommandLine.trim() !== ''
      ? rec.CommandLine.trim()
      : undefined;
    const execPath = typeof rec.ExecutablePath === 'string' && rec.ExecutablePath.trim() !== ''
      ? rec.ExecutablePath.trim()
      : undefined;
    entries.push({ pid, name, ...(command ? { command } : {}), ...(execPath ? { execPath } : {}) });
  }
  return entries;
}

/** 解析 `tasklist /FO CSV /NH` 输出：`"镜像名","PID",...`（表头已由 /NH 去掉，字段顺序与语言无关）。 */
export function parseWindowsTasklistCsv(raw: string): WindowsProcessEntry[] {
  const entries: WindowsProcessEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.match(/"[^"]*"|[^,]+/g);
    if (!fields || fields.length < 2) continue;
    const name = fields[0]!.replace(/^"|"$/g, '').trim();
    const pid = Number(fields[1]!.replace(/^"|"$/g, '').trim());
    if (!name || !Number.isInteger(pid) || pid <= 0) continue;
    entries.push({ pid, name });
  }
  return entries;
}

/**
 * 解析 `netstat -ano` 输出中属于指定 PID 的监听端口。
 *
 * 不依赖 state 那一列的文字：Windows 的 netstat 状态名会随系统语言变化，
 * 而「监听中」的本质特征是「对端地址为 *:0」，这一条在任何语言下都成立。
 */
export function parseWindowsNetstatListeners(raw: string, pids: readonly number[]): number[] {
  const wanted = new Set(pids);
  const ports: number[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // Proto 本地地址 对端地址 状态 PID
    if (cols.length < 4) continue;
    const proto = cols[0]!.toUpperCase();
    if (proto !== 'TCP' && proto !== 'TCPV6') continue;
    const local = cols[1]!;
    const foreign = cols[2]!;
    if (!/:0$/.test(foreign)) continue;
    const pid = Number(cols[cols.length - 1]);
    if (!wanted.has(pid)) continue;
    const portText = local.slice(local.lastIndexOf(':') + 1);
    const port = Number(portText);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

/** 单次 Windows 进程列表调用比较贵（子进程启动 + 查询），同一个进程里只查一次。 */
let windowsProcessCache: WindowsProcessEntry[] | undefined;
/** POSIX 的 ps 也要避免重复调用（内核发现与内核路径查找会各查一次）。 */
let posixProcessCache: WindowsProcessEntry[] | undefined;

/** 清掉进程列表缓存（测试与「内核刚重启」这类场景用）。 */
export function clearWindowsProcessCache(): void {
  windowsProcessCache = undefined;
  windowsUserSidCache = undefined;
  posixProcessCache = undefined;
}

function runPowerShell(script: string): string | undefined {
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    try {
      return execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      // 换下一个解释器
    }
  }
  return undefined;
}

function tryTasklist(): WindowsProcessEntry[] {
  try {
    return parseWindowsTasklistCsv(
      execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }),
    );
  } catch {
    return [];
  }
}

/**
 * 取指定进程的命令行（只查这些 PID，不做全量扫描）。
 *
 * Windows PowerShell 5.1 默认按控制台代码页（简中是 GBK）写 stdout，
 * 用 UTF-8 解码会把中文用户名一类的命令行弄成乱码，因此先强制 UTF-8 输出。
 */
function tryPowerShellCommands(pids: readonly number[]): Map<number, string> {
  const found = new Map<number, string>();
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' or ');
  const raw = runPowerShell(
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      `Get-CimInstance Win32_Process -Filter "${filter}" | ` +
      'Select-Object ProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress',
  );
  if (!raw) return found;
  for (const entry of parseWindowsProcessJson(raw)) {
    if (entry.command) found.set(entry.pid, entry.command);
  }
  return found;
}

/**
 * 列出 Windows 上的进程（镜像名 + 能读到的命令行）。
 *
 * 顺序是刻意的：
 *   1. `tasklist` 拿全部进程的镜像名与 PID —— 只要一两百毫秒，且不受权限影响；
 *   2. 只对「镜像名像内核」的那几个 PID 再查命令行（`-d` / `-f` / `-ext-ctl*` 都在里面）——
 *      服务模式下内核以 SYSTEM 身份运行，普通用户读不到它的 CommandLine，
 *      这时镜像名就是唯一可用的判据；
 *   3. tasklist 都不可用时才退回全量 WMI 扫描。
 * 全量 WMI 很贵（实测在 CI 上要十几秒），所以不能每次发现都跑它。
 */
function runWindowsProcessList(): WindowsProcessEntry[] {
  if (windowsProcessCache) return windowsProcessCache;

  let entries = tryTasklist();
  const kernelPids = entries.filter((e) => isKernelImageName(e.name)).map((e) => e.pid);
  if (kernelPids.length > 0) {
    const commands = tryPowerShellCommands(kernelPids);
    entries = entries.map((e) => {
      const command = commands.get(e.pid);
      return command ? { ...e, command } : e;
    });
  }

  if (entries.length === 0) {
    const raw = runPowerShell(
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
        'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress',
    );
    entries = raw ? parseWindowsProcessJson(raw) : [];
  }

  windowsProcessCache = entries;
  return entries;
}

/** 列出正在运行的内核进程与它的原始命令行。 */
function runProcessList(ctx: PlatformContext): WindowsProcessEntry[] {
  if (isWindows(ctx)) return runWindowsProcessList();
  if (posixProcessCache) return posixProcessCache;

  const out: WindowsProcessEntry[] = [];
  let psOut: string;
  try {
    psOut = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return [];
  }
  for (const line of psOut.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pidText, command] = match;
    if (!command) continue;
    const pid = Number(pidText);
    // 命令行首 token 通常就是可执行文件路径；/proc/<pid>/exe 更权威（Linux 有，macOS 没有）
    const execPath = procExecPath(pid) ?? firstTokenPath(command);
    out.push({ pid, name: '', command, ...(execPath ? { execPath } : {}) });
  }
  posixProcessCache = out;
  return out;
}

/** 命令行首 token 若是绝对路径就当作可执行文件（去掉可能的引号）。 */
function firstTokenPath(command: string): string | undefined {
  const match = /^"([^"]+)"|^(\S+)/.exec(command.trim());
  const token = (match?.[1] ?? match?.[2] ?? '').trim();
  return token.startsWith('/') ? token : undefined;
}

/** Linux 上 /proc/<pid>/exe 指向真实的可执行文件（被替换过也能拿到）。 */
function procExecPath(pid: number): string | undefined {
  try {
    const target = readlinkSync(`/proc/${pid}/exe`);
    return target.startsWith('/') ? target : undefined;
  } catch {
    return undefined;
  }
}

/** 列出正在运行的 mihomo 内核进程（含工作目录与控制端点参数）。 */
export function listKernelProcesses(ctx: PlatformContext = currentPlatform()): KernelProcess[] {
  const results: KernelProcess[] = [];
  for (const { pid, name, command } of runProcessList(ctx)) {
    // Windows 上镜像名就够（服务模式读不到命令行）；POSIX 只能看命令行。
    const byName = name !== '' && isKernelImageName(name);
    const byCommand = command !== undefined && KERNEL_COMMAND_PATTERN.test(command);
    if (!byName && !byCommand) continue;
    if (command?.includes('afc-probe')) continue;
    results.push({
      pid,
      name,
      command: command ?? name,
      ...(command ? parseKernelArgs(command) : {}),
    });
  }
  return results;
}

/**
 * 只按「已知数据目录」列出的运行时配置路径（不启任何子进程，因此很便宜）。
 *
 * 关键：Clash Verge Rev 真正喂给内核的运行时配置叫 **clash-verge.yaml**
 * （见其 constants.rs 的 `files::RUNTIME_CONFIG`），而 `config.yaml` 是它的 clash 配置存储，
 * 两者都要看 —— 只看后者会在不少安装上什么都读不到。
 * Clash Party 则是 <dataDir>/work/config.yaml（diffWorkDir 时在 work/<profileId>/ 下）。
 *
 * 返回的是**待检查**的候选（不预先筛存在性），调用方读不到就当没有；
 * 这样诊断输出才说得出「检查过哪些路径」。
 */
export function staticRuntimeConfigPaths(
  explicit?: string,
  ctx: PlatformContext = currentPlatform(),
): string[] {
  const j = joinFor(ctx);
  const paths: string[] = [];
  if (explicit) paths.push(explicit);
  for (const dir of clashVergeDataDirs(ctx)) {
    paths.push(j(dir, 'clash-verge.yaml'));
    paths.push(j(dir, 'config.yaml'));
  }
  for (const dir of clashPartyDataDirs(ctx)) paths.push(j(dir, 'config.yaml'));
  const partyWork = j(clashPartyDataDir(ctx), 'work');
  paths.push(j(partyWork, 'config.yaml'));
  // diffWorkDir 模式下配置位于 work/<profileId>/config.yaml
  try {
    for (const entry of readdirSync(partyWork, { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(j(partyWork, entry.name, 'config.yaml'));
    }
  } catch {
    // work 目录不存在时忽略
  }
  return [...new Set(paths)];
}

/**
 * 候选的运行时配置文件路径（只返回真实存在的文件）。
 *
 * 先放进程派生出来的（-f / -d 最权威，能覆盖 diffWorkDir 这类设置），再补数据目录。
 * 只想拿「便宜的那部分」时用 staticRuntimeConfigPaths。
 */
export function runtimeConfigPathCandidates(
  explicit?: string,
  ctx: PlatformContext = currentPlatform(),
): string[] {
  const j = joinFor(ctx);
  const paths: string[] = [];
  if (explicit) paths.push(explicit);
  for (const proc of listKernelProcesses(ctx)) {
    // -f 是内核实际在用的那份配置，比按 -d 猜出来的路径更准（Clash Verge 就是这么起的）
    if (proc.configFile) paths.push(proc.configFile);
    if (proc.workDir) paths.push(joinLike(proc.workDir, 'config.yaml'));
  }
  for (const path of staticRuntimeConfigPaths(explicit, ctx)) {
    if (!paths.includes(path)) paths.push(path);
  }
  return [...new Set(paths.filter((p) => existsSync(p)))];
}

/** 读取运行时配置中的通用字段（endpoint / secret 等）。 */
export interface RuntimeConfigSummary {
  path: string;
  externalController?: string;
  externalControllerUnix?: string;
  /** Windows 命名管道（Clash Verge Rev 就是这么把控制器交给内核的）。 */
  externalControllerPipe?: string;
  secret?: string;
  proxies: unknown[];
  proxyGroups: unknown[];
  proxyProviders: Record<string, unknown>;
}

export function readRuntimeConfig(path: string): RuntimeConfigSummary {
  const doc = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') throw new Error(`运行时配置不是有效的 YAML 映射：${path}`);
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const pipe = str(doc['external-controller-pipe']);
  return {
    path,
    ...(str(doc['external-controller']) ? { externalController: str(doc['external-controller']) } : {}),
    ...(str(doc['external-controller-unix']) ? { externalControllerUnix: str(doc['external-controller-unix']) } : {}),
    ...(pipe ? { externalControllerPipe: normalizeWindowsPipePath(pipe) } : {}),
    ...(str(doc['secret']) ? { secret: str(doc['secret']) } : {}),
    proxies: Array.isArray(doc['proxies']) ? doc['proxies'] : [],
    proxyGroups: Array.isArray(doc['proxy-groups']) ? doc['proxy-groups'] : [],
    proxyProviders: obj(doc['proxy-providers']),
  };
}

/**
 * 把配置/命令行里写的管道名规范成 Node 能连的完整路径。
 *
 * mihomo 的 external-controller-pipe 允许只写名字（例如 `verge-mihomo`），
 * 而 node:http 的 socketPath 需要 `\\.\pipe\verge-mihomo` 这种完整形式。
 */
export function normalizeWindowsPipePath(value: string): string {
  const trimmed = value.trim().replace(/\//g, '\\');
  if (trimmed.startsWith('\\\\')) return trimmed;
  return `\\\\.\\pipe\\${trimmed.replace(/^\\+/, '')}`;
}

/**
 * 内核进程自己监听的 TCP 端口（Windows）。
 *
 * 为什么需要：Clash Verge Rev 的 external-controller 端口可以自定义甚至随重启变化，
 * 只猜 9090/9097 会漏；而内核是哪个进程、监听了哪些端口是能直接查到的。
 * 多出来的端口（混合代理口等）无害 —— 探针会用 GET /version 确认是不是控制端口。
 */
export function windowsListenerPorts(pids: readonly number[]): number[] {
  if (pids.length === 0) return [];
  const wanted = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (wanted.length === 0) return [];

  try {
    const raw = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const ports = parseWindowsNetstatListeners(raw, wanted);
    if (ports.length > 0) return ports;
  } catch {
    // 落到 PowerShell
  }

  const ports: number[] = [];
  for (const pid of wanted) {
    const raw = runPowerShell(
      `Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | ` +
        'Select-Object -ExpandProperty LocalPort',
    );
    for (const line of (raw ?? '').split(/\r?\n/)) {
      const port = Number(line.trim());
      if (Number.isInteger(port) && port > 0 && port <= 65535 && !ports.includes(port)) ports.push(port);
    }
  }
  return ports;
}

/**
 * 客户端写在数据目录里的内核 PID 文件。
 *
 * Clash Party 会把内核 PID 写到 <dataDir>/core.pid，这样即使读不到命令行
 * （服务模式、权限不足），也能顺藤摸瓜找到内核监听的端口。
 */
export function kernelPidFilePids(ctx: PlatformContext = currentPlatform()): number[] {
  const j = joinFor(ctx);
  const files = [
    ...clashPartyDataDirs(ctx).map((dir) => j(dir, 'core.pid')),
    ...clashVergeDataDirs(ctx).map((dir) => j(dir, 'core.pid')),
  ];
  const pids: number[] = [];
  for (const file of files) {
    try {
      const pid = Number(readFileSync(file, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
    } catch {
      // 没有这个文件就跳过
    }
  }
  return pids;
}

/** 当前 Windows 用户的 SID（Verge 的管道名由它派生）。 */
let windowsUserSidCache: string | undefined;

export function windowsUserSid(): string | undefined {
  if (windowsUserSidCache !== undefined) return windowsUserSidCache || undefined;
  const readSid = (text: string | undefined): string | undefined => {
    const match = text ? /S-1-[0-9-]+/.exec(text.replace(/\s+/g, '')) : null;
    return match?.[0];
  };

  // whoami 只要几十毫秒，PowerShell 启动要接近一秒：先 whoami，拿不到才上 PowerShell
  let raw: string | undefined;
  try {
    raw = execFileSync('whoami.exe', ['/user'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    raw = undefined;
  }
  let sid = readSid(raw);
  if (!sid) {
    sid = readSid(runPowerShell('[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'));
  }

  windowsUserSidCache = sid ?? '';
  return sid;
}

export interface NodeDefinitionSource {
  /** 节点定义（可直接喂给探针实例）。 */
  proxies: unknown[];
  nodeNames: string[];
  /** 定义来自哪个文件。 */
  path: string;
  /** runtime-config = 内核实际在跑的配置；profile-file = 订阅档案。 */
  kind: 'runtime-config' | 'profile-file';
  /** 该文件里是否使用了 proxy-providers（节点由外部下发）。 */
  usesProxyProviders: boolean;
}

function proxyNames(proxies: unknown[]): string[] {
  return proxies
    .map((p) => (typeof p === 'object' && p !== null ? (p as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string' && n !== '');
}

/** 命中的节点名越多，说明这个文件越可能就是当前生效的订阅。 */
function scoreNames(names: string[], needed?: readonly string[]): number {
  if (!needed || needed.length === 0) return names.length;
  const wanted = new Set(needed);
  return names.reduce((acc, n) => acc + (wanted.has(n) ? 1 : 0), 0);
}

/** 订阅档案可能存放的位置（运行时配置所在目录及其上级的 profiles 子目录等）。 */
function profileFileCandidates(runtimeConfigPaths: string[], ctx: PlatformContext): string[] {
  const dirs = new Set<string>();
  for (const path of runtimeConfigPaths) {
    const dir = dirname(path);
    dirs.add(dir);
    dirs.add(dirname(dir));
  }
  dirs.add(clashPartyDataDir(ctx));
  dirs.add(clashVergeDataDir(ctx));

  const files: string[] = [];
  for (const dir of dirs) {
    const rel = (child: string) => joinLike(dir, child);
    for (const sub of [dir, rel('profiles'), rel('profile'), rel('subscriptions')]) {
      let entries;
      try {
        entries = readdirSync(sub, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(ya?ml)$/i.test(entry.name)) continue;
        files.push(joinLike(sub, entry.name));
      }
    }
  }
  return [...new Set(files)];
}

export class NodeDefinitionNotFoundError extends Error {
  constructor(tried: string[], needed?: readonly string[]) {
    super(
      '找不到可用的节点定义。\n' +
      (needed && needed.length > 0
        ? `需要定义的节点（当前订阅的组成员，共 ${needed.length} 个）：${needed.slice(0, 3).join('、')}${needed.length > 3 ? ' …' : ''}\n`
        : '') +
      '已检查的文件：\n' + tried.map((p) => `  - ${p}`).join('\n') + '\n' +
      '如果节点由 proxy-providers 外链下发，请确认该订阅能被内核正常加载；\n' +
      '也可以在 afc.config.yaml 里用 probe.runtimeConfigPath 显式指定运行时配置路径。',
    );
    this.name = 'NodeDefinitionNotFoundError';
  }
}

/**
 * 找出「当前生效的」节点定义。
 *
 * 不同客户端喂给内核的运行时配置位置不同，而且有些客户端把节点放在外链的
 * proxy-providers 里。这里按「与当前订阅组成员的重合度」挑最匹配的文件，
 * 从而对 Clash Party / Clash Verge / 独立 mihomo 都尽量通用。
 */
export function findNodeDefinitions(
  options: { runtimeConfigPath?: string; neededNodeNames?: readonly string[] } = {},
  ctx: PlatformContext = currentPlatform(),
): NodeDefinitionSource {
  // 显式指定了运行时配置就只认它（外加订阅档案兜底）：
  // 否则机器上同时存在多个客户端时，会挑到另一个客户端的数据，用户无法预期。
  const explicitPath = options.runtimeConfigPath
    ? (isAbsolute(options.runtimeConfigPath) ? options.runtimeConfigPath : resolve(options.runtimeConfigPath))
    : undefined;
  const runtimePaths = explicitPath ? [explicitPath] : runtimeConfigPathCandidates(undefined, ctx);
  const tried: string[] = [];
  let best: NodeDefinitionSource | undefined;
  let bestScore = -1;

  const consider = (path: string, kind: NodeDefinitionSource['kind']): void => {
    if (tried.includes(path)) return;
    tried.push(path);
    let summary: RuntimeConfigSummary;
    try {
      summary = readRuntimeConfig(path);
    } catch {
      return;
    }
    if (summary.proxies.length === 0) return;
    const names = proxyNames(summary.proxies);
    const score = scoreNames(names, options.neededNodeNames);
    if (score > bestScore) {
      bestScore = score;
      best = {
        proxies: summary.proxies,
        nodeNames: names,
        path,
        kind,
        usesProxyProviders: Object.keys(summary.proxyProviders).length > 0,
      };
    }
  };

  for (const path of runtimePaths) consider(path, 'runtime-config');
  // 运行时配置里没有内联节点时（或重合度为 0），去订阅档案里找
  if (bestScore <= 0) {
    for (const path of profileFileCandidates(runtimePaths, ctx)) consider(path, 'profile-file');
  }

  if (!best || bestScore <= 0) throw new NodeDefinitionNotFoundError(tried, options.neededNodeNames);
  return best;
}
