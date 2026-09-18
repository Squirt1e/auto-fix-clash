# afc — 让 Clash 代理组自动选中「真正能用」的节点

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
  认不到时先跑 `afc groups --verbose` 看它找到了什么，再用 `--controller` / `--secret` 手动指定。
- **多个订阅**：afc 跟着**当前生效的订阅**走 —— 切订阅是客户端的事，不用在 afc 里切。
  两个订阅的组名不一样也能自动认（例如一个叫 `GPT`、另一个叫 `🤖AI网站`）。

## 常见问题

**系统提示「App 后台活动」显示为 Node.js Foundation？（仅 macOS）**
正常，那就是本项目的定时任务（它执行的是 `node`，macOS 按代码签名主体归类）。
查看或关闭：系统设置 → 通用 → 登录项与扩展；`afc schedule status --verbose` 可核对任务文件路径。

**会改我的 Clash 配置吗？**
不会。afc 只写这几处：系统调度器的任务定义（macOS 的 `~/Library/LaunchAgents/`、
Linux 的 `~/.config/systemd/user/` 或 crontab、Windows 的任务计划程序数据库）、
日志目录（macOS `~/Library/Logs/afc`、Linux `~/.local/state/afc`、Windows `%LOCALAPPDATA%\afc\logs`），
以及你自己用 `afc add` 指定的那份 afc 配置文件。卸载时任务与日志一起删除。

**日志里的运行间隔不均匀（比如 05:33 → 06:15）？**
正常。电脑睡眠期间不触发，唤醒后会补跑一次（systemd 那边靠 `Persistent=true`，launchd 由系统自己补）。

**退出码**：`0` 成功　`2` 未找到可用节点　`3` 环境故障　`64` 用法错误
