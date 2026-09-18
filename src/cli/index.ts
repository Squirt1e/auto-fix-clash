import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT_ENVIRONMENT, EXIT_OK, EXIT_USAGE } from '../exit-codes.ts';
import { ConfigError } from '../config.ts';
import { UsageError } from '../errors.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `afc — 为 Clash/mihomo 代理组挑选真正可用的节点

用法：afc <命令> [选项]

命令：
  groups           列出当前订阅实际存在的代理组（确定 --group 该写什么）
  doctor           体检：逐个探测目标组的候选节点，输出判定与依据（不改动当前选择）
  fix              修复：按「仅当前节点不可用才切换」策略为指定组或全部组切换节点
  schedule         周期性修复任务：install / uninstall / status
  help             显示本帮助
  version          显示版本

通用选项：
  --config <path>     指定配置文件（默认 ./afc.config.yaml 或 ~/.config/afc/config.yaml）
  --group <name>      指定目标组（doctor / fix），默认使用配置里的第一个组
  --all               对全部已配置组执行（fix）
  --json              以机器可读格式输出（doctor）
  --quiet             精简输出（供计划任务使用）
  --dry-run           只展示将要执行的改动，不写入
  --controller <ep>   显式指定控制端点：unix:/path/to.sock 或 127.0.0.1:9090
  --secret <s>        控制端点认证密钥
  -h, --help          显示帮助

示例：
  afc groups                     # 当前订阅有哪些组？--group 该写什么？
  afc doctor                     # 体检 GPT 组并打印可用性表格
  afc doctor --json              # 机器可读输出，便于脚本消费
  afc fix --group GPT            # 仅在当前节点不可用时才换到可用节点
  afc fix --all                  # 修复全部已配置组
  afc schedule install           # 安装周期性修复（默认每 300 秒）
  afc schedule status            # 查看任务是否已载入与最近运行情况
  afc schedule uninstall         # 完全移除任务

说明：本工具只通过 mihomo 控制端点切换代理组的选中节点，不会修改任何 Clash 配置文件。

退出码：
  0  成功（找到或保持可用节点）
  ${EXIT_USAGE} 用法错误
  ${EXIT_ENVIRONMENT} 环境故障（控制端点不可达、内核缺失等）
  2  未找到可用节点
`;

interface CommandContext {
  positionals: string[];
  values: Record<string, unknown>;
}

type CommandHandler = (ctx: CommandContext) => Promise<number>;

// 用非字面量的说明符做惰性导入：命令模块尚未实现时，运行时给出清晰提示而不是崩溃。
const loadCommand = (name: string): Promise<{ run: CommandHandler }> =>
  import(`./commands/${name}.ts`) as Promise<{ run: CommandHandler }>;

const COMMANDS: Record<string, { summary: string; run: () => Promise<CommandHandler> }> = {
  doctor: { summary: '体检目标组的候选节点', run: async () => (await loadCommand('doctor')).run },
  fix: { summary: '按粘性策略修复代理组', run: async () => (await loadCommand('fix')).run },
  groups: { summary: '列出当前订阅的代理组（用于确定 --group 该写什么）', run: async () => (await loadCommand('groups')).run },
  schedule: { summary: '管理周期性修复任务', run: async () => (await loadCommand('schedule')).run },
};

function isNotImplemented(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null &&
    'code' in err && (err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
  );
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string' },
        json: { type: 'boolean', default: false },
        group: { type: 'string' },
        all: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        controller: { type: 'string' },
        secret: { type: 'string' },
        interval: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`参数错误：${(err as Error).message}\n\n${HELP}`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.help || command === undefined || command === 'help') {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  if (command === 'version') {
    process.stdout.write(`${packageVersion()}\n`);
    return EXIT_OK;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    process.stderr.write(`未知命令：${command}\n\n${HELP}`);
    return EXIT_USAGE;
  }

  try {
    const run = await entry.run();
    return await run({ positionals: positionals.slice(1), values: values as Record<string, unknown> });
  } catch (err) {
    if (isNotImplemented(err)) {
      process.stderr.write(`命令 “${command}”（${entry.summary}）尚未实现。\n`);
      return EXIT_ENVIRONMENT;
    }
    if (err instanceof ConfigError || err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_USAGE;
    }
    process.stderr.write(`${(err as Error).message}\n`);
    return EXIT_ENVIRONMENT;
  }
}

/**
 * 是否为「直接执行本文件」（例如 `node src/cli/index.ts doctor`）。
 * 用 realpath 比较而不是文件名后缀：后者在符号链接、相对路径下会判错。
 */
function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
