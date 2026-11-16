# 故障排查与平台细节

README 只讲怎么用；认不到客户端、定时任务行为异常、结果报「不完整」这类问题看这里。

## 认不到控制端点

afc 通过 mihomo 的**外部控制端点**（不是代理端口）指挥内核，通常会自动找到。它按这个顺序找：

1. 运行时配置里的 `external-controller` / `external-controller-pipe`
2. 内核进程命令行里的 `-ext-ctl*`
3. 内核进程实际监听的端口
4. 命名管道（枚举 + 按当前用户 SID 推导 Clash Verge 的管道名）
5. 常见套接字 / 管道名
6. 默认端口 9090、9097

认不到时先跑 `afc groups --verbose`，它会打印「afc 到底找了哪些地方、每个候选源自哪里」。也可以手动指定：

```bash
afc groups --controller unix:/tmp/mihomo-party-<uid>-<pid>.sock   # Linux / macOS 的套接字
afc groups --controller 'pipe:\\.\pipe\MihomoParty\mihomo'        # Clash Party 的命名管道
afc groups --controller 'pipe:\\.\pipe\verge-mihomo'              # Clash Verge 旧版的命名管道
afc groups --controller 127.0.0.1:9097 --secret <密钥>            # 开 external-controller 时（Verge 默认 9097）
```

改过控制端口就写进 `afc.config.yaml`（定时任务也读这里，它不带任何端点参数）：

```yaml
controller:
  endpoint: 127.0.0.1:9191        # 也可写 unix:/path.sock 或 pipe:\\.\pipe\MihomoParty\mihomo
  secret: your-secret             # 省略时从客户端自己的运行时配置里读
  ports: [9191]                   # 只写了端口：自动发现时额外试这些端口
```

优先级：`--controller` / `--secret`（命令行）> `controller.*`（配置文件）> 自动发现。

**多个订阅**：afc 跟着**当前生效的订阅**走，切订阅是客户端的事，不用在 afc 里切。两个订阅的组名不一样
也能自动认（例如一个叫 `GPT`、另一个叫 `🤖AI网站`）。

## Windows 上容易踩的点

- **「代理端口」和「控制端口」是两回事**（最常见的误判）。混合 / HTTP / SOCKS 代理端口是给浏览器和系统
  代理用的，改成什么都与 afc 无关；afc 要的是客户端设置里单独那一项：
  Clash Verge Rev 在「设置 → Clash 设置 → 外部控制」（默认 `127.0.0.1:9097`），
  Clash Party 在「内核设置 → 外部控制地址 / 外部控制访问密钥」。
  如果把代理端口改成了 afc 会去试的端口（比如 9090），afc 收到的就是代理端口对 `/version` 回的
  `400 Bad Request`，表现为「找到了候选但都无法访问」——1.1.2 起这种应答会被直接点名。
- **Clash Verge Rev 新版默认不开 TCP 端口**，控制端点挂在命名管道
  `\\.\pipe\verge-mihomo-sidecar-<release|dev>-<当前用户 SID 的 sha256>` 上（名字和随机 `secret`
  都写在 `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\config.yaml` 里）。
  afc 会读那份配置，也会自己按你的 SID 算出管道名，一般不用手动指定。
- **Clash Party 的管道是「子目录」形式** `\\.\pipe\MihomoParty\mihomo`，不是 `\\.\pipe\mihomo-party`；
  内核还可能以服务身份（SYSTEM）运行，此时读不到命令行，afc 会改用镜像名 + 内核实际监听的端口来找。

## 找不到 mihomo 内核二进制

`afc doctor` / `afc fix` 要起临时内核实例、逐个节点发真实请求，所以需要一个 mihomo 可执行文件
（afc 不下载、不内置内核）。查找顺序：

正在运行的内核进程 → **客户端主程序旁边的内核**（Clash Verge 的 `verge-mihomo.exe` /
`verge-mihomo-alpha.exe`，Clash Party 的 `resources\sidecar\mihomo.exe`，所以装在哪个目录都行）
→ 常见安装位置 → 客户端目录扫描 → `PATH`。

都不行就显式指定：

```yaml
probe:
  kernelPath: D:\tools\Clash Verge\verge-mihomo.exe
```

## 在 WSL（bash）里跑？

请改用 Windows 的 PowerShell / cmd —— 在**跑 Clash 的那台机器上**运行：

```powershell
npm i -g auto-fix-clash
afc groups
```

