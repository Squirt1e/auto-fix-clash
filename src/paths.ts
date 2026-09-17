import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Clash Party 的数据目录。 */
export function clashPartyDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'mihomo-party');
}

/** Clash Verge Rev 的数据目录（仅用于发现，本期不写入）。 */
export function clashVergeDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev');
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 已知的内核二进制位置（按优先级）。 */
export function kernelPathCandidates(): string[] {
  return [
    '/Applications/Clash Party.app/Contents/Resources/sidecar/mihomo',
    join(clashPartyDataDir(), 'sidecar', 'mihomo'),
    '/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo',
    '/Applications/ClashX Meta.app/Contents/Resources/mihomo',
    '/opt/homebrew/bin/mihomo',
    '/usr/local/bin/mihomo',
    join(homedir(), '.config', 'mihomo', 'mihomo'),
  ];
}

export class KernelNotFoundError extends Error {
  constructor(tried: string[]) {
    super(
      '找不到 mihomo 内核二进制。\n' +
      '已尝试的位置：\n' + tried.map((p) => `  - ${p}`).join('\n') + '\n' +
      '请在 afc.config.yaml 中设置 probe.kernelPath 指定内核路径，\n' +
      '或确认 Clash Party / Clash Verge 已安装（本项目不下载、不内置内核）。',
    );
    this.name = 'KernelNotFoundError';
  }
}

/** 定位 mihomo 内核二进制：显式路径 > 已知位置 > PATH。 */
export function findKernelBinary(explicit?: string): string {
  const tried: string[] = [];
  if (explicit) {
    if (isExecutableFile(explicit)) return explicit;
    tried.push(`${explicit}（配置中指定，不可执行）`);
  }
  for (const candidate of kernelPathCandidates()) {
    tried.push(candidate);
    if (isExecutableFile(candidate)) return candidate;
  }
  for (const name of ['mihomo', 'verge-mihomo', 'clash-meta']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
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
  return out;
}

/** 列出正在运行的 mihomo 内核进程。 */
export function listKernelProcesses(): KernelProcess[] {
  let psOut: string;
  try {
    psOut = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return [];
  }
  const results: KernelProcess[] = [];
  for (const line of psOut.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pidText, command] = match;
    if (!command || !/(^|\/)(mihomo|verge-mihomo|clash-meta)(\s|$)/.test(command)) continue;
    if (command.includes('afc-probe')) continue;
    results.push({ pid: Number(pidText), command, ...parseKernelArgs(command) });
  }
  return results;
}

/**
 * 候选的运行时配置文件路径。
 * Clash Party 正常使用 <dataDir>/work/config.yaml；
 * 进程的 -d 参数是最权威的来源（能覆盖 diffWorkDir 等设置）。
 */
export function runtimeConfigPathCandidates(explicit?: string): string[] {
  const paths: string[] = [];
  if (explicit) paths.push(explicit);
  for (const proc of listKernelProcesses()) {
    if (proc.workDir) paths.push(join(proc.workDir, 'config.yaml'));
  }
  const partyWork = join(clashPartyDataDir(), 'work');
  paths.push(join(partyWork, 'config.yaml'));
  // diffWorkDir 模式下配置位于 work/<profileId>/config.yaml
  try {
    for (const entry of readdirSync(partyWork, { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(join(partyWork, entry.name, 'config.yaml'));
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
}

export function readRuntimeConfig(path: string): RuntimeConfigSummary {
  const doc = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') throw new Error(`运行时配置不是有效的 YAML 映射：${path}`);
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  return {
    path,
    ...(str(doc['external-controller']) ? { externalController: str(doc['external-controller']) } : {}),
    ...(str(doc['external-controller-unix']) ? { externalControllerUnix: str(doc['external-controller-unix']) } : {}),
    ...(str(doc['secret']) ? { secret: str(doc['secret']) } : {}),
    proxies: Array.isArray(doc['proxies']) ? doc['proxies'] : [],
    proxyGroups: Array.isArray(doc['proxy-groups']) ? doc['proxy-groups'] : [],
  };
}
