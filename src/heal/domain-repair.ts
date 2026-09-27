import type { AfcConfig, TargetConfig } from '../config.ts';
import type { MihomoClient } from '../controller/client.ts';
import { EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE, EXIT_OK } from '../exit-codes.ts';
import type { ProbePolicy } from '../probe/engine.ts';
import {
  resolveDomainRoutes,
  type ResolvedBinding,
  type RouteIssue,
} from '../routes/resolver.ts';
import type { RuntimeRuleMetadata } from '../routes/runtime-rules.ts';
import {
  DEFAULT_DOMAIN_TARGETS,
  parseDomainPattern,
  type DomainPattern,
  type DomainTargetConfig,
} from '../targets/domain.ts';
import {
  repairGroup,
  type GroupRepairOptions,
  type RepairOutcome,
} from './repair.ts';

export interface DomainRepairIssue {
  pattern?: string;
  witness?: string;
  group?: string;
  kind: string;
  reason: string;
  ruleIndex?: number;
}

export interface DomainRepairReport {
  bindings: ResolvedBinding[];
  outcomes: RepairOutcome[];
  issues: DomainRepairIssue[];
  exitCode: number;
}

export interface RepairDomainsOptions {
  config: AfcConfig;
  targets: DomainTargetConfig[];
  client: MihomoClient;
  force?: boolean;
  dryRun?: boolean;
  onNotice?: (message: string) => void;
  repairer?: (options: GroupRepairOptions) => Promise<RepairOutcome>;
  runtimeRules?: readonly RuntimeRuleMetadata[];
}

function asTarget(
  name: string,
  source: Pick<DomainTargetConfig, 'probe' | 'extraProbes' | 'geoProbe' | 'countryAllow' | 'countryDeny'>,
): TargetConfig {
  if (!source.probe) throw new Error(`域名目标 ${name} 没有探测端点`);
  return {
    name,
    aliases: [],
    probe: source.probe,
    extraProbes: source.extraProbes,
    ...(source.geoProbe ? { geoProbe: source.geoProbe } : {}),
    countryAllow: source.countryAllow,
    countryDeny: source.countryDeny,
  };
}

export function policyForDomain(target: DomainTargetConfig, witness: string): ProbePolicy {
  const requested = parseDomainPattern(target.pattern);
  const chatgptPattern = parseDomainPattern(DEFAULT_DOMAIN_TARGETS[0]!.pattern);
  const preset = requested.apex === chatgptPattern.apex || requested.apex.endsWith(`.${chatgptPattern.apex}`)
    ? DEFAULT_DOMAIN_TARGETS[0]
    : undefined;
  const source = target.probe ? target : preset;
  const geoProbe = target.overrides?.geoProbe || target.geoProbe ? target.geoProbe : source?.geoProbe;
  const countryAllow = target.overrides?.countryAllow || target.countryAllow.length > 0
    ? target.countryAllow
    : (source?.countryAllow ?? []);
  const countryDeny = target.overrides?.countryDeny || target.countryDeny.length > 0
    ? target.countryDeny
    : (source?.countryDeny ?? []);

  if (source?.probe) {
    return {
      label: `${target.pattern} 功能判据`,
      target: asTarget(target.pattern, {
        probe: source.probe,
        extraProbes: [],
        ...(geoProbe ? { geoProbe } : {}),
        countryAllow,
        countryDeny,
      }),
      confidence: 'service',
    };
  }

  return {
    label: `${requested.apex} HTTPS 可达性`,
    target: {
      name: target.pattern,
      aliases: [],
      probe: { url: `https://${requested.apex}/`, expectedStatus: [200, 399], method: 'GET' },
      extraProbes: [],
      ...(geoProbe ? { geoProbe } : {}),
      countryAllow,
      countryDeny,
    },
    confidence: 'reachability',
  };
}

function policiesForDomain(target: DomainTargetConfig, witness: string): ProbePolicy[] {
  const primary = policyForDomain(target, witness);
  const requested = parseDomainPattern(target.pattern);
  const chatgpt = parseDomainPattern(DEFAULT_DOMAIN_TARGETS[0]!.pattern);
  const preset = requested.apex === chatgpt.apex || requested.apex.endsWith(`.${chatgpt.apex}`)
    ? DEFAULT_DOMAIN_TARGETS[0]
    : undefined;
  const extras = target.overrides?.extraProbes || target.extraProbes.length > 0
    ? target.extraProbes
    : (preset?.extraProbes ?? []);
  return [primary, ...extras.map((probe, index) => ({
    label: `${target.pattern} 附加判据 ${index + 1}`,
    target: {
      name: target.pattern,
      aliases: [],
      probe,
      extraProbes: [],
      countryAllow: [],
      countryDeny: [],
    },
    confidence: primary.confidence,
  } satisfies ProbePolicy))];
}

export async function repairDomains(options: RepairDomainsOptions): Promise<DomainRepairReport> {
  const repairer = options.repairer ?? repairGroup;
  const [configs, rules, proxies] = await Promise.all([
    options.client.configs(),
    options.client.rules(),
    options.client.proxies(),
  ]);
  const patterns = options.targets.map((target) => parseDomainPattern(target.pattern));
  const resolution = await resolveDomainRoutes(
    patterns,
    rules,
    proxies,
    typeof configs['mode'] === 'string' ? configs['mode'] : '',
    {
      ...(options.runtimeRules ? { runtimeRules: options.runtimeRules } : {}),
      resolveAddresses: async (host) => await options.client.resolveHost(host),
    },
  );
  const targetsByPattern = new Map(options.targets.map((target) => [
    parseDomainPattern(target.pattern).input,
    target,
  ]));
  const outcomes: RepairOutcome[] = [];
  const issues: DomainRepairIssue[] = resolution.issues.map((issue: RouteIssue) => ({ ...issue }));

  for (const binding of resolution.bindings) {
    const policiesByKey = new Map<string, ProbePolicy>();
    for (const evidence of binding.evidence) {
      const target = targetsByPattern.get(evidence.pattern);
      if (!target) throw new Error(`内部错误：找不到域名目标 ${evidence.pattern}`);
      for (const policy of policiesForDomain(target, evidence.witness)) {
        const key = JSON.stringify({
          probe: policy.target.probe,
          extraProbes: policy.target.extraProbes,
          geoProbe: policy.target.geoProbe,
          countryAllow: policy.target.countryAllow,
          countryDeny: policy.target.countryDeny,
        });
        if (!policiesByKey.has(key)) policiesByKey.set(key, policy);
      }
    }
    const policies = [...policiesByKey.values()];
    try {
      outcomes.push(await repairer({
        config: options.config,
        groupName: binding.group,
        policies,
        client: options.client,
        knownProxies: proxies,
        ...(options.config.probe.runtimeConfigPath
          ? { runtimeConfigPath: options.config.probe.runtimeConfigPath }
          : {}),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.onNotice ? { onNotice: options.onNotice } : {}),
      }));
    } catch (err) {
      issues.push({
        group: binding.group,
        kind: 'repair-error',
        reason: (err as Error).message,
      });
    }
  }

  const exitCode = issues.length > 0 || outcomes.some((outcome) => outcome.plan.action === 'stale')
    ? EXIT_ENVIRONMENT
    : outcomes.some((outcome) => outcome.plan.action === 'no-candidate')
      ? EXIT_NO_USABLE_NODE
      : EXIT_OK;
  return { bindings: resolution.bindings, outcomes, issues, exitCode };
}
