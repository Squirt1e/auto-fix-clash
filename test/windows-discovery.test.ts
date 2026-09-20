import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ControllerDiscoveryError,
  candidateEndpoints,
  cheapPlan,
  discoverController,
  parseEndpointString,
  planDiscovery,
} from '../src/controller/discovery.ts';
import { pipePathsFromNames } from '../src/controller/pipe-scan.ts';
import {
  isKernelImageName,
  normalizeWindowsPipePath,
  parseKernelArgs,
  parseWindowsNetstatListeners,
  parseWindowsProcessJson,
  parseWindowsTasklistCsv,
  readRuntimeConfig,
} from '../src/paths.ts';
import { DEFAULT_CONTROLLER_PORTS, pipeCandidates, vergeSidecarPipeNames, type PlatformContext } from '../src/platform.ts';

const WINDOWS_CTX: PlatformContext = {
  platform: 'win32',
  home: 'C:\\Users\\x',
  env: {
    APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    PROGRAMFILES: 'C:\\Program Files',
  },
};

function tempConfig(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'afc-win-test-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, content, 'utf8');
  return { dir, path };
}

/** 找一个没人监听的端口。 */
async function freeClosedPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = address !== null && typeof address !== 'string' ? address.port : 1;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function startFakeController(secret?: string): Promise<{ server: Server; port: number }> {
  const server = createHttpServer((req, res) => {
    if (secret && req.headers.authorization !== `Bearer ${secret}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Unauthorized' }));
      return;
    }
    if ((req.url ?? '') === '/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ meta: true, version: 'v1.19.27' }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('无法取得端口');
      resolve({ server, port: address.port });
    });
  });
}

test('parseKernelArgs 解析 Clash Verge 在 Windows 上的启动参数', () => {
  const parsed = parseKernelArgs(
    '"C:\\Program Files\\Clash Verge\\verge-mihomo.exe" ' +
    '-d "C:\\Users\\张三\\AppData\\Roaming\\io.github.clash-verge-rev.clash-verge-rev" ' +
    '-f "C:\\Users\\张三\\AppData\\Roaming\\io.github.clash-verge-rev.clash-verge-rev\\config.yaml" ' +
    '-ext-ctl-pipe \\\\.\\pipe\\verge-mihomo-sidecar-release-c169',
  );
  assert.equal(parsed.configFile, 'C:\\Users\\张三\\AppData\\Roaming\\io.github.clash-verge-rev.clash-verge-rev\\config.yaml');
  assert.equal(parsed.workDir, 'C:\\Users\\张三\\AppData\\Roaming\\io.github.clash-verge-rev.clash-verge-rev');
  assert.equal(parsed.pipePath, '\\\\.\\pipe\\verge-mihomo-sidecar-release-c169');
  // -ext-ctl-pipe 不能被当成 -ext-ctl（否则会把管道名当 host:port 解析）
  assert.equal(parsed.tcpController, undefined);
});

test('parseWindowsProcessJson 认数组、单对象、空命令行与坏输入', () => {
  const array = parseWindowsProcessJson(JSON.stringify([
    { ProcessId: 10, Name: 'verge-mihomo.exe', CommandLine: '"C:\\Program Files\\Clash Verge\\verge-mihomo.exe" -d "C:\\Users\\张三\\AppData\\Roaming\\io.github.clash-verge-rev.clash-verge-rev"' },
    { ProcessId: 11, Name: 'mihomo.exe', CommandLine: null },
  ]));
  assert.equal(array.length, 2);
  assert.equal(array[0]!.name, 'verge-mihomo.exe');
  assert.equal(array[0]!.pid, 10);
  assert.match(array[0]!.command!, /张三/);
  // 服务模式下的内核读不到命令行：不能因此把它丢掉
  assert.equal(array[1]!.command, undefined);

  const single = parseWindowsProcessJson('{"ProcessId":7,"Name":"mihomo.exe","CommandLine":"mihomo -d C:\\\\work"}');
  assert.deepEqual(single, [{ pid: 7, name: 'mihomo.exe', command: 'mihomo -d C:\\work' }]);

  assert.deepEqual(parseWindowsProcessJson(''), []);
  assert.deepEqual(parseWindowsProcessJson('不是 JSON'), []);
});

test('parseWindowsTasklistCsv 解析 tasklist 兜底输出', () => {
  const rows = parseWindowsTasklistCsv(
    '"verge-mihomo.exe","4321","Console","1","120,000 K"\r\n' +
    '"chrome.exe","99","Console","1","10 K"\r\n',
  );
  assert.deepEqual(rows.map((r) => [r.name, r.pid]), [
    ['verge-mihomo.exe', 4321],
    ['chrome.exe', 99],
  ]);
});

test('parseWindowsNetstatListeners 只取指定 PID 的监听端口（不看状态列文字）', () => {
  // 状态列在不同语言的 Windows 上会被翻译，因此判据是对端地址 *:0
  const netstat = [
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    0.0.0.0:7890           0.0.0.0:0              LISTENING       4321',
    '  TCP    127.0.0.1:9097         0.0.0.0:0              ABHÖREN         4321',
    '  TCP    127.0.0.1:9097         127.0.0.1:51234        ESTABLISHED     4321',
    '  TCP    [::]:9090              [::]:0                 LISTENING       4321',
    '  TCP    127.0.0.1:1080         0.0.0.0:0              LISTENING       9999',
    '  UDP    0.0.0.0:5353           *:*                                    4321',
  ].join('\r\n');
  assert.deepEqual(parseWindowsNetstatListeners(netstat, [4321]), [7890, 9097, 9090]);
  assert.deepEqual(parseWindowsNetstatListeners(netstat, [9999]), [1080]);
  assert.deepEqual(parseWindowsNetstatListeners(netstat, []), []);
});

test('isKernelImageName 按镜像名认内核（服务模式下命令行是空的）', () => {
  for (const name of [
    'verge-mihomo.exe', 'verge-mihomo-alpha.exe', 'mihomo.exe', 'Mihomo.EXE',
    'clash-meta.exe', 'clash_meta.exe', 'mihomo-core.exe',
  ]) {
    assert.equal(isKernelImageName(name), true, name);
  }
  for (const name of ['', 'chrome.exe', 'Clash Verge.exe', 'verge.exe', 'afc-probe-1234.exe']) {
    assert.equal(isKernelImageName(name), false, name);
  }
});

test('normalizeWindowsPipePath 补全成 Node 能连的完整路径', () => {
  assert.equal(normalizeWindowsPipePath('verge-mihomo'), '\\\\.\\pipe\\verge-mihomo');
  assert.equal(normalizeWindowsPipePath('\\\\.\\pipe\\MihomoParty\\mihomo'), '\\\\.\\pipe\\MihomoParty\\mihomo');
  // 只写了名字的相对写法（mihomo 自己也接受）也补全，并统一分隔符
  assert.equal(normalizeWindowsPipePath('.\\pipe\\x'), '\\\\.\\pipe\\.\\pipe\\x');
  assert.equal(normalizeWindowsPipePath('/pipe/x'), '\\\\.\\pipe\\pipe\\x');
});

test('vergeSidecarPipeNames 按 SID 推导出 Verge 的管道名（sha256，与 service-ipc 的 owner_key 一致）', () => {
  const names = vergeSidecarPipeNames('S-1-5-21-1-2-3-1001');
  assert.deepEqual(names, [
    '\\\\.\\pipe\\verge-mihomo-sidecar-release-c169ebe52e9c0ba43200ce3a6af1b392219cdaf6006bba3e879ccb699a245fae',
    '\\\\.\\pipe\\verge-mihomo-sidecar-dev-c169ebe52e9c0ba43200ce3a6af1b392219cdaf6006bba3e879ccb699a245fae',
  ]);
});

test('pipePathsFromNames 只留下像 mihomo 的管道，并支持子目录形式', () => {
  const paths = pipePathsFromNames([
    'lsass',
    'MihomoParty\\mihomo',
    'verge-mihomo-sidecar-release-abc',
    'chrome.devtools',
    'mihomo-party-helper',
    'winsat\\metadata', // 弱匹配（meta）排最后
  ]);
  assert.deepEqual(paths, [
    '\\\\.\\pipe\\MihomoParty\\mihomo',
    '\\\\.\\pipe\\verge-mihomo-sidecar-release-abc',
    '\\\\.\\pipe\\mihomo-party-helper',
    '\\\\.\\pipe\\winsat\\metadata',
  ]);
  // 去重（Windows 管道名大小写不敏感）
  assert.deepEqual(pipePathsFromNames(['MihomoParty', 'mihomoparty']), ['\\\\.\\pipe\\MihomoParty']);
});

test('parseEndpointString 接受报错信息里打印的 tcp: 写法与省略前缀的管道名', () => {
  assert.deepEqual(parseEndpointString('tcp:127.0.0.1:9097'), {
    kind: 'tcp', host: '127.0.0.1', port: 9097, source: '显式指定',
  });
  assert.deepEqual(parseEndpointString('pipe:verge-mihomo'), {
    kind: 'pipe', path: '\\\\.\\pipe\\verge-mihomo', source: '显式指定',
  });
  assert.deepEqual(parseEndpointString('\\\\.\\pipe\\MihomoParty\\mihomo'), {
    kind: 'pipe', path: '\\\\.\\pipe\\MihomoParty\\mihomo', source: '显式指定',
  });
});

test('Windows 候选包含真实的管道名与 9097（README 曾把人引到 9090）', () => {
  const pipes = pipeCandidates(WINDOWS_CTX);
  assert.ok(pipes.includes('\\\\.\\pipe\\MihomoParty\\mihomo'), 'Clash Party 的管道是子目录形式');
  assert.ok(DEFAULT_CONTROLLER_PORTS.includes(9097), 'Clash Verge Rev 默认 9097');

  const candidates = candidateEndpoints({}, WINDOWS_CTX);
  assert.ok(candidates.some((c) => c.kind === 'pipe' && c.path === '\\\\.\\pipe\\MihomoParty\\mihomo'));
  assert.ok(candidates.some((c) => c.kind === 'tcp' && c.port === 9097));
  assert.ok(candidates.every((c) => c.kind !== 'unix'), 'Windows 上不应有 Unix 套接字候选');
});

test('readRuntimeConfig 读出 Clash Verge 写进配置的管道名与 secret', () => {
  const { dir, path } = tempConfig(
    'external-controller: 127.0.0.1:9097\n' +
    'external-controller-pipe: \\\\.\\pipe\\verge-mihomo-sidecar-release-deadbeef\n' +
    'secret: s3cr3t\n',
  );
  try {
    const summary = readRuntimeConfig(path);
    assert.equal(summary.externalController, '127.0.0.1:9097');
    assert.equal(summary.externalControllerPipe, '\\\\.\\pipe\\verge-mihomo-sidecar-release-deadbeef');
    assert.equal(summary.secret, 's3cr3t');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('运行时配置里的管道/端口/secret 会变成候选，且 secret 兜底给其它候选', () => {
  const { dir, path } = tempConfig(
    'external-controller: 127.0.0.1:9097\n' +
    'external-controller-pipe: \\\\.\\pipe\\verge-mihomo-sidecar-release-deadbeef\n' +
    'secret: s3cr3t\n',
  );
  try {
    const plan = planDiscovery({ runtimeConfigPath: path }, WINDOWS_CTX);
    const pipe = plan.candidates.find((c) => c.kind === 'pipe' && c.path.includes('deadbeef'));
    assert.ok(pipe, '配置里的 external-controller-pipe 必须成为候选');
    assert.equal(pipe.secret, 's3cr3t');

    const tcp = plan.candidates.find((c) => c.kind === 'tcp' && c.port === 9097);
    assert.ok(tcp, '配置里的 external-controller 必须成为候选');
    assert.equal(tcp.source, `运行时配置 ${path}`);

    // 猜出来的候选也带上配置里的 secret：Verge 的 secret 是随机的，用户填不出来
    const fallback = plan.candidates.find((c) => c.kind === 'tcp' && c.port === 9090);
    assert.equal(fallback?.secret, 's3cr3t');
    assert.equal(plan.facts.configSecret, 's3cr3t');
    assert.equal(plan.facts.runtimeConfigs[0]?.path, path);
    assert.equal(plan.facts.runtimeConfigs[0]?.hasSecret, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cheapPlan 只读运行时配置：不碰进程、管道与默认端口（那层很贵）', () => {
  const { dir, path } = tempConfig('external-controller: 127.0.0.1:1234\nexternal-controller-pipe: \\\\.\\pipe\\verge-x\nsecret: s\n');
  try {
    const plan = cheapPlan({ runtimeConfigPath: path }, WINDOWS_CTX);
    assert.deepEqual(
      plan.candidates.map((c) => c.source),
      [`运行时配置 ${path}`, `运行时配置 ${path}`],
      '便宜层只该有配置里写明的端点',
    );
    assert.ok(!plan.candidates.some((c) => c.kind === 'tcp' && c.port === 9090), '默认端口属于后一层');
    assert.ok(!plan.candidates.some((c) => c.source === '常见命名管道'), '写死的管道名属于后一层');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('便宜层命中就不再走重量级枚举（配置里的端点能答就直接用）', async () => {
  const { server, port } = await startFakeController('s3cr3t');
  const { dir, path } = tempConfig(`external-controller: 127.0.0.1:${port}\nsecret: s3cr3t\n`);
  const closed = await freeClosedPort();
  try {
    const found = await discoverController(
      {
        runtimeConfigPath: path,
        // 这个候选属于后一层：如果前面命中了，它不该被尝试（也就不会出现在 attempts 里）
        extraCandidates: [{ kind: 'tcp', host: '127.0.0.1', port: closed, source: '后一层的候选' }],
      },
      WINDOWS_CTX,
    );
    assert.equal(found.version, 'v1.19.27');
    assert.equal((found.endpoint as { port: number }).port, port);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('显式端点不通时，报错里给出「afc 自己发现的可用端点」', async () => {
  const { server, port } = await startFakeController();
  const { dir, path } = tempConfig(`external-controller: 127.0.0.1:${port}\nsecret: none\n`);
  const closed = await freeClosedPort();
  try {
    await assert.rejects(
      () => discoverController(
        { explicit: `127.0.0.1:${closed}`, timeoutMs: 1000, runtimeConfigPath: path },
        WINDOWS_CTX,
      ),
      (err: unknown) => {
        assert.ok(err instanceof ControllerDiscoveryError);
        const discoveryError = err as ControllerDiscoveryError;
        assert.equal(discoveryError.reason, 'unreachable');
        assert.equal(discoveryError.alternative?.endpoint.kind, 'tcp');
        assert.equal((discoveryError.alternative?.endpoint as { port?: number }).port, port);
        assert.match(discoveryError.message, /另外发现这个端点可用/);
        // 每个候选都要能看出「它是从哪来的」
        assert.ok(discoveryError.attempts.every((a) => a.source !== ''));
        assert.match(discoveryError.message, /来源：/);
        // 报错里给出的 --controller 写法必须能原样粘回来用
        const suggestion = /确实要显式指定的话：--controller (\S+)/.exec(discoveryError.message)?.[1];
        assert.ok(suggestion, '应给出可直接粘贴的 --controller 写法');
        const parsed = parseEndpointString(suggestion);
        assert.equal(parsed.kind, 'tcp');
        assert.equal((parsed as { port: number }).port, port);
        return true;
      },
    );
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('显式端点缺 secret 时，用运行时配置里的 secret 自动补上', async () => {
  const { server, port } = await startFakeController('verge-secret');
  const { dir, path } = tempConfig(`external-controller: 127.0.0.1:${port}\nsecret: verge-secret\n`);
  try {
    const found = await discoverController(
      // 用户只给了端口（照 README 抄的），而 Verge 的 secret 是随机生成的
      { explicit: `127.0.0.1:${port}`, timeoutMs: 1500, runtimeConfigPath: path },
      WINDOWS_CTX,
    );
    assert.equal(found.version, 'v1.19.27');
    assert.equal(found.endpoint.secret, 'verge-secret');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('发现失败时给出 Windows 专属排查提示与候选来源', async () => {
  const closed = await freeClosedPort();
  await assert.rejects(
    () => discoverController({ explicit: `127.0.0.1:${closed}`, timeoutMs: 800 }, WINDOWS_CTX),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /Clash Verge Rev/);
      assert.match(message, /MihomoParty/);
      assert.match(message, /--verbose/);
      return true;
    },
  );
});
