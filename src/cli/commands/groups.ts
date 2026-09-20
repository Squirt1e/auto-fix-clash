import { isGroup } from '../../controller/client.ts';
import { expandAutoTargets } from '../../targets/auto.ts';
import { EXIT_ENVIRONMENT, EXIT_OK } from '../../exit-codes.ts';
import { runtimeConfigPathCandidates } from '../../paths.ts';
import { writeGroupsIndex } from '../groups-index.ts';
import { pad } from '../format.ts';
import { isQuiet, kernelDiagnosticLine, openRuntime } from '../runtime.ts';
import { optBoolean, type CommandContext } from '../context.ts';

export interface GroupRow {
  /** 打印顺序里的编号；`afc add <编号>` 用它，免得手打 emoji 组名。 */
  index: number;
  name: string;
  typeLabel: string;
  current: string;
  /** 是否受 afc 管理（配置声明或自动接管）。 */
  managed: boolean;
  /** 是否由配置显式声明。 */
  configured: boolean;
  /** 是否为可被可靠切换的类型（只有手动选择组可以）。 */
  switchable: boolean;
}

/**
 * 排序：会受管理的组放前面（显式声明的优先于自动接管的），
 * 其次是可切换但未被管理的，最后是不可切换的；同组内按名称排序。
 */
export function sortGroupRows(rows: GroupRow[]): GroupRow[] {
  const rank = (row: GroupRow): number => {
    if (row.configured) return 0;
    if (row.managed) return 1;
    return row.switchable ? 2 : 3;
  };
  return [...rows].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return a.name.localeCompare(b.name, 'zh');
  });
}

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

  // 用与 fix/doctor 相同的判定逻辑，保证"表格里显示会被管"与"真的会被管"一致
  const expansion = expandAutoTargets(runtime.config.targets, all);
  const autoByGroup = new Map(expansion.targets.map((t) => [t.groupName, t.source]));
  const configuredGroups = new Set(runtime.config.targets.map((t) => t.name));

  const rows = sortGroupRows(
    groups.map(([name, info]) => ({
      index: 0,
      name,
      typeLabel: GROUP_TYPE_LABEL[info.type] ?? info.type,
      current: info.now ?? '—',
      managed: autoByGroup.has(name),
      configured: autoByGroup.get(name) === 'configured',
      /** 是否为可被可靠切换的类型（只有手动选择组可以）。 */
      switchable: info.type === 'Selector',
    })),
  );
  // 编号 = 打印顺序（1 起）。落盘一份，`afc add <编号>` / `afc remove <编号>` 才认得出它。
  rows.forEach((row, i) => { row.index = i + 1; });
  writeGroupsIndex(
    endpointAddress(runtime.controller.endpoint),
    rows.map((r) => ({ name: r.name, type: r.typeLabel })),
  );

  if (optBoolean(context.values, 'json')) {
    process.stdout.write(JSON.stringify({
      controller: runtime.controller.endpoint,
      kernelVersion: runtime.controller.version,
      runtimeConfig: runtimeConfigPathCandidates(runtime.config.probe.runtimeConfigPath)[0] ?? null,
      groups: rows.map((r) => ({
        index: r.index,
        name: r.name,
        type: r.typeLabel,
        current: r.current,
        managed: r.managed,
        source: r.configured ? 'configured' : r.managed ? 'auto' : null,
      })),
    }, null, 2) + '\n');
    return EXIT_OK;
  }

  const verbose = optBoolean(context.values, 'verbose');
  // 诊断信息（控制器/配置路径从哪来）只在 --verbose 时打印：
  // 常规使用只需要"有哪些组、哪些会被处理"。
  if (verbose) {
    const configPath = runtimeConfigPathCandidates(runtime.config.probe.runtimeConfigPath)[0];
    process.stdout.write(
      `afc 配置：${runtime.config.sourcePath ?? '（未使用配置文件，采用内置默认）'}\n` +
      `控制器：${describeEndpoint(runtime.controller.endpoint)}\n` +
      `内核版本：${runtime.controller.version}\n` +
      `运行时配置：${configPath ?? '（未找到）'}\n` +
      (kernelDiagnosticLine() ?? '').replace(/\n$/, '') + '\n',
    );
  }

  process.stdout.write(
    pad('#', 4) + pad('组名', 24) + pad('类型', 10) + pad('当前选中', 24) + '受 afc 管理\n',
  );
  process.stdout.write('-'.repeat(74) + '\n');
  for (const r of rows) {
    // 只有手动选择组能被可靠指定成员；自动选择型组会被内核下次体检覆盖
    const manageState = r.configured ? '是' : r.managed ? '自动' : r.switchable ? '否' : '不可切换';
    process.stdout.write(
      pad(String(r.index), 4) +
      pad(r.name, 24) +
      pad(r.typeLabel, 10) +
      pad(r.current, 24) +
      manageState + '\n',
    );
  }

  if (verbose && expansion.skipped.length > 0) {
    process.stdout.write(
      '\n不会被处理的组：\n' +
      expansion.skipped.map((s) => `  ${s.groupName}：${s.reason}`).join('\n') + '\n',
    );
  } else if (rows.some((r) => !r.managed && r.switchable)) {
    process.stdout.write('\n标「否」的组不会被处理（--verbose 查看原因，或用 targets 显式声明）。\n');
  }

  // 结尾给一条能直接抄的命令：组名常带 emoji，用编号比手打组名靠谱
  const addable = rows.find((r) => r.switchable && !r.managed);
  const sample = addable ?? rows.find((r) => r.switchable);
  process.stdout.write(
    '\n用编号操作（组名带 emoji 时尤其省事）：\n' +
    `  afc add ${sample ? sample.index : '<编号>'}      把该组交给 afc 管理${sample ? `（例：${sample.name}）` : ''}\n` +
    `  afc remove ${sample ? sample.index : '<编号>'}   取消管理\n` +
    `  afc fix --group ${sample ? sample.index : '<编号>'}   只处理该组\n`,
  );
  return EXIT_OK;
}

/** 端点地址本身（不带来源）。 */
function endpointAddress(endpoint: { kind: string; path?: string; host?: string; port?: number }): string {
  return endpoint.kind === 'tcp' ? `tcp:${endpoint.host}:${endpoint.port}` : `${endpoint.kind}:${endpoint.path}`;
}

/** 给人看的端点描述，带上它是怎么被发现的（排查问题时最关键的一列）。 */
function describeEndpoint(endpoint: { kind: string; path?: string; host?: string; port?: number; source: string }): string {
  return `${endpointAddress(endpoint)}（来源：${endpoint.source}）`;
}
