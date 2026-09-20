import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MihomoClient } from '../src/controller/client.ts';
import { ControllerDiscoveryError, candidateEndpoints, discoverController, parseEndpointString } from '../src/controller/discovery.ts';
import { parseKernelArgs } from '../src/paths.ts';

interface FakeController {
  server: Server;
  port: number;
  requests: string[];
}

/** 起一个假的 mihomo 控制端点。 */
async function startFakeController(
  handler?: (path: string, method: string) => { status: number; body: string } | undefined,
): Promise<FakeController> {
  const requests: string[] = [];
  const server = createHttpServer((req, res) => {
    const path = req.url ?? '/';
    requests.push(`${req.method} ${path}`);
    const custom = handler?.(path, req.method ?? 'GET');
    if (custom) {
      res.writeHead(custom.status, { 'content-type': 'application/json' });
      res.end(custom.body);
      return;
    }
    if (path === '/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ meta: true, version: 'v1.19.27' }));
      return;
    }
    if (path.startsWith('/proxies/')) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法取得端口');
  return { server, port: address.port, requests };
}

test('parseEndpointString 支持 unix 与 tcp 两种写法', () => {
  assert.deepEqual(parseEndpointString('unix:/tmp/x.sock'), { kind: 'unix', path: '/tmp/x.sock', source: '显式指定' });
  assert.deepEqual(parseEndpointString('127.0.0.1:9090'), {
    kind: 'tcp', host: '127.0.0.1', port: 9090, source: '显式指定',
  });
  assert.deepEqual(parseEndpointString('http://127.0.0.1:9090', 'sec'), {
    kind: 'tcp', host: '127.0.0.1', port: 9090, secret: 'sec', source: '显式指定',
  });
  assert.throws(() => parseEndpointString('127.0.0.1'), /无效的端点/);
});

test('parseKernelArgs 解析内核命令行参数', () => {
  const parsed = parseKernelArgs(
    '/Applications/Clash Party.app/Contents/Resources/sidecar/mihomo ' +
    '-d /Users/x/Library/Application Support/mihomo-party/work ' +
    '-ext-ctl-unix /tmp/mihomo-party-502-609.sock',
  );
  assert.equal(parsed.workDir, '/Users/x/Library/Application Support/mihomo-party/work');
  assert.equal(parsed.unixSocket, '/tmp/mihomo-party-502-609.sock');
  assert.equal(parsed.tcpController, undefined);
});

test('parseKernelArgs 支持 -ext-ctl=<值> 形式', () => {
  const parsed = parseKernelArgs('mihomo -d /work -ext-ctl=127.0.0.1:9090');
  assert.equal(parsed.tcpController, '127.0.0.1:9090');
});

test('发现 TCP 控制端点并识别 mihomo 版本', async () => {
  const fake = await startFakeController();
  try {
    const found = await discoverController({ explicit: `127.0.0.1:${fake.port}` });
    assert.equal(found.version, 'v1.19.27');
    assert.equal(found.endpoint.kind, 'tcp');
  } finally {
    fake.server.close();
  }
});

// Windows 上没有 Unix 套接字（用命名管道），这条在 Windows 上跳过
test('发现带 PID 的 Unix 套接字端点（路径随进程变化）', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-test-'));
  const socketPath = join(dir, 'mihomo-party-502-12345.sock');
  const body = JSON.stringify({ meta: true, version: 'v1.19.27' });
  const server = createNetServer((socket) => {
    socket.on('data', () => {
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const found = await discoverController({ explicit: `unix:${socketPath}` });
    assert.equal(found.version, 'v1.19.27');
    assert.equal(found.endpoint.kind, 'unix');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// 回归：发现分两层（先便宜的配置层，再枚举进程/端口/管道），第二层命中时必须成功返回。
// 1.1.3–1.2.1 漏了第二层的成功判定，导致「候选来自进程/套接字扫描」的用户（macOS/Linux 上的
// Clash Party 就是这种）一律报「找到了控制端点候选，但都无法访问」，且已发布过。
test('第二层（进程/套接字扫描）命中时也要成功返回', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-test-'));
  const socketPath = join(dir, 'mihomo-party-502-12345.sock');
  const body = JSON.stringify({ meta: true, version: 'v1.19.27' });
  const server = createNetServer((socket) => {
    socket.on('data', () => {
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    // 不指定显式端点，也不给运行时配置：只能靠第三组候选（套接字目录扫描 / 内核进程）找到
    const found = await discoverController(
      { runtimeConfigPath: join(dir, '不存在.yaml'), timeoutMs: 1500 },
      { platform: 'linux', home: '/home/x', env: { XDG_RUNTIME_DIR: dir } },
    );
    assert.equal(found.version, 'v1.19.27');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('认证失败被识别为 unauthorized，而不是「没有端点」', async () => {
  const fake = await startFakeController(() => ({ status: 401, body: '{"message":"Unauthorized"}' }));
  try {
    await assert.rejects(
      () => discoverController({ explicit: `127.0.0.1:${fake.port}` }),
      (err: unknown) => {
        assert.ok(err instanceof ControllerDiscoveryError);
        assert.equal((err as ControllerDiscoveryError).reason, 'unauthorized');
        assert.match((err as Error).message, /认证失败/);
        return true;
      },
    );
  } finally {
    fake.server.close();
  }
});

test('响应不是 mihomo 时不被误认为有效端点', async () => {
  const fake = await startFakeController(() => ({ status: 200, body: '{"hello":"world"}' }));
  try {
    await assert.rejects(
      () => discoverController({ explicit: `127.0.0.1:${fake.port}`, timeoutMs: 1500 }),
      (err: unknown) => {
        assert.ok(err instanceof ControllerDiscoveryError);
        assert.equal((err as ControllerDiscoveryError).reason, 'unreachable');
        return true;
      },
    );
  } finally {
    fake.server.close();
  }
});

test('端点不可达时给出可诊断的错误', async () => {
  // 找一个没人监听的端口
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = address !== null && typeof address !== 'string' ? address.port : 1;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  await assert.rejects(
    () => discoverController({ explicit: `127.0.0.1:${port}`, timeoutMs: 1200 }),
    (err: unknown) => {
      assert.ok(err instanceof ControllerDiscoveryError);
      assert.equal((err as ControllerDiscoveryError).reason, 'unreachable');
      assert.ok((err as ControllerDiscoveryError).attempts.length > 0);
      return true;
    },
  );
});

test('MihomoClient 可以切换组选择', async () => {
  const fake = await startFakeController();
  try {
    const client = new MihomoClient({ kind: 'tcp', host: '127.0.0.1', port: fake.port, source: 'test' });
    await client.select('GPT', '[Normal] 美国 03');
    assert.ok(fake.requests.some((r) => r.startsWith('PUT /proxies/')));
  } finally {
    fake.server.close();
  }
});

test('解析 Windows 命名管道端点', () => {
  const explicit = parseEndpointString('pipe:\\\\.\\pipe\\verge-mihomo');
  assert.equal(explicit.kind, 'pipe');
  assert.equal((explicit as { path: string }).path, '\\\\.\\pipe\\verge-mihomo');

  // 省略前缀也认
  const bare = parseEndpointString('\\\\.\\pipe\\mihomo');
  assert.equal(bare.kind, 'pipe');
});

test('Windows 平台枚举命名管道候选，POSIX 平台枚举套接字目录', () => {
  const win = { platform: 'win32' as const, home: 'C:\\Users\\x', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } };
  const winCandidates = candidateEndpoints({}, win);
  assert.ok(winCandidates.some((c) => c.kind === 'pipe'), 'Windows 上应有命名管道候选');
  assert.ok(winCandidates.every((c) => c.kind !== 'unix'), 'Windows 上不应有 Unix 套接字候选');

  const linux = { platform: 'linux' as const, home: '/home/x', env: {} };
  const linuxCandidates = candidateEndpoints({}, linux);
  assert.ok(linuxCandidates.every((c) => c.kind !== 'pipe'), 'POSIX 平台不应有命名管道候选');
});
