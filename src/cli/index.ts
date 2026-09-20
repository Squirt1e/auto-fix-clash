import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { EXIT_ENVIRONMENT, EXIT_NO_USABLE_NODE, EXIT_OK, EXIT_USAGE } from '../exit-codes.ts';
import { ConfigError } from '../config.ts';
import { COMMAND_HELP, TOP_HELP } from './help.ts';
import { UsageError } from '../errors.ts';
import { setVerbose } from '../verbosity.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

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
let logTeeInstalled = false;

/**
 * `--log-file <path>`：把本进程的 stdout/stderr 同时追加到文件。
 *
 * 为什么需要它：Windows 的任务计划程序不像 launchd/systemd 那样能重定向输出，
 * 把日志交给 afc 自己写，三个平台的日志行为才一致。
 */
function installLogTee(logFile: string): void {
  if (logTeeInstalled) return;
  logTeeInstalled = true;
  mkdirSync(dirname(logFile), { recursive: true });
  for (const stream of [process.stdout, process.stderr] as const) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      try {
        appendFileSync(logFile, typeof chunk === 'string' ? chunk : Buffer.from(chunk));
      } catch {
        // 日志写不进去不能影响主流程
      }
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
  }
}

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
        backend: { type: 'string' },
        'log-file': { type: 'string' },
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
    process.stderr.write(`参数错误：${(err as Error).message}\n\n${TOP_HELP}`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  // 报错文案的详略由它决定：默认只给下一步，--verbose 才铺开候选清单与平台细节
  setVerbose(values.verbose === true);

  // 计划任务在 Windows 上没有输出重定向，靠它把日志落盘
  const logFile = typeof values['log-file'] === 'string' ? values['log-file'] : undefined;
  if (logFile) installLogTee(logFile);

  if (values.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return EXIT_OK;
  }
  if (values.help || command === undefined || command === 'help') {
    // `afc <命令> --help` 打印该命令的用法；否则打印顶层帮助
    const commandHelp = command !== undefined && command !== 'help' ? COMMAND_HELP[command] : undefined;
    process.stdout.write(commandHelp ?? TOP_HELP);
    return EXIT_OK;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    const hint = command === 'version' ? '（版本号请用：afc --version 或 afc -v）\n' : '';
    process.stderr.write(`未知命令：${command}\n${hint}\n${TOP_HELP}`);
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
