import { readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { MihomoClient, NotMihomoError, UnauthorizedError } from './client.ts';
import { describeEndpoint, endpointArg, HttpError, type ControllerEndpoint } from './http.ts';
import {
  kernelPidFilePids,
  listKernelProcesses,
  normalizeWindowsPipePath,
  readRuntimeConfig,
  runtimeConfigPathCandidates,
  staticRuntimeConfigPaths,
  windowsListenerPorts,
  windowsUserSid,
  type KernelProcess,
} from '../paths.ts';
import {
  currentPlatform,
  DEFAULT_CONTROLLER_PORTS,
  detectWsl,
  isWindows,
  pipeCandidates,
  socketDirs,
  vergeSidecarPipeNames,
  type PlatformContext,
} from '../platform.ts';
import { scanWindowsPipes } from './pipe-scan.ts';

export interface DiscoveredController {
  endpoint: ControllerEndpoint;
  version: string;
  client: MihomoClient;
}

export type DiscoveryReason = 'no-candidates' | 'unauthorized' | 'unreachable';

export interface EndpointAttempt {
  endpoint: string;
  /** 候选是怎么来的（运行时配置 / 内核进程 / 管道枚举 …），排查时最关键的一列。 */
  source: string;
  error: string;
  /** 这个端口的应答像是「代理端口」而不是「控制端口」。 */
  proxyPortLike?: boolean;
}

/** 显式端点失败时，顺手发现的可用端点。 */
export interface AlternativeEndpoint {
  endpoint: ControllerEndpoint;
  version: string;
}

export class ControllerDiscoveryError extends Error {
  readonly reason: DiscoveryReason;
  readonly attempts: EndpointAttempt[];
  readonly hint?: string;
  readonly alternative?: AlternativeEndpoint;

  constructor(
    reason: DiscoveryReason,
    attempts: EndpointAttempt[],
    hint?: string,
    alternative?: AlternativeEndpoint,
  ) {
    super(ControllerDiscoveryError.buildMessage(reason, attempts, hint, alternative));
    this.name = 'ControllerDiscoveryError';
    this.reason = reason;
    this.attempts = attempts;
    if (hint) this.hint = hint;
    if (alternative) this.alternative = alternative;
  }

  private static buildMessage(
    reason: DiscoveryReason,
    attempts: EndpointAttempt[],
    hint?: string,
    alternative?: AlternativeEndpoint,
  ): string {
    const detail = attempts.length > 0
      ? '\n已尝试的端点：\n'
        + attempts.map((a) => `  - ${a.endpoint}（来源：${a.source}）：${a.error}`).join('\n')
      : '';
    // 显式指定的端点是唯一候选（见 candidateEndpoints 的说明），但如果我们自己
    // 恰好发现了能用的端点，就该直接告诉用户，而不是让他继续瞎猜。
    const found = alternative
      ? `\n\n另外发现这个端点可用：${describeEndpoint(alternative.endpoint)}（${alternative.endpoint.source}）\n`
        + `去掉 --controller 直接跑一次即可（afc 会自己选到它，并读好对应的凭据）；\n`
        + `确实要显式指定的话：--controller ${endpointArg(alternative.endpoint)}`
      : '';
    switch (reason) {
      case 'no-candidates':
        return '没有找到任何 mihomo 控制端点候选。\n'
          + '请确认 Clash Party / Clash Verge 正在运行（内核进程未运行时不提供服务），\n'
          + '或用 --controller <unix:/path | pipe:\\.\\pipe\\name | host:port> 显式指定端点。'
          + (hint ? `\n\n${hint}` : '');
      case 'unauthorized':
        return '找到了控制端点，但认证失败。\n'
          + '请在 afc.config.yaml 中配置 controller.secret，或用 --secret 指定密钥。'
          + detail + (hint ? `\n\n${hint}` : '') + found;
      case 'unreachable':
        return '找到了控制端点候选，但都无法访问。\n'
          + '可能是内核正在重启、套接字路径已变化，或端点并非 mihomo 控制端口。'
          + detail + (hint ? `\n\n${hint}` : '') + found;
    }
  }
}

export interface DiscoverOptions {
  /** 显式端点：`unix:/path/to.sock`、`pipe:\\.\pipe\name`、`http://127.0.0.1:9090` 或 `127.0.0.1:9090`。 */
  explicit?: string;
  secret?: string;
  timeoutMs?: number;
  /** 发现阶段的总预算：候选很多时不至于让命令卡很久。 */
  budgetMs?: number;
  /** 显式指定运行时配置路径（用于读取 external-controller 与 secret）。 */
  runtimeConfigPath?: string;
  /** 用户在 afc 配置里声明的控制端口（客户端改过「外部控制地址」的端口时用）。 */
  configuredPorts?: readonly number[];
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
  // Windows 命名管道：pipe:\\.\pipe\verge-mihomo（也接受省略前缀的 \\.\pipe\...）
  if (value.startsWith('pipe:') || value.startsWith('\\\\.\\pipe\\')) {
    const path = value.startsWith('pipe:') ? value.slice('pipe:'.length) : value;
    if (!path) throw new Error(`无效的端点：${value}`);
    return { kind: 'pipe', path: normalizeWindowsPipePath(path), source, ...(secret ? { secret } : {}) };
  }
  // 报错信息里打印的是 `tcp:host:port`，所以这里也接受这个前缀（让报错内容可直接复制粘贴）
  const stripped = value.replace(/^https?:\/\//, '').replace(/^tcp:/, '');
  const [host, portText] = stripped.split(':');
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(`无效的端点：${value}（期望 unix:/path、pipe:\\\\.\\pipe\\name 或 host:port）`);
  }
  return { kind: 'tcp', host, port, source, ...(secret ? { secret } : {}) };
}

const SOCKET_NAME_PATTERN = /(mihomo|clash|verge|party)/i;

function discoverSocketFiles(ctx: PlatformContext): string[] {
  const found: string[] = [];
  for (const dir of socketDirs(ctx)) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.endsWith('.sock') && SOCKET_NAME_PATTERN.test(entry.name)) {
        found.push(join(dir, entry.name));
        continue;
      }
      // 有些客户端把套接字放在子目录里（如 /tmp/<客户端>/xxx.sock），
      // 因此在名字像目标客户端的子目录里再找一层。
      if (entry.isDirectory() && SOCKET_NAME_PATTERN.test(entry.name)) {
        const subdir = join(dir, entry.name);
        try {
          for (const inner of readdirSync(subdir, { withFileTypes: true })) {
            if (inner.isFile() && inner.name.endsWith('.sock')) found.push(join(subdir, inner.name));
          }
        } catch {
          // 读不到就跳过
        }
      }
    }
  }
  return found;
}

