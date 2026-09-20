import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  joinFor,
  joinLike,
  clashPartyDataDirs,
  clashVergeDataDirs,
  currentPlatform,
  detectWsl,
  isWindows,
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

function isExecutableFile(path: string): boolean {
  try {
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

export class KernelNotFoundError extends Error {
  constructor(tried: string[]) {
    super(
      '找不到 mihomo 内核二进制。\n' +
      (detectWsl()
        ? '检测到 afc 跑在 WSL 里：Clash 与 mihomo 内核都在 Windows 宿主机上，WSL 里看不到它们。\n'
          + '请在 Windows 的 PowerShell / cmd 里运行 afc；确实要在 WSL 里用的话，\n'
          + '用 probe.kernelPath 指一个 WSL 里可执行的 Linux 版 mihomo。\n'
        : '') +
      '已尝试的位置：\n' + tried.map((p) => `  - ${p}`).join('\n') + '\n' +
      '请在 afc 配置里设置 probe.kernelPath 指定内核路径，\n' +
      '或确认 Clash Party / Clash Verge 已安装（本项目不下载、不内置内核）。',
    );
    this.name = 'KernelNotFoundError';
  }
}

/** 定位 mihomo 内核二进制：显式路径 > 已知位置 > PATH。 */
export function findKernelBinary(explicit?: string, ctx: PlatformContext = currentPlatform()): string {
  const tried: string[] = [];
  if (explicit) {
    if (isExecutableFile(explicit)) return explicit;
    tried.push(`${explicit}（配置中指定，不可执行）`);
  }
  for (const candidate of kernelPathCandidates(ctx)) {
    tried.push(candidate);
    if (isExecutableFile(candidate)) return candidate;
  }
  const lookup = isWindows(ctx) ? { cmd: 'where', args: [] } : { cmd: 'which', args: [] };
  for (const name of kernelExecutableNames(ctx)) {
    try {
      const out = execFileSync(lookup.cmd, [...lookup.args, name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      // where 可能返回多行，取第一行
      const found = out.split(/\r?\n/)[0]?.trim();
      if (found && isExecutableFile(found)) return found;
    } catch {
      tried.push(`PATH 中的 ${name}`);
    }
  }
  throw new KernelNotFoundError(tried);
}

/** 运行中的 mihomo 进程信息。 */
export interface KernelProcess {
  pid: number;
  command: string;
  /** Windows 上的镜像名（例如 verge-mihomo.exe）。 */
  name?: string;
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
    const rec = item as { ProcessId?: unknown; Name?: unknown; CommandLine?: unknown };
    const pid = typeof rec.ProcessId === 'number' ? rec.ProcessId : Number(rec.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const name = typeof rec.Name === 'string' ? rec.Name : '';
    const command = typeof rec.CommandLine === 'string' && rec.CommandLine.trim() !== ''
      ? rec.CommandLine.trim()
      : undefined;
    entries.push({ pid, name, ...(command ? { command } : {}) });
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

/** 清掉进程列表缓存（测试与「内核刚重启」这类场景用）。 */
export function clearWindowsProcessCache(): void {
  windowsProcessCache = undefined;
  windowsUserSidCache = undefined;
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
      'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
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
        'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    );
    entries = raw ? parseWindowsProcessJson(raw) : [];
  }

  windowsProcessCache = entries;
  return entries;
}

/** 列出正在运行的内核进程与它的原始命令行。 */
function runProcessList(ctx: PlatformContext): WindowsProcessEntry[] {
  const out: WindowsProcessEntry[] = [];
  if (isWindows(ctx)) return runWindowsProcessList();

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
    out.push({ pid: Number(pidText), name: '', command });
  }
  return out;
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
