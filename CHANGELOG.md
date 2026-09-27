# 更新日志

## 1.3.1

- 只更新文档，**包内代码与 1.3.0 完全相同**（`dist` 逐字节一致，`README.md` 本来就在 npm 包的 `files` 里，
  所以需要发一个新版本才能把修正后的说明同步到 npm）。
- README 的示例输出改为与 1.3.0 的真实行为一致：`afc schedule status` 会额外打印后端、配置路径与已登记的域名范围；
  `afc fix` 的真实输出是「绑定范围 → 每个见证域名的规则依据 → 对组的实际操作」三段，并说明了 `规则 #N` 是人看的
  一基编号（`--verbose` 时另附 `(API index N-1)` 供对照控制 API）。
- 点明 `afc doctor` 是**按组**体检、不接受域名参数（域名请用 `afc fix <域名> --dry-run`）。
- 英文段补全域名范围驱动的默认行为、`--force`、`afc schedule add/list/remove`，以及保守路由判定
  （`no-resolve`、控制器 DNS、不完整时返回退出码 3）与四个退出码。

## 1.3.0

- 修复入口改为稳定的域名范围：`afc fix '*.chatgpt.com'` 会读取实时 mihomo 规则，修复所有能确认承载该范围的代理组；
  `*.` 同时包含裸域，落到 `MATCH` 的路径也纳入处理，订阅改组名后无需改 afc 配置。
- 新增 `--force`，可在当前节点健康时主动切换到另一个通过全部适用判据的节点；没有可用替代时保持原选择。
- 新增 `domains` 配置和 `afc schedule add/list/remove`。定时任务改跑 `fix --scheduled --quiet`，每次重新解析实时路由，
  不再以可能变化的代理组名作为默认范围；旧 `targets` 与显式 `--group` 模式继续兼容。
- 路由解析会从当前运行配置补回 `/rules` 缺失的 `no-resolve` 修饰符，因此私网 IP 规则不再无条件遮住后面的域名规则；
  普通 `IP-CIDR`/`IP-CIDR6` 使用 mihomo 控制器 DNS 的 A/AAAA 结果，所有地址路由一致才算确认。
- 对 `RULE-SET`、`GEOSITE`、GEOIP/ASN、进程或入站条件等仍无法可靠展开的不透明规则不猜测：先修复独立确认的组，
  再报告未解析范围并以退出码 3 表示结果不完整。`DIRECT`/`REJECT` 与自动选择类组只报告跳过。
- **升级后请重跑 `afc schedule install`**，用新的域名驱动参数覆盖系统里已有的 `fix --all --quiet` 任务定义。

## 1.2.3

- **Windows 计划任务不再每 5 分钟弹一个控制台窗口**：`schtasks` 创建的交互式任务在用户会话里运行，
  而 `node.exe` 是控制台子系统程序 —— 每跑一次就会闪出一个窗口。现在任务改为执行
  `wscript.exe` + 由 afc 生成的 `run-hidden.vbs`（GUI 子系统，自己不开控制台），
  由它把子进程的窗口状态设为隐藏；启动器会等待子进程并把退出码回传，所以任务计划程序里的
  "上次运行结果" 仍然是 afc 的真实退出码（0/2/3）。wscript 被安全策略禁用时自动退回原方式并明确提示。
  **升级后请重跑一次 `afc schedule install`**，否则系统里那条旧任务还是原来的动作。
- 安装时会核验并回报隐藏启动器的路径；`afc schedule uninstall` 会一并删除它。

## 1.2.2

- **修掉 1.1.3 起引入的回归（已发布过，影响面不小）**：发现流程分两层后漏了第二层的成功判定，
  于是「控制端点来自进程/套接字扫描」的用户一律报「找到了控制端点候选，但都无法访问」——
  macOS / Linux 上的 Clash Party 就是这种（Windows 上因为运行时配置里直接有端点，反而不受影响）。
  现在第二层命中即正常返回，并补了盯着这条路径的回归测试。
- **修掉 Windows 上 `afc schedule status` 永远说"未安装"**：`schtasks /Query` 的输出在中文等本地化
  系统上是 GBK 且标签被翻译，按 UTF-8 解码 + 按英文标签匹配必然失败（英文 CI 测不出来）。
  现在状态走 PowerShell `Get-ScheduledTask` 的结构化字段（与语言无关），存在性再用退出码判一次；
  `install` / `uninstall` 之后都会**核验**并把核验结果回报，不再出现"装过了但 status 说没有"。
- **`afc doctor` / `afc fix` 找不到内核**：改为按可靠性查找 —— 正在运行的内核进程 exe 路径 →
  **客户端主程序同级的内核**（Verge 自己就是这么解析的，自定义/便携安装目录都能命中）→ 常见位置
  → 客户端目录有限深度扫描 → PATH；并补上 `verge-mihomo-alpha.exe` 等名字。
  内核缺失这类永久错误不再重试（以前会重试一次并报成"（已重试 1 次）"，看着像临时故障）。
  实现要点（第一版漏掉的）：Windows 上 `tasklist` 只给镜像名与 PID、**没有路径**，所以必须把
  PowerShell 的 `ExecutablePath` 取回来 —— 且**客户端主程序的 PID 也要查**（只查内核等于拿不到
  "客户端装在哪"）；macOS 上 `ps` 输出不带引号、路径含空格，取路径时按「存在的最长前缀」切，
  否则会得到 `/Applications/Clash` 这种半截路径。`--verbose` 现在会打印选中的内核与依据。
- **输出精简**：默认每条错误只给「发生了什么 + 一个能立刻执行的下一步」，平台差异、候选清单、
  配置写法都移到 `--verbose`；认不到端点时默认不再打印十几行路径。
