import {
  BUILTIN_TYPES,
  GROUP_TYPES,
  isRealNode,
  type MihomoRule,
  type ProxyInfo,
} from '../controller/client.ts';
import {
  domainPatternMatches,
  parseDomainPattern,
  type DomainPattern,
} from '../targets/domain.ts';

export type RouteIssueKind =
  | 'unsupported-mode'
  | 'unresolved-rule'
  | 'no-match'
  | 'policy-skipped'
  | 'policy-missing'
  | 'group-cycle';

export interface RouteIssue {
  pattern: string;
  witness?: string;
  kind: RouteIssueKind;
  reason: string;
}

export interface RouteEvidence {
  pattern: string;
  witness: string;
  rule: MihomoRule;
  policy: string;
  chain: string[];
}

export interface ResolvedBinding {
  pattern: string;
  witness: string;
  rule: MihomoRule;
  policy: string;
  group: string;
  evidence: RouteEvidence[];
}

export interface RouteResolution {
  bindings: ResolvedBinding[];
  issues: RouteIssue[];
}

export interface PolicyResolution {
  group?: string;
  chain: string[];
  issue?: { kind: 'policy-skipped' | 'policy-missing' | 'group-cycle'; reason: string };
}

const BUILTIN_NAMES = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE']);

export function resolvePolicy(policy: string, proxies: Record<string, ProxyInfo>): PolicyResolution {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current = policy;
  let deepestSelector: string | undefined;

  while (true) {
    if (visited.has(current)) {
      return { chain: [...chain, current], issue: { kind: 'group-cycle', reason: `代理组委托形成循环：${[...chain, current].join(' → ')}` } };
    }
    visited.add(current);
    chain.push(current);

    if (BUILTIN_NAMES.has(current.toUpperCase())) {
      return { chain, issue: { kind: 'policy-skipped', reason: `路由指向 ${current}，没有可切换节点` } };
    }

    const info = proxies[current];
    if (!info) {
      return { chain, issue: { kind: 'policy-missing', reason: `控制器中找不到策略 “${current}”` } };
    }
    if (info.type === 'Selector') {
      deepestSelector = current;
      if (!info.now) {
        return { chain, issue: { kind: 'policy-missing', reason: `Selector “${current}” 没有当前选中成员` } };
      }
      current = info.now;
      continue;
    }
    if (GROUP_TYPES.has(info.type)) {
      return { chain, issue: { kind: 'policy-skipped', reason: `路由最终委托给自动组 ${current}（${info.type}），不应手动钉住` } };
    }
    if (BUILTIN_TYPES.has(info.type)) {
      return { chain, issue: { kind: 'policy-skipped', reason: `路由最终指向内置策略 ${current}` } };
    }
    if (isRealNode(info) && deepestSelector) return { group: deepestSelector, chain };
    return { chain, issue: { kind: 'policy-missing', reason: `策略链 ${chain.join(' → ')} 没有可修复的 Selector` } };
  }
}

function normalizedRule(rule: MihomoRule): MihomoRule {
  return {
    ...rule,
    type: rule.type.trim().toUpperCase(),
    payload: rule.payload.trim().toLowerCase().replace(/\.$/, ''),
  };
}

function suffixMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function ruleMatches(rule: MihomoRule, host: string): boolean {
  if (rule.type === 'DOMAIN') return host === rule.payload;
  if (rule.type === 'DOMAIN-SUFFIX') return suffixMatches(host, rule.payload);
  return rule.type === 'MATCH';
}

