import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig } from '../src/config.ts';
import { resolveControllerOptions } from '../src/cli/runtime.ts';
import { ControllerDiscoveryError, cheapPlan, discoverController } from '../src/controller/discovery.ts';

function tempConfig(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'afc-controller-test-'));
  const path = join(dir, 'afc.config.yaml');
  writeFileSync(path, content, 'utf8');
  return { dir, path };
}

const BASE = 'targets:\n  - name: GPT\n    probe:\n      url: https://chatgpt.com/backend-api/codex/responses\n      expectedStatus: [405]\n';

test('controller 段：endpoint / secret / ports 都能读出来', () => {
  const { dir, path } = tempConfig(
    BASE + 'controller:\n  endpoint: 127.0.0.1:9191\n  secret: s3cr3t\n  ports: [9191, "9192", 9191]\n',
  );
  try {
    const config = loadConfig(path);
    assert.equal(config.controller.endpoint, '127.0.0.1:9191');
    assert.equal(config.controller.secret, 's3cr3t');
    assert.deepEqual(config.controller.ports, [9191, 9192], '端口去重且接受字符串数字');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('不写 controller 段时不影响原有行为', () => {
  const { dir, path } = tempConfig(BASE);
  try {
    const config = loadConfig(path);
    assert.equal(config.controller.endpoint, undefined);
    assert.deepEqual(config.controller.ports, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('controller.endpoint 支持的三种写法都能通过校验', () => {
  const cases = ['127.0.0.1:9097', 'unix:/tmp/mihomo-party-502-609.sock', 'pipe:\\\\.\\pipe\\MihomoParty\\mihomo'];
  for (const endpoint of cases) {
    const { dir, path } = tempConfig(`${BASE}controller:\n  endpoint: ${JSON.stringify(endpoint)}\n`);
    try {
      assert.equal(loadConfig(path).controller.endpoint, endpoint, endpoint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('controller 段的错值在加载配置时就报错（而不是等到发现阶段）', () => {
  const { dir, path } = tempConfig(
    BASE + 'controller:\n  endpoint: 127.0.0.1\n  ports: [0, 70000, "abc"]\n',
  );
  try {
    assert.throws(
      () => loadConfig(path),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        const problems = (err as ConfigError).problems.join('\n');
        assert.match(problems, /controller\.endpoint 无效/);
        assert.match(problems, /controller\.ports 含非法端口/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('命令行参数压过配置文件的 controller 段', () => {
  const { dir, path } = tempConfig(BASE + 'controller:\n  endpoint: 127.0.0.1:9191\n  secret: from-config\n  ports: [9191]\n');
  try {
    const config = loadConfig(path);
    const fromConfig = resolveControllerOptions(config, {});
    assert.equal(fromConfig.explicit, '127.0.0.1:9191');
    assert.equal(fromConfig.secret, 'from-config');
    assert.deepEqual(fromConfig.configuredPorts, [9191]);

    const fromCli = resolveControllerOptions(config, { controller: 'pipe:\\\\.\\pipe\\x', secret: 'from-cli' });
    assert.equal(fromCli.explicit, 'pipe:\\\\.\\pipe\\x');
    assert.equal(fromCli.secret, 'from-cli');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('配置里声明的端口属于「便宜层」的候选，并且排在猜测的默认端口之前', () => {
  const plan = cheapPlan({ configuredPorts: [9191] }, { platform: 'linux', home: '/home/x', env: {} });
  assert.deepEqual(plan.candidates.map((c) => [c.kind, (c as { port?: number }).port, c.source]), [
    ['tcp', 9191, '配置里的控制端口'],
  ]);
});

test('配置里声明的端口能被真正连上（改过外部控制端口的情形）', async () => {
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"meta":true,"version":"v1.19.27"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法取得端口');
  try {
    const found = await discoverController(
      { configuredPorts: [address.port], timeoutMs: 1500 },
      { platform: 'linux', home: '/home/x', env: { XDG_RUNTIME_DIR: '/nonexistent' } },
    );
    assert.equal(found.version, 'v1.19.27');
    assert.equal((found.endpoint as { port: number }).port, address.port);
    assert.equal(found.endpoint.source, '配置里的控制端口');
  } finally {
    server.close();
  }
});

test('把代理端口当控制端口时，报错直接点出「这是代理端口」', async () => {
  // mihomo 的混合/HTTP 代理端口对 GET /version 正是回 400 且响应体为空
  const server = createHttpServer((_req, res) => {
    res.writeHead(400, { connection: 'close', 'content-length': '0' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法取得端口');
  try {
    await assert.rejects(
      () => discoverController(
        { explicit: `127.0.0.1:${address.port}`, timeoutMs: 1000 },
        { platform: 'linux', home: '/home/x', env: { XDG_RUNTIME_DIR: '/nonexistent' } },
      ),
      (err: unknown) => {
        assert.ok(err instanceof ControllerDiscoveryError);
        const discoveryError = err as ControllerDiscoveryError;
        assert.equal(discoveryError.attempts[0]?.proxyPortLike, true);
        assert.match(discoveryError.message, /代理端口/);
        assert.match(discoveryError.message, /外部控制地址/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});