WSL 与 Windows 不在同一个网络命名空间（WSL2 的 `127.0.0.1` 是它自己的回环，命名管道也跨不过去），
而且 afc 探测节点还要用 Windows 上的 mihomo 内核二进制。要在 WSL 里用需要额外配网络，afc 不做自动适配；
真需要的话用 `controller.endpoint` 指向宿主机 IP、并给 `probe.kernelPath` 准备一个 Linux 版 mihomo。

## 定时任务行为异常

**Windows 上每 5 分钟弹一个黑窗口？**
1.2.3 起不会了：任务不再是直接跑控制台程序 `node.exe`，而是跑 `wscript.exe` + 由 afc 生成的
`%LOCALAPPDATA%\afc\logs\run-hidden.vbs`，把窗口状态设为隐藏（启动器还会把 afc 的退出码回传给任务计划程序）。
从旧版本升级后请重跑一次 `afc schedule install` 改写已有任务；若本机 `wscript` 被安全策略禁用，
安装时会明确告诉你任务会有窗口闪现。

**`afc schedule status` 说没安装，但我装过了？**
1.2.2 起会给出**核验过**的状态：`install` 创建任务后会立刻回查一次，`status` 走的是 PowerShell 的
`Get-ScheduledTask`（结构化字段，与系统语言无关）。此前版本在中文等本地化 Windows 上会把 `schtasks`
的 GBK 输出按 UTF-8 读、按英文标签匹配，于是永远报告"未安装"。仍显示未安装时加 `--verbose` 看任务名与
后端，或手动 `schtasks /Query /TN auto-fix-clash-heal`。

**日志里的运行间隔不均匀（比如 05:33 → 06:15）？**
正常。电脑睡眠期间不触发：systemd 那边靠 `Persistent=true`、launchd 由系统自己补跑，Windows 上错过的
那一次不补，但下一个周期照常（间隔 5 分钟，最多晚几分钟）。

**系统提示「App 后台活动」显示为 Node.js Foundation？（仅 macOS）**
正常，那就是本项目的定时任务（它执行的是 `node`，macOS 按代码签名主体归类）。
查看或关闭：系统设置 → 通用 → 登录项与扩展；`afc schedule status --verbose` 可核对任务文件路径。

**Linux 上没登录也要跑？**
任务跟着你的登录会话跑。执行一次 `loginctl enable-linger $USER` 即可脱离会话。
容器里没有 systemd 时用 `afc schedule install --backend cron` 强制指定后端
（可选 `launchd`、`systemd`、`cron`、`schtasks`，`--dry-run` 可先看将要写入的任务定义）。

各平台查看任务的位置：macOS 系统设置 → 通用 → 登录项与扩展；
Linux `systemctl --user list-timers afc-heal.timer`；Windows 任务计划程序里名为
`auto-fix-clash-heal` 的任务。任务计划程序不记录程序输出，所以 Windows 上 afc 自己把日志写到
`%LOCALAPPDATA%\afc\logs`。

## 结果报「不完整」是什么意思

afc 只在**能证明**路由时才动你的组，证明不了就报告不完整并返回退出码 3，绝不猜一个组去切换。

- 旧版控制 API 的 `/rules` 不返回 `no-resolve` 修饰符，afc 只看到 IP 规则时会把 `IPCIDR` 报成无法完整解析而保守停止。
  现在 afc 会从 mihomo 当前运行配置补回该修饰符：域名阶段能确定跳过的私网规则会继续往后匹配；确实需要目标 IP 的规则，
  则使用控制器 `/dns/query` 的 A/AAAA 结果（而不是可能不同的系统 DNS）。只要不同地址得到不同策略，
  仍会退出码 3。
- `RULE-SET`、`GEOSITE`、`GEOIP`/IP-ASN、进程或入站条件等仍无法可靠展开的规则同样不猜：**已确认的组照常修复**，
  未解析的部分单独报告。手动 `afc fix` 和定时任务共用这套解析逻辑。

## 从旧版本升级

1.3.0 把计划任务从旧的 `fix --all --quiet` 改为域名驱动的 `fix --scheduled --quiet`。**仅升级 npm 包不会
自动改系统任务**，所以升级后请先用 `afc schedule list` 核对域名，再重跑一次 `afc schedule install`
覆盖旧定义。

## afc 会写哪些文件

