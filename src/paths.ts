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
  /** 由 -d 指定的工作目录。 */
  workDir?: string;
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

/** 列出正在运行的内核进程与它的原始命令行。 */
function runProcessList(ctx: PlatformContext): { pid: number; command: string }[] {
  const out: { pid: number; command: string }[] = [];
  if (isWindows(ctx)) {
    // Windows 没有 ps：用 PowerShell 取进程命令行
    let raw: string;
    try {
      raw = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ' +
            'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(raw.trim() || '[]');
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue;
        const rec = item as { ProcessId?: unknown; CommandLine?: unknown };
        if (typeof rec.ProcessId === 'number' && typeof rec.CommandLine === 'string') {
          out.push({ pid: rec.ProcessId, command: rec.CommandLine });
        }
      }
    } catch {
      return [];
    }
    return out;
  }

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
    out.push({ pid: Number(pidText), command });
  }
  return out;
}

/** 列出正在运行的 mihomo 内核进程（含工作目录与控制端点参数）。 */
export function listKernelProcesses(ctx: PlatformContext = currentPlatform()): KernelProcess[] {
  const results: KernelProcess[] = [];
  for (const { pid, command } of runProcessList(ctx)) {
    if (!KERNEL_COMMAND_PATTERN.test(command)) continue;
    if (command.includes('afc-probe')) continue;
    results.push({ pid, command, ...parseKernelArgs(command) });
  }
  return results;
}

/**
 * 候选的运行时配置文件路径。
 * Clash Party 正常使用 <dataDir>/work/config.yaml；
 * 进程的 -d 参数是最权威的来源（能覆盖 diffWorkDir 等设置）。
 */
export function runtimeConfigPathCandidates(
  explicit?: string,
  ctx: PlatformContext = currentPlatform(),
): string[] {
  const j = joinFor(ctx);
  const paths: string[] = [];
  if (explicit) paths.push(explicit);
  for (const proc of listKernelProcesses(ctx)) {
    if (proc.workDir) paths.push(joinLike(proc.workDir, 'config.yaml'));
  }
  // Clash Verge 系列把合并后的运行时配置放在数据目录下的 config.yaml
  for (const dir of clashVergeDataDirs(ctx)) paths.push(j(dir, 'config.yaml'));
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
  return [...new Set(paths.filter((p) => existsSync(p)))];
}

/** 读取运行时配置中的通用字段（endpoint / secret 等）。 */
export interface RuntimeConfigSummary {
  path: string;
  externalController?: string;
  externalControllerUnix?: string;
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
  return {
    path,
    ...(str(doc['external-controller']) ? { externalController: str(doc['external-controller']) } : {}),
    ...(str(doc['external-controller-unix']) ? { externalControllerUnix: str(doc['external-controller-unix']) } : {}),
    ...(str(doc['secret']) ? { secret: str(doc['secret']) } : {}),
    proxies: Array.isArray(doc['proxies']) ? doc['proxies'] : [],
    proxyGroups: Array.isArray(doc['proxy-groups']) ? doc['proxy-groups'] : [],
    proxyProviders: obj(doc['proxy-providers']),
  };
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
