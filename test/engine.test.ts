import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AfcConfig, TargetConfig } from '../src/config.ts';
import { DEFAULT_SCHEDULE, DEFAULT_TARGETS } from '../src/config.ts';
import { ProbeEngine } from '../src/probe/engine.ts';
import type { ProbeInstance } from '../src/probe/instance.ts';
import { ProxyRequestError, type ProxyRequestOptions, type ProxyRequestResult } from '../src/probe/proxy-request.ts';

const CODEX = 'https://chatgpt.com/backend-api/codex/responses';
const OPENAI = 'https://api.openai.com/v1/models';
const TRACE = 'https://chatgpt.com/cdn-cgi/trace';

/** 假实例：通道用端口区分，真实出口由 selection 决定。 */
function fakeInstance(channels: number): {
  instance: ProbeInstance;
  selection: Map<number, string>;
  ports: number[];
} {
  const ports = Array.from({ length: channels }, (_, i) => 41000 + i);
  const selection = new Map<number, string>();
  const instance = {
    channelsCount: channels,
    channelPort: (index: number) => ports[index],
    channelGroup: (index: number) => `CH${index}`,
    select: async (channel: number, node: string) => { selection.set(channel, node); },
    stop: async () => {},
    tempDir: '/tmp/fake',
  };
  return { instance: instance as unknown as ProbeInstance, selection, ports };
}

type Reply = { status: number; body?: string; ttfbMs?: number } | 'error';

function makeTransport(
  ports: number[],
  selection: Map<number, string>,
  reply: (node: string, url: string, callIndex: number) => Reply,
  hooks: { onEnter?: (node: string) => void; onExit?: () => void; delayMs?: number } = {},
): (options: ProxyRequestOptions) => Promise<ProxyRequestResult> {
  const callsPerNode = new Map<string, number>();
  return async (options) => {
    const channel = ports.indexOf(options.proxy.port);
    const node = selection.get(channel) ?? 'unknown';
    const index = callsPerNode.get(node) ?? 0;
    callsPerNode.set(node, index + 1);
    hooks.onEnter?.(node);
    try {
      if (hooks.delayMs) await new Promise((r) => setTimeout(r, hooks.delayMs));
      const r = reply(node, options.url, index);
      if (r === 'error') throw new ProxyRequestError('模拟传输失败', 'request', 5);
      return {
        status: r.status,
        body: r.body ?? '',
        ttfbMs: r.ttfbMs ?? 50,
        elapsedMs: (r.ttfbMs ?? 50) + 10,
      };
    } finally {
      hooks.onExit?.();
    }
  };
}

function configWith(concurrency = 1, retries = 0): AfcConfig {
  const target: TargetConfig = { ...DEFAULT_TARGETS[0]! };
  return {
    probe: { concurrency, retries, timeoutMs: 3000 },
    schedule: { ...DEFAULT_SCHEDULE },
    targets: [target],
  };
}

const traceBody = 'ip=1.2.3.4\nloc=HK\nwarp=on\n';

test('可用节点：主端点返回期望状态码即为 ok', async () => {
  const { instance, selection, ports } = fakeInstance(1);
  const engine = await ProbeEngine.create({
    config: configWith(),
    proxies: [{}],
    nodeNames: ['A'],
    instanceFactory: async () => instance,
    transport: makeTransport(ports, selection, (_n, url) =>
      url === CODEX ? { status: 405, ttfbMs: 120 } : { status: 401 }),
  });
  const result = await engine.probeOne('A', DEFAULT_TARGETS[0]!);
  await engine.close();
  assert.equal(result.verdict, 'ok');
  assert.equal(result.statusCode, 405);
  assert.equal(result.attempts, 1);
  assert.equal(result.ttfbMs, 120);
});

test('被目标站点拒绝：拿到 403 不重试（明确结论）', async () => {
  const { instance, selection, ports } = fakeInstance(1);
  let calls = 0;
  const engine = await ProbeEngine.create({
    config: configWith(1, 3),
    proxies: [{}],
    nodeNames: ['A'],
    instanceFactory: async () => instance,
    transport: makeTransport(ports, selection, (_n, url) => {
      if (url === CODEX) { calls += 1; return { status: 403 }; }
      if (url === TRACE) return { status: 200, body: traceBody };
      return { status: 403 };
    }),
  });
  const result = await engine.probeOne('A', DEFAULT_TARGETS[0]!);
  await engine.close();
  assert.equal(result.verdict, 'blocked');
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1, '得到 4xx 是明确结论，不应重试');
  assert.equal(result.country, 'HK');
});

test('无任何响应：按配置重试后才判为死节点', async () => {
  const { instance, selection, ports } = fakeInstance(1);
  let calls = 0;
  const engine = await ProbeEngine.create({
    config: configWith(1, 2),
    proxies: [{}],
    nodeNames: ['A'],
    instanceFactory: async () => instance,
    transport: makeTransport(ports, selection, () => { calls += 1; return 'error'; }),
  });
  const result = await engine.probeOne('A', DEFAULT_TARGETS[0]!);
  await engine.close();
  assert.equal(result.verdict, 'dead');
  assert.equal(result.attempts, 3, 'retries=2 → 共 3 次尝试');
  assert.match(result.reason, /重试 3 次/);
  assert.ok(calls >= 3);
});

