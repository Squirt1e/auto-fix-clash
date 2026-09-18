import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE, EXIT_OK, EXIT_USAGE } from '../exit-codes.ts';
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

const EXIT_CODE_HELP = ([
  [EXIT_OK, '成功（找到或保持可用节点）'],
  [EXIT_NO_USABLE_NODE, '未找到可用节点'],
  [EXIT_ENVIRONMENT, '环境故障（控制端点不可达、内核缺失等）'],
  [EXIT_USAGE, '用法错误（命令或选项写错、组名未配置等）'],
] as const)
  .map(([code, description]) => `  ${String(code).padEnd(2)} ${description}`)
  .join('\n');

const HELP = `afc — 为 Clash/mihomo 代理组挑选真正可用的节点

用法：afc <命令> [选项]

命令：
  add              把一个组加入配置，指定它的判据（afc add <组名>）
  remove           把某个组从配置里移除
  groups           列出当前订阅实际存在的代理组
  doctor           体检：探测候选节点并给出判定（不改动当前选择）
  fix              修复：只把不可用的节点换掉（可用时什么都不做）
  schedule         定时自动修复：install / uninstall / status

最省事的用法（想让它自己一直好着，就这两条）：
  afc schedule install     # 每 5 分钟自动体检 + 需要时才换节点，装完不用管
  afc schedule status      # 看它是否在跑、最近一次做了什么

通用选项：
  --config <path>     指定配置文件（默认 ./afc.config.yaml 或 ~/.config/afc/config.yaml）
  --group <name>      只处理指定组（doctor / fix）
  --all               处理全部"该管的组"（等同默认行为）
  --no-auto           只处理配置文件里声明过的组，不自动接管其它组
  --json              以机器可读格式输出
  --quiet             精简输出：每次运行只留一行（计划任务用）
  --verbose           额外打印诊断信息（控制器来源、配置路径等）
  --dry-run           只展示将要执行的改动，不写入
  --controller <ep>   显式指定控制端点：unix:/path/to.sock 或 127.0.0.1:9090
  --secret <s>        控制端点认证密钥
  -h, --help          显示帮助
  -v, --version       显示版本

示例：
  afc groups                     # 当前订阅有哪些组、哪些会被处理
  afc add Netflix                # 把 Netflix 组加入管理（用内置预设判据）
  afc add 我的组 --url https://example.com/ --expect 200   # 自定义判据
  afc doctor                     # 体检 GPT 组并打印可用性表格
  afc doctor --json              # 机器可读输出，便于脚本消费
  afc fix --group GPT            # 仅在当前节点不可用时才换到可用节点
  afc schedule install           # 安装周期性修复（默认每 300 秒）

默认处理范围（"该管的组"）：配置里声明过的组，以及你在 Clash 里**手动钉了某个节点**的组。
不会被改动：指向 DIRECT/REJECT 的组、委托给"自动选择"的组、自动测速类组（这些由内核自己维护）。

说明：本工具只通过 mihomo 控制端点切换代理组的选中节点，不会修改任何 Clash 配置文件。

退出码：
${EXIT_CODE_HELP}
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
  add: { summary: '把一个组加入配置', run: async () => (await loadCommand('add')).run },
  remove: { summary: '把某个组从配置里移除', run: async () => (await loadCommand('remove')).run },
  groups: { summary: '列出当前订阅的代理组（用于确定 --group 该写什么）', run: async () => (await loadCommand('groups')).run },
  schedule: { summary: '管理周期性修复任务', run: async () => (await loadCommand('schedule')).run },
};

function isNotImplemented(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null &&
    'code' in err && (err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND'
  );
}

let pipeGuardInstalled = false;

/**
 * 输出被下游提前关闭时（例如 `afc groups | head`）不要抛栈：静默结束即可。
 * 只安装一次 —— 每次 main() 都挂监听会在测试里堆积并触发 MaxListeners 警告。
 */
function installPipeGuard(): void {
  if (pipeGuardInstalled) return;
  pipeGuardInstalled = true;
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') process.exit(EXIT_OK);
    });
  }
}

export async function main(argv: string[]): Promise<number> {
  installPipeGuard();

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
        'no-auto': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        controller: { type: 'string' },
        secret: { type: 'string' },
        interval: { type: 'string' },
        url: { type: 'string' },
        expect: { type: 'string' },
        'country-deny': { type: 'string' },
        force: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (err) {
    process.stderr.write(`参数错误：${(err as Error).message}\n\n${HELP}`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return EXIT_OK;
  }
  if (values.help || command === undefined || command === 'help') {
    process.stdout.write(HELP);
    return EXIT_OK;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    const hint = command === 'version' ? '（版本号请用：afc --version 或 afc -v）\n' : '';
    process.stderr.write(`未知命令：${command}\n${hint}\n${HELP}`);
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