const keyOf = (e: ControllerEndpoint): string =>
  e.kind === 'tcp' ? `tcp:${e.host}:${e.port}` : `${e.kind}:${e.path}`;

function makePush(candidates: ControllerEndpoint[]): (e: ControllerEndpoint | undefined) => void {
  return (e) => {
    if (!e) return;
    if (candidates.some((c) => keyOf(c) === keyOf(e))) return;
    candidates.push(e);
  };
}

/**
 * 读一份运行时配置，把里面的控制端点变成候选，并把「看到了什么」记进 facts。
 *
 * 客户端写的 external-controller-pipe（Clash Verge 的命名管道）与 secret 都在这里拿到，
 * 这是最权威也最便宜的一条线索：不用启任何子进程。
 */
function collectConfigCandidates(
  configPath: string,
  options: DiscoverOptions,
  facts: DiscoveryFacts,
  push: (e: ControllerEndpoint | undefined) => void,
): void {
  try {
    const summary = readRuntimeConfig(configPath);
    const secret = options.secret ?? summary.secret;
    facts.runtimeConfigs.push({
      path: configPath,
      ...(summary.externalController ? { controller: summary.externalController } : {}),
      ...(summary.externalControllerPipe ? { pipe: summary.externalControllerPipe } : {}),
      ...(summary.externalControllerUnix ? { unix: summary.externalControllerUnix } : {}),
      hasSecret: Boolean(summary.secret),
    });
    // 记下配置里的 secret：Clash Verge 的 secret 是随机生成的，用户没法自己填，
    // 因此把它当其它候选的兜底凭据（凭据不对时服务端一样是 401，不会有副作用）。
    if (!facts.configSecret && summary.secret) facts.configSecret = summary.secret;

    if (summary.externalControllerUnix) {
      push({ kind: 'unix', path: summary.externalControllerUnix, source: `运行时配置 ${configPath}`, ...(secret ? { secret } : {}) });
    }
    if (summary.externalControllerPipe) {
      push({ kind: 'pipe', path: summary.externalControllerPipe, source: `运行时配置 ${configPath}`, ...(secret ? { secret } : {}) });
    }
    if (summary.externalController) {
      push(tcpFromPair(summary.externalController, `运行时配置 ${configPath}`, secret));
    }
  } catch {
    // 配置读取失败不影响其它候选
  }
}

