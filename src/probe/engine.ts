import type { AfcConfig, ProbeEndpoint, TargetConfig } from '../config.ts';
import { ProbeInstance, type ProbeInstanceOptions } from './instance.ts';
import { requestThroughProxy, ProxyRequestError, type ProxyRequestOptions, type ProxyRequestResult } from './proxy-request.ts';
import {
  decideVerdict,
  parseTrace,
  shortEndpoint,
  type EndpointObservation,
  type GeoObservation,
  type NodeObservation,
  type Verdict,
} from './verdict.ts';

export interface NodeProbeResult {
  node: string;
  verdict: Verdict;
  reason: string;
  statusCode?: number;
  country?: string;
  ip?: string;
  warp?: string;
  ttfbMs?: number;
  attempts: number;
}

export interface ProbeEngineOptions {
  config: AfcConfig;
  /** 节点定义来源（通常是运行时配置的 proxies 段）。 */
  proxies: unknown[];
  /** 可切换的节点名（真实节点）。 */
  nodeNames: string[];
  /** 注入探针实例工厂，便于测试替换。 */
  instanceFactory?: (options: ProbeInstanceOptions) => Promise<ProbeInstance>;
  /** 注入 HTTP 传输层（测试用），默认经 CONNECT 隧道请求。 */
  transport?: (options: ProxyRequestOptions) => Promise<ProxyRequestResult>;
}

const DEFAULT_INSTANCE_FACTORY = (options: ProbeInstanceOptions): Promise<ProbeInstance> =>
  ProbeInstance.start(options);

interface HitResult {
  observation: EndpointObservation;
  body?: string;
}

/**
 * 探测引擎：在隔离实例上按通道切换出口，发起真实请求并给出判定。
 *
 * 并发被限制在配置的通道数内（默认 2）——实测更高并发会触发机场限流，
 * 导致大量「假死」判定。
 */
export class ProbeEngine {
  private readonly config: AfcConfig;
  private readonly instance: ProbeInstance;
  private readonly transport: (options: ProxyRequestOptions) => Promise<ProxyRequestResult>;

  private constructor(
    config: AfcConfig,
    instance: ProbeInstance,
    transport: (options: ProxyRequestOptions) => Promise<ProxyRequestResult>,
  ) {
    this.config = config;
    this.instance = instance;
    this.transport = transport;
  }

  static async create(options: ProbeEngineOptions): Promise<ProbeEngine> {
    const factory = options.instanceFactory ?? DEFAULT_INSTANCE_FACTORY;
    const instance = await factory({
      proxies: options.proxies,
      nodeNames: options.nodeNames,
      channels: options.config.probe.concurrency,
      ...(options.config.probe.kernelPath ? { kernelPath: options.config.probe.kernelPath } : {}),
    });
    return new ProbeEngine(options.config, instance, options.transport ?? requestThroughProxy);
  }

  get channels(): number {
    return this.instance.channelsCount;
  }

  private async hit(
    channel: number,
    endpoint: ProbeEndpoint,
    timeoutMs: number,
    captureBody = false,
  ): Promise<HitResult> {
    try {
      const res = await this.transport({
        proxy: { host: '127.0.0.1', port: this.instance.channelPort(channel) },
        url: endpoint.url,
        method: endpoint.method ?? 'GET',
        timeoutMs,
      });
      return {
        observation: {
          endpoint: endpoint.url,
          statusCode: res.status,
          ttfbMs: res.ttfbMs,
          elapsedMs: res.elapsedMs,
        },
        ...(captureBody ? { body: res.body } : {}),
      };
    } catch (err) {
      return {
        observation: {
          endpoint: endpoint.url,
          error: err instanceof ProxyRequestError ? err.message : (err as Error).message,
        },
      };
    }
  }

  /**
   * 探测单个节点。
   *
   * 只有在「完全没有 HTTP 响应」时才会重试：拿到 4xx 是明确结论，重试没有意义，
   * 而且能避免对同一个出口重复打请求（机场对同账号并发/频率敏感）。
   */
  async probeOne(
    node: string,
    target: TargetConfig,
    channel = 0,
    overrides: { timeoutMs?: number; retries?: number } = {},
  ): Promise<NodeProbeResult> {
    const timeoutMs = overrides.timeoutMs ?? this.config.probe.timeoutMs;
    const maxAttempts = (overrides.retries ?? this.config.probe.retries) + 1;
    let observation: NodeObservation = { node, attempts: 0, endpoints: [] };

    await this.instance.select(channel, node);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const endpoints: EndpointObservation[] = [];
      for (const [index, endpoint] of [target.probe, ...target.extraProbes].entries()) {
        const { observation: endpointObservation } = await this.hit(channel, endpoint, timeoutMs);
        endpoints.push(endpointObservation);
        // fail-fast：主端点连 HTTP 响应都拿不到，说明这个出口不通，
        // 再打附加端点只会白等一次超时（死节点场景下可省一半时间）。
        if (index === 0 && endpointObservation.statusCode === undefined) break;
      }

      let geo: GeoObservation | undefined;
      // 只有拿到过 HTTP 响应才值得再取出口信息；死节点直接跳过以省一次请求。
      if (endpoints.some((e) => e.statusCode !== undefined) && target.geoProbe) {
        const geoHit = await this.hit(
          channel,
          { url: target.geoProbe.url, expectedStatus: [200] },
          timeoutMs,
          true,
        );
        if (geoHit.observation.statusCode !== undefined && geoHit.body) {
          const parsed = parseTrace(geoHit.body);
          if (Object.keys(parsed).length > 0) geo = parsed;
        }
      }

      observation = { node, attempts: attempt, endpoints, ...(geo ? { geo } : {}) };
      const decision = decideVerdict(target, observation);
      if (decision.verdict !== 'dead') {
        return { node, attempts: attempt, ...toResult(decision, observation) };
      }
    }

