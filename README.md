# afc — 让 Clash 代理组自动选中「真正能用」的节点

> Clash / mihomo（Clash Meta）代理组自动测速与自愈工具：直连 ChatGPT、Codex 等目标站点判定节点真实可用性，当前节点挂了自动切换，
> 一条命令装好定时巡检。支持 macOS / Linux / Windows，兼容 Clash Party、Clash Verge（Rev）、ClashX Meta 与任意 mihomo 内核。

## 你是否也遇到过这些情况？

- 打开 Codex 或 ChatGPT 突然用不了，只能去 Clash 里一个个节点试，试到能连为止
- 延迟最低的那批节点（香港，400ms）偏偏全都用不了；能用的美国节点反而要 900ms
- 叫「香港 20」的节点，实测出口在日本
- 昨天挑好的节点今天又挂了

afc 帮你自动挑节点：**直接请求目标站点、看它的真实响应**，能用的才用，坏了自己换。

## 快速开始

```bash
npm i -g auto-fix-clash   # 要求 Node.js ≥ 20（macOS / Linux / Windows）
afc schedule install      # 装完就不用管：每 5 分钟自动检查，节点坏了自己换
```

看看它在不在跑：

```bash
$ afc schedule status
周期性修复任务：运行中，每 300 秒
  最近一次：2026-09-18 13:50:55 GPT：保持 [Normal x0.5] 日本 03（可用）
  卸载：afc schedule uninstall　（--verbose 查看路径与显示名）
```

不想用了，一条命令撤掉：

```bash
afc schedule uninstall    # 不会改动你的任何 Clash 配置
```

## 它会做什么

- 每 5 分钟检查一次该组**当前节点**：能用就什么都不做；不能用了才扫描候选、换成实测可用的那个
- **只通过控制端点改变组的选中节点，不写任何 Clash 配置**
- 默认照顾**你在 Clash 里手动钉了某个节点的组**（这类组坏了内核不会替你换，比如你手动钉了 GPT 组）
- 不会碰指向 `DIRECT`/`REJECT` 的组（如 `Bilibili`、`去广告`），也不会碰委托给"自动选择"的组
- 想让更多组也被照顾：`afc add <组名>`

定时任务由系统自带的调度器承担，后端按平台自动选择，一般不用管：

| 系统 | 用什么调度 | 想查看任务 |
|---|---|---|
| macOS | launchd | 系统设置 → 通用 → 登录项与扩展 |
| Linux | systemd 用户定时器（没有 systemd 时自动退回 cron） | `systemctl --user list-timers afc-heal.timer` |
| Windows | 任务计划程序 | 任务计划程序里名为 `auto-fix-clash-heal` 的任务 |

需要强制指定后端（例如容器里没有 systemd）：

```bash
afc schedule install --backend cron
afc schedule install --dry-run      # 先看将要写入的任务定义
```

后端名字：`launchd`、`systemd`、`cron`、`schtasks`。两处平台差异值得知道：

- **Linux**：任务跟着你的登录会话跑。没登录也要跑，执行一次 `loginctl enable-linger $USER`。
- **Windows**：任务以当前用户身份运行，不需要管理员权限。任务计划程序不记录程序输出，
  所以 afc 自己把日志写到 `%LOCALAPPDATA%\afc\logs` —— `afc schedule status` 能看到最近一次的结果。

## 常用命令

| 命令 | 作用 |
|---|---|
| `afc schedule install` | 装定时自动修复（最常用） |
| `afc schedule status` | 看它是否在跑、最近做了什么 |
| `afc schedule uninstall` | 卸载 |
| `afc groups` | 当前订阅有哪些组、哪些会被照顾 |
| `afc doctor` | 体检并打印判定表 |
| `afc fix` | 立刻检查并修复 |
| `afc add <组名>` | 把某个组加入照顾范围 |
| `afc remove <组名>` | 从照顾范围移除 |

任何命令加 `--help` 看详细用法，例如 `afc add --help`。

## 看看效果

体检 —— 每个节点到底行不行：

```bash
$ afc doctor
GPT　当前：[Normal x0.5] 日本 03　候选 38 个

节点                          判定    状态码  出口  耗时
--------------------------------------------------------------
  [Normal x0.5] 日本 06       可用    405     JP    606ms
* [Normal x0.5] 日本 03       可用    405     JP    729ms
  [Normal] 美国 03            可用    405     US    857ms
  [Normal x0.5] 香港 06       被拒绝  403     HK    366ms
  [Normal x0.5] 香港 01       被拒绝  403     HK    571ms
  [Normal x0.5] 日本 01       死节点  —       —     —

可用 14　被拒绝 13　国家受限 0　死节点 11　共 38（* 为当前节点）
```

当前节点坏掉时自动换：

```bash
$ afc fix
GPT：已切换 [Normal x0.5] 日本 02 → [Normal x0.5] 日本 03
```

当前节点还好时什么都不做，只探测这一个节点（约 2 秒）：

```bash
$ afc fix
GPT：保持 [Normal x0.5] 日本 03（可用）
```

## 手动控制

```bash
afc fix --group GPT       # 只处理指定组
afc fix --dry-run         # 只看会怎么切，不做改动
afc fix --no-auto         # 只处理配置里声明过的组
afc doctor --json         # 机器可读，可直接喂给 jq
afc groups --verbose      # 逐组说明为什么管/不管，以及它认到的控制器
afc -v                    # 版本号
```

