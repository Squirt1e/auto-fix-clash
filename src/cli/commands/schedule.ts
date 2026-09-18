import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../config.ts';
import { EXIT_OK, EXIT_USAGE } from '../../exit-codes.ts';
import { currentPlatform } from '../../platform.ts';
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

const HERE = dirname(fileURLToPath(import.meta.url));

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
      const config = loadConfig(optString(context.values, 'config'));
      const interval = optNumber(context.values, 'interval') ?? config.schedule.intervalSeconds;
      const options: ScheduleOptions = {
        nodePath: process.execPath,
        cliPath: resolveCliEntry(),
        intervalSeconds: interval,
        workingDirectory: process.cwd(),
        ...(config.sourcePath ? { configPath: config.sourcePath } : {}),
        logDir: scheduleLogDir(ctx),
      };

      if (optBoolean(context.values, 'dry-run')) {
        process.stdout.write(`将要写入（后端：${backend.name}）：\n\n${backend.preview(options)}\n`);
        return EXIT_OK;
      }

      const result = await backend.install(options);
      process.stdout.write(
        `已安装周期性修复任务（后端：${result.backend}）：每 ${interval} 秒运行一次` +
        `${result.replaced ? '，已覆盖同名旧任务' : ''}\n` +
        (result.definitions.length > 0
          ? `  任务定义：\n${result.definitions.map((d) => `    - ${d}`).join('\n')}\n`
          : '') +
        `  运行日志：${result.logPath}\n` +
        `  ${result.message}\n` +
        inspectHint(ctx.platform) +
        '  处理范围：配置里声明的组 + 你在 Clash 里手动钉了节点的组\n' +
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
