import {
  existsSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse, stringify } from 'yaml';
import {
  listKernelProcesses,
  listClientProcesses,
  readRuntimeConfig,
  findKernelBinary,
} from '../paths.ts';
import { discoverController } from '../controller/discovery.ts';
import { MihomoClient, isRealNode, type MihomoRule, type ProxyInfo } from '../controller/client.ts';
import type { Runtime } from '../cli/runtime.ts';
import type { Binding } from './store.ts';
import { bindingRule, ordered } from './plan.ts';

export interface Party {
  root: string;
  profile: string;
  runtimePath: string;
  app: string;
  kernel: string;
  client: MihomoClient;
}
const safeProfile = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
export function currentProfile(root: string): string {
  const data = parse(readFileSync(join(root, 'profile.yaml'), 'utf8'));
  if (
    !safeProfile(data?.current) ||
    !data.items?.some((i: { id: string }) => i.id === data.current)
  )
    throw new Error('无法确认当前订阅 ID');
  return data.current;
}
export async function inspectParty(runtime: Pick<Runtime, 'controller'>): Promise<Party> {
  if (process.platform !== 'darwin') throw new Error('bind 首版仅支持 macOS Clash Party');
  const ep = runtime.controller.endpoint;
  if (ep.kind !== 'unix')
    throw new Error('bind 需要本机 Clash Party 的 Unix 控制端点；不支持远程写入');
  const processes = listKernelProcesses().filter((p) => p.unixSocket === ep.path);
  if (processes.length !== 1) throw new Error('控制器无法唯一关联到 Clash Party 进程');
  const proc = processes[0]!;
  const app = proc.command.match(/^(.*?\.app)\/Contents\//)?.[1];
  if (
    !app ||
    execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')],
      { encoding: 'utf8' },
    ).trim() !== 'party.mihomo.app'
  )
    throw new Error('当前控制器不是支持的 Clash Party');
  const runtimePath =
    proc.configFile ?? (proc.workDir ? join(proc.workDir, 'config.yaml') : undefined);
  if (!runtimePath) throw new Error('找不到实际运行配置路径');
  let root = dirname(runtimePath);
  while (dirname(root) !== root && !existsSync(join(root, 'profile.yaml'))) root = dirname(root);
  if (!existsSync(join(root, 'profile.yaml')) || !existsSync(join(root, 'override.yaml')))
    throw new Error('无法确认 Party 数据目录');
  root = realpathSync(root);
  const profile = currentProfile(root);
  const kernel = proc.execPath ?? proc.command.slice(0, proc.command.indexOf(' -'));
  return { root, profile, runtimePath, app, kernel, client: runtime.controller.client };
}
export async function stop(p: Party): Promise<void> {
  // Target the observed executable, not LaunchServices' potentially stale bundle-ID registration.
  const main = listClientProcesses().filter(
    (x) => x.execPath === join(p.app, 'Contents/MacOS/Clash Party'),
  );
  if (main.length > 1) throw new Error('检测到多个 Party 主进程，取消重启');
  if (main[0])
    execFileSync(
      'osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        `ObjC.import('AppKit'); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${main[0].pid}); if (!app.isNil()) app.terminate;`,
      ],
      { timeout: 10000, stdio: 'pipe' },
    );
  for (let i = 0; i < 100; i++) {
    if (
      ![...listKernelProcesses(), ...listClientProcesses()].some((x) =>
        x.command.includes(`${p.app}/Contents/`),
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Party 未完全退出，取消写入（不强杀）');
}
export async function start(p: Party): Promise<Party> {
  execFileSync('open', ['-a', p.app], { timeout: 10000 });
  for (let i = 0; i < 60; i++) {
    try {
      const found = await discoverController({
        runtimeConfigPath: p.runtimePath,
        budgetMs: 800,
        timeoutMs: 400,
      });
      const next = await inspectParty({ controller: found });
      if (next.root === p.root && next.profile === p.profile) return next;
    } catch {
      /* startup */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Party 启动或订阅身份验收超时');
}
export function verifyBindings(
  bindings: Binding[],
  rules: MihomoRule[],
  proxies: Record<string, ProxyInfo>,
): void {
  for (const [i, b] of ordered(bindings).entries()) {
    const r = rules[i];
    if (
      !r ||
      r.extra?.disabled ||
      r.type.replace(/[-_]/g, '').toUpperCase() !==
        (b.pattern.startsWith('*.') ? 'DOMAINSUFFIX' : 'DOMAIN') ||
      r.payload.toLowerCase().replace(/\.$/, '') !== b.pattern.replace(/^\*\./, '') ||
      r.proxy !== b.group ||
      proxies[b.group]?.type !== 'Selector'
    )
      throw new Error(`绑定未生效或已漂移：${b.pattern} → ${b.group}`);
    if (!(proxies[b.group]?.all ?? []).some((name) => isRealNode(proxies[name])))
      throw new Error(`绑定组没有真实候选节点：${b.group}`);
  }
}
export function validateConfig(p: Party, bindings: Binding[]): void {
  const config = parse(readFileSync(p.runtimePath, 'utf8'));
  config.rules = [...ordered(bindings).map(bindingRule), ...(config.rules ?? [])];
  const names = new Set((config['proxy-groups'] ?? []).map((g: { name: string }) => g.name));
  for (const b of bindings)
    if (!names.has(b.group)) {
      (config['proxy-groups'] ??= []).push({
        name: b.group,
        type: 'select',
        'include-all-proxies': true,
        'exclude-type': 'Direct|Reject|RejectDrop|Compatible|Pass|PassRule|Dns|Unknown',
      });
      names.add(b.group);
    }
  const dir = mkdtempSync(join(tmpdir(), 'afc-bind-check-'));
  try {
    // Relative providers/geodata must resolve against the original work directory.
    const file = join(dir, 'config.yaml');
    writeFileSync(file, stringify(config), { mode: 0o600 });
    execFileSync(p.kernel, ['-t', '-d', dirname(p.runtimePath), '-f', file], {
      timeout: 20000,
      stdio: 'pipe',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function exactDefinitions(p: Party): unknown[] {
  return readRuntimeConfig(p.runtimePath).proxies;
}
// Offline writes are explicit and only allowed after the user has exited Party.
export function inspectOfflineParty(
  root: string,
  kernelPath?: string,
  running = [...listClientProcesses(), ...listKernelProcesses()],
): {
  party: Party;
  proxies: Record<string, ProxyInfo>;
  configs: Record<string, unknown>;
  rules: MihomoRule[];
} {
  if (process.platform !== 'darwin') throw new Error('离线绑定首版仅支持 macOS Clash Party');
  if (running.some((p) => /(?:Clash Party|mihomo-party)/i.test(p.command))) {
    throw new Error('Clash Party 仍在运行。请由你手动退出后再执行 --offline；AFC 不会代为退出');
  }
  root = realpathSync(root);
  const profile = currentProfile(root);
  if (!existsSync(join(root, 'override.yaml'))) throw new Error('不是完整的 Party 数据目录');
  const settings = parse(readFileSync(join(root, 'config.yaml'), 'utf8')) ?? {};
  const runtimePath = join(root, 'work', ...(settings.diffWorkDir ? [profile] : []), 'config.yaml');
  const configs = parse(readFileSync(runtimePath, 'utf8')) as Record<string, unknown>;
  const proxies: Record<string, ProxyInfo> = {};
  const builtins = new Set([
    'direct',
    'reject',
    'rejectdrop',
    'compatible',
    'pass',
    'passrule',
    'dns',
    'unknown',
  ]);
  const nodes = (configs.proxies ?? []) as { name: string; type: string }[];
  for (const n of nodes)
    if (
      typeof n.name === 'string' &&
      typeof n.type === 'string' &&
      !builtins.has(n.type.replace(/-/g, '').toLowerCase())
    )
      proxies[n.name] = { name: n.name, type: n.type };
  const nodeNames = Object.keys(proxies);
  for (const g of (configs['proxy-groups'] ?? []) as {
    name: string;
    type: string;
    proxies?: string[];
    'include-all-proxies'?: boolean;
  }[]) {
    proxies[g.name] = {
      name: g.name,
      type: g.type === 'select' ? 'Selector' : 'URLTest',
      all: g['include-all-proxies'] ? nodeNames : (g.proxies ?? []),
    };
  }
  const kernel = findKernelBinary(kernelPath);
  const app = kernel.match(/^(.*?\.app)\/Contents\//)?.[1] ?? '';
  const client = new MihomoClient({
    kind: 'unix',
    path: join(root, 'offline.sock'),
    source: 'offline (not contacted)',
  });
  return {
    party: { root, profile, runtimePath, app, kernel, client },
    proxies,
    configs,
    rules: [],
  };
}