test('瞬时失败后重试成功 → 判为可用，不算死节点', async () => {
  const { instance, selection, ports } = fakeInstance(1);
  let attempt = 0;
  const engine = await ProbeEngine.create({
    config: configWith(1, 1),
    proxies: [{}],
    nodeNames: ['A'],
    instanceFactory: async () => instance,
    transport: makeTransport(ports, selection, (_n, url) => {
      if (url !== CODEX) return { status: 401 };
      attempt += 1;
      return attempt === 1 ? 'error' : { status: 405 };
    }),
  });
  const result = await engine.probeOne('A', DEFAULT_TARGETS[0]!);
  await engine.close();
  assert.equal(result.verdict, 'ok');
  assert.equal(result.attempts, 2);
});

test('出口国家在黑名单：即使端点通过也判为国家受限', async () => {
  const { instance, selection, ports } = fakeInstance(1);
  const engine = await ProbeEngine.create({
    config: configWith(),
    proxies: [{}],
    nodeNames: ['A'],
    instanceFactory: async () => instance,
    transport: makeTransport(ports, selection, (_n, url) => {
      if (url === CODEX) return { status: 405 };
      if (url === TRACE) return { status: 200, body: traceBody };
      return { status: 401 };
    }),
  });
  const result = await engine.probeOne('A', DEFAULT_TARGETS[0]!);
  await engine.close();
  assert.equal(result.verdict, 'country-policy');
  assert.equal(result.country, 'HK');
  assert.equal(result.ip, '1.2.3.4');
  assert.equal(result.warp, 'on');
});

test('死节点不会再去取出口信息（省一次请求）', async () => {
  const { instance, selection, ports } = fakeInstance(1);
  const seen: string[] = [];
  const engine = await ProbeEngine.create({
    config: configWith(1, 0),
    proxies: [{}],
    nodeNames: ['A'],
    instanceFactory: async () => instance,
    transport: makeTransport(ports, selection, (_n, url) => {
      seen.push(url);
      return 'error';
    }),
  });
  await engine.probeOne('A', DEFAULT_TARGETS[0]!);
  await engine.close();
  assert.ok(seen.every((url) => url !== TRACE), `不应请求出口端点，实际请求：${seen.join(', ')}`);
});

test('并发探测不会超过配置的通道上限', async () => {
  const { instance, selection, ports } = fakeInstance(2);
  let inFlight = 0;
  let maxInFlight = 0;
  const engine = await ProbeEngine.create({
    config: configWith(2, 0),
    proxies: [{}],
    nodeNames: ['A', 'B', 'C', 'D'],
    instanceFactory: async () => instance,
    transport: makeTransport(
      ports,
      selection,
      (_n, url) => (url === CODEX ? { status: 405, ttfbMs: 10 } : { status: 401 }),
      {
        delayMs: 20,
        onEnter: () => { inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); },
        onExit: () => { inFlight -= 1; },
      },
    ),
  });
  const results = await engine.probeAll(['A', 'B', 'C', 'D'], DEFAULT_TARGETS[0]!);
  await engine.close();
  assert.equal(results.length, 4);
  assert.ok(maxInFlight <= 2, `并发上限被突破：${maxInFlight}`);
  assert.ok(maxInFlight > 1, '应当有并发发生（否则测不到上限）');
  assert.deepEqual(results.map((r) => r.node), ['A', 'B', 'C', 'D'], '结果顺序应与输入一致');
});

test('每个通道的出口选择互不干扰', async () => {
  const { instance, selection, ports } = fakeInstance(2);
  const egressByPort = new Map<number, string>();
  const engine = await ProbeEngine.create({
    config: configWith(2, 0),
    proxies: [{}],
    nodeNames: ['A', 'B'],
    instanceFactory: async () => instance,
    transport: async (options) => {
      const channel = ports.indexOf(options.proxy.port);
      const node = selection.get(channel) ?? 'unknown';
      egressByPort.set(options.proxy.port, node);
      const body = node === 'A' ? 'loc=HK\n' : 'loc=SG\n';
      if (options.url === CODEX) return { status: 405, body: '', ttfbMs: 5, elapsedMs: 6 };
      if (options.url === OPENAI) return { status: 401, body: '', ttfbMs: 5, elapsedMs: 6 };
      return { status: 200, body, ttfbMs: 5, elapsedMs: 6 };
    },
  });
  const results = await engine.probeAll(['A', 'B'], DEFAULT_TARGETS[0]!);
  await engine.close();
  // 通道 0 与通道 1 各自拿到了自己指定的节点
  assert.equal(egressByPort.get(ports[0]), 'A');
  assert.equal(egressByPort.get(ports[1]), 'B');
  assert.equal(results[0]!.verdict, 'country-policy');
  assert.equal(results[1]!.verdict, 'ok');
});
