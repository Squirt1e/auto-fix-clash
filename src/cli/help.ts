/** 顶层帮助：只放"要做什么、用哪条命令"，细节放到各命令自己的帮助里。 */
export const TOP_HELP = `afc — 让 Clash 代理组自动选中「真正能用」的节点

用法：afc <命令> [选项]

  fix <域名|*.域名>              立即找出该网站经过的代理组并修复
  schedule add <域名|*.域名>     添加一个定时修复的网站
  schedule list                  查看已添加的网站
  schedule remove <域名|*.域名>  移除一个网站
  schedule install / status      安装定时任务 / 查看运行状态
  groups / doctor                查看代理组 / 体检节点
  add / remove <组名>            旧版按组配置（组名固定时使用）

常用选项：
  --dry-run  只看不切换　--config <path> 指定配置　--verbose / --quiet 控制输出
  -v, --version 显示版本　-h, --help 显示帮助　--controller <端点> 手动指定控制端点

添加网站并立即使用：
  afc schedule add '*.example.com'
  afc schedule list
  afc fix '*.chatgpt.com' --force

处理范围：*.example.com 同时包含裸域；每次按当前规则重新定位所有确认的代理组。
          DIRECT/REJECT、自动选择组会跳过；无法确认的规则会明确报告为不完整。

退出码：0 成功　2 未找到可用节点　3 环境故障　64 用法错误
查看某条命令的用法：afc <命令> --help　　卸载：afc schedule uninstall
`;

export const SCHEDULE_HELP = `用法：afc schedule <add|list|remove|install|uninstall|status> [参数] [选项]

  add <域名|*.域名>     登记一个定时修复范围（*. 同时包含裸域）
  list                  查看当前登记的域名
  remove <域名|*.域名>  移除一个范围
  install     安装定时任务（默认每 300 秒运行一次 afc fix）
  uninstall   移除任务并删除本工具的日志
  status      查看是否在运行、最近一次做了什么

定时任务后端按平台自动选择：macOS 用 launchd、Linux 用 systemd 用户定时器
（没有 systemd 时退回 cron）、Windows 用任务计划程序（后台静默运行，不弹窗口）。

选项：
  --interval <seconds>   运行间隔，最小 60
  --backend <name>       强制指定后端：launchd | systemd | cron | schtasks
  --config <path>        指定配置文件（会写入任务，供后台运行时使用）
  --url <地址>           add 时指定服务探测地址（必须同时给 --expect）
  --expect <状态码>      add 时指定期望状态码或范围
  --country-deny <列表>  add 时指定出口国家黑名单，如 HK,CN
  --dry-run              只展示将要写入的任务定义
  --verbose              额外打印任务定义路径与系统里显示的名字

说明：任务每次都按当前规则重新解析域名所属的代理组，只通过控制端点切换选择，
不修改任何 Clash 配置。升级旧版本后请重跑 install，替换旧的按组任务参数。
`;

export const ADD_HELP = `用法：afc add <组名|编号> [选项]

把某个组加入管理，使其参与定时修复。

判据会自动挑：命中内置预设就用预设的（GPT / Telegram / Google / Github），
否则用通用可达性判据（只在节点彻底不通时才换，不会换掉你特意选的地区）。

选项：
  --url <地址>            指定探测地址
  --expect <状态码>       期望状态码：200 / 200,301 / 200-299
  --country-deny <列表>   出口国家黑名单，如 HK,CN
  --config <path>         写入哪个配置文件
  --force                 已存在同名条目时覆盖

编号来自最近一次 afc groups（组名带 emoji / 中文时推荐用它，免得手打错）：
  afc groups          # 第一列就是编号
  afc add 3

例：
  afc add Netflix
  afc add 我的组 --url https://example.com/generate_204 --expect 204
`;

export const REMOVE_HELP = `用法：afc remove <组名|编号> [选项]

把某个组从配置里移除。
若该组仍然"手动钉着某个节点"，它会被自动模式按通用可达性判据接管。

选项：
  --config <path>   指定配置文件
`;

const GROUPS_HELP = `用法：afc groups [选项]

列出当前订阅实际存在的代理组，并标出哪些会被 afc 处理。
排序：受管理的组排在最前；第一列是编号，可以直接拿去用：

  afc add <编号>          把该组交给 afc 管理
  afc remove <编号>       取消管理
  afc fix --group <编号>  只处理该组（doctor 同理）

选项：
  --json      机器可读输出
  --verbose   额外打印控制器来源与配置路径，并逐组说明未处理的原因
              （认不到控制器时也会打印"afc 找了哪些地方"的诊断）

认不到控制器时，用 --controller 手动指定：
  --controller unix:/tmp/mihomo-party-<uid>-<pid>.sock      （Linux / macOS 套接字）
  --controller 'pipe:\\\\.\\pipe\\MihomoParty\\mihomo'         （Clash Party 的命名管道）
  --controller 'pipe:\\\\.\\pipe\\verge-mihomo'                （Clash Verge 旧版的命名管道）
  --controller 127.0.0.1:9097 --secret <密钥>               （外部控制端口，Verge 默认 9097）

也可以写进 afc.config.yaml（定时任务只读配置，不带命令行参数）：
  controller:
    endpoint: 127.0.0.1:9097
    secret: <外部控制访问密钥>
    ports: [9191]                 # 自动发现时额外要试的端口

注意：这里要的是客户端的「外部控制地址」，不是「混合/HTTP/SOCKS 代理端口」。
Windows 上 Clash Verge Rev 新版的管道名带用户 SID 哈希，写在运行时配置里，
afc 会自动读它；也可以先用 afc groups --verbose 看 afc 找到了什么。
`;

const DOCTOR_HELP = `用法：afc doctor [选项]

逐个探测"该管的组"里的候选节点，打印每个节点的判定（可用 / 被拒绝 / 死节点）、
状态码、出口国家与耗时。不会改动任何组的选择。

选项：
  --group <组名|编号>  只体检指定组
  --json           机器可读输出
  --no-auto        只体检配置里声明过的组
  --verbose        额外打印判据与探测并发上限
`;

const FIX_HELP = `用法：afc fix [域名|*.域名] [选项]

按当前 mihomo 规则找出该域名实际托管到的代理组，再验证当前节点；
可用就保持，不可用才筛查候选。'*.chatgpt.com' 包含裸域 chatgpt.com
及其所有子域名。请给 * 加引号，避免被 shell 展开。

只通过控制端点改变组的选择，不写任何 Clash 配置。
内置服务判据能验证服务能力；未知站点的默认判据只能证明 HTTPS 可达。

选项：
  --force           即使当前节点可用，也切到另一个实测可用节点
  --group <组名|编号>  只处理指定组
  --all            旧版按组模式：处理全部"该管的组"
  --no-auto        只处理配置里声明过的组
  --dry-run        只展示会怎么切，不写入
  --quiet          每次运行只留一行（计划任务用）

例：
  afc fix '*.chatgpt.com'
  afc fix '*.chatgpt.com' --force
`;

export const COMMAND_HELP: Record<string, string> = {
  groups: GROUPS_HELP,
  doctor: DOCTOR_HELP,
  fix: FIX_HELP,
  add: ADD_HELP,
  remove: REMOVE_HELP,
  schedule: SCHEDULE_HELP,
};
