import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { afcConfigPath, currentPlatform } from '../../platform.ts';
import { addTargetToConfigText, writeConfigText } from '../../config-edit.ts';
import { findGroupName, loadConfig, resolveConfigPath, type TargetConfig } from '../../config.ts';
import { isGroup } from '../../controller/client.ts';
import { UsageError } from '../../errors.ts';
import { EXIT_OK } from '../../exit-codes.ts';
import { genericTarget, matchPreset, presetToTarget } from '../../targets/presets.ts';
import { ADD_HELP } from '../help.ts';
import { resolveGroupArg } from '../groups-index.ts';
import { openRuntime } from '../runtime.ts';
import { optBoolean, optString, type CommandContext } from '../context.ts';

/** 解析 --expect：支持 200、200,301,302、200-299。 */
export function parseExpectedStatus(value: string): number[] {
  const parts = value.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) throw new UsageError('--expect 不能为空');

  const range = parts.length === 1 ? /^(\d{3})\s*-\s*(\d{3})$/.exec(parts[0]!) : null;
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (from >= to) throw new UsageError(`--expect 的区间必须升序：${parts[0]}`);
    return [from, to];
  }
  const codes = parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 100 || n > 599) {
      throw new UsageError(`--expect 只接受 100–599 的整数或升序区间，收到：${p}`);
    }
    return n;
  });
  return codes;
}

/**
 * 决定写到哪个配置文件：显式指定 > 已有的那份 > 固定的用户级位置。
 *
 * 关键：没有现成配置时**不要**按当前目录新建 —— 否则在不同目录运行会各生成一份，
 * 计划任务指向哪一份就变得不可预期（实测踩过：在 home 目录跑一次就多出一份配置，
 * 定时任务从此读的是那一份）。
 */
export function resolveWritePath(explicit?: string): string {
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(explicit);
  const existing = resolveConfigPath();
  if (existing) return existing;
  return afcConfigPath(currentPlatform());
}

export async function run(context: CommandContext): Promise<number> {
  const rawArg = context.positionals[0];
  if (!rawArg) {
    process.stderr.write(ADD_HELP);
    return 64;
  }
  // 支持 `afc add 3`：编号取自最近一次 afc groups（组名带 emoji 时省事且不易打错）
  const groupName = resolveGroupArg(rawArg);

  // --config 指向的文件可能还不存在（本命令负责创建它），那种情况下不能让 loadConfig
  // 去读它（它会报"指定的配置文件不存在"）。但文件存在时就要读 —— 里面可能有 controller
  // 段（外部控制端点/密钥/端口），忽略它会让 "afc add <编号> --config <那份配置>" 连不上。
  const rawConfigArg = optString(context.values, 'config');
  const configExists = rawConfigArg !== undefined
    && existsSync(isAbsolute(rawConfigArg) ? rawConfigArg : resolve(rawConfigArg));
  const runtime = await openRuntime({
    positionals: context.positionals,
    values: { ...context.values, config: configExists ? rawConfigArg : undefined },
  });
  const client = runtime.controller.client;
  const allProxies = await client.proxies();
  const groupNames = Object.entries(allProxies)
    .filter(([, info]) => isGroup(info))
    .map(([name]) => name);

  if (!groupNames.includes(groupName)) {
    process.stderr.write(
      `当前订阅里没有代理组 “${groupName}”。\n` +
      `现有的组：${groupNames.join(', ') || '（无）'}\n` +
      '用 afc groups 可以看到全部组及各自状态。\n',
    );
    return 64;
  }
  if (allProxies[groupName]!.type !== 'Selector') {
    process.stderr.write(
      `“${groupName}” 是 ${allProxies[groupName]!.type} 类型，不是手动选择组。\n` +
      'afc 只能切换手动选择组 —— 自动测速类组的成员由内核自己维护，指定了也会被覆盖。\n',
    );
    return 64;
  }

  const url = optString(context.values, 'url');
  const expectText = optString(context.values, 'expect');
  const denyText = optString(context.values, 'country-deny');

  let target: TargetConfig;
  let judgeNote: string;
  let caveat: string | undefined;

  if (url || expectText) {
    if (!url || !expectText) {
      throw new UsageError('--url 与 --expect 必须同时提供（或用内置预设，二者都不给）。');
    }
    target = {
      name: groupName,
      aliases: [],
      probe: { url, expectedStatus: parseExpectedStatus(expectText) },
      extraProbes: [],
      countryAllow: [],
      countryDeny: denyText
        ? denyText.split(',').map((c) => c.trim().toUpperCase()).filter((c) => c !== '')
        : [],
    };
    judgeNote = `自定义判据：${url} 期望 ${target.probe.expectedStatus.join('/')}`;
  } else {
    const preset = matchPreset(groupName);
    if (preset) {
      target = presetToTarget(preset, groupName);
      judgeNote = `内置预设（${preset.name}）：${target.probe.url} 期望 ${target.probe.expectedStatus.join('/')}`;
      if (preset.confidence === 'low' && preset.note) caveat = preset.note;
    } else {
      target = genericTarget(groupName);
      judgeNote = `通用可达性判据：${target.probe.url} 期望 ${target.probe.expectedStatus.join('/')}`;
      caveat = '该判据只判断节点是否彻底不通，不会因为出口地区而换节点；若该站点有地区/解锁要求，建议用 --url/--expect 指定更准的判据';
    }
  }

  const path = resolveWritePath(optString(context.values, 'config'));
  const fileExists = existsSync(path);
  const existingText = fileExists ? readFileSync(path, 'utf8') : '';
  // 目标文件存在时以它为准做重复检查；不存在则用内置默认（含 GPT 预设）判断
  const baseTargets = fileExists ? loadConfig(path).targets : runtime.config.targets;

  const alreadyConfigured = baseTargets.some((t) => findGroupName(t, [groupName]) !== undefined);
  if (alreadyConfigured && !optBoolean(context.values, 'force')) {
    process.stderr.write(
      `“${groupName}” 已经在配置里了（${fileExists ? path : '内置默认'}）。\n` +
      '要改判据就加上 --force，或直接编辑配置文件。\n',
    );
    return 64;
  }

  const next = addTargetToConfigText(existingText, target);
  const result = writeConfigText(path, next);

  process.stdout.write(
    `${result.created ? '已创建并写入' : '已写入'}：${result.path}\n` +
    `  组名：${groupName}\n` +
    `  判据：${judgeNote}\n` +
    (caveat ? `  注意：${caveat}\n` : '') +
    `\n验证：afc doctor --group ${groupName}\n` +
    '计划任务会自动使用这份配置（若它指向别的配置文件，重跑一次 afc schedule install）。\n' +
    '现有配置里的其它内容与注释均未改动。\n',
  );
  return EXIT_OK;
}
