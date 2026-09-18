import { isGroup } from '../../controller/client.ts';
import { targetGroupNames } from '../../config.ts';
import { EXIT_ENVIRONMENT, EXIT_OK } from '../../exit-codes.ts';
import { runtimeConfigPathCandidates } from '../../paths.ts';
import { pad } from '../format.ts';
import { isQuiet, openRuntime } from '../runtime.ts';
import { optBoolean, type CommandContext } from '../context.ts';

const GROUP_TYPE_LABEL: Record<string, string> = {
  Selector: '手动选择',
  URLTest: '自动测速',
  Fallback: '故障转移',
  LoadBalance: '负载均衡',
  Relay: '链式代理',
  Smart: 'Smart',
};

/**
 * 列出当前订阅实际存在的代理组。
 *
 * 存在的意义：用户需要知道 `--group` 后面能写什么，以及哪些组还没被 afc 管理。
 * 组名永远以控制端点上报的为准 —— 不同订阅、不同客户端下组名都可能不一样。
 */
export async function run(context: CommandContext): Promise<number> {
  const runtime = await openRuntime(context);
  const client = runtime.controller.client;
  const all = await client.proxies();

  const groups = Object.entries(all).filter(([, info]) => isGroup(info));
  if (groups.length === 0) {
    process.stderr.write('当前控制端点没有上报任何代理组。\n');
    return EXIT_ENVIRONMENT;
  }

  const managedBy = new Map<string, string>();
  for (const target of runtime.config.targets) {
    for (const groupName of targetGroupNames(target)) managedBy.set(groupName, target.name);
  }

  const rows = groups
    .map(([name, info]) => ({
      name,
      typeLabel: GROUP_TYPE_LABEL[info.type] ?? info.type,
      members: (info.all ?? []).length,
      current: info.now ?? '—',
      /** 若该组是某个目标的组名或别名，记录它归属的目标。 */
      managed: managedBy.get(name),
      configured: managedBy.has(name),
      /** 是否为可被可靠切换的类型（只有手动选择组可以）。 */
      switchable: info.type === 'Selector',
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  if (optBoolean(context.values, 'json')) {
    process.stdout.write(JSON.stringify({
      controller: runtime.controller.endpoint,
      kernelVersion: runtime.controller.version,
      runtimeConfig: runtimeConfigPathCandidates(runtime.config.probe.runtimeConfigPath)[0] ?? null,
      groups: rows.map((r) => ({
        name: r.name,
        type: r.typeLabel,
        members: r.members,
        current: r.current,
        managedAs: r.managed ?? null,
      })),
    }, null, 2) + '\n');
    return EXIT_OK;
  }

  // 诊断信息（控制器/配置路径从哪来）只在 --verbose 时打印：
  // 常规使用只需要"有哪些组、哪些已受管理"。
  if (optBoolean(context.values, 'verbose')) {
    const configPath = runtimeConfigPathCandidates(runtime.config.probe.runtimeConfigPath)[0];
    process.stdout.write(
      `afc 配置：${runtime.config.sourcePath ?? '（未使用配置文件，采用内置默认）'}\n` +
      `控制器：${describeEndpoint(runtime.controller.endpoint)}\n` +
      `内核版本：${runtime.controller.version}\n` +
      `运行时配置：${configPath ?? '（未找到）'}\n\n`,
    );
  }

  process.stdout.write(
    pad('组名', 24) + pad('类型', 10) + pad('当前选中', 24) + '受 afc 管理\n',
  );
  process.stdout.write('-'.repeat(70) + '\n');
  for (const r of rows) {
    // 只有手动选择组能被可靠指定成员；自动选择型组会被内核下次体检覆盖
    const manageState = r.configured ? '是' : r.switchable ? '否' : '不可切换';
    process.stdout.write(
      pad(r.name, 24) +
      pad(r.typeLabel, 10) +
      pad(r.current, 24) +
      manageState + '\n',
    );
  }

  if (rows.some((r) => !r.configured && r.switchable)) {
    process.stdout.write(
      '\n让某个组也受管理：在 afc.config.yaml 的 targets 里加一条（组名照抄上表），详见 README。\n',
    );
  }
  return EXIT_OK;
}

function describeEndpoint(endpoint: { kind: string; path?: string; host?: string; port?: number; source: string }): string {
  const address = endpoint.kind === 'unix' ? `unix:${endpoint.path}` : `tcp:${endpoint.host}:${endpoint.port}`;
  return `${address}（来源：${endpoint.source}）`;
}