普通 `fix` 不写 Clash 配置。显式 `bind/unbind` 会在当前 Party 数据目录管理 `profile.yaml` 的覆写引用、`override.yaml`、AFC 自有覆写和 `rules/<profileId>.yaml` 的前置规则；不改原始订阅。绑定状态保存在用户级 AFC 配置目录的 `bindings.json`，事务期间会有权限受限的恢复记录。绑定只属于指定订阅，不随切换传播；回切后重新生效。

其他写入包括：

- 系统调度器的任务定义：macOS `~/Library/LaunchAgents/`、Linux `~/.config/systemd/user/` 或 crontab、
  Windows 的任务计划程序数据库
- 日志目录：macOS `~/Library/Logs/afc`、Linux `~/.local/state/afc`、Windows `%LOCALAPPDATA%\afc\logs`
- 你自己用 `afc schedule add` 指定的那份 afc 配置文件

`afc schedule uninstall` 会把任务与日志一起删除。

## 绑定失败或重启中断

`bind` 首版仅支持 macOS Clash Party 的 Unix 控制端点及可提取完整内联定义的节点。非 Selector、只含嵌套组或 provider-only 候选会在写入前拒绝。无 `--restart-client` 时不会修改配置。

若进程中断留下 `binding-transaction.json`，先启动原 Party，再执行 `afc bind --restart-client` 恢复，恢复完成后重试原命令。恢复记录可能包含原配置，勿公开其正文。文件被其他程序改动时会保留记录并停止，避免覆盖外部修改。规则或生成覆写被手动修改后，`fix` 会报告漂移并停止对应修复。

## 由你手动操作的本机绑定验证（不由 AFC 退出客户端）

以下步骤使用本仓库刚构建的程序，避免误用尚未升级的全局 `afc`。我不会代你执行其中的退出、启动或订阅刷新。

1. 保持 Party 运行，先在本仓库执行 `npm run build`，然后预览：

   ```bash
   node dist/cli/index.js bind '*.chatgpt.com' --group 'AFC-Validation' --create --dry-run
   ```

   预期输出“仅预览，未写入、未重启”。记录当前订阅和原代理组的选择。

2. 在 Party 菜单中由你选择退出，确认主进程及内核均已退出。仅关闭窗口会保留后台进程，不满足离线写入要求。此时代理网络可能短暂中断。

3. 退出后先在 Finder 将 `~/Library/Application Support/mihomo-party` 复制到一个本地备份位置（其中可能有订阅凭据，不要上传或分享）；如已有 `~/.config/afc/bindings.json`，也备份该文件。然后执行离线绑定：

   ```bash
   node dist/cli/index.js bind '*.chatgpt.com' --group 'AFC-Validation' --create \
     --offline --client-dir "$HOME/Library/Application Support/mihomo-party"
   ```

   使用自定义/便携目录时替换路径。命令不会退出或启动任何客户端；若 Party 还在运行，会拒绝写入。预期输出“已离线保存，尚未验证生效”。离线命令退出码 0 表示保存成功，不能代替下一步的实时验收。

4. 由你手动启动 Party，然后执行：

   ```bash
   node dist/cli/index.js bind --list --json
   node dist/cli/index.js fix '*.chatgpt.com' --dry-run
   ```

   预期绑定条目为 `active: true`；修复输出指向 `AFC-Validation`，不再被前置 GEOIP/IP-CIDR 阻塞；`--dry-run` 不切换节点。网页本身的探测仍可能因出口不可用返回无可用候选，这与路由绑定生效是两个验证结果。

5. 在 Party 中由你刷新同一订阅，再执行 `bind --list --json`；绑定仍应 active，组成员应随内联节点更新。切换其他订阅时不应自动出现该绑定，切回后应恢复。已有组的成员与选择应保持。

6. 撤销测试：由你退出 Party，执行下列命令，再手动启动并检查列表及实际规则：

   ```bash
   node dist/cli/index.js unbind '*.chatgpt.com' \
     --offline --client-dir "$HOME/Library/Application Support/mihomo-party"
   node dist/cli/index.js bind --list --json
   ```

   最后一条要在手动启动后运行。域名规则及绑定应消失；首版保留自建组，避免删除未知外部引用。若复用已有组而非新建组，将步骤 1/3 的组名换成现有 Selector 名称并去掉 `--create`；全程应保留该组原选择。

如果某一步失败，保留命令输出与退出码即可，不要公开订阅 URL、节点凭据或事务记录正文。当前自动退出路径尚未通过本机端到端验收，推荐先使用上述手动离线流程。
