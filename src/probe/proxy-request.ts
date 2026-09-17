import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

/** HTTP 代理（mihomo 的入站端口）。 */
export interface ProxyTarget {
  host: string;
  port: number;
}

export interface ProxyRequestOptions {
  proxy: ProxyTarget;
  url: string;
  method?: 'GET' | 'POST' | 'HEAD';
  timeoutMs: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProxyRequestResult {
  status: number;
  body: string;
  /** 从发起连接到收到首字节的耗时（用于横向比较节点快慢）。 */
  ttfbMs: number;
  /** 从发起连接到响应结束的总耗时。 */
  elapsedMs: number;
}

export class ProxyRequestError extends Error {
  readonly phase: 'connect' | 'tunnel' | 'tls' | 'request';
  readonly elapsedMs: number;

  constructor(message: string, phase: ProxyRequestError['phase'], elapsedMs: number) {
    super(message);
    this.name = 'ProxyRequestError';
    this.phase = phase;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * 以「暂停模式」读到分隔符为止。
 *
 * 必须用 'readable' + read() 而不是 'data' 监听：后者会把 socket 切到流动模式，
 * 移除监听后到达的数据会被静默丢弃 —— 而 CONNECT 之后紧接着就是 TLS 握手的字节。
 * 读到分隔符后若缓冲区还有剩余，用 unshift 放回流中交给 TLS 层消费。
 */
function readUntilPaused(socket: Socket, delimiter: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const marker = Buffer.from(delimiter, 'utf8');
    const cleanup = (): void => {
      socket.off('readable', onReadable);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onReadable = (): void => {
      for (;;) {
        const chunk = socket.read() as Buffer | null;
        if (chunk === null) break;
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        const index = buffer.indexOf(marker);
        if (index >= 0) {
          const head = buffer.subarray(0, index + marker.length);
          const rest = buffer.subarray(index + marker.length);
          cleanup();
          if (rest.length > 0) socket.unshift(Buffer.from(rest));
          resolve(head.toString('utf8'));
          return;
        }
      }
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('连接在响应完成前被关闭'));
    };
    socket.on('readable', onReadable);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

interface RawHttpResponse {
  status: number;
  body: Buffer;
  ttfbMs: number;
}

function decodeChunked(input: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = input.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const sizeText = input.subarray(offset, lineEnd).toString('utf8').split(';')[0]!.trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = lineEnd + 2;
    if (start + size > input.length) break;
    parts.push(input.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(parts);
}

/**
 * 手动完成一次 HTTP/1.1 交换。
 *
 * 不使用 node:http —— 它无法复用我们已经建好的 TLS socket（实测会退化成
 * 直连 / ECONNREFUSED）。这里只需要一个请求一个响应，手写反而更可靠：
 * 精确控制 TTFB 计时，并能原样看到 4xx 状态码（这正是本项目的判据来源）。
 */
function exchangeHttp(socket: TLSSocket, requestText: string, startedAt: number): Promise<RawHttpResponse> {
  const elapsed = (): number => Date.now() - startedAt;

  return new Promise<RawHttpResponse>((resolve, reject) => {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let headerEnd = -1;
    let status = 0;
    let contentLength: number | undefined;
    let chunked = false;
    let ttfbMs: number | undefined;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const headText = buffer.subarray(0, headerEnd).toString('utf8');
        let payload = buffer.subarray(headerEnd);
        if (chunked) payload = decodeChunked(payload);
        else if (contentLength !== undefined) payload = payload.subarray(0, contentLength);
        resolve({ status, body: payload, ttfbMs: ttfbMs ?? elapsed() });
      } catch (err) {
        reject(new ProxyRequestError(`解析响应失败：${(err as Error).message}`, 'request', elapsed()));
      }
    };

    const cleanup = (): void => {
      socket.off('readable', onReadable);
      socket.off('end', onEnd);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    const tryComplete = (): boolean => {
      if (headerEnd < 0) return false;
      const payload = buffer.subarray(headerEnd);
      if (contentLength !== undefined) return payload.length >= contentLength;
      if (chunked) return payload.includes(Buffer.from('\r\n0\r\n\r\n')) || payload.indexOf(Buffer.from('0\r\n\r\n')) >= 0;
      return false;
    };

    const onReadable = (): void => {
      for (;;) {
        const chunk = socket.read() as Buffer | null;
        if (chunk === null) break;
        ttfbMs ??= elapsed();
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

        if (headerEnd < 0) {
          const index = buffer.indexOf(Buffer.from('\r\n\r\n'));
          if (index < 0) continue;
          headerEnd = index + 4;
          const headerText = buffer.subarray(0, index).toString('utf8');
          const [statusLine = '', ...headerLines] = headerText.split('\r\n');
          const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
          if (!match) {
            settled = true;
            cleanup();
            reject(new ProxyRequestError(`响应状态行无法解析：${statusLine.slice(0, 80)}`, 'request', elapsed()));
            return;
          }
          status = Number(match[1]);
          for (const line of headerLines) {
            const colon = line.indexOf(':');
            if (colon <= 0) continue;
            const key = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim().toLowerCase();
            if (key === 'content-length') contentLength = Number(value);
            else if (key === 'transfer-encoding' && value.includes('chunked')) chunked = true;
          }
        }
        if (tryComplete()) {
          finish();
          return;
        }
      }
    };

    const onEnd = (): void => {
      if (headerEnd < 0) {
        settled = true;
        cleanup();
        reject(new ProxyRequestError('连接在收到响应头之前被关闭', 'request', elapsed()));
        return;
      }
      finish();
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ProxyRequestError(`读取响应失败：${err.message}`, 'request', elapsed()));
    };

    const onClose = (): void => {
      if (settled) return;
      if (headerEnd >= 0) finish();
      else onError(new Error('连接被关闭'));
    };

    socket.on('readable', onReadable);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write(requestText);
  });
}

/**
 * 通过 HTTP 代理（CONNECT 隧道）发起一个 HTTPS 请求，并原样返回状态码。
 *
 * 之所以自己实现：探测需要一个「能看到真实状态码」的通道，
 * 而 mihomo 的 /proxies/<name>/delay 接口会忽略状态码（实测对 403/405/500 一律算成功）。
 *
 * 最外层还有一道硬性截止（deadlineMs）兜底：网络栈在某些情况下可能既不 resolve
 * 也不 reject，绝不能因为单个卡住的连接把整轮筛查拖死。
 */
export async function requestThroughProxy(options: ProxyRequestOptions): Promise<ProxyRequestResult> {
  const { timeoutMs } = options;
  const deadlineMs = timeoutMs + 2000;
  let deadlineTimer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      performRequest(options),
      new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new ProxyRequestError(`整体超时（${deadlineMs}ms）`, 'request', deadlineMs)),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

async function performRequest(options: ProxyRequestOptions): Promise<ProxyRequestResult> {
  const { proxy, url, method = 'GET', timeoutMs, headers = {}, body } = options;
  const target = new URL(url);
  if (target.protocol !== 'https:') {
    throw new Error(`目前只支持 https 探测地址，收到：${url}`);
  }
  const port = Number(target.port || 443);
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;

  let socket: Socket | undefined;
  let tlsSocket: TLSSocket | undefined;
  const timer = setTimeout(() => {
    socket?.destroy();
    tlsSocket?.destroy();
  }, timeoutMs);

  try {
    // 1) 连接代理
    socket = netConnect({ host: proxy.host, port: proxy.port });
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => { cleanup(); resolve(); };
      const onError = (err: Error): void => {
        cleanup();
        reject(new ProxyRequestError(`连接代理失败：${err.message}`, 'connect', elapsed()));
      };
      // 必须同时监听 close：socket 在连接建立前被销毁时不一定触发 error，
      // 只等 connect/error 会让 Promise 永远不 settle（实测会把整轮筛查挂死）。
      const onClose = (): void => {
        cleanup();
        reject(new ProxyRequestError('连接代理时被关闭', 'connect', elapsed()));
      };
      const cleanup = (): void => {
        socket!.off('connect', onConnect);
        socket!.off('error', onError);
        socket!.off('close', onClose);
      };
      socket!.once('connect', onConnect);
      socket!.once('error', onError);
      socket!.once('close', onClose);
    });
    socket.setNoDelay(true);

    // 2) 建立 CONNECT 隧道
    const authority = `${target.hostname}:${port}`;
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    let tunnelHead: string;
    try {
      tunnelHead = await readUntilPaused(socket, '\r\n\r\n');
    } catch (err) {
      throw new ProxyRequestError(`建立隧道失败：${(err as Error).message}`, 'tunnel', elapsed());
    }
    const statusLine = tunnelHead.split('\r\n')[0] ?? '';
    if (!/^HTTP\/1\.[01]\s+200/.test(statusLine)) {
      throw new ProxyRequestError(`代理拒绝建立隧道（${statusLine.trim() || '无响应行'}）`, 'tunnel', elapsed());
    }

    // 3) TLS 握手
    tlsSocket = await new Promise<TLSSocket>((resolve, reject) => {
      const tls = tlsConnect({ socket: socket!, servername: target.hostname }, () => resolve(tls));
      tls.once('error', (err) => reject(new ProxyRequestError(`TLS 握手失败：${err.message}`, 'tls', elapsed())));
    });

    // 4) 手动发一个 HTTP/1.1 请求
    const headerLines: string[] = [
      `${method} ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.hostname}`,
      'Accept: */*',
      'Accept-Encoding: identity',
      'Connection: close',
      'User-Agent: afc/0.1 (+node)',
    ];
    for (const [key, value] of Object.entries(headers)) headerLines.push(`${key}: ${value}`);
    if (body !== undefined) headerLines.push(`Content-Length: ${Buffer.byteLength(body)}`);

    const response = await exchangeHttp(
      tlsSocket,
      `${headerLines.join('\r\n')}\r\n\r\n${body ?? ''}`,
      startedAt,
    );

    return {
      status: response.status,
      body: response.body.toString('utf8'),
      ttfbMs: response.ttfbMs,
      elapsedMs: elapsed(),
    };
  } finally {
    clearTimeout(timer);
    tlsSocket?.destroy();
    socket?.destroy();
  }
}
