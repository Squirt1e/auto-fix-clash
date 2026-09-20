import { findGroupName, loadConfig, requireTarget, type AfcConfig, type TargetConfig } from '../config.ts';
import { isGroup, type MihomoClient, type ProxyInfo } from '../controller/client.ts';
import {
  ControllerDiscoveryError,
  describeDiscovery,
  discoverController,
  renderDiscoveryReport,
  type DiscoverOptions,
  type DiscoveredController,
} from '../controller/discovery.ts';
import { expandAutoTargets } from '../targets/auto.ts';
import { optBoolean, optString, resolveTargets, type CommandContext } from './context.ts';

export interface Runtime {
  config: AfcConfig;
  controller: DiscoveredController;
}

/**
 * 把配置文件和命令行里的控制端点设置合成发现参数。
 *
 * 优先级：命令行 > 配置文件。配置文件这一层是必需的 —— 定时任务执行的是
 * `afc fix --all --quiet --config <path>`，不带任何端点参数，用户改过控制端口时
 * 只能靠 afc.config.yaml 里的 controller 段告诉它。
 */
export function resolveControllerOptions(
  config: AfcConfig,
  values: Record<string, unknown>,
): DiscoverOptions {
  const endpoint = optString(values, 'controller') ?? config.controller.endpoint;
  const secret = optString(values, 'secret') ?? config.controller.secret;
  return {
    ...(endpoint ? { explicit: endpoint } : {}),
    ...(secret ? { secret } : {}),
    ...(config.controller.ports.length > 0 ? { configuredPorts: config.controller.ports } : {}),
    ...(config.probe.runtimeConfigPath ? { runtimeConfigPath: config.probe.runtimeConfigPath } : {}),
  };
}

/** 读取配置并发现控制端点。 */
export async function openRuntime(context: CommandContext): Promise<Runtime> {
  const config = loadConfig(optString(context.values, 'config'));
  const options = resolveControllerOptions(config, context.values);
  try {
    const controller = await discoverController(options);
    return { config, controller };
  } catch (err) {
    // 发现失败时 --verbose 必须也能给东西看：把「afc 找了哪些地方」打出来。
    // （成功路径的诊断在各自的命令里打印。）
    if (err instanceof ControllerDiscoveryError && optBoolean(context.values, 'verbose')) {
      process.stderr.write(renderDiscoveryReport(describeDiscovery(options)) + '\n');
    }
    throw err;
  }
}

export function targetsFor(runtime: Runtime, context: CommandContext): TargetConfig[] {
  return resolveTargets(runtime.config, context.values, requireTarget);
}

export function isQuiet(context: CommandContext): boolean {
  return optBoolean(context.values, 'quiet');
}

export interface TargetPlan {
  groupName: string;
  target: TargetConfig;
  /** configured / preset / generic */
  source: string;
  note: string;
}

export interface PlannedTargets {
  plans: TargetPlan[];
  /** 未被纳入的组及原因（--verbose 时展示，避免默认输出刷屏）。 */
  skipped: { groupName: string; reason: string }[];
}

/**
 * 决定这次要处理哪些组。
 *
 * - `--group X`：只处理 X（必须在配置里声明过）
 * - 默认 / `--all`：自动模式 —— 配置里声明的组 + 当前手动钉了节点的手动选择组
 * - `--no-auto`：只处理配置里声明的组
 */
export async function planTargets(
  runtime: Runtime,
  context: CommandContext,
  client: MihomoClient,
  /** 已获取的 /proxies 结果，避免重复请求。 */
  knownProxies?: Record<string, ProxyInfo>,
): Promise<PlannedTargets> {
  const group = optString(context.values, 'group');
  const config = runtime.config;

  if (group) {
    const target = requireTarget(config, group);
    return {
      plans: [{ groupName: target.name, target, source: 'configured', note: '配置里声明的判据' }],
      skipped: [],
    };
  }

  const proxies = knownProxies ?? await client.proxies();
  const groupNames = Object.entries(proxies)
    .filter(([, info]) => isGroup(info))
    .map(([name]) => name);

  if (optBoolean(context.values, 'no-auto')) {
    const plans: TargetPlan[] = [];
    const skipped: { groupName: string; reason: string }[] = [];
    for (const target of config.targets) {
      const groupName = findGroupName(target, groupNames);
      if (!groupName) {
        skipped.push({ groupName: target.name, reason: '当前订阅里没有这个组' });
        continue;
      }
      plans.push({ groupName, target: { ...target, name: groupName }, source: 'configured', note: '配置里声明的判据' });
    }
    return { plans, skipped };
  }

  const expansion = expandAutoTargets(config.targets, proxies);
  return {
    plans: expansion.targets.map((t) => ({
      groupName: t.groupName,
      target: t.target,
      source: t.source,
      note: t.note,
    })),
    skipped: expansion.skipped,
  };
}
