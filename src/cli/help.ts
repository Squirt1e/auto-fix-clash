/** 顶层帮助：只放"要做什么、用哪条命令"，细节放到各命令自己的帮助里。 */
export const TOP_HELP = `afc — 让 Clash 代理组自动选中「真正能用」的节点

用法：afc <命令> [选项]

  schedule install   装一次，之后每 5 分钟自动体检并修复 ← 最常用
  groups             当前订阅有哪些组、哪些会被处理
  doctor             体检并打印判定表（不改动选择）
  fix                把不可用的节点换掉（可用时什么都不做）
  add <组名>         把某个组加入管理
  remove <组名>      把某个组从配置里移除

常用选项：
  --group <name>   只处理这个组         --dry-run   只看会怎么切，不写入
  --json           机器可读输出         --verbose   打印诊断信息与判定依据
  --config <path>  指定配置文件         --quiet     每次运行只留一行
  -v, --version    显示版本             -h, --help  显示本帮助

处理范围：配置里声明的组 + 你在 Clash 里手动钉了节点的组。
          指向 DIRECT/REJECT 的组、委托给「自动选择」的组不会被改。
          用 afc groups --verbose 可逐组查看原因。

退出码：0 成功　2 未找到可用节点　3 环境故障　64 用法错误
查看某条命令的用法：afc <命令> --help　　卸载：afc schedule uninstall
`;

export const SCHEDULE_HELP = `用法：afc schedule <install|uninstall|status> [选项]

  install     安装定时任务（默认每 300 秒运行一次 afc fix）
  uninstall   移除任务并删除本工具的日志
  status      查看是否在运行、最近一次做了什么

定时任务后端按平台自动选择：macOS 用 launchd、Linux 用 systemd 用户定时器
（没有 systemd 时退回 cron）、Windows 用任务计划程序。

选项：
  --interval <seconds>   运行间隔，最小 60
  --backend <name>       强制指定后端：launchd | systemd | cron | schtasks
  --config <path>        指定配置文件（会写入任务，供后台运行时使用）
  --dry-run              只展示将要写入的任务定义
  --verbose              额外打印任务定义路径与系统里显示的名字

说明：任务只通过控制端点切换代理组的选中节点，不修改任何 Clash 配置。
`;

export const ADD_HELP = `用法：afc add <组名> [选项]

把某个组加入管理，使其参与定时修复。

判据会自动挑：命中内置预设就用预设的（GPT / Telegram / Google / Github），
否则用通用可达性判据（只在节点彻底不通时才换，不会换掉你特意选的地区）。

选项：
  --url <地址>            指定探测地址
  --expect <状态码>       期望状态码：200 / 200,301 / 200-299
  --country-deny <列表>   出口国家黑名单，如 HK,CN
  --config <path>         写入哪个配置文件
  --force                 已存在同名条目时覆盖

例：
  afc add Netflix
  afc add 我的组 --url https://example.com/generate_204 --expect 204
`;

export const REMOVE_HELP = `用法：afc remove <组名> [选项]

把某个组从配置里移除。
若该组仍然"手动钉着某个节点"，它会被自动模式按通用可达性判据接管。

选项：
  --config <path>   指定配置文件
`;

const GROUPS_HELP = `用法：afc groups [选项]

列出当前订阅实际存在的代理组，并标出哪些会被 afc 处理。
排序：受管理的组排在最前。

选项：
  --json      机器可读输出
  --verbose   额外打印控制器来源与配置路径，并逐组说明未处理的原因
`;

const DOCTOR_HELP = `用法：afc doctor [选项]

逐个探测"该管的组"里的候选节点，打印每个节点的判定（可用 / 被拒绝 / 死节点）、
状态码、出口国家与耗时。不会改动任何组的选择。

选项：
  --group <name>   只体检指定组
  --json           机器可读输出
  --no-auto        只体检配置里声明过的组
  --verbose        额外打印判据与探测并发上限
`;

const FIX_HELP = `用法：afc fix [选项]

先验证该组当前节点：可用就什么都不做；不可用才按顺序筛查候选，
切换到第一个实测可用的节点（找到即停）。

只通过控制端点改变组的选择，不写任何 Clash 配置。

选项：
  --group <name>   只处理指定组
  --all            处理全部"该管的组"（默认行为）
  --no-auto        只处理配置里声明过的组
  --dry-run        只展示会怎么切，不写入
  --quiet          每次运行只留一行（计划任务用）
`;

export const COMMAND_HELP: Record<string, string> = {
  groups: GROUPS_HELP,
  doctor: DOCTOR_HELP,
  fix: FIX_HELP,
  add: ADD_HELP,
  remove: REMOVE_HELP,
  schedule: SCHEDULE_HELP,
};