/**
 * 只做「便宜的那部分」发现：读已知数据目录里的运行时配置，外加配置里声明的端口。
 *
 * 存在的意义是延迟：Windows 上枚举进程/端口/管道要启子进程（实测 CI 上十几秒），
 * 而绝大多数用户的控制端点就写在自己的运行时配置里 —— 先试这一层，
 * 命中就不必再掀整个系统。
 */
export function cheapPlan(
  options: DiscoverOptions = {},
  ctx: PlatformContext = currentPlatform(),
): DiscoveryPlan {
  const facts = emptyFacts();
  const candidates: ControllerEndpoint[] = [];
  const push = makePush(candidates);
  facts.windows = isWindows(ctx);
  const configPaths = staticRuntimeConfigPaths(options.runtimeConfigPath, ctx);
  facts.checkedConfigPaths = configPaths;
  for (const configPath of configPaths) {
    collectConfigCandidates(configPath, options, facts, push);
  }
  for (const port of configuredPorts(options)) {
    push({
      kind: 'tcp',
      host: '127.0.0.1',
      port,
      source: '配置里的控制端口',
      ...(options.secret ? { secret: options.secret } : {}),
    });
  }
  return { candidates, facts };
}

/** 配置里声明的控制端口（去重、去非法值）。 */
function configuredPorts(options: DiscoverOptions): number[] {
  const ports: number[] = [];
  for (const port of options.configuredPorts ?? []) {
    if (Number.isInteger(port) && port > 0 && port <= 65535 && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

/** 发现过程中看到的事实，用于诊断输出与报错提示。 */
export interface DiscoveryFacts {
  runtimeConfigs: {
    path: string;
    controller?: string;
    pipe?: string;
    unix?: string;
    hasSecret: boolean;
  }[];
  kernelProcesses: KernelProcess[];
  kernelPorts: number[];
  /** 系统里实际存在的、像 mihomo 的命名管道。 */
  pipes: string[];
  /** 枚举到的管道总数与枚举方式（用于区分「枚举失败」与「确实没有」）。 */
  pipesEnumerated: number;
  pipesMethod: 'fs' | 'powershell' | 'none';
  /** 按当前用户 SID 推导出的 Verge 管道。 */
  vergePipes: string[];
  /** 当前用户的 SID（推导管道用的；拿不到说明 whoami/PowerShell 都失败了）。 */
  sid?: string;
  /** 检查过（不保证存在）的运行时配置路径。 */
  checkedConfigPaths: string[];
  /** 本次发现是否按 Windows 走（决定报告里要不要讲管道枚举）。 */
  windows: boolean;
  defaults: readonly number[];
  /** 从运行时配置里读到的 secret（用于给其它候选兜底，以及认证失败后的重试）。 */
  configSecret?: string;
}

export interface DiscoveryPlan {
  candidates: ControllerEndpoint[];
  facts: DiscoveryFacts;
}

/**
 * 按可靠性排序枚举候选端点：
 *   1. 显式指定
 *   2. 运行时配置中的 external-controller / external-controller-pipe（最权威：内核实际在用的配置）
 *   3. 运行中内核进程的命令行参数
 *   4. 内核进程监听的 TCP 端口（端口被改过、或读不到命令行时依然有效）
 *   5. 按当前用户 SID 推导出的 Clash Verge 命名管道
 *   6. 系统里真实存在、名字像 mihomo 的命名管道
 *   7. 常见目录下名字像 mihomo/clash 的套接字（POSIX）
 *   8. 常见命名管道名（Windows）
 *   9. 默认 TCP 端口
 */
export function planDiscovery(
  options: DiscoverOptions = {},
  ctx: PlatformContext = currentPlatform(),
): DiscoveryPlan {
  // 显式指定的端点就是唯一候选：用户既然点名了端点，失败时应该明确报错，
  // 而不是悄悄回退到别的端点（否则排查时会被误导）。
  // 不过失败信息里会把「我们自己发现的可用端点」一并给出，避免用户瞎猜。
  if (options.explicit) {
    return {
      candidates: [parseEndpointString(options.explicit, options.secret)],
      facts: emptyFacts(),
    };
  }

  const facts = emptyFacts();
  const candidates: ControllerEndpoint[] = [];
  const push = makePush(candidates);
  facts.windows = isWindows(ctx);

  const processes = listKernelProcesses(ctx);
  facts.kernelProcesses = processes;
  facts.checkedConfigPaths = staticRuntimeConfigPaths(options.runtimeConfigPath, ctx);

  for (const configPath of runtimeConfigPathCandidates(options.runtimeConfigPath, ctx)) {
    collectConfigCandidates(configPath, options, facts, push);
  }

  // 用户自己声明的控制端口比「猜默认值」可信，排在猜测之前
  const fallbackSecret = options.secret ?? facts.configSecret;
  for (const port of configuredPorts(options)) {
    push({ kind: 'tcp', host: '127.0.0.1', port, source: '配置里的控制端口', ...(fallbackSecret ? { secret: fallbackSecret } : {}) });
  }

  for (const proc of processes) {
    if (proc.unixSocket) {
      push({ kind: 'unix', path: proc.unixSocket, source: `内核进程 ${proc.pid} 的 -ext-ctl-unix`, ...(fallbackSecret ? { secret: fallbackSecret } : {}) });
    }
    if (proc.pipePath) {
      push({
        kind: 'pipe',
        path: normalizeWindowsPipePath(proc.pipePath),
        source: `内核进程 ${proc.pid} 的 -ext-ctl-pipe`,
        ...(fallbackSecret ? { secret: fallbackSecret } : {}),
      });
    }
    if (proc.tcpController) {
      push(tcpFromPair(proc.tcpController, `内核进程 ${proc.pid} 的 -ext-ctl`, fallbackSecret));
    }
  }

  if (isWindows(ctx)) {
    // 内核监听在哪些端口是查得到的事实，比猜默认端口可靠（Verge 的端口可以自定义/随机）。
    const pids = [...new Set([...processes.map((p) => p.pid), ...kernelPidFilePids(ctx)])];
    facts.kernelPorts = windowsListenerPorts(pids);
    for (const port of facts.kernelPorts) {
      push({ kind: 'tcp', host: '127.0.0.1', port, source: `内核进程监听端口 ${port}`, ...(fallbackSecret ? { secret: fallbackSecret } : {}) });
    }

    // Clash Verge Rev 新版的管道名 = \\.\pipe\verge-mihomo-sidecar-<flavor>-<sha256(用户 SID)>，
    // 无法猜别人的，但可以算自己的。
    const sid = windowsUserSid();
    if (sid) facts.sid = sid;
    if (sid) {
      facts.vergePipes = vergeSidecarPipeNames(sid);
      for (const path of facts.vergePipes) {
        push({ kind: 'pipe', path, source: 'Clash Verge 命名管道（按当前用户 SID 推导）', ...(fallbackSecret ? { secret: fallbackSecret } : {}) });
      }
    }

    // 真实存在的管道名单（Clash Party 的 \\.\pipe\MihomoParty\mihomo 就在里面）
    const pipeScan = scanWindowsPipes(ctx);
    facts.pipes = pipeScan.matched;
    facts.pipesEnumerated = pipeScan.enumerated;
    facts.pipesMethod = pipeScan.method;
    for (const path of facts.pipes) {
      push({ kind: 'pipe', path, source: '命名管道枚举', ...(fallbackSecret ? { secret: fallbackSecret } : {}) });
    }
  }

  for (const path of discoverSocketFiles(ctx)) {
    push({ kind: 'unix', path, source: '套接字目录扫描', ...(fallbackSecret ? { secret: fallbackSecret } : {}) });
  }

  for (const path of pipeCandidates(ctx)) {
    push({ kind: 'pipe', path, source: '常见命名管道', ...(fallbackSecret ? { secret: fallbackSecret } : {}) });
  }

  facts.defaults = DEFAULT_CONTROLLER_PORTS;
  for (const port of DEFAULT_CONTROLLER_PORTS) {
    push({ kind: 'tcp', host: '127.0.0.1', port, source: `默认 TCP 端口 ${port}`, ...(fallbackSecret ? { secret: fallbackSecret } : {}) });
  }

  for (const extra of options.extraCandidates ?? []) push(extra);

  return { candidates, facts };
}

/** 只要候选列表（测试与调试用）。 */
export function candidateEndpoints(
  options: DiscoverOptions = {},
  ctx: PlatformContext = currentPlatform(),
): ControllerEndpoint[] {
  return planDiscovery(options, ctx).candidates;
}

function emptyFacts(): DiscoveryFacts {
  return {
    runtimeConfigs: [],
    kernelProcesses: [],
    kernelPorts: [],
    pipes: [],
    pipesEnumerated: 0,
    pipesMethod: 'none',
    vergePipes: [],
    checkedConfigPaths: [],
    windows: false,
    defaults: DEFAULT_CONTROLLER_PORTS,
  };
}

/** `host:port`（或 `http://host:port`）→ tcp 候选；非法值返回 undefined。 */
function tcpFromPair(value: string, source: string, secret?: string): ControllerEndpoint | undefined {
  const hostPort = value.replace(/^https?:\/\//, '');
  const [host, portText] = hostPort.split(':');
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port <= 0) return undefined;
  const normalized = host === '0.0.0.0' || host === '' ? '127.0.0.1' : host;
  return { kind: 'tcp', host: normalized, port, source, ...(secret ? { secret } : {}) };
}

interface AttemptResult {
  found?: DiscoveredController;
  attempts: EndpointAttempt[];
  sawUnauthorized: boolean;
  budgetExhausted: boolean;
}

/**
 * 把一次探测失败翻译成人能看懂的说明。
 *
 * 最值得一提的是「代理端口」：客户端界面上的混合/HTTP 端口长得就像个控制端口，
 * 用户很容易把它填给 afc。Go 的代理端口对非代理请求（例如 GET /version）会回
 * 400 Bad Request 且响应体为空 —— 这是它的签名，可以据此给出明确指引。
 */
function classifyFailure(endpoint: ControllerEndpoint, err: unknown): { message: string; proxyPortLike?: boolean } {
  if (err instanceof NotMihomoError) return { message: '不是 mihomo 控制端点' };
  if (endpoint.kind === 'tcp' && err instanceof HttpError && err.status === 400) {
    return {
      message: 'GET /version 返回 HTTP 400 且响应体为空 —— 这个端口像是「代理端口」，不是控制端口'
        + '（混合/HTTP 代理口的非代理请求正是这么回的）',
      proxyPortLike: true,
    };
  }
  return { message: (err as Error).message };
}

/** 依次尝试候选端点，返回第一个确认是 mihomo 的端点。 */
async function attemptEndpoints(
  candidates: readonly ControllerEndpoint[],
  timeoutMs: number,
  budgetMs: number,
): Promise<AttemptResult> {
  const attempts: EndpointAttempt[] = [];
  const deadline = Date.now() + budgetMs;
  let sawUnauthorized = false;
  let budgetExhausted = false;

  for (const endpoint of candidates) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      budgetExhausted = true;
      break;
    }
    const client = new MihomoClient(endpoint, timeoutMs);
    try {
      const info = await client.version(Math.min(timeoutMs, remaining));
      return { found: { endpoint, version: info.version, client }, attempts, sawUnauthorized, budgetExhausted: false };
    } catch (err) {
      if (err instanceof UnauthorizedError) sawUnauthorized = true;
      const failure = classifyFailure(endpoint, err);
      attempts.push({
        endpoint: describeEndpoint(endpoint),
        source: endpoint.source,
        error: failure.message,
        ...(failure.proxyPortLike ? { proxyPortLike: true } : {}),
      });
      if (err instanceof HttpError && err.status === 401) sawUnauthorized = true;
    }
  }

  return { attempts, sawUnauthorized, budgetExhausted };
}

/**
 * 发现并验证 mihomo 控制端点。
 *
 * 分两层：先试「读已知数据目录里的运行时配置」这一层（不启子进程，很快），
 * 没命中才去枚举进程/端口/管道（Windows 上这层要启子进程，实测可能十几秒）。
 * 两层都失败时才会给出诊断与「另外发现的可用端点」。
 */
export async function discoverController(
  options: DiscoverOptions = {},
  ctx: PlatformContext = currentPlatform(),
): Promise<DiscoveredController> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const budgetMs = options.budgetMs ?? 15000;

  // 显式指定的端点就是唯一候选，直接用，不做任何自动发现（失败时的提示另算）
  if (options.explicit) {
    const explicitEndpoint = parseEndpointString(options.explicit, options.secret);
    const result = await attemptEndpoints([explicitEndpoint], timeoutMs, budgetMs);
    if (result.found) return result.found;
    // 这一层失败才跑自动发现：只为了告诉用户「其实还有能用的端点」以及给出排查提示
    const auto = planDiscovery({ ...options, explicit: undefined }, ctx);
    if (result.sawUnauthorized && !options.secret && auto.facts.configSecret) {
      const retried = await tryEndpoint(parseEndpointString(options.explicit, auto.facts.configSecret), timeoutMs);
      if (retried) return retried;
    }
    const shortlist = auto.candidates.slice(0, 6);
    const alternative = shortlist.length > 0 ? await firstWorking(shortlist, timeoutMs) : undefined;
    throw new ControllerDiscoveryError(
      result.sawUnauthorized ? 'unauthorized' : 'unreachable',
      result.attempts,
      hintText(auto.facts, ctx, result.attempts),
      alternative,
    );
  }

  const startedAt = Date.now();
  const cheap = cheapPlan(options, ctx);
  const first = await attemptEndpoints(cheap.candidates, timeoutMs, Math.min(budgetMs, 5000));
  if (first.found) return first.found;

  const plan = planDiscovery(options, ctx);
  const tried = new Set(cheap.candidates.map(keyOf));
  const rest = plan.candidates.filter((c) => !tried.has(keyOf(c)));
  const second = await attemptEndpoints(rest, timeoutMs, Math.max(1000, budgetMs - (Date.now() - startedAt)));

  const attempts = [...first.attempts, ...second.attempts];
  if (plan.candidates.length === 0) {
    throw new ControllerDiscoveryError('no-candidates', attempts, hintText(plan.facts, ctx));
  }

  const exhausted = first.budgetExhausted || second.budgetExhausted
    ? `（已用满 ${budgetMs}ms 预算，还有候选没试；可以用 --controller 直接指定，或先看一眼 --verbose 的报告）`
    : undefined;
  throw new ControllerDiscoveryError(
    first.sawUnauthorized || second.sawUnauthorized ? 'unauthorized' : 'unreachable',
    attempts,
    [exhausted, hintText(plan.facts, ctx, attempts)].filter((v): v is string => Boolean(v)).join('\n'),
  );
}

