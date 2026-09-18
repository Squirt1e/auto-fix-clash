import { findGroupName, type AfcConfig, type TargetConfig } from '../config.ts';
import { isGroup, isRealNode, type MihomoClient, type ProxyInfo } from '../controller/client.ts';
import { ProbeEngine } from '../probe/engine.ts';
import type { NodeProbeResult } from '../probe/engine.ts';
import { findNodeDefinitions, type NodeDefinitionSource } from '../paths.ts';
import { UsageError } from '../errors.ts';
import { planRepair, type RepairPlan } from './plan.ts';

/** 目标组不是可切换的选择器类型：可以继续体检，但无法安全地切换成员。 */
export class GroupNotSwitchableError extends UsageError {
  constructor(group: string, type: string) {
    super(
      `代理组 “${group}” 的类型是 ${type}，不是可稳定指定的 Selector。\n` +
      '自动选择型组（URLTest / Fallback / LoadBalance）会被内核下次体检覆盖，' +
      '因此本工具只对 Selector 组执行切换。可在 Clash 中把该组改为手动选择组，' +
      '或改为配置一个 Selector 类型的目标组。',
    );
    this.name = 'GroupNotSwitchableError';
  }
}

/**
 * 当前订阅里找不到目标组。
 *
 * 多订阅场景下这是正常情况（不同订阅的组名不一样），因此单独成一类错误，
 * 让「修复全部组」可以跳过它而不是整体失败。
 */
export class TargetGroupMissingError extends UsageError {
  readonly targetName: string;
  readonly availableGroups: string[];

  constructor(target: TargetConfig, availableGroups: string[]) {
    const aliasHint = target.aliases.length > 0 ? `（已尝试的别名：${target.aliases.join('、')}）` : '';
    super(
      `当前订阅里没有代理组 “${target.name}”${aliasHint}。\n` +
      `当前订阅实际存在的组：${availableGroups.join(', ') || '（无）'}\n` +
      '如果只是另一个订阅里叫法不同，把那个名字写进该目标的 name 或 aliases 即可，例如：\n' +
      `  - name: ${target.name}\n` +
      '    aliases: [<上面列表里对应的那个名字>]\n' +
      '用 afc groups 可以查看当前订阅有哪些组、以及各组是否受 afc 管理。',
    );
    this.name = 'TargetGroupMissingError';
    this.targetName = target.name;
    this.availableGroups = availableGroups;
  }
}

export interface RepairOptions {
  config: AfcConfig;
  target: TargetConfig;
  client: MihomoClient;
  runtimeConfigPath?: string;
  dryRun?: boolean;
  onNotice?: (message: string) => void;
  /** 测试注入。 */
  engineFactory?: (options: {
    config: AfcConfig;
    proxies: unknown[];
    nodeNames: string[];
  }) => Promise<ProbeEngine>;
}

export interface RepairOutcome {
  group: string;
  plan: RepairPlan;
  applied: boolean;
  /** 本次实际探测的节点数；稳态应为 1。 */
  probedNodes: number;
  candidatesConsidered: number;
  currentProbe?: NodeProbeResult;
}

const defaultEngineFactory = (options: {
  config: AfcConfig;
  proxies: unknown[];
  nodeNames: string[];
}): Promise<ProbeEngine> => ProbeEngine.create(options);

/**
 * 取出「当前生效的」节点定义。
 * 会按与当前订阅组成员的重合度挑选文件，因此对 Clash Party / Clash Verge /
 * 独立 mihomo 都尽量通用，也能在节点由 proxy-providers 下发时给出明确指引。
 */
export function loadNodeDefinitions(
  options: { runtimeConfigPath?: string; neededNodeNames?: readonly string[] } = {},
): NodeDefinitionSource {
  return findNodeDefinitions(options);
}

/**
 * 对单个目标组执行粘性修复。
 *
 * 稳态成本：当前节点可用时只探测它一个节点，不遍历候选。
 */
