import { HttpError, rawRequest, type ControllerEndpoint } from './http.ts';

export interface ProxyHistoryEntry {
  time: string;
  delay: number;
}

export interface ProxyInfo {
  name: string;
  type: string;
  /** 选择器/自动组当前选中的成员名。 */
  now?: string;
  /** 组成员名列表。 */
  all?: string[];
  history?: ProxyHistoryEntry[];
  alive?: boolean;
}

export interface VersionInfo {
  meta?: boolean;
  version: string;
}

export const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay', 'Smart']);

/** 内置策略类型：既不是代理组，也不是可拨号的真实节点。 */
export const BUILTIN_TYPES = new Set(['Direct', 'Reject', 'RejectDrop', 'Compatible', 'Pass', 'Dns', 'Unknown']);

/** 判定一个 /proxies 条目是否为代理组（而非真实节点）。 */
export function isGroup(info: ProxyInfo): boolean {
  return GROUP_TYPES.has(info.type);
}

/** 判定是否为「可以作为出口切换目标」的真实节点。 */
export function isRealNode(info: ProxyInfo | undefined): boolean {
  if (!info) return false;
  return !GROUP_TYPES.has(info.type) && !BUILTIN_TYPES.has(info.type);
}

export class UnauthorizedError extends Error {
  constructor(endpoint: string) {
    super(`控制端点需要认证但凭据无效：${endpoint}`);
    this.name = 'UnauthorizedError';
  }
}

export class NotMihomoError extends Error {
  constructor(endpoint: string, status: number, body: string) {
    super(`${endpoint} 的响应不像 mihomo 控制端点（HTTP ${status}）：${body.slice(0, 120)}`);
    this.name = 'NotMihomoError';
  }
}

/**
 * Clash/mihomo 外部控制 API 的最小客户端。
 * 只实现本项目需要的端点，并对「认证失败」与「不是 mihomo」分别报错。
 */
export class MihomoClient {
  readonly endpoint: ControllerEndpoint;
  private readonly timeoutMs: number;

  constructor(endpoint: ControllerEndpoint, timeoutMs = 8000) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const res = await rawRequest(this.endpoint, {
      method,
      path,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: timeoutMs ?? this.timeoutMs,
    });
    if (res.status === 401 || res.status === 403) throw new UnauthorizedError(path);
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(`mihomo API ${method} ${path} 返回 HTTP ${res.status}：${res.body.slice(0, 200)}`, res.status);
    }
    if (res.body.trim() === '') return undefined as T;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new NotMihomoError(path, res.status, res.body);
    }
  }

  async version(timeoutMs?: number): Promise<VersionInfo> {
    const v = await this.call<VersionInfo>('GET', '/version', undefined, timeoutMs);
    if (typeof v?.version !== 'string') {
      throw new NotMihomoError('GET /version', 200, JSON.stringify(v));
    }
    return v;
  }

  async proxies(): Promise<Record<string, ProxyInfo>> {
    const res = await this.call<{ proxies: Record<string, ProxyInfo> }>('GET', '/proxies');
    return res.proxies ?? {};
  }

  async proxy(name: string): Promise<ProxyInfo> {
    return await this.call<ProxyInfo>('GET', `/proxies/${encodeURIComponent(name)}`);
  }

  /** 把某个选择器/自动组切到指定成员。 */
  async select(group: string, name: string): Promise<void> {
    await this.call<void>('PUT', `/proxies/${encodeURIComponent(group)}`, { name });
  }

  /** 组内全体节点延迟测试（会真实发起请求，注意频率）。 */
  async groupDelay(
    group: string,
    opts: { url?: string; timeoutMs?: number; expectedStatus?: string; signal?: AbortSignal } = {},
  ): Promise<Record<string, number>> {
    const q = new URLSearchParams();
    q.set('timeout', String(opts.timeoutMs ?? 5000));
    if (opts.url) q.set('url', opts.url);
    if (opts.expectedStatus) q.set('expected-status', opts.expectedStatus);
    return await this.call<Record<string, number>>(
      'GET',
      `/group/${encodeURIComponent(group)}/delay?${q.toString()}`,
      undefined,
      (opts.timeoutMs ?? 5000) + 5000,
    );
  }

  async configs(): Promise<Record<string, unknown>> {
    return await this.call<Record<string, unknown>>('GET', '/configs');
  }

  /** 让内核按指定配置文件热重载（与 Clash Party 自身的做法一致）。 */
  async reloadConfig(configPath: string): Promise<void> {
    await this.call<void>('PUT', '/configs?force=true', { path: configPath });
  }
}