function witnessesFor(pattern: DomainPattern, rules: MihomoRule[]): string[] {
  if (!pattern.wildcard) return [pattern.apex];
  const witnesses = new Set<string>([pattern.apex]);
  for (const rule of rules) {
    if (rule.extra?.disabled) continue;
    if (rule.type === 'DOMAIN') {
      if (domainPatternMatches(pattern, rule.payload)) witnesses.add(parseDomainPattern(rule.payload).apex);
      continue;
    }
    if (rule.type !== 'DOMAIN-SUFFIX') continue;
    let suffix: string;
    try {
      suffix = parseDomainPattern(rule.payload).apex;
    } catch {
      continue;
    }
    if (domainPatternMatches(pattern, suffix)) witnesses.add(suffix);
    else if (suffixMatches(pattern.apex, suffix)) witnesses.add(pattern.apex);
  }

  const exact = new Set(rules.filter((rule) => rule.type === 'DOMAIN').map((rule) => rule.payload));
  let counter = 0;
  let remainder = `afc-route-probe.${pattern.apex}`;
  while (exact.has(remainder)) {
    counter += 1;
    remainder = `afc-route-probe-${counter}.${pattern.apex}`;
  }
  witnesses.add(remainder);
  return [...witnesses];
}

type RuleEvaluation =
  | { rule: MihomoRule }
  | { issue: { kind: 'unresolved-rule' | 'no-match'; reason: string } };

function evaluateRules(host: string, rules: MihomoRule[]): RuleEvaluation {
  for (const rule of rules) {
    if (rule.extra?.disabled) continue;
    if (rule.type !== 'DOMAIN' && rule.type !== 'DOMAIN-SUFFIX' && rule.type !== 'MATCH') {
      return {
        issue: {
          kind: 'unresolved-rule',
          reason: `规则 #${rule.index} ${rule.type} 无法仅凭域名可靠判定，后续路由不作猜测`,
        },
      };
    }
    if (ruleMatches(rule, host)) return { rule };
  }
  return { issue: { kind: 'no-match', reason: `没有规则匹配 ${host}` } };
}

export function resolveDomainRoutes(
  patterns: DomainPattern[],
  rawRules: MihomoRule[],
  proxies: Record<string, ProxyInfo>,
  mode: string,
): RouteResolution {
  const bindingsByGroup = new Map<string, ResolvedBinding>();
  const issues: RouteIssue[] = [];
  const normalizedMode = mode.trim().toLowerCase();
  if (normalizedMode !== 'rule') {
    return {
      bindings: [],
      issues: patterns.map((pattern) => ({
        pattern: pattern.input,
        kind: 'unsupported-mode',
        reason: `当前 mihomo 模式是 ${mode || '未知'}，只有 rule 模式能按域名确认路由`,
      })),
    };
  }

  const rules = rawRules.map(normalizedRule).sort((a, b) => a.index - b.index);
  for (const pattern of patterns) {
    for (const witness of witnessesFor(pattern, rules)) {
      const evaluation = evaluateRules(witness, rules);
      if ('issue' in evaluation) {
        issues.push({ pattern: pattern.input, witness, ...evaluation.issue });
        continue;
      }
      const policy = resolvePolicy(evaluation.rule.proxy, proxies);
      if (!policy.group) {
        issues.push({
          pattern: pattern.input,
          witness,
          kind: policy.issue?.kind ?? 'policy-missing',
          reason: policy.issue?.reason ?? `策略 ${evaluation.rule.proxy} 无法解析`,
        });
        continue;
      }
      const evidence: RouteEvidence = {
        pattern: pattern.input,
        witness,
        rule: evaluation.rule,
        policy: evaluation.rule.proxy,
        chain: policy.chain,
      };
      const existing = bindingsByGroup.get(policy.group);
      if (existing) {
        if (!existing.evidence.some((item) =>
          item.pattern === evidence.pattern && item.witness === evidence.witness && item.rule.index === evidence.rule.index)) {
          existing.evidence.push(evidence);
        }
      } else {
        bindingsByGroup.set(policy.group, {
          pattern: pattern.input,
          witness,
          rule: evaluation.rule,
          policy: evaluation.rule.proxy,
          group: policy.group,
          evidence: [evidence],
        });
      }
    }
  }

  return { bindings: [...bindingsByGroup.values()], issues };
}