    const decision = decideVerdict(target, observation);
    return { node, attempts: observation.attempts, ...toResult(decision, observation) };
  }

  /** 探测多个节点，按配置的并发上限调度；返回顺序与输入一致。 */
  async probeAll(
    nodes: string[],
    target: TargetConfig,
    onResult?: (result: NodeProbeResult, index: number) => void,
  ): Promise<NodeProbeResult[]> {
    const results: NodeProbeResult[] = new Array(nodes.length);
    let next = 0;
    const workerCount = Math.min(this.channels, Math.max(1, nodes.length));

    const worker = async (channel: number): Promise<void> => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= nodes.length) return;
        const node = nodes[index]!;
        const result = await this.probeOne(node, target, channel);
        results[index] = result;
        onResult?.(result, index);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));
    return results;
  }

  async close(): Promise<void> {
    await this.instance.stop();
  }

  /**
   * 按顺序分批筛查候选，找到第一个真正可用的节点就停下。
   *
   * 为什么要这样：粘性修复只需要「一个」可用节点，没必要遍历整份订阅；
   * 而拿到 4xx 是快结论、没有响应才是慢的（要等超时）。因此筛查阶段用较短超时、
   * 不做重试，只对最终选中的节点做一次完整判定（含重试），既快又不会误判。
   */
  async findFirstUsable(
    nodes: string[],
    target: TargetConfig,
    screenTimeoutMs = 5000,
  ): Promise<{ result?: NodeProbeResult; screened: number; lastScreened?: NodeProbeResult }> {
    const batchSize = Math.max(1, this.channels);
    let screened = 0;
    let lastScreened: NodeProbeResult | undefined;

    for (let start = 0; start < nodes.length; start += batchSize) {
      const batch = nodes.slice(start, start + batchSize);
      const screenedBatch: NodeProbeResult[] = await Promise.all(
        batch.map(async (node, index) => {
          const channel = index % this.channels;
          const screenedResult = await this.probeOne(node, target, channel, { timeoutMs: screenTimeoutMs, retries: 0 });
          screened += 1;
          lastScreened = screenedResult;
          return screenedResult;
        }),
      );

      const usable = screenedBatch.filter((r) => r.verdict === 'ok');
      if (usable.length === 0) continue;

      // 用完整设置复核一次，避免把筛查阶段的宽松判定当成结论。
      const best = usable.sort((a, b) => (a.ttfbMs ?? Infinity) - (b.ttfbMs ?? Infinity))[0]!;
      const confirmed = await this.probeOne(best.node, target, 0);
      if (confirmed.verdict === 'ok') return { result: confirmed, screened };
      lastScreened = confirmed;
    }

    return { screened, ...(lastScreened ? { lastScreened } : {}) };
  }
}

function toResult(
  decision: ReturnType<typeof decideVerdict>,
  observation: NodeObservation,
): Omit<NodeProbeResult, 'node' | 'attempts'> {
  const matched = decision.matchedEndpoint
    ? observation.endpoints.find((e) => e.endpoint === decision.matchedEndpoint)
    : undefined;
  const timing = matched ?? observation.endpoints.find((e) => e.statusCode !== undefined);
  return {
    verdict: decision.verdict,
    reason: decision.reason,
    ...(decision.statusCode !== undefined ? { statusCode: decision.statusCode } : {}),
    ...(decision.country ? { country: decision.country } : {}),
    ...(observation.geo?.ip ? { ip: observation.geo.ip } : {}),
    ...(observation.geo?.warp ? { warp: observation.geo.warp } : {}),
    ...(timing?.ttfbMs !== undefined ? { ttfbMs: timing.ttfbMs } : {}),
  };
}

/** 供报告使用：把端点列表压缩成简短描述。 */
export function describeEndpoints(target: TargetConfig): string {
  return [target.probe, ...target.extraProbes].map((e) => shortEndpoint(e.url)).join(' + ');
}
