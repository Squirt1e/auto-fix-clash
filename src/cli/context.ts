import type { AfcConfig, TargetConfig } from '../config.ts';

export interface CommandContext {
  positionals: string[];
  values: Record<string, unknown>;
}

export function optString(values: Record<string, unknown>, key: string): string | undefined {
  const v = values[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function optBoolean(values: Record<string, unknown>, key: string): boolean {
  return values[key] === true;
}

export function optNumber(values: Record<string, unknown>, key: string): number | undefined {
  const v = values[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** 解析要处理的目标组：--all → 全部；--group <name> → 指定；都不给 → 第一个已配置组。 */
export function resolveTargets(
  config: AfcConfig,
  values: Record<string, unknown>,
  requireTarget: (config: AfcConfig, name: string) => TargetConfig,
): TargetConfig[] {
  if (optBoolean(values, 'all')) return config.targets;
  const group = optString(values, 'group');
  if (group) return [requireTarget(config, group)];
  const first = config.targets[0];
  if (!first) throw new Error('配置中没有可用的目标组。');
  return [first];
}
