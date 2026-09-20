import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { MihomoClient } from '../controller/client.ts';
import type { ControllerEndpoint } from '../controller/http.ts';
import { findKernelBinary, KernelNotFoundError } from '../paths.ts';

/** 探针组名前缀；每个并发通道对应一个组 + 一个独立入站端口。 */
const PROBE_GROUP_PREFIX = '__AFC_PROBE_';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') {
        srv.close(() => reject(new Error('无法分配空闲端口')));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

const PROBE_TEMP_PREFIX = 'afc-probe-';

/** 永久性的准备失败（配置缺失、内核不在），重试没有意义。 */
class ProbeSetupError extends Error {}
/** 超过这个时间的残留临时目录会被清理（进程被强杀时来不及自我清理）。 */
const STALE_TEMP_MS = 60 * 60 * 1000;

/** 清理历史遗留的探针临时目录，避免被强杀后无限堆积。 */
function pruneStaleTempDirs(): void {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(PROBE_TEMP_PREFIX)) continue;
    const path = join(root, entry);
    try {
      if (now - statSync(path).mtimeMs > STALE_TEMP_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // 清理失败不影响本次探测
    }
  }
}

export interface ProbeInstanceOptions {
  /** 节点定义（运行时配置里的 proxies 段）。 */
  proxies: unknown[];
  /** 可用于切换的节点名（真实节点，不含代理组与内置策略）。 */
  nodeNames: string[];
  /** 并发通道数。 */
  channels?: number;
  kernelPath?: string;
  startupTimeoutMs?: number;
  /** 保留临时目录（排查用）。 */
  keepTempDir?: boolean;
}

/**
 * 一次性 mihomo 探针实例。
 *
 * 存在的意义：需要一个「能指定出口节点、并且能看到真实 HTTP 状态码」的通道。
 * 内核自带的延迟接口会忽略状态码，而在用实例上翻转代理组会干扰用户连接，
 * 因此单独起一个只含本机节点定义的临时实例，用完即销毁。
 *
 * 并发实现方式：每个通道用一个**独立入站端口**，通过 mihomo 的
 * `listeners[].proxy` 把该端口直接绑定到一个选择器组。
 * 这样通道之间互不干扰，也不需要依赖规则匹配（早期版本用 `MATCH,<组>` 规则
 * 导致所有通道都走了同一个组，是错误做法）。
 */
export class ProbeInstance {
  readonly client: MihomoClient;
  private readonly process: ChildProcess;
  private readonly dir: string;
  private readonly ports: number[];
  private readonly keepTempDir: boolean;
  private stopped = false;

  private constructor(opts: {
    child: ChildProcess;
    dir: string;
    ports: number[];
    client: MihomoClient;
    keepTempDir: boolean;
  }) {
    this.process = opts.child;
    this.dir = opts.dir;
    this.ports = opts.ports;
    this.client = opts.client;
    this.keepTempDir = opts.keepTempDir;
  }

  /** 第 index 个并发通道的入站端口。 */
  channelPort(index: number): number {
    const port = this.ports[index];
    if (port === undefined) throw new Error(`探测通道越界：${index}/${this.ports.length}`);
    return port;
  }

  /** 第 index 个并发通道对应的选择器组名。 */
  channelGroup(index: number): string {
    if (index < 0 || index >= this.ports.length) throw new Error(`探测通道越界：${index}/${this.ports.length}`);
    return `${PROBE_GROUP_PREFIX}${index}__`;
  }

  get channelsCount(): number {
    return this.ports.length;
  }

  get tempDir(): string {
    return this.dir;
  }

  static async start(options: ProbeInstanceOptions): Promise<ProbeInstance> {
    // 刚唤醒、系统负载高或端口刚回收时，内核对就绪可能明显变慢。
    // 这类失败是暂时的，重试一次比直接放弃整轮修复更合理（实测出现过一次就绪超时）。
    const maxAttempts = 2;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await ProbeInstance.startOnce(options);
      } catch (err) {
        lastError = err as Error;
        // 配置/环境类问题重试没有意义：重试只会拖慢报错，还会把"内核没找到"
        // 这种确定结论说成"（已重试 1 次）"，看起来像临时故障
        if (err instanceof KernelNotFoundError || err instanceof ProbeSetupError) throw err;
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error(`${lastError?.message ?? '无法启动探针实例'}（已重试 ${maxAttempts - 1} 次）`);
  }

