import type { MihomoRule } from '../controller/client.ts';
import { readRuntimeConfig, runtimeConfigPathCandidates } from '../paths.ts';

export interface RuntimeRuleMetadata {
  index: number;
  type: string;
  payload: string;
  proxy: string;
  noResolve: boolean;
}

export interface RuntimeRulesSnapshot {
  path: string;
  rules: RuntimeRuleMetadata[];
}

const TRAILING_MODIFIERS = new Set(['no-resolve', 'src']);

function compactRuleType(type: string): string {
  const compact = type.trim().replace(/[-_]/g, '').toUpperCase();
  // mihomo 的 /rules 把 IPv4/IPv6 CIDR 统一回报为 IPCIDR。
  return compact === 'IPCIDR6' ? 'IPCIDR' : compact;
}

function normalizedPayload(payload: string): string {
  return payload.trim().toLowerCase().replace(/\.$/, '');
}

export function parseRuntimeRuleMetadata(entries: readonly unknown[]): RuntimeRuleMetadata[] {
  const parsed: RuntimeRuleMetadata[] = [];
  entries.forEach((entry, index) => {
    if (typeof entry !== 'string') return;
    const fields = entry.split(',').map((field) => field.trim());
    if (fields.length < 3) return;
    const modifiers = new Set<string>();
    while (fields.length > 3 && TRAILING_MODIFIERS.has(fields.at(-1)!.toLowerCase())) {
      modifiers.add(fields.pop()!.toLowerCase());
    }
    const type = fields.shift();
    const proxy = fields.pop();
    if (!type || !proxy || fields.length === 0) return;
    parsed.push({
      index,
      type: type.toUpperCase(),
      payload: fields.join(','),
      proxy,
      noResolve: modifiers.has('no-resolve'),
    });
  });
  return parsed;
}

export function loadRuntimeRuleMetadata(explicitPath?: string): RuntimeRulesSnapshot | undefined {
  for (const path of runtimeConfigPathCandidates(explicitPath)) {
    try {
      return { path, rules: parseRuntimeRuleMetadata(readRuntimeConfig(path).rules) };
    } catch {
      // 继续尝试下一个真实存在的运行时配置。
    }
  }
  return undefined;
}

export function enrichLiveRules(
  live: readonly MihomoRule[],
  metadata?: readonly RuntimeRuleMetadata[],
): MihomoRule[] {
  const byIndex = new Map(metadata?.map((rule) => [rule.index, rule]) ?? []);
  return live.map((rule) => {
    const candidate = byIndex.get(rule.index);
    if (!candidate
      || compactRuleType(candidate.type) !== compactRuleType(rule.type)
      || normalizedPayload(candidate.payload) !== normalizedPayload(rule.payload)
      || candidate.proxy !== rule.proxy) {
      return { ...rule };
    }
    return { ...rule, noResolve: candidate.noResolve };
  });
}
