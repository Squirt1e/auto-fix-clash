import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../config.ts';
import { EXIT_OK, EXIT_USAGE } from '../../exit-codes.ts';
import {
  buildPlist,
  installSchedule,
  logDir,
  logPath,
  plistPath,
  scheduleStatus,
  uninstallSchedule,
} from '../../schedule/launchd.ts';
import { optBoolean, optNumber, optString, type CommandContext } from '../context.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 计划任务要执行的 CLI 入口（与本模块同属 src/cli）。 */
const CLI_ENTRY = join(HERE, '..', 'index.ts');

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
        cliPath: CLI_ENTRY,
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
        `已安装周期性修复任务。\n` +
        `  间隔：${interval} 秒\n` +
        `  任务定义：${result.plistPath}\n` +
        `  日志：${result.logPath}\n` +
        `  ${result.message}\n\n` +
        '说明：该任务只通过控制端点切换代理组的选中节点，不会修改任何 Clash 配置。\n' +
        '用 afc schedule uninstall 可完全移除。\n',
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
      process.stdout.write(
        `周期性修复任务状态\n` +
        `  已安装：${status.installed ? '是' : '否'}\n` +
        `  已载入调度器：${status.loaded ? '是' : '否'}\n` +
        `  间隔：${status.intervalSeconds === undefined ? '—' : `${status.intervalSeconds} 秒`}\n` +
        `  任务定义：${status.plistPath}\n` +
        `  日志：${status.logPath}\n` +
        (status.lastExitStatus ? `  最近退出码：${status.lastExitStatus}\n` : '') +
        (status.lastLogLine ? `  最近日志：${status.lastLogLine}\n` : '') +
        (status.installed && !status.loaded
          ? '\n注意：任务已安装但未被调度器载入，请重新执行 afc schedule install。\n'
          : ''),
      );
      return EXIT_OK;
    }

    default:
      process.stderr.write(`未知的 schedule 子命令：${action}\n\n${USAGE}`);
      return EXIT_USAGE;
  }
}
