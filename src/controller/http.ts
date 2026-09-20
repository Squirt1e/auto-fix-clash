import { request as httpRequest } from 'node:http';

/** mihomo 控制端点：Unix 域套接字、Windows 命名管道，或 TCP。 */
export type ControllerEndpoint =
  | { kind: 'unix'; path: string; secret?: string; source: string }
  | { kind: 'pipe'; path: string; secret?: string; source: string }
  | { kind: 'tcp'; host: string; port: number; secret?: string; source: string };

export interface RawResponse {
  status: number;
  body: string;
}

export class HttpError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HttpError';
    if (status !== undefined) this.status = status;
  }
}

export interface RawRequestOptions {
  method?: string;
  path: string;
  body?: string;
  timeoutMs?: number;
  secret?: string;
  signal?: AbortSignal;
}

/**
 * 用 node:http 直接请求控制端点，避免依赖 curl，并支持 socketPath。
 * 返回原始状态码与响应体，便于区分「无响应」「401」「非 mihomo 服务」。
 */
export function rawRequest(endpoint: ControllerEndpoint, options: RawRequestOptions): Promise<RawResponse> {
  const { method = 'GET', path, body, timeoutMs = 8000, secret, signal } = options;
  const headers: Record<string, string> = { accept: 'application/json' };
  const effectiveSecret = secret ?? endpoint.secret;
  if (effectiveSecret) headers['authorization'] = `Bearer ${effectiveSecret}`;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(body));
  }

  // Unix 套接字与 Windows 命名管道在 Node 里都通过 socketPath 连接
  const target = endpoint.kind === 'tcp'
    ? { host: endpoint.host, port: endpoint.port }
    : { socketPath: endpoint.path };

  return new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest({ ...target, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (err) => reject(new HttpError(`读取响应失败：${err.message}`)));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new HttpError(`请求超时（${timeoutMs}ms）：${method} ${path}`));
    });
    req.on('error', (err) => {
      reject(err instanceof HttpError ? err : new HttpError(`${method} ${path} 失败：${err.message}`));
    });
    if (signal) {
      if (signal.aborted) req.destroy(new HttpError('请求已取消'));
      else signal.addEventListener('abort', () => req.destroy(new HttpError('请求已取消')), { once: true });
    }
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export function describeEndpoint(endpoint: ControllerEndpoint): string {
  if (endpoint.kind === 'tcp') return `tcp:${endpoint.host}:${endpoint.port}`;
  return `${endpoint.kind}:${endpoint.path}`;
}

/**
 * 可以直接喂给 `--controller` 的写法。
 *
 * 与 describeEndpoint 的区别：TCP 端点不带 `tcp:` 前缀 —— 少一层引号/转义，
 * 在 cmd 与 PowerShell 里都能原样粘贴（这些值里不会有空格或 shell 元字符）。
 */
export function endpointArg(endpoint: ControllerEndpoint): string {
  if (endpoint.kind === 'tcp') return `${endpoint.host}:${endpoint.port}`;
  return `${endpoint.kind}:${endpoint.path}`;
}