## 不是 Clash Party / 有多个订阅

- **其他客户端**（Clash Verge 等）：afc 会自动去找内核的控制端点和运行时配置，通常直接就能用。
  它按这个顺序找：运行时配置里的 `external-controller` / `external-controller-pipe` →
  内核进程命令行里的 `-ext-ctl*` → 内核进程实际监听的端口 → 命名管道（枚举 + 按当前用户 SID 推导 Verge 的管道名）→ 常见套接字/管道名 → 默认端口 9090、9097。

  认不到时先跑 `afc groups --verbose`，它会打印「afc 到底找了哪些地方、每个候选源自哪里」；
  也可以手动指定：

```bash
afc groups --controller unix:/tmp/mihomo-party-<uid>-<pid>.sock   # Linux / macOS 的套接字
afc groups --controller 'pipe:\\.\pipe\MihomoParty\mihomo'        # Clash Party 的命名管道
afc groups --controller 'pipe:\\.\pipe\verge-mihomo'              # Clash Verge 旧版的命名管道
afc groups --controller 127.0.0.1:9097 --secret <密钥>            # 开了 external-controller 时（Verge 默认 9097）
```

  Windows 上还有两个容易踩的点：

  - **Clash Verge Rev 新版默认不开 TCP 端口**，控制端点挂在命名管道
    `\\.\pipe\verge-mihomo-sidecar-<release|dev>-<当前用户 SID 的 sha256>` 上（名字和随机
    `secret` 都写在 `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev\config.yaml` 里）。
    afc 会读那份配置，也会自己按你的 SID 算出管道名，一般不用手动指定。
  - **Clash Party 的管道是「子目录」形式** `\\.\pipe\MihomoParty\mihomo`，不是 `\\.\pipe\mihomo-party`；
    内核还可能以服务身份（SYSTEM）运行，此时读不到命令行，afc 会改用镜像名 + 内核实际监听的端口来找。

- **多个订阅**：afc 跟着**当前生效的订阅**走 —— 切订阅是客户端的事，不用在 afc 里切。
  两个订阅的组名不一样也能自动认（例如一个叫 `GPT`、另一个叫 `🤖AI网站`）。

## 常见问题

**Clash 里的 GPT 分组老是断开，能不能自动换节点？**
这正是 afc 做的事：每 5 分钟验证一次当前节点，连不上才去扫候选、换成实测能用的那个（能连就绝不动你的选择）。
只在你手动钉了节点的组、或配置里声明过的组上生效，`DIRECT`/`REJECT` 与委托给「自动选择」的组一律不碰。

**系统提示「App 后台活动」显示为 Node.js Foundation？（仅 macOS）**
正常，那就是本项目的定时任务（它执行的是 `node`，macOS 按代码签名主体归类）。
查看或关闭：系统设置 → 通用 → 登录项与扩展；`afc schedule status --verbose` 可核对任务文件路径。

**会改我的 Clash 配置吗？**
不会。afc 只写这几处：系统调度器的任务定义（macOS 的 `~/Library/LaunchAgents/`、
Linux 的 `~/.config/systemd/user/` 或 crontab、Windows 的任务计划程序数据库）、
日志目录（macOS `~/Library/Logs/afc`、Linux `~/.local/state/afc`、Windows `%LOCALAPPDATA%\afc\logs`），
以及你自己用 `afc add` 指定的那份 afc 配置文件。卸载时任务与日志一起删除。

**日志里的运行间隔不均匀（比如 05:33 → 06:15）？**
正常。电脑睡眠期间不触发：systemd 那边靠 `Persistent=true`、launchd 由系统自己补跑，
Windows 上错过的那一次不补，但下一个周期照常（间隔 5 分钟，最多晚几分钟）。

**退出码**：`0` 成功　`2` 未找到可用节点　`3` 环境故障　`64` 用法错误

---

## English

**afc** (auto-fix-clash) keeps a Clash / mihomo proxy group pinned to a node that actually works.

It does not trust latency or node names. It sends a real request to the target site
(for example `chatgpt.com/backend-api/codex/responses`) and reads the response: `405` means the
node is usable, `403` means its exit is country-blocked. When the currently selected node fails,
afc probes the group's candidates and switches to the first one that really works; while the
current node is healthy it changes nothing.

- Cross-platform: macOS (launchd), Linux (systemd user timer, cron fallback), Windows (Task Scheduler)
- Works with Clash Party, Clash Verge / Verge Rev, ClashX Meta or any mihomo kernel —
  Unix socket, Windows named pipe (`\\.\pipe\MihomoParty\mihomo`,
  `\\.\pipe\verge-mihomo-sidecar-*-<hash>`) or external-controller with a secret
- Never rewrites your Clash config: it only switches the selected node through the control API
- Install: `npm i -g auto-fix-clash && afc schedule install` (Node.js ≥ 20)

Keywords: clash, mihomo, clash-meta, clash-verge, clash-party, proxy group auto switch,
node health check, self-healing proxy, latency vs real reachability, ChatGPT / Codex connectivity,
launchd, systemd, Windows Task Scheduler, cross-platform CLI.