/** 在一小组候选里找出第一个能用的（只用于失败路径上的提示）。 */
async function firstWorking(
  candidates: readonly ControllerEndpoint[],
  timeoutMs: number,
): Promise<AlternativeEndpoint | undefined> {
  const result = await attemptEndpoints(candidates, Math.min(timeoutMs, 1500), 5000);
  return result.found
    ? { endpoint: result.found.endpoint, version: result.found.version }
    : undefined;
}

/** 单独验证一个端点是不是 mihomo 控制端点。 */
async function tryEndpoint(endpoint: ControllerEndpoint, timeoutMs: number): Promise<DiscoveredController | undefined> {
  const client = new MihomoClient(endpoint, timeoutMs);
  try {
    const info = await client.version(timeoutMs);
    return { endpoint, version: info.version, client: new MihomoClient(endpoint) };
  } catch {
    return undefined;
  }
}

/** 平台相关的排查提示。 */
function hintText(facts: DiscoveryFacts, ctx: PlatformContext, attempts: readonly EndpointAttempt[] = []): string {
  const lines: string[] = [];

  // 「代理端口 ≠ 控制端口」是最高频的误解，而且症状很迷惑（报了端口不可访问），
  // 所以一旦看到代理端口的签名就把两者的区别讲清楚。
  const proxyPorts = attempts.filter((a) => a.proxyPortLike).map((a) => a.endpoint);
  if (proxyPorts.length > 0) {
    lines.push(
      `${proxyPorts.join('、')} 应答的是「代理端口」，不是「控制端口」——这两个是不同用途的端口：`,
      '  · 代理端口（混合/HTTP/SOCKS 端口）给浏览器与系统代理用，改成什么都与 afc 无关；',
    );
  }

  if (isWindows(ctx)) {
    lines.push(
      'Windows 上要找的是「外部控制地址」，它在客户端设置里单独一项：',
      '  · Clash Verge Rev：设置 → Clash 设置 → 外部控制（默认 127.0.0.1:9097，也可以只靠命名管道）；',
      '    同一页的「端口设置」（混合代理端口等）是代理端口，不是这个。',
      '  · Clash Party：内核设置 → 外部控制地址 + 外部控制访问密钥；Windows 上默认走命名管道',
      '    \\\\.\\pipe\\MihomoParty\\mihomo，改过端口的话记得重启内核。',
    );
    if (facts.runtimeConfigs.length === 0) {
      lines.push('这次没有读到任何运行时配置：确认客户端的数据目录（%APPDATA%\\<客户端 id>\\config.yaml）存在。');
    } else if (facts.pipes.length === 0 && facts.kernelProcesses.length === 0) {
      lines.push('这次既没枚举到像 mihomo 的命名管道，也没找到内核进程：内核可能没在运行。');
    }
  } else if (detectWsl()) {
    // 在 WSL 里跑 afc、Clash 装在 Windows 宿主机上：这是"看着像 Clash 没在跑"的典型假象
    lines.push(
      'afc 现在跑在 WSL 里，而 Clash 客户端通常装在 Windows 宿主机上 —— 两者不在同一个网络命名空间：',
      '  · WSL2 的 127.0.0.1 是它自己的回环，连不到宿主机的控制端口（宿主机的 127.0.0.1:9097 也不对外监听），',
      '    命名管道更是完全用不了；',
      '  · afc 探测节点还要用 mihomo 内核二进制，那个同样在 Windows 上。',
      '请在 Windows 的 PowerShell / cmd 里跑 afc：npm i -g auto-fix-clash，再 afc groups。',
      '确实要在 WSL 里用的话：Verge 打开「局域网连接」、把「外部控制器监听地址」改成 0.0.0.0:9097、放行防火墙，',
      '然后 controller.endpoint 指向宿主机 IP（取 /etc/resolv.conf 里的 nameserver），',
      '并用 probe.kernelPath 指一个 WSL 里可执行的 Linux 版 mihomo。',
    );
  } else {
    lines.push(
      '要找的是「外部控制地址」（不是混合/HTTP/SOCKS 代理端口）：',
      '  · Clash Verge Rev 默认 127.0.0.1:9097，Clash Party 用 Unix 套接字 /tmp/mihomo-party-<uid>-<pid>.sock。',
    );
  }

  lines.push(
    '改过控制端口的话，把它写进配置（定时任务也读这里）：',
    '  controller:',
    '    endpoint: 127.0.0.1:9097      # 或 unix:/path.sock、pipe:\\\\.\\pipe\\MihomoParty\\mihomo',
    '    secret: <外部控制访问密钥>     # 省略则从客户端运行时配置里读',
    '    ports: [9191]                 # 自动发现时额外要试的端口',
    '用 afc groups --verbose 可以看到「afc 到底找了哪些地方、每个候选源自哪里」。',
  );
  return lines.join('\n');
}