export async function repairTarget(options: RepairOptions): Promise<RepairOutcome> {
  const { config, target, client } = options;
  const notice = options.onNotice ?? ((): void => {});
  const engineFactory = options.engineFactory ?? defaultEngineFactory;

  const allProxies = await client.proxies();
  // 按主名/别名解析出当前订阅里真实存在的那个组
  const availableGroups = Object.entries(allProxies)
    .filter(([, info]) => isGroup(info))
    .map(([name]) => name);
  const groupName = findGroupName(target, availableGroups);
  if (!groupName) throw new TargetGroupMissingError(target, availableGroups);
  const groupInfo: ProxyInfo = allProxies[groupName]!;

  const groupCandidates = (groupInfo.all ?? []).filter((name) => isRealNode(allProxies[name]));
  if (groupCandidates.length === 0) {
    throw new UsageError(`代理组 “${groupName}” 中没有可作为出口的真实节点（可能只包含其它代理组）。`);
  }

  const definitions = loadNodeDefinitions({
    ...(options.runtimeConfigPath ? { runtimeConfigPath: options.runtimeConfigPath } : {}),
    neededNodeNames: groupCandidates,
  });
  // 探针实例只能使用它自己配置里存在的节点定义；订阅若走 proxy-providers，
  // 运行时配置的 proxies 段可能是空的，此时给出明确指引而不是静默失败。
  const candidates = groupCandidates.filter((name) => definitions.nodeNames.includes(name));
  if (candidates.length === 0) {
    throw new Error(
      `代理组 “${groupName}” 的节点在运行时配置的 proxies 段中找不到定义，无法构造探针实例。\n` +
      '如果你的订阅使用 proxy-providers 下发节点，请改用在内核运行时配置中能直接看到节点定义的前端/配置。',
    );
  }
  if (candidates.length < groupCandidates.length) {
    notice(`有 ${groupCandidates.length - candidates.length} 个成员在运行时配置中没有节点定义，已跳过。`);
  }

  const currentNode = groupInfo.now;
  const currentNodeIsCandidate = currentNode !== undefined && candidates.includes(currentNode);

  const engine = await engineFactory({
    config,
    proxies: definitions.proxies,
    nodeNames: candidates,
  });

  try {
    let currentProbe: NodeProbeResult | undefined;
    if (currentNodeIsCandidate) {
      notice(`体检当前节点 ${currentNode} …`);
      currentProbe = await engine.probeOne(currentNode, target, 0);
    } else if (currentNode !== undefined) {
      notice(`当前选中成员 ${currentNode} 不是可探测的真实节点，将直接寻找可用候选。`);
    }

    if (currentProbe?.verdict === 'ok') {
      const plan = planRepair({ current: currentNode, currentResult: currentProbe });
      return {
        group: groupName,
        plan,
        applied: false,
        probedNodes: 1,
        candidatesConsidered: candidates.length,
        currentProbe,
      };
    }

    const remaining = candidates.filter((name) => name !== currentNode);
    notice(
      `当前节点不可用，按顺序筛查 ${remaining.length} 个候选节点` +
      `（并发上限 ${config.probe.concurrency}，筛查超时 ${config.probe.screenTimeoutMs}ms，找到可用即停止）…`,
    );
    const { result: chosen, screened, lastScreened } = remaining.length > 0
      ? await engine.findFirstUsable(remaining, target, config.probe.screenTimeoutMs)
      : { screened: 0, lastScreened: undefined };

    const candidateResults: NodeProbeResult[] = chosen ? [chosen] : [];
    const plan = planRepair({
      ...(currentNode === undefined ? {} : { current: currentNode }),
      ...(currentProbe ? { currentResult: currentProbe } : {}),
      candidateResults,
    });

    if (plan.action === 'no-candidate' && lastScreened) {
      notice(`最后一个候选的失败原因：${lastScreened.node} — ${lastScreened.reason}`);
    }

    if (plan.action === 'switch' && groupInfo.type !== 'Selector') {
      throw new GroupNotSwitchableError(groupName, groupInfo.type);
    }

    let applied = false;
    if (plan.action === 'switch' && plan.to && !options.dryRun) {
      await client.select(groupName, plan.to);
      applied = true;
    }

    return {
      group: groupName,
      plan,
      applied,
      probedNodes: 1 + screened,
      candidatesConsidered: candidates.length,
      ...(currentProbe ? { currentProbe } : {}),
    };
  } finally {
    await engine.close();
  }
}