- **撤掉 1.2.0 的 WSL 自动桥接**（读 `/mnt/c` 配置 + 宿主机地址重写）：它只在用户额外配置网络时
  才生效，等于没换来"开箱可用"。现在检测到 WSL 就直接提示改用 Windows 的 PowerShell / cmd 运行。

## 1.2.1

- 修掉 1.2.0 的测试用例在 Windows 上的写法问题（用 `URL.pathname` 取 CLI 路径会得到
  `/D:/a/...`），因此 1.2.0 没有发布 —— 1.2.1 是它的修复版，功能与 1.2.0 一致。

## 1.2.0

- **在 WSL（bash）里也能用**：afc 会从 `/mnt/c` 读 Windows 客户端的运行时配置（外部控制端口与密钥），
  并把候选主机名换成 `127.0.0.1`（镜像网络模式）与宿主机地址（NAT 模式的网关 / DNS），两边都试。
  Windows 的命名管道跨不过 WSL 边界，所以不再生成这类候选；剩下的只是网络层：
  推荐在 `.wslconfig` 里开 `networkingMode=mirrored`，或让客户端监听 `0.0.0.0` 并放行防火墙。
  `afc fix` / `afc doctor` 仍需一个能跑的 Linux 版 mihomo（`probe.kernelPath`）。
- **`afc groups` 打印编号**：第一列是编号，组名带 emoji / 中文时不用再手打；
  编号可直接用于 `afc add <编号>`、`afc remove <编号>`、`afc fix --group <编号>`（doctor 同理）。
  编号来自最近一次 `afc groups`（缓存在运行状态目录，`--json` 输出里也带）。
- `afc groups` 结尾给出可直接抄的命令示例（`afc add <编号>` 等）。
- 顺带修掉 `afc add --config <已有配置>` 会忽略该配置里 `controller` 段的问题 ——
  它以前为了「配置文件可能还不存在」而完全不读它，于是「先 groups 拿编号、再 add 编号」这条
  最自然的路径会连不上控制器。

## 1.1.4

- **认出「afc 跑在 WSL 里」这种跑错地方的情况**：WSL2 的 `127.0.0.1` 是它自己的回环，连不到 Windows
  宿主机上 Clash 的控制端口（宿主机的 `127.0.0.1:9097` 也不对外监听），命名管道更用不了，
  症状看起来完全是「Clash 没在运行」。现在报错会直说，并给出在 Windows 侧运行的做法与
  「确实要在 WSL 里用」时需要配齐的三件事。
  `KernelNotFoundError`（找不到 mihomo 内核二进制）同样会提示这一点。
- README 增加对应条目。

## 1.1.3

- **Clash Verge Rev 的运行时配置找错了文件**：它真正喂给内核的是 `clash-verge.yaml`
  （`constants.rs` 的 `files::RUNTIME_CONFIG`），afc 以前只看数据目录里的 `config.yaml`（它的配置存储）。
  现在两个都读，而且 `clash-verge.yaml` 排在前面 —— 这份是内核实际在跑的配置，
  `external-controller` / `external-controller-pipe` / `secret` 一定在里面。
- `--verbose` 的诊断报告更完整：列出**检查过但不存在**的配置路径、当前用户 SID，
  以及命名管道枚举的总数与方式（用来区分「枚举失败」和「枚举到了但没有 mihomo 管道」）。
- CI：发布后回查注册表的窗口从 60 秒放宽到 5 分钟。npm 对发布请求回 202（"being processed"），
  版本要过几分钟才能读到，1.1.1 与 1.1.2 都因此被误判成「没有发布」。

## 1.1.2

- 新增 `controller` 配置段（`endpoint` / `secret` / `ports`）：客户端把「外部控制地址」改成非默认端口时，
  写进 `afc.config.yaml` 即可，定时任务也会用上（定时任务不带任何端点参数）。
  优先级：`--controller` / `--secret` > 配置文件 > 自动发现。
- 探测到「代理端口」时直接点名：混合/HTTP 代理端口对 `/version` 回 400，afc 会说明这是代理端口
  而不是控制端口，并给出各客户端「外部控制地址」的位置（最常见的误判）。
- 认不到端点时的提示重写：讲清代理端口与控制端口的区别，并给出写进配置的示例。

## 1.1.1

修掉 Windows 上认不到 Clash Verge / Clash Party 控制端点的问题。

- 控制端点发现补齐 Windows 实际形态：运行时配置里的 `external-controller-pipe`、按用户 SID 推导的
  Clash Verge 管道（`\\.\pipe\verge-mihomo-sidecar-<release|dev>-<hash>`）、命名管道枚举、
  Clash Party 的 `\\.\pipe\MihomoParty\mihomo`、内核实际监听的端口，以及 Verge 的默认端口 9097。
- 内核进程在服务模式下读不到命令行时改用镜像名识别；配置里的 `secret` 会自动补到其它候选上。
- 发现流程分两层：先读客户端数据目录里的运行时配置（命中即用，Windows 上不再为此启动 WMI 全量扫描），
  没命中才去枚举进程、监听端口与命名管道。
- 认不到端点时的输出重做：标出每个候选的来源，直接给出发现的可用端点与可粘贴的 `--controller` 写法，
  `--verbose` 在发现失败时也会打印「afc 找了哪些地方」。

## 1.1.0

- 支持 macOS / Linux / Windows 三平台，兼容 Clash Verge (Rev)、ClashX Meta 等其它客户端与任意 mihomo 内核。
- 发布走 npm trusted publishing：打 `v*` tag 自动出包并发版。

## 1.0.0

- 首个可用版本：按目标站点的真实响应判定节点可用性，坏节点自动切换，并装好定时巡检。
