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
import { enrichLiveRules, type RuntimeRuleMetadata } from './runtime-rules.ts';

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
  /** mihomo /rules 返回的零基索引。 */
  ruleIndex?: number;
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
  const compactType = rule.type.trim().replace(/[-_]/g, '').toUpperCase();
  const aliases: Record<string, string> = {
    DOMAINSUFFIX: 'DOMAIN-SUFFIX',
    DOMAINKEYWORD: 'DOMAIN-KEYWORD',
    DOMAINWILDCARD: 'DOMAIN-WILDCARD',
    DOMAINREGEX: 'DOMAIN-REGEX',
    IPCIDR: 'IP-CIDR',
    IPCIDR6: 'IP-CIDR6',
  };
  const type = aliases[compactType] ?? compactType;
  return {
    ...rule,
    type,
    payload: type === 'DOMAIN-REGEX'
      ? rule.payload.trim()
      : rule.payload.trim().toLowerCase().replace(/\.$/, ''),
  };
}

function suffixMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function wildcardRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function witnessesFor(pattern: DomainPattern, rules: MihomoRule[]): string[] {
  if (!pattern.wildcard) return [pattern.apex];
  const witnesses = new Set<string>([pattern.apex]);
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const rule of rules) {
    if (rule.extra?.disabled) continue;
    if (rule.type === 'DOMAIN') {
      try {
        const host = parseDomainPattern(rule.payload).apex;
        exact.add(host);
        if (domainPatternMatches(pattern, host)) witnesses.add(host);
      } catch {
        // 非法 payload 会在实际求值时按不透明规则处理；这里不拿它制造见证。
      }
      continue;
    }
    if (rule.type !== 'DOMAIN-SUFFIX') continue;
    let suffix: string;
    try {
      suffix = parseDomainPattern(rule.payload).apex;
    } catch {
      continue;
    }
    if (domainPatternMatches(pattern, suffix) || suffixMatches(pattern.apex, suffix)) suffixes.push(suffix);
  }

  const representative = (apex: string, excludedSuffixes: string[]): string => {
    for (let counter = 0; ; counter += 1) {
      const label = counter === 0 ? 'afc-route-probe' : `afc-route-probe-${counter}`;
      const candidate = `${label}.${apex}`;
      if (!exact.has(candidate) && !excludedSuffixes.some((suffix) => suffixMatches(candidate, suffix))) {
        return candidate;
      }
    }
  };

  for (const suffix of suffixes) {
    if (domainPatternMatches(pattern, suffix)) witnesses.add(suffix);
    const base = domainPatternMatches(pattern, suffix) ? suffix : pattern.apex;
    const narrower = suffixes.filter((other) => other !== suffix && other.endsWith(`.${base}`));
    witnesses.add(representative(base, narrower));
  }

  const coversWholePattern = suffixes.some((suffix) => suffixMatches(pattern.apex, suffix));
  if (!coversWholePattern) {
    const narrower = suffixes.filter((suffix) => suffix.endsWith(`.${pattern.apex}`));
    witnesses.add(representative(pattern.apex, narrower));
  }
  return [...witnesses];
}

type RuleEvaluation =
  | { rule: MihomoRule }
  | { issue: { kind: 'unresolved-rule' | 'no-match'; reason: string; ruleIndex?: number } };

type RuleDecision =
  | { kind: 'match' }
  | { kind: 'miss' }
  | { kind: 'unknown'; reason: string };

function evaluateRule(rule: MihomoRule, host: string, destinationResolved: boolean): RuleDecision {
  if (rule.type === 'DOMAIN') return { kind: host === rule.payload ? 'match' : 'miss' };
  if (rule.type === 'DOMAIN-SUFFIX') return { kind: suffixMatches(host, rule.payload) ? 'match' : 'miss' };
  if (rule.type === 'DOMAIN-KEYWORD') return { kind: host.includes(rule.payload) ? 'match' : 'miss' };
  if (rule.type === 'DOMAIN-WILDCARD') {
    try {
      return { kind: wildcardRegex(rule.payload).test(host) ? 'match' : 'miss' };
    } catch {
      return { kind: 'unknown', reason: '域名通配表达式无效' };
    }
  }
  if (rule.type === 'DOMAIN-REGEX') {
    try {
      return { kind: new RegExp(rule.payload).test(host) ? 'match' : 'miss' };
    } catch {
      return { kind: 'unknown', reason: '域名正则表达式无效' };
    }
  }
  if (rule.type === 'MATCH') return { kind: 'match' };
  if (rule.type === 'IP-CIDR' || rule.type === 'IP-CIDR6') {
    if (rule.noResolve === true && !destinationResolved) return { kind: 'miss' };
    if (rule.noResolve === undefined) {
      return { kind: 'unknown', reason: '运行时规则缺少 no-resolve 修饰符证据' };
    }
    return { kind: 'unknown', reason: '目标 IP 规则需要通过 mihomo DNS 判定' };
  }
  return { kind: 'unknown', reason: '无法仅凭域名可靠判定' };
}

function evaluateRules(host: string, rules: MihomoRule[]): RuleEvaluation {
  for (const rule of rules) {
    if (rule.extra?.disabled) continue;
    const decision = evaluateRule(rule, host, false);
    if (decision.kind === 'unknown') {
      return {
        issue: {
          kind: 'unresolved-rule',
          ruleIndex: rule.index,
          reason: `规则 #${rule.index + 1} ${rule.type} ${decision.reason}，后续路由不作猜测`,
        },
      };
    }
    if (decision.kind === 'match') return { rule };
  }
  return { issue: { kind: 'no-match', reason: `没有规则匹配 ${host}` } };
}

export interface RouteResolveOptions {
  runtimeRules?: readonly RuntimeRuleMetadata[];
  resolveAddresses?: (host: string) => Promise<readonly string[]>;
}

export async function resolveDomainRoutes(
  patterns: DomainPattern[],
  rawRules: MihomoRule[],
  proxies: Record<string, ProxyInfo>,
  mode: string,
  options: RouteResolveOptions = {},
): Promise<RouteResolution> {
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

  const rules = enrichLiveRules(rawRules, options.runtimeRules)
    .map(normalizedRule)
    .sort((a, b) => a.index - b.index);
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
