import type { ProbeEndpoint, TargetConfig } from '../config.ts';

/** 单个探测端点的观测结果。statusCode 未定义表示没有任何 HTTP 响应。 */
export interface EndpointObservation {
  endpoint: string;
  statusCode?: number;
  ttfbMs?: number;
  elapsedMs?: number;
  error?: string;
}

/** 对某节点的一次完整探测（可能包含重试与多个端点）。 */
export interface NodeObservation {
  node: string;
  attempts: number;
  endpoints: EndpointObservation[];
  geo?: GeoObservation;
}

/** 出口信息（来自 Cloudflare trace 之类的端点）。 */
export interface GeoObservation {
  loc?: string;
  ip?: string;
  warp?: string;
}

export type Verdict = 'ok' | 'blocked' | 'dead' | 'country-policy';

export interface VerdictDecision {
  verdict: Verdict;
  /** 人类可读的判定依据。 */
  reason: string;
  /** 命中的端点（verdict 为 ok 时）。 */
  matchedEndpoint?: string;
  /** 代表性状态码（用于报告）。 */
  statusCode?: number;
  country?: string;
}

/** 状态码是否落在期望集合内（支持升序两值表示闭区间）。 */
export function statusMatches(status: number, expected: number[]): boolean {
  if (expected.length === 2 && expected[0]! < expected[1]!) {
    return status >= expected[0]! && status <= expected[1]!;
  }
  return expected.includes(status);
}

function describeStatus(statusCode: number | undefined, endpoint: string): string {
  return statusCode === undefined ? `${endpoint} 无响应` : `${endpoint} 返回 ${statusCode}`;
}

/**
 * 判定一个节点对目标组是否可用。
 *
 * 规则：
 *   - 任一已声明端点返回其期望状态码 → 可用（除非被出口国家策略否决）
 *   - 所有端点都拿到了 HTTP 响应但都不符合期望 → 被目标站点拒绝（blocked）
 *   - 所有端点都没有产生任何 HTTP 响应 → 死节点（dead）
 */
export function decideVerdict(target: TargetConfig, observation: NodeObservation): VerdictDecision {
  const endpoints: ProbeEndpoint[] = [target.probe, ...target.extraProbes];
  const byUrl = new Map(observation.endpoints.map((e) => [e.endpoint, e]));

  const matched: { endpoint: ProbeEndpoint; obs: EndpointObservation }[] = [];
  let responded = 0;
  let lastStatus: number | undefined;

  for (const endpoint of endpoints) {
    const obs = byUrl.get(endpoint.url);
    if (!obs || obs.statusCode === undefined) continue;
    responded += 1;
    lastStatus = obs.statusCode;
    if (statusMatches(obs.statusCode, endpoint.expectedStatus)) {
      matched.push({ endpoint, obs });
    }
  }

  if (matched.length === 0) {
    if (responded === 0) {
      const detail = observation.endpoints.map((e) => e.error ?? '无响应').slice(0, 2).join('；');
      return {
        verdict: 'dead',
        reason: observation.attempts > 1
          ? `重试 ${observation.attempts} 次后仍无 HTTP 响应（${detail}）`
          : `无 HTTP 响应（${detail}）`,
      };
    }
    const expected = endpoints.map((e) => `${e.expectedStatus.join('/')}`).join('、');
    const blockedCountry = observation.geo?.loc?.toUpperCase();
    return {
      verdict: 'blocked',
      reason: `端点均返回非期望状态码（实际 ${lastStatus}，期望 ${expected}）→ 出口被目标站点拒绝${
        blockedCountry ? `（出口 ${blockedCountry}）` : ''
      }`,
      ...(lastStatus !== undefined ? { statusCode: lastStatus } : {}),
      ...(blockedCountry ? { country: blockedCountry } : {}),
    };
  }

  const country = observation.geo?.loc?.toUpperCase();
  if (country) {
    if (target.countryDeny.includes(country)) {
      return {
        verdict: 'country-policy',
        reason: `端点可用但出口国家 ${country} 在黑名单中`,
        country,
        ...(lastStatus !== undefined ? { statusCode: lastStatus } : {}),
      };
    }
    if (target.countryAllow.length > 0 && !target.countryAllow.includes(country)) {
      return {
        verdict: 'country-policy',
        reason: `端点可用但出口国家 ${country} 不在白名单中`,
        country,
        ...(lastStatus !== undefined ? { statusCode: lastStatus } : {}),
      };
    }
  }

  const primary = matched[0]!;
  const statusText = describeStatus(primary.obs.statusCode, shortEndpoint(primary.endpoint.url));
  return {
    verdict: 'ok',
    reason: country ? `${statusText}，出口 ${country}` : statusText,
    matchedEndpoint: primary.endpoint.url,
    ...(primary.obs.statusCode !== undefined ? { statusCode: primary.obs.statusCode } : {}),
    ...(country ? { country } : {}),
  };
}

/** 报告里用短名代替完整 URL，避免表格过宽。 */
export function shortEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** 解析 Cloudflare `cdn-cgi/trace` 形式的纯文本响应。 */
export function parseTrace(body: string): GeoObservation {
  const geo: GeoObservation = {};
  for (const line of body.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key === 'loc') geo.loc = value.toUpperCase();
    else if (key === 'ip') geo.ip = value;
    else if (key === 'warp') geo.warp = value;
  }
  return geo;
}