export interface DiscoveryReport {
  /** 用户用 --controller 指定的端点（此时 facts 给出的是「自动发现会找到什么」）。 */
  explicit?: string;
  facts: DiscoveryFacts;
  candidates: ControllerEndpoint[];
}

/** 供 `--verbose` 使用的诊断报告：afc 到底找了哪些地方。 */
export function describeDiscovery(
  options: DiscoverOptions = {},
  ctx: PlatformContext = currentPlatform(),
): DiscoveryReport {
  // 显式指定端点时 discovery 只会用那一个候选，但诊断的意义恰恰是
  // 「如果不用 --controller，afc 本来能找到什么」，所以这里照样跑一遍自动发现。
  if (options.explicit) {
    const auto = planDiscovery({ ...options, explicit: undefined }, ctx);
    return { explicit: options.explicit, facts: auto.facts, candidates: auto.candidates };
  }
  const plan = planDiscovery(options, ctx);
  return { facts: plan.facts, candidates: plan.candidates };
}

export function renderDiscoveryReport(report: DiscoveryReport): string {
  const { facts, candidates } = report;
  const lines: string[] = ['端点发现过程：'];
  if (report.explicit) {
    lines.push(`  手动指定了端点：${report.explicit}（自动发现被跳过，下面是自动发现的结果）`);
  }

  if (facts.runtimeConfigs.length === 0) {
    lines.push('  运行时配置：没有找到可读的（下面列出「检查过但不存在」的路径）');
    if (facts.checkedConfigPaths.length > 0) {
      lines.push(`  检查过的配置路径（${facts.checkedConfigPaths.length} 个，都不存在）：`);
      for (const path of facts.checkedConfigPaths) lines.push(`    - ${path}`);
    }
  } else {
    for (const config of facts.runtimeConfigs) {
      const parts = [
        config.controller ? `external-controller: ${config.controller}` : undefined,
        config.pipe ? `external-controller-pipe: ${config.pipe}` : undefined,
        config.unix ? `external-controller-unix: ${config.unix}` : undefined,
        config.hasSecret ? '含 secret' : '无 secret',
      ].filter((v): v is string => Boolean(v));
      lines.push(`  运行时配置：${config.path}（${parts.join('，')}）`);
    }
  }

  if (facts.kernelProcesses.length === 0) {
    lines.push('  内核进程：没有发现（内核未运行，或读不到进程列表）');
  } else {
    for (const proc of facts.kernelProcesses) {
      const args = [
        proc.workDir ? `-d ${proc.workDir}` : undefined,
        proc.configFile ? `-f ${proc.configFile}` : undefined,
        proc.tcpController ? `-ext-ctl ${proc.tcpController}` : undefined,
        proc.pipePath ? `-ext-ctl-pipe ${proc.pipePath}` : undefined,
        proc.unixSocket ? `-ext-ctl-unix ${proc.unixSocket}` : undefined,
      ].filter((v): v is string => Boolean(v));
      // 镜像名只有在 Windows 上才拿得到（POSIX 只有命令行，太长没必要重复打印）
      const shown = proc.name && proc.name !== '' ? proc.name : 'mihomo 内核';
      lines.push(`  内核进程：${shown}（pid ${proc.pid}${args.length > 0 ? `，${args.join(' ')}` : ''}）`);
    }
  }

  if (facts.kernelPorts.length > 0) lines.push(`  内核监听端口：${facts.kernelPorts.join('、')}`);
  if (facts.sid) lines.push(`  当前用户 SID：${facts.sid}`);
  if (facts.vergePipes.length > 0) lines.push(`  按 SID 推导的 Verge 管道：${facts.vergePipes[0]}`);
  if (facts.pipes.length > 0) {
    lines.push(`  枚举到的命名管道：${facts.pipes.join('、')}`);
  } else if (facts.windows) {
    // 区分「枚举不到」与「枚举了但没有像 mihomo 的」——两者的排查方向完全不同
    lines.push(facts.pipesMethod === 'none'
      ? '  命名管道枚举：失败（Node 与 PowerShell 两种方式都没读出来）'
      : `  命名管道枚举：共 ${facts.pipesEnumerated} 个，其中没有像 mihomo 的（内核可能没在运行）`);
  }

  lines.push(`  候选端点（${candidates.length} 个，按尝试顺序）：`);
  for (const c of candidates) lines.push(`    - ${describeEndpoint(c)}（${c.source}）`);
  return lines.join('\n') + '\n';
}
