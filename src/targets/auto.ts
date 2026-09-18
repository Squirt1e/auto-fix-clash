import { findGroupName, type TargetConfig } from '../config.ts';
import { isGroup, isRealNode, type ProxyInfo } from '../controller/client.ts';
import { genericTarget, matchPreset, presetToTarget } from './presets.ts';

/** 一个待处理的组：目标配置 + 它的来源。 */
export interface AutoTarget {
  groupName: string;
  target: TargetConfig;
  source: 'configured' | 'preset' | 'generic';
  /** 给用户看的说明（为什么把它纳入/用什么判据）。 */
  note: string;
}

export interface SkippedGroup {
  groupName: string;
  reason: string;
}

export interface AutoExpansion {
  targets: AutoTarget[];
  skipped: SkippedGroup[];
}

/** 内置策略：组指向这些值时说明用户有意这样设置，绝不能替他改。 */
const BUILTIN_SELECTIONS = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);

/**
 * 自动决定"该管哪些组"。
 *
 * 只接管两类组：
 *   1. 配置里显式声明的组（判据来自配置）
 *   2. **当前手动钉了某个节点**的手动选择组 —— 这类组坏了内核不会替你换
 *
 * 明确不碰：
 *   - 指向 DIRECT / REJECT 的组（例如"广告拦截"指向 REJECT、"Bilibili"指向 DIRECT，改了会破坏你的设置）
 *   - 委托给其它组的组（如 Youtube → Proxy → 自动选择，内核自己会维护）
 *   - 自动测速类组（URLTest/Fallback，成员由内核维护）
 *
 * 纯函数，便于测试：调用方只需把控制端点看到的组列表传进来。
 */
export function expandAutoTargets(
  configuredTargets: TargetConfig[],
  proxies: Record<string, ProxyInfo>,
): AutoExpansion {
  const groupEntries = Object.entries(proxies).filter(([, info]) => isGroup(info));
  const groupNames = groupEntries.map(([name]) => name);

  const targets: AutoTarget[] = [];
  const skipped: SkippedGroup[] = [];
  const claimed = new Set<string>();

  // 1) 配置里显式声明的组优先
  for (const configured of configuredTargets) {
    const groupName = findGroupName(configured, groupNames);
    if (!groupName) {
      skipped.push({ groupName: configured.name, reason: '当前订阅里没有这个组' });
      continue;
    }
    claimed.add(groupName);
    targets.push({
      groupName,
      target: { ...configured, name: groupName },
      source: 'configured',
      note: '配置里声明的判据',
    });
  }

  // 2) 自动接管"手动钉了节点"的组
  for (const [groupName, info] of groupEntries) {
    if (claimed.has(groupName)) continue;

    if (info.type !== 'Selector') {
      skipped.push({ groupName, reason: '自动测速类，成员由内核维护' });
      continue;
    }

    const now = info.now;
    if (now === undefined) {
      skipped.push({ groupName, reason: '没有选中节点' });
      continue;
    }
    if (BUILTIN_SELECTIONS.has(now.toUpperCase())) {
      skipped.push({ groupName, reason: `当前指向 ${now}（尊重你的设置，不碰）` });
      continue;
    }
    if (!isRealNode(proxies[now])) {
      // 指向另一个代理组：内核的自动选择会维护它
      skipped.push({ groupName, reason: `委托给 ${now}（内核自己维护）` });
      continue;
    }

    const preset = matchPreset(groupName);
    if (preset && preset.confidence === 'high') {
      targets.push({
        groupName,
        target: presetToTarget(preset, groupName),
        source: 'preset',
        note: `内置预设：${preset.name}`,
      });
    } else {
      // 没有可信预设时用通用可达性判据：只在节点彻底不通时才换，
      // 因此不会把你特意选的地区节点换掉。
      targets.push({
        groupName,
        target: genericTarget(groupName),
        source: 'generic',
        note: '通用可达性判据（只在节点彻底不通时才换）',
      });
    }
  }

  return { targets, skipped };
}
