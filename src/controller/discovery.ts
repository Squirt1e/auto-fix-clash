import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MihomoClient, NotMihomoError, UnauthorizedError } from './client.ts';
import { describeEndpoint, HttpError, type ControllerEndpoint } from './http.ts';
import { listKernelProcesses, readRuntimeConfig, runtimeConfigPathCandidates } from '../paths.ts';

export interface DiscoveredController {
  endpoint: ControllerEndpoint;
  version: string;
  client: MihomoClient;
}

export type DiscoveryReason = 'no-candidates' | 'unauthorized' | 'unreachable';

export interface EndpointAttempt {
  endpoint: string;
  error: string;
}

export class ControllerDiscoveryError extends Error {
  readonly reason: DiscoveryReason;
  readonly attempts: EndpointAttempt[];

  constructor(reason: DiscoveryReason, attempts: EndpointAttempt[]) {
    super(ControllerDiscoveryError.buildMessage(reason, attempts));
    this.name = 'ControllerDiscoveryError';
    this.reason = reason;
    this.attempts = attempts;
  }

  private static buildMessage(reason: DiscoveryReason, attempts: EndpointAttempt[]): string {
    const detail = attempts.length > 0
      ? '\n已尝试的端点：\n' + attempts.map((a) => `  - ${a.endpoint}：${a.error}`).join('\n')
      : '';
    switch (reason) {
      case 'no-candidates':
        return '没有找到任何 mihomo 控制端点候选。\n'
          + '请确认 Clash Party / Clash Verge 正在运行（内核进程未运行时不提供服务），\n'
          + '或用 --controller <unix:/path | host:port> 显式指定端点。';
      case 'unauthorized':
        return '找到了控制端点，但认证失败。\n'
          + '请在 afc.config.yaml 中配置 controller.secret，或用 --secret 指定密钥。' + detail;
      case 'unreachable':
        return '找到了控制端点候选，但都无法访问。\n'
          + '可能是内核正在重启、套接字路径已变化，或端点并非 mihomo 控制端口。' + detail;
    }
  }
}

export interface DiscoverOptions {
  /** 显式端点：`unix:/path/to.sock`、`http://127.0.0.1:9090` 或 `127.0.0.1:9090`。 */
  explicit?: string;
  secret?: string;
  timeoutMs?: number;
  /** 显式指定运行时配置路径（用于读取 external-controller 与 secret）。 */
  runtimeConfigPath?: string;
  /** 额外注入的候选（测试用）。 */
  extraCandidates?: ControllerEndpoint[];
}

/** 解析用户给出的端点字符串。 */
export function parseEndpointString(value: string, secret?: string): ControllerEndpoint {
  const source = '显式指定';
  if (value.startsWith('unix:')) {
    const path = value.slice('unix:'.length);
    if (!path) throw new Error(`无效的端点：${value}`);
    return { kind: 'unix', path, source, ...(secret ? { secret } : {}) };
  }
  const stripped = value.replace(/^https?:\/\//, '');
  const [host, portText] = stripped.split(':');
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(`无效的端点：${value}（期望 unix:/path 或 host:port）`);
  }
  return { kind: 'tcp', host, port, source, ...(secret ? { secret } : {}) };
}

const SOCKET_DIRS = ['/tmp', '/var/run', '/var/tmp'];
const SOCKET_NAME_PATTERN = /(mihomo|clash|verge|party)/i;

function discoverSocketFiles(): string[] {
  const found: string[] = [];
  for (const dir of SOCKET_DIRS) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.sock')) continue;
      if (!SOCKET_NAME_PATTERN.test(entry)) continue;
      found.push(join(dir, entry));
    }
  }
  return found;
}

const keyOf = (e: ControllerEndpoint): string => (e.kind === 'unix' ? `unix:${e.path}` : `tcp:${e.host}:${e.port}`);

/**
 * 按可靠性排序枚举候选端点：
 *   1. 显式指定
 *   2. 运行时配置中的 external-controller（最权威：内核实际在用的配置）
 *   3. 运行中内核进程的命令行参数
 *   4. 常见目录下名字像 mihomo/clash 的套接字
 *   5. 默认 TCP 端口
 */
