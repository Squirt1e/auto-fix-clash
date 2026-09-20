import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hexRouteAddress,
  parseDefaultGateway,
  parseNameServers,
  windowsClientConfigPaths,
  windowsPathToPosix,
  wslClientConfigPaths,
  wslHostAddresses,
  type WslBridge,
} from '../src/wsl.ts';
import { collectWslCandidates } from '../src/controller/discovery.ts';
import type { ControllerEndpoint } from '../src/controller/http.ts';

// 真实的 /proc/net/route 片段（NAT 模式：默认网关就是 Windows 宿主机）
const ROUTE_TABLE = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
  'eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
].join('\n');

test('解析 Windows 宿主机的网关与 DNS 地址', () => {
  assert.equal(hexRouteAddress('010011AC'), '172.17.0.1');
  assert.equal(hexRouteAddress('00000000'), undefined, '全零不是有效地址');
  assert.equal(hexRouteAddress('nothex'), undefined);
  assert.equal(parseDefaultGateway(ROUTE_TABLE), '172.17.0.1');
  assert.deepEqual(parseNameServers('nameserver 172.17.0.1\nnameserver 8.8.8.8\n# 注释'), ['172.17.0.1', '8.8.8.8']);
  // 127.0.0.1 排在最前（镜像网络模式下它就是宿主机）
  assert.deepEqual(wslHostAddresses('nameserver 172.17.0.1', ROUTE_TABLE), ['127.0.0.1', '172.17.0.1']);
  assert.deepEqual(wslHostAddresses('', ROUTE_TABLE), ['127.0.0.1', '172.17.0.1']);
});

test('Windows 路径映射到 WSL 挂载点', () => {
  assert.equal(windowsPathToPosix('C:\\Users\\张三'), '/mnt/c/Users/张三');
  assert.equal(windowsPathToPosix('D:\\data'), '/mnt/d/data');
  assert.equal(windowsPathToPosix('not-a-path'), undefined);
});

test('列出 Windows 侧客户端配置路径时用 POSIX 分隔符', () => {
  const paths = windowsClientConfigPaths('/mnt/c', 'x');
  assert.ok(paths.includes('/mnt/c/Users/x/AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml'));
  assert.ok(paths.includes('/mnt/c/Users/x/AppData/Roaming/mihomo-party/work/config.yaml'));
  assert.ok(paths.every((p) => !p.includes('\\')), 'WSL 里必须用正斜杠');
});

test('本机（非 WSL）读不到 Windows 配置时返回空，而不是报错', () => {
  const bridge: WslBridge = {
    profiles: [{ mountRoot: '/mnt/c', username: 'nobody' }],
    hostAddresses: ['127.0.0.1', '172.17.0.1'],
  };
  assert.deepEqual(wslClientConfigPaths(bridge), []);
});

test('WSL 候选：读 Windows 那份配置并换成宿主机地址，同时丢掉跨不过去的管道', () => {
  const dir = mkdtempSync(join(tmpdir(), 'afc-wsl-'));
  const configPath = join(dir, 'clash-verge.yaml');
  writeFileSync(
    configPath,
    'external-controller: 127.0.0.1:9191\n' +
    'external-controller-pipe: \\\\.\\pipe\\verge-mihomo-sidecar-release-deadbeef\n' +
    'secret: s3cr3t\n',
    'utf8',
  );
  try {
    const bridge: WslBridge = {
      profiles: [{ mountRoot: '/mnt/c', username: 'x' }],
      hostAddresses: ['127.0.0.1', '172.17.0.1'],
    };
    const candidates: ControllerEndpoint[] = [];
    const facts = {
      runtimeConfigs: [], kernelProcesses: [], kernelPorts: [], pipes: [], pipesEnumerated: 0,
      pipesMethod: 'none' as const, vergePipes: [], checkedConfigPaths: [], windows: false,
      wslProfiles: [] as string[], wslHostAddresses: [] as string[], wslConfigPaths: [] as string[],
      defaults: [],
    };
    collectWslCandidates({}, facts, (e) => { if (e) candidates.push(e); }, bridge, [configPath]);

    const tcp = candidates.filter((c) => c.kind === 'tcp') as { host: string; port: number; secret?: string; source: string }[];
    // 配置里的端口，在两种网络模式下各生成一份
    assert.ok(tcp.some((c) => c.host === '127.0.0.1' && c.port === 9191), '镜像网络模式用 127.0.0.1');
    assert.ok(tcp.some((c) => c.host === '172.17.0.1' && c.port === 9191), 'NAT 模式用宿主机地址');
    assert.ok(tcp.filter((c) => c.port === 9191).every((c) => c.secret === 's3cr3t'), '密钥要跟着走');
    assert.ok(tcp.some((c) => c.source.includes('WSL 宿主机')), '来源要标出是 WSL 换过的地址');
    // 宿主机上的默认端口也试一遍
    assert.ok(tcp.some((c) => c.host === '172.17.0.1' && c.port === 9097));
    // Windows 的命名管道在 WSL 里毫无意义，不该生成候选
    assert.ok(!candidates.some((c) => c.kind === 'pipe'), 'WSL 里不该有管道候选');
    assert.deepEqual(facts.wslHostAddresses, ['127.0.0.1', '172.17.0.1']);
    assert.deepEqual(facts.wslConfigPaths, [configPath]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
