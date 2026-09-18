import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../config.ts';
import { EXIT_OK, EXIT_USAGE } from '../../exit-codes.ts';
import {
  buildPlist,
  describeProgramIdentity,
  installSchedule,
  logDir,
  logPath,
  plistPath,
  scheduleStatus,
  uninstallSchedule,
} from '../../schedule/launchd.ts';
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

const USAGE = `用法：afc schedule <install|uninstall|status> [选项]

  install     安装周期性修复任务（默认每 300 秒，可用 --interval 调整）
  uninstall   移除任务并删除本工具产生的日志
  status      查看任务是否已载入、间隔与最近一次运行情况

选项：
  --interval <seconds>  运行间隔（>= 60）
  --config <path>       指定配置文件（会写入计划任务，供后台运行时使用）
  --dry-run             只展示将要写入的 plist，不执行安装
`;

export async function run(context: CommandContext): Promise<number> {
  const action = context.positionals[0] ?? 'status';

  switch (action) {
    case 'install': {
      const config = loadConfig(optString(context.values, 'config'));
      const interval = optNumber(context.values, 'interval') ?? config.schedule.intervalSeconds;
      const plistOptions = {
        nodePath: process.execPath,
        cliPath: resolveCliEntry(),
        intervalSeconds: interval,
        workingDirectory: process.cwd(),
        ...(config.sourcePath ? { configPath: config.sourcePath } : {}),
        logDir: logDir(),
      };

      if (optBoolean(context.values, 'dry-run')) {
        process.stdout.write(`将写入 ${plistPath()}：\n\n${buildPlist(plistOptions)}\n`);
        return EXIT_OK;
      }

      const result = await installSchedule(plistOptions);
      process.stdout.write(
        `已安装周期性修复任务：每 ${interval} 秒运行一次（${result.message}）\n` +
        `  任务定义：${result.plistPath}\n` +
        `  运行日志：${result.logPath}\n` +
        '  处理范围：配置里声明的组 + 你在 Clash 里手动钉了节点的组\n\n' +
        '提示：系统「App 后台活动」里它会显示为「' + describeProgramIdentity().displayName + '」\n' +
        '      （执行的是 node，macOS 按代码签名主体归类），不代表装了别的软件。\n' +
        '      查看/关闭：系统设置 → 通用 → 登录项与扩展\n' +
        '      卸载：afc schedule uninstall（不修改任何 Clash 配置）\n',
      );
      return EXIT_OK;
    }

    case 'uninstall': {
      const result = await uninstallSchedule(true);
      process.stdout.write(
        `已卸载周期性修复任务。\n  ${result.message}\n` +
        (result.removed.length > 0
          ? `  已删除：\n${result.removed.map((p) => `    - ${p}`).join('\n')}\n`
          : '  没有需要删除的文件。\n') +
        'Clash 配置与当前代理组选择未做任何改动。\n',
      );
      return EXIT_OK;
    }

    case 'status': {
      const status = await scheduleStatus();
      if (!status.installed) {
        process.stdout.write('未安装周期性修复任务（afc schedule install 可安装）。\n');
        return EXIT_OK;
      }
      process.stdout.write(
        `周期性修复任务：${status.loaded ? '运行中' : '已安装但未被调度器载入'}` +
        `${status.intervalSeconds === undefined ? '' : `，每 ${status.intervalSeconds} 秒`}\n` +
        (status.lastLogLine ? `  最近一次：${status.lastLogLine}\n` : '  还没有运行记录。\n'),
      );
      if (!status.loaded) {
        process.stdout.write('  请重新执行 afc schedule install 以载入调度器。\n');
      }
      if (optBoolean(context.values, 'verbose')) {
        const identity = describeProgramIdentity();
        process.stdout.write(
          `\n  任务定义：${status.plistPath}\n` +
          `  执行程序：${identity.program}\n` +
          `  系统里显示为：${identity.displayName}\n` +
          `  日志：${status.logPath}\n` +
          `  最近退出码：${status.lastExitStatus ?? '（未记录）'}\n`,
        );
      }
      process.stdout.write('  卸载：afc schedule uninstall　（--verbose 查看路径与显示名）\n');
      return EXIT_OK;
    }

    default:
      process.stderr.write(`未知的 schedule 子命令：${action}\n\n${USAGE}`);
      return EXIT_USAGE;
  }
}
