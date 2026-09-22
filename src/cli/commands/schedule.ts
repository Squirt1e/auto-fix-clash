import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SCHEDULE, loadConfig } from '../../config.ts';
import {
  addDomainToConfigText,
  materializeDomainsInConfigText,
  removeDomainFromConfigText,
  writeConfigText,
} from '../../config-edit.ts';
import { UsageError } from '../../errors.ts';
import { EXIT_OK, EXIT_USAGE } from '../../exit-codes.ts';
import { afcStateDir, currentPlatform, joinFor, type PlatformContext } from '../../platform.ts';
import { DEFAULT_DOMAIN_TARGETS, parseDomainPattern, type DomainTargetConfig } from '../../targets/domain.ts';
import {
  BACKEND_CHOICES,
  defaultBackendName,
  getScheduleBackend,
  isBackendChoice,
  scheduleLogDir,
  type BackendChoice,
  type ScheduleOptions,
} from '../../schedule/index.ts';
import { SCHEDULE_HELP } from '../help.ts';
import { optBoolean, optNumber, optString, type CommandContext } from '../context.ts';
import { parseExpectedStatus, resolveWritePath } from './add.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ScheduleMetadata { configPath: string }

function scheduleMetadataPath(ctx: PlatformContext): string {
  return joinFor(ctx)(afcStateDir(ctx), 'schedule.json');
}