  private static async startOnce(options: ProbeInstanceOptions): Promise<ProbeInstance> {
    if (options.proxies.length === 0) throw new ProbeSetupError('运行时配置中没有可用的节点定义，无法启动探针实例');
    if (options.nodeNames.length === 0) throw new ProbeSetupError('没有可切换的节点，无法启动探针实例');
    const kernelPath = findKernelBinary(options.kernelPath);
    const channels = Math.max(1, options.channels ?? 1);
    const startupTimeoutMs = options.startupTimeoutMs ?? 45000;
    const keepTempDir = options.keepTempDir ?? false;
    pruneStaleTempDirs();

    const dir = mkdtempSync(join(tmpdir(), PROBE_TEMP_PREFIX));
    const controllerPath = join(dir, 'controller.sock');
    const ports: number[] = [];
    for (let i = 0; i < channels; i += 1) ports.push(await freePort());

    const config = {
      'bind-address': '127.0.0.1',
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'warning',
      ipv6: true,
      'unified-delay': true,
      dns: {
        enable: true,
        ipv6: true,
        'enhanced-mode': 'normal',
        'default-nameserver': ['223.5.5.5'],
        nameserver: ['https://doh.pub/dns-query'],
        'proxy-server-nameserver': ['https://doh.pub/dns-query'],
      },
      proxies: options.proxies,
      'proxy-groups': ports.map((_, i) => ({
        name: `${PROBE_GROUP_PREFIX}${i}__`,
        type: 'select',
        proxies: options.nodeNames,
      })),
      // 每个通道一个入站端口，直接绑定到本通道的选择器组，
      // 因此探测流量不经过规则匹配，通道之间也不会互相干扰。
      listeners: ports.map((port, i) => ({
        name: `afc-channel-${i}`,
        type: 'mixed',
        port,
        listen: '127.0.0.1',
        proxy: `${PROBE_GROUP_PREFIX}${i}__`,
      })),
      rules: ['MATCH,DIRECT'],
    };

    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, stringifyYaml(config), 'utf8');

    // 控制端点走 Unix 套接字：不额外暴露 TCP 端口。
    const child = spawn(kernelPath, ['-d', dir, '-f', configPath, '-ext-ctl-unix', controllerPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    let log = '';
    child.stdout?.on('data', (d: Buffer) => { log += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { log += d.toString(); });

    const endpoint: ControllerEndpoint = { kind: 'unix', path: controllerPath, source: 'afc 探针实例' };
    const client = new MihomoClient(endpoint, 5000);

    const deadline = Date.now() + startupTimeoutMs;
    let ready = false;
    let exitInfo = '';
    child.once('exit', (code, signal) => { exitInfo = `内核进程已退出（code=${code}, signal=${signal}）`; });

    while (Date.now() < deadline) {
      if (exitInfo) break;
      try {
        await client.version(1500);
        // 端点能应答还不够：必须确认我们的探针组已经就绪，
        // 否则随后的 PUT /proxies/<探针组> 会 404（实测出现过一次）。
        await client.proxy(`${PROBE_GROUP_PREFIX}0__`);
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (!ready) {
      child.kill('SIGKILL');
      if (!keepTempDir) rmSync(dir, { recursive: true, force: true });
      const detail = exitInfo || '就绪等待超时';
      throw new Error(
        `无法启动探针实例：${detail}\n内核：${kernelPath}\n日志：\n${log.trim().slice(-2000) || '（无输出）'}`,
      );
    }

    return new ProbeInstance({ child, dir, ports, client, keepTempDir });
  }

  /** 让某个通道指向指定节点。 */
  async select(channel: number, node: string): Promise<void> {
    await this.client.select(this.channelGroup(channel), node);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.process.exitCode === null && !this.process.killed) {
      this.process.kill('SIGTERM');
      const deadline = Date.now() + 3000;
      while (this.process.exitCode === null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.process.exitCode === null) this.process.kill('SIGKILL');
    }
    if (!this.keepTempDir) rmSync(this.dir, { recursive: true, force: true });
  }
}
