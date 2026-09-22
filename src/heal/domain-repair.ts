import type { AfcConfig, TargetConfig } from '../config.ts';
import type { MihomoClient } from '../controller/client.ts';
import { EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE, EXIT_OK } from '../exit-codes.ts';
import type { ProbePolicy } from '../probe/engine.ts';
import {
  resolveDomainRoutes,
  type ResolvedBinding,
  type RouteIssue,
} from '../routes/resolver.ts';
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
}

function patternsIntersect(a: DomainPattern, b: DomainPattern): boolean {
  if (a.apex === b.apex) return true;
  if (a.wildcard && b.apex.endsWith(`.${a.apex}`)) return true;
  return b.wildcard && a.apex.endsWith(`.${b.apex}`);
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
  if (target.probe) {
    return {
      label: `${target.pattern} 功能判据`,
      target: asTarget(target.pattern, target),
      confidence: 'service',
    };
  }

  const requested = parseDomainPattern(target.pattern);
  const chatgptPattern = parseDomainPattern(DEFAULT_DOMAIN_TARGETS[0]!.pattern);
  if (patternsIntersect(requested, chatgptPattern)) {
    const preset = DEFAULT_DOMAIN_TARGETS[0]!;
    return {
      label: `${target.pattern} ChatGPT 服务判据`,
      target: asTarget(target.pattern, preset),
      confidence: 'service',
    };
  }

  return {
    label: `${witness} HTTPS 可达性`,
    target: {
      name: target.pattern,
      aliases: [],
      probe: { url: `https://${witness}/`, expectedStatus: [200, 399], method: 'GET' },
      extraProbes: [],
      countryAllow: [],
      countryDeny: [],
    },
    confidence: 'reachability',
  };
}

export async function repairDomains(options: RepairDomainsOptions): Promise<DomainRepairReport> {
  const repairer = options.repairer ?? repairGroup;
  const [configs, rules, proxies] = await Promise.all([
    options.client.configs(),
    options.client.rules(),
    options.client.proxies(),
  ]);
  const patterns = options.targets.map((target) => parseDomainPattern(target.pattern));
  const resolution = resolveDomainRoutes(
    patterns,
    rules,
    proxies,
    typeof configs['mode'] === 'string' ? configs['mode'] : '',
  );
  const targetsByPattern = new Map(options.targets.map((target) => [
    parseDomainPattern(target.pattern).input,
    target,
  ]));
  const outcomes: RepairOutcome[] = [];
  const issues: DomainRepairIssue[] = resolution.issues.map((issue: RouteIssue) => ({ ...issue }));

  for (const binding of resolution.bindings) {
    const policies = binding.evidence.map((evidence) => {
      const target = targetsByPattern.get(evidence.pattern);
      if (!target) throw new Error(`内部错误：找不到域名目标 ${evidence.pattern}`);
      return policyForDomain(target, evidence.witness);
    });
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

  const exitCode = issues.length > 0
    ? EXIT_ENVIRONMENT
    : outcomes.some((outcome) => outcome.plan.action === 'no-candidate')
      ? EXIT_NO_USABLE_NODE
      : EXIT_OK;
  return { bindings: resolution.bindings, outcomes, issues, exitCode };
}