export function writeScheduleMetadata(ctx: PlatformContext, configPath: string): void {
  const path = scheduleMetadataPath(ctx);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ configPath }, null, 2)}\n`, 'utf8');
}

export function readScheduleMetadata(ctx: PlatformContext): ScheduleMetadata | undefined {
  try {
    const raw = JSON.parse(readFileSync(scheduleMetadataPath(ctx), 'utf8')) as { configPath?: unknown };
    return typeof raw.configPath === 'string' && raw.configPath !== '' ? { configPath: raw.configPath } : undefined;
  } catch {
    return undefined;
  }
}

export function configPathMismatchWarning(installedPath: string, requestedPath: string): string | undefined {
  return installedPath === requestedPath
    ? undefined
    : `注意：已安装的计划任务仍使用 ${installedPath}；当前操作的是 ${requestedPath}。请重跑 afc schedule install --config ${requestedPath}`;
}

export function resolveScheduleConfigArgument(
  explicit: string | undefined,
  ctx: PlatformContext = currentPlatform(),
): string | undefined {
  return explicit ?? readScheduleMetadata(ctx)?.configPath;
}

function emitInstalledConfigWarning(ctx: PlatformContext, requestedPath: string): void {
  const installed = readScheduleMetadata(ctx)?.configPath;
  const warning = installed ? configPathMismatchWarning(installed, requestedPath) : undefined;
  if (warning) process.stderr.write(`${warning}\n`);
}

/**
 * 计划任务要执行的 CLI 入口。
 *
 * 必须同时兼容两种形态：源码运行（src/cli/index.ts）与 npm 安装后的
 * 编译产物（dist/cli/index.js，此时扩展名是 .js）。优先用实际被执行的脚本
 * （process.argv[1]），它最准确；拿不到时按当前模块的扩展名推断同级入口。
 */
function resolveCliEntry(): string {
  const argv1 = process.argv[1];
  if (argv1 && /\.(m?js|ts)$/.test(argv1)) {
    try {
      return realpathSync(argv1);
    } catch {
      // 落到下面的推断
    }
  }
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return join(HERE, '..', `index${ext}`);
}

/** 各平台"怎么查看这个任务"的一句话提示。 */
function inspectHint(platform: string): string {
  if (platform === 'darwin') {
    return '  查看或关闭：系统设置 → 通用 → 登录项与扩展（显示名是 node 的签名主体，不是本项目名）\n';
  }
  if (platform === 'win32') {
    return '  查看：任务计划程序里名为 auto-fix-clash-heal 的任务\n';
  }
  return '  查看：systemctl --user list-timers afc-heal.timer\n';
}

export async function run(context: CommandContext): Promise<number> {
  const action = context.positionals[0] ?? 'status';
  const ctx = currentPlatform();

  if (action === 'add' || action === 'remove' || action === 'list') {
    try {
      return handleDomainAction(action, context);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return EXIT_USAGE;
    }
  }

  const rawChoice = optString(context.values, 'backend') ?? 'auto';
  if (!isBackendChoice(rawChoice)) {
    process.stderr.write(
      `未知的后端：${rawChoice}（可选：${BACKEND_CHOICES.join(' / ')}）\n\n${SCHEDULE_HELP}`,
    );
    return EXIT_USAGE;
  }
  const choice: BackendChoice = rawChoice;
  const backend = await getScheduleBackend(choice, ctx);

  switch (action) {
    case 'install': {
      const explicitConfig = resolveScheduleConfigArgument(optString(context.values, 'config'), ctx);
      const configPath = resolveWritePath(explicitConfig);
      const dryRun = optBoolean(context.values, 'dry-run');
      if (!existsSync(configPath) && !dryRun) {
        writeConfigText(configPath, addDomainToConfigText('', DEFAULT_DOMAIN_TARGETS[0]!, false));
      }
      const config = existsSync(configPath)
        ? loadConfig(configPath)
        : { schedule: DEFAULT_SCHEDULE, domains: DEFAULT_DOMAIN_TARGETS };
      const interval = optNumber(context.values, 'interval') ?? config.schedule.intervalSeconds;
      const options: ScheduleOptions = {
        nodePath: process.execPath,
        cliPath: resolveCliEntry(),
        intervalSeconds: interval,
        workingDirectory: process.cwd(),
        configPath,
        logDir: scheduleLogDir(ctx),
      };

      if (dryRun) {
        process.stdout.write(`将要写入（后端：${backend.name}）：\n\n${backend.preview(options)}\n`);
        return EXIT_OK;
      }

      const result = await backend.install(options);
      writeScheduleMetadata(ctx, configPath);
      process.stdout.write(
        `已安装周期性修复任务（后端：${result.backend}）：每 ${interval} 秒运行一次` +
        `${result.replaced ? '，已覆盖同名旧任务' : ''}\n` +
        (result.definitions.length > 0
          ? `  任务定义：\n${result.definitions.map((d) => `    - ${d}`).join('\n')}\n`
          : '') +
        `  运行日志：${result.logPath}\n` +
        `  ${result.message}\n` +
        inspectHint(ctx.platform) +
        `  处理范围：${config.domains.map((target) => target.pattern).join('、') || '（无）'}\n` +
        '  升级旧任务后请重跑本命令，以替换原来的 fix --all --quiet。\n' +
        '  卸载：afc schedule uninstall（不修改任何 Clash 配置）\n',
      );
      return EXIT_OK;
    }

    case 'uninstall': {
      const result = await backend.uninstall(true);
      process.stdout.write(
        `已卸载周期性修复任务（后端：${result.backend}）。\n  ${result.message}\n` +
        (result.removed.length > 0
          ? `  已删除：\n${result.removed.map((p) => `    - ${p}`).join('\n')}\n`
          : '  没有需要删除的内容。\n') +
        'Clash 配置与当前代理组选择未做任何改动。\n',
      );
      return EXIT_OK;
    }

    case 'status': {
      const status = await backend.status();
      if (!status.installed) {
        process.stdout.write(
          `未安装周期性修复任务（本机默认后端：${defaultBackendName(ctx)}）。\n` +
          '  安装：afc schedule install\n',
        );
        return EXIT_OK;
      }
      process.stdout.write(
        `周期性修复任务：${status.loaded ? '运行中' : '已安装但未载入'}` +
        `，后端 ${status.backend}` +
        `${status.intervalSeconds === undefined ? '' : `，每 ${status.intervalSeconds} 秒`}\n` +
        (status.lastLogLine ? `  最近一次：${status.lastLogLine}\n` : '  还没有运行记录。\n'),
      );
      const metadata = readScheduleMetadata(ctx);
      const explicitConfig = optString(context.values, 'config');
      const requestedPath = explicitConfig ? resolveWritePath(explicitConfig) : undefined;
      if (metadata?.configPath && requestedPath) {
        const warning = configPathMismatchWarning(metadata.configPath, requestedPath);
        if (warning) process.stderr.write(`${warning}\n`);
      }
      if (metadata?.configPath && existsSync(metadata.configPath)) {
        const config = loadConfig(metadata.configPath);
        process.stdout.write(
          `  配置：${metadata.configPath}\n` +
          `  域名范围：${config.domains.map((target) => target.pattern).join('、') || '（无）'}\n`,
        );
      } else {
        process.stdout.write('  无法确认已安装任务的配置路径，请重跑 afc schedule install。\n');
      }
      if (!status.loaded) {
        process.stdout.write('  请重新执行 afc schedule install 以载入任务。\n');
      }
      if (optBoolean(context.values, 'verbose')) {
        process.stdout.write(
          (status.definitions.length > 0
            ? `  任务定义：\n${status.definitions.map((d) => `    - ${d}`).join('\n')}\n`
            : '') +
          `  日志：${status.logPath}\n` +
          `  最近退出码：${status.lastExitStatus ?? '（未记录）'}\n`,
        );
      }
      process.stdout.write('  卸载：afc schedule uninstall　（--verbose 查看定义文件与日志路径）\n');
      return EXIT_OK;
    }

    default:
      process.stderr.write(`未知的 schedule 子命令：${action}\n\n${SCHEDULE_HELP}`);
      return EXIT_USAGE;
  }
}

function domainTargetFromContext(pattern: string, context: CommandContext): DomainTargetConfig {
  const normalized = parseDomainPattern(pattern).input;
  const url = optString(context.values, 'url');
  const expect = optString(context.values, 'expect');
  if ((url === undefined) !== (expect === undefined)) {
    throw new UsageError('--url 与 --expect 必须同时提供。');
  }
  const countryDeny = (optString(context.values, 'country-deny') ?? '')
    .split(',').map((country) => country.trim().toUpperCase()).filter(Boolean);
  return {
    pattern: normalized,
    ...(url && expect ? { probe: { url, expectedStatus: parseExpectedStatus(expect) } } : {}),
    extraProbes: [],
    countryAllow: [],
    countryDeny,
  };
}

function handleDomainAction(
  action: 'add' | 'remove' | 'list',
  context: CommandContext,
): number {
  const explicit = resolveScheduleConfigArgument(optString(context.values, 'config'));
  if (action === 'list') {
    const config = loadConfig(explicit);
    process.stdout.write(`定时修复域名（${config.sourcePath ?? '内置默认'}）：\n`);
    if (config.domains.length === 0) process.stdout.write('  没有登记任何域名。\n');
    for (const [index, target] of config.domains.entries()) {
      const source = target.probe ? '显式/服务判据' : '通用 HTTPS 可达性';
      process.stdout.write(`  ${index + 1}. ${target.pattern}（${source}）\n`);
    }
    if (config.sourcePath) emitInstalledConfigWarning(currentPlatform(), config.sourcePath);
    return EXIT_OK;
  }

  const rawPattern = context.positionals[1];
  if (!rawPattern) throw new UsageError(`用法：afc schedule ${action} <域名|*.域名>`);
  if (context.positionals.length > 2) throw new UsageError(`afc schedule ${action} 一次只接受一个域名范围。`);

  if (action === 'add') {
    const target = domainTargetFromContext(rawPattern, context);
    const path = resolveWritePath(explicit);
    const fileExists = existsSync(path);
    const text = fileExists ? readFileSync(path, 'utf8') : '';
    const existing = fileExists ? loadConfig(path).domains : DEFAULT_DOMAIN_TARGETS;
    if (existing.some((item) => parseDomainPattern(item.pattern).input === target.pattern)) {
      throw new UsageError(`“${target.pattern}” 已经登记在定时修复列表中。`);
    }
    const materializeDefaults = !/^domains:/m.test(text);
    writeConfigText(path, addDomainToConfigText(text, target, materializeDefaults));
    emitInstalledConfigWarning(currentPlatform(), path);
    process.stdout.write(
      `已登记定时修复域名：${target.pattern}\n  配置：${path}\n` +
      '如果系统任务已经安装，请重跑 afc schedule install 以确认它指向这份配置。\n',
    );
    return EXIT_OK;
  }

  const config = loadConfig(explicit);
  if (!config.sourcePath) throw new UsageError('当前域名来自内置默认，尚无可编辑配置文件。');
  const text = readFileSync(config.sourcePath, 'utf8');
  const numericSelector = /^\d+$/.test(rawPattern);
  const index = numericSelector ? Number(rawPattern) - 1 : -1;
  if (numericSelector && (!Number.isSafeInteger(index) || index < 0 || index >= config.domains.length)) {
    throw new UsageError(`域名序号 ${rawPattern} 不存在，请先运行 afc schedule list。`);
  }
  const wanted = numericSelector
    ? config.domains[index]!.pattern
    : parseDomainPattern(rawPattern).input;
  let next = removeDomainFromConfigText(text, wanted);
  if (next === undefined && !/^domains:/m.test(text)) {
    const remaining = config.domains.filter(
      (target) => parseDomainPattern(target.pattern).input !== wanted,
    );
    if (remaining.length !== config.domains.length) {
      next = materializeDomainsInConfigText(text, remaining);
    }
  }
  if (next === undefined) throw new UsageError(`配置中没有登记 “${wanted}”。`);
  writeConfigText(config.sourcePath, next);
  emitInstalledConfigWarning(currentPlatform(), config.sourcePath);
  process.stdout.write(`已移除定时修复域名：${wanted}\n  配置：${config.sourcePath}\n`);
  return EXIT_OK;
}