export function candidateEndpoints(options: DiscoverOptions = {}): ControllerEndpoint[] {
  // 显式指定的端点就是唯一候选：用户既然点名了端点，失败时应该明确报错，
  // 而不是悄悄回退到别的端点（否则排查时会被误导）。
  if (options.explicit) return [parseEndpointString(options.explicit, options.secret)];

  const candidates: ControllerEndpoint[] = [];
  const push = (e: ControllerEndpoint | undefined): void => {
    if (!e) return;
    if (candidates.some((c) => keyOf(c) === keyOf(e))) return;
    candidates.push(e);
  };

  const processes = listKernelProcesses();
  for (const configPath of runtimeConfigPathCandidates(options.runtimeConfigPath)) {
    try {
      const summary = readRuntimeConfig(configPath);
      const secret = options.secret ?? summary.secret;
      if (summary.externalControllerUnix) {
        push({ kind: 'unix', path: summary.externalControllerUnix, source: `运行时配置 ${configPath}`, ...(secret ? { secret } : {}) });
      }
      if (summary.externalController) {
        const hostPort = summary.externalController.replace(/^https?:\/\//, '');
        const [host, portText] = hostPort.split(':');
        const port = Number(portText);
        if (host && Number.isInteger(port) && port > 0) {
          const normalized = host === '0.0.0.0' || host === '' ? '127.0.0.1' : host;
          push({ kind: 'tcp', host: normalized, port, source: `运行时配置 ${configPath}`, ...(secret ? { secret } : {}) });
        }
      }
    } catch {
      // 配置读取失败不影响其它候选
    }
  }

  for (const proc of processes) {
    const secret = options.secret;
    if (proc.unixSocket) {
      push({ kind: 'unix', path: proc.unixSocket, source: `内核进程 ${proc.pid} 的 -ext-ctl-unix`, ...(secret ? { secret } : {}) });
    }
    if (proc.tcpController) {
      const [host, portText] = proc.tcpController.split(':');
      const port = Number(portText);
      if (host && Number.isInteger(port) && port > 0) {
        const normalized = host === '0.0.0.0' || host === '' ? '127.0.0.1' : host;
        push({ kind: 'tcp', host: normalized, port, source: `内核进程 ${proc.pid} 的 -ext-ctl`, ...(secret ? { secret } : {}) });
      }
    }
  }

  for (const path of discoverSocketFiles()) {
    push({ kind: 'unix', path, source: '套接字目录扫描', ...(options.secret ? { secret: options.secret } : {}) });
  }

  push({ kind: 'tcp', host: '127.0.0.1', port: 9090, source: '默认 TCP 端口', ...(options.secret ? { secret: options.secret } : {}) });

  for (const extra of options.extraCandidates ?? []) push(extra);

  return candidates;
}

/**
 * 发现并验证 mihomo 控制端点。
 * 逐个候选请求 /version，取第一个确认是 mihomo 的端点。
 */
export async function discoverController(options: DiscoverOptions = {}): Promise<DiscoveredController> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const candidates = candidateEndpoints(options);
  if (candidates.length === 0) throw new ControllerDiscoveryError('no-candidates', []);

  const attempts: EndpointAttempt[] = [];
  let sawUnauthorized = false;

  for (const endpoint of candidates) {
    const client = new MihomoClient(endpoint, timeoutMs);
    try {
      const info = await client.version(timeoutMs);
      return { endpoint, version: info.version, client: new MihomoClient(endpoint) };
    } catch (err) {
      if (err instanceof UnauthorizedError) sawUnauthorized = true;
      const message = err instanceof NotMihomoError ? '不是 mihomo 控制端点' : (err as Error).message;
      attempts.push({ endpoint: describeEndpoint(endpoint), error: message });
      if (err instanceof HttpError && err.status === 401) sawUnauthorized = true;
    }
  }

  throw new ControllerDiscoveryError(sawUnauthorized ? 'unauthorized' : 'unreachable', attempts);
}
