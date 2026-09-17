import { loadConfig, requireTarget, type AfcConfig, type TargetConfig } from '../config.ts';
import { discoverController, type DiscoveredController } from '../controller/discovery.ts';
import { optBoolean, optString, resolveTargets, type CommandContext } from './context.ts';

export interface Runtime {
  config: AfcConfig;
  controller: DiscoveredController;
}

/** 读取配置并发现控制端点。 */
export async function openRuntime(context: CommandContext): Promise<Runtime> {
  const config = loadConfig(optString(context.values, 'config'));
  const explicit = optString(context.values, 'controller');
  const secret = optString(context.values, 'secret');
  const controller = await discoverController({
    ...(explicit ? { explicit } : {}),
    ...(secret ? { secret } : {}),
    ...(config.probe.runtimeConfigPath ? { runtimeConfigPath: config.probe.runtimeConfigPath } : {}),
  });
  return { config, controller };
}

export function targetsFor(runtime: Runtime, context: CommandContext): TargetConfig[] {
  return resolveTargets(runtime.config, context.values, requireTarget);
}

export function isQuiet(context: CommandContext): boolean {
  return optBoolean(context.values, 'quiet');
}
