import { readFileSync } from 'node:fs';
import { removeTargetFromConfigText, writeConfigText } from '../../config-edit.ts';
import { loadConfig, targetGroupNames } from '../../config.ts';
import { EXIT_OK, EXIT_USAGE } from '../../exit-codes.ts';
import { optString, type CommandContext } from '../context.ts';

const USAGE = `用法：afc remove <组名> [选项]

把某个组从配置里移除（之后它不再被 afc 处理；若它仍"手动钉着节点"，
会被自动模式按通用可达性判据接管）。

选项：
  --config <path>   指定配置文件
`;

export async function run(context: CommandContext): Promise<number> {
  const groupName = context.positionals[0];
  if (!groupName) {
    process.stderr.write(USAGE);
    return EXIT_USAGE;
  }

  const explicit = optString(context.values, 'config');
  let sourcePath: string | undefined;
  try {
    sourcePath = loadConfig(explicit).sourcePath;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return EXIT_USAGE;
  }
  if (!sourcePath) {
    process.stderr.write(
      `“${groupName}” 来自内置默认配置，不在任何配置文件里，无需移除。\n` +
      '如果它就是被自动模式接管的组，请在 Clash 里把它改成指向"自动选择"或 DIRECT 即可不再被处理。\n',
    );
    return EXIT_USAGE;
  }

  const text = readFileSync(sourcePath, 'utf8');
  const config = loadConfig(explicit);
  const target = config.targets.find((t) => targetGroupNames(t).includes(groupName));
  // 主名与别名都试一遍：用户可能记的是别名
  const names = target ? targetGroupNames(target) : [groupName];
  const next = removeTargetFromConfigText(text, names);
  if (next === undefined) {
    process.stderr.write(`${sourcePath} 里没有 “${groupName}” 这一条。\n`);
    return EXIT_USAGE;
  }

  writeConfigText(sourcePath, next);
  const remaining = loadConfig(sourcePath).targets.map((t) => t.name);
  process.stdout.write(
    `已从配置移除：${target?.name ?? groupName}\n` +
    `  文件：${sourcePath}\n` +
    `  剩余声明的目标：${remaining.join(', ') || '（无）'}\n` +
    (remaining.length === 0
      ? '  说明：配置里已无声明目标，afc 会改用自动模式（只按通用可达性判据处理你手动钉了节点的组）。\n'
      : ''),
  );
  return EXIT_OK;
}
