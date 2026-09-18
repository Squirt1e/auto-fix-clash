# afc — 让 Clash 代理组自动选中「真正能用」的节点

机场节点经常失效，而"哪个节点能用"没法靠名称或延迟判断。afc 直接请求目标站点、读它的**真实响应**，
挑出能用的节点；当前节点坏掉时自动换掉。

## 不想了解细节，只想让它一直好着

```bash
afc schedule install     # 装完就不用管：每 5 分钟自动体检，节点坏了自己换
afc schedule status      # 想确认时看一眼它在不在跑、最近做了什么
```

装之前想先看看它会动哪些组：

```bash
afc fix --dry-run --verbose
```

**默认处理范围不用你配**：你在 Clash 里**手动钉了某个节点**的组（比如把 GPT 组钉在某个节点上 ——
这类组坏了内核不会替你换）。指向 `DIRECT`/`REJECT` 的组、以及委托给"自动选择"的组都不会被碰。

不满意就一条命令撤掉：`afc schedule uninstall`（全程不改你的 Clash 配置）。

## 它解决什么问题

用真实订阅实测出来的三件事：

1. **延迟最低的节点往往最不能用。** GPT 组里最快的是香港节点（425ms），但它们对 OpenAI 全部返回 `403`，一个都用不了；能用的美国/日本/新加坡节点反而更慢（800–1000ms）。按延迟挑节点必然踩坑。
2. **节点名称会说谎。** 名为「香港 20」的节点，第一次实测出口在 **JP** 且可用，几小时后再测变成 **HK** 且被拒绝。所以只能每次实测。
3. **节点一直在变。** 同一批 38 个节点，几个小时内"能用 → 无响应 → 被拒绝"来回切换，长期有 **30%~45% 不可用**。

## 举个例子

体检 —— 一条命令看清每个节点到底行不行（下面是真实输出）：

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

修复 —— 当前节点坏掉时自动换（也是真实输出）：

```bash
$ afc fix --group GPT
GPT：已切换 [Normal x0.5] 日本 02 → [Normal x0.5] 日本 03
```

如果当前节点还是好的，它什么都不做，只探测这一个节点（约 2 秒）：

```bash
$ afc fix --group GPT
GPT：保持 [Normal x0.5] 日本 03（可用）
```

想让它一直自动做这件事（装一次，之后你什么都不用管）：

```bash
$ afc schedule install
已安装周期性修复任务：每 300 秒运行一次（已载入并触发一次试跑。）
  任务定义：~/Library/LaunchAgents/com.auto-fix-clash.heal.plist
  运行日志：~/Library/Logs/afc/heal.log

$ afc schedule status
周期性修复任务：运行中，每 300 秒
  最近一次：2026-09-18 13:50:55 GPT：保持 [Normal x0.5] 日本 03（可用）
  卸载：afc schedule uninstall　（--verbose 查看路径与显示名）
```

## 安装

### 用 npm（推荐）

```bash
npm i -g auto-fix-clash
afc groups            # 能列出你当前订阅的代理组就算装好了
```

要求：**macOS** + **Node.js ≥ 20**。

内核不用单独装：afc 复用你现有 Clash 客户端自带的 mihomo，不下载、不内置内核。

> 包名是 `auto-fix-clash`。如果安装时提示找不到这个包，说明还没有发布到你的 npm 源，
> 用下面的「从源码」方式即可（功能完全一致）。

### 从源码

```bash
git clone <仓库地址> auto-fix-clash && cd auto-fix-clash
pnpm install
pnpm build
pnpm add -g .         # 装成全局命令（链接到源码目录，改完代码立即生效）
```

从源码开发需要 Node.js ≥ 22.6（直接运行 TypeScript）。

> 三种入口跑的东西不一样，改代码时注意：
> - `pnpm afc <命令>` 直接跑 `src/`（改完立即生效，无需构建）
> - 全局 `afc` 命令走后端 `bin/afc.js`：**有 `dist/` 就用 `dist/`**，所以改完源码要 `pnpm build`
> - `afc schedule install` 安装的定时任务记录的是**安装时那个入口**；从源码目录安装时记的是 `src/cli/index.ts`，改完立即生效

### 先确认它认到了什么

```bash
$ afc groups
组名                    类型      当前选中                 受 afc 管理
-----------------------------------------------------------------------
GPT                     手动选择  [Normal x0.5] 日本 03    是
Netflix                 手动选择  Proxy                    否
Youtube                 手动选择  Proxy                    否
自动选择                自动测速  [Advanced x3] 香港 20    不可切换

让某个组也受管理：在 afc.config.yaml 的 targets 里加一条（组名照抄上表），详见 README。
```

这一条回答两个问题：**有哪些组**（能写进 `--group`）、**哪些组还没被管理**。
`不可切换` 指该组是自动测速类，成员会被内核自己改回去，afc 不会去动它。

排查「它到底认到了什么」时加 `--verbose`：

```bash
$ afc groups --verbose
afc 配置：/Users/you/auto-fix-clash/afc.config.yaml
控制器：unix:/tmp/mihomo-party-502-609.sock（来源：内核进程 16946 的 -ext-ctl-unix）
内核版本：v1.19.27
运行时配置：~/Library/Application Support/mihomo-party/work/config.yaml
```

## 使用

### 平时不用管：装一次自动化

```bash
afc schedule install     # 每 5 分钟自动体检 + 需要时才切换
afc schedule status      # 看它是否在跑、最近一次的结果
afc schedule uninstall   # 彻底移除
```

它由 macOS 的 launchd 每隔几分钟拉起一个**一次性短命进程**，没有常驻守护：

- 先只验证该组**当前节点**；可用就什么都不做
- 只有当前节点不可用时，才按顺序筛查候选并切到第一个实测可用的（找到即停）
- **不写任何 Clash 配置**，只通过控制端点改变该组的选中节点

### 想看看 / 想手动修

```bash
afc groups                    # 当前订阅有哪些组？（确定 --group 该写什么）
afc doctor                    # 体检（默认第一个已配置的组）
afc doctor --group GPT        # 指定组
afc doctor --json             # 机器可读，可直接喂给 jq
afc fix --group GPT           # 只在当前节点不可用时才换
afc fix --all                 # 照顾所有已配置的组
afc fix --dry-run             # 只看会怎么切，不动
afc -v / afc --version        # 版本号
afc <命令> --verbose          # 额外打印诊断信息（控制器来源、配置路径、判定依据）
```

输出默认保持简洁：体检是「一行表头 + 一张表 + 一行汇总」，修复每次只打印一行结果；
进度提示只在终端里以单行覆盖显示，管道和日志里不会出现噪音。

### 给别的组也加上保护

绝大多数情况不用配 —— 你在 Clash 里手动钉了节点的组会被自动接管（用通用可达性判据：
只在节点彻底不通时才换，不会把你特意选的地区换掉）。

想让某个组按**站点级判据**来判（更准，比如"这个出口能不能被 OpenAI 接受"），在 `afc.config.yaml` 里加一条：

```yaml
targets:
  - name: Youtube                     # 组名，要和 Clash 里的组名对得上
    aliases: [🎬媒体解锁, Youtube专用]   # 可选：别的订阅里的叫法
    probe:
      url: https://www.youtube.com/generate_204
      expectedStatus: [204]           # 该站点"能用"时的响应码
    geoProbe:
      url: https://www.youtube.com/cdn-cgi/trace
      format: cloudflare-trace
    countryDeny: [CN]                 # 出口国家黑名单（可选）
```

## 我的客户端不是 Clash Party，能用吗

能。afc 不依赖任何特定客户端 —— 它只需要两样东西：mihomo 的**控制端点**、以及内核**正在使用**的运行时配置。
两者都优先从**运行中的内核进程**读取（`-ext-ctl-unix` / `-ext-ctl` / `-d` 参数），只要该客户端是用 mihomo 内核跑的，这套发现方式就成立。

自动查找顺序：

1. `--controller` / `--secret` 显式指定
2. 运行中内核进程的命令行参数（最可靠，能覆盖"配置里没写控制器"的情况）
3. 运行时配置里的 `external-controller` / `external-controller-unix` / `secret`
4. `/tmp`、`/var/run` 等目录下名字像 mihomo/clash 的套接字
5. 默认 TCP 端口 `127.0.0.1:9090`

认不到时，`afc groups` 会告诉你它找到了什么、用了哪个来源；也可以显式指定：

```yaml
# afc.config.yaml
probe:
  kernelPath: /path/to/mihomo                  # 内核二进制（一般不用写，会自动找）
  runtimeConfigPath: /path/to/config.yaml      # 内核正在用的那份配置
```

```bash
afc groups --controller 127.0.0.1:9097 --secret <你的密钥>
```

已知情况：

| 客户端 | 状态 | 说明 |
|---|---|---|
| Clash Party | ✅ 实测可用 | 控制端点是 `/tmp/mihomo-party-<uid>-<pid>.sock`（路径含 PID，每次启动都变，afc 会自动重新发现）；运行时配置在 `<数据目录>/work/config.yaml` |
| Clash Verge Rev | 机制上支持，未实测 | ⚠️ 新版**默认不监听 TCP**：`config.yaml` 里那行 `external-controller: 127.0.0.1:9097` 并不会真正绑定，照着它连会 connection refused；默认 secret 是 `set-your-secret`。macOS 上要么在 Verge 里启用 TCP 控制器然后用 `--controller 127.0.0.1:9097 --secret <secret>`，要么让 afc 从内核进程参数/Unix 套接字自行发现（参见 [讨论 #6951](https://github.com/clash-verge-rev/clash-verge-rev/discussions/6951)） |
| 独立安装的 mihomo | 机制上支持，未实测 | 用 `-d <目录>` 跑时，afc 会去 `<目录>/config.yaml` 找配置与节点定义；`-ext-ctl` / `-ext-ctl-unix` 会被自动识别 |
| 其它前端 | 机制上支持，未实测 | 先跑 `afc groups` 看发现了什么；认不到就按上面的方式显式指定 |

> 如果你的客户端要用外链的 `proxy-providers` 下发节点，afc 会先在运行时配置里找内联节点，
> 找不到就去订阅档案（`profiles/*.yaml` 之类）里按**与当前组成员的吻合度**挑最匹配的那份。
> 都不行时它会明确告诉你检查了哪些文件，而不会静默失败。

## 有多个订阅时怎么切换

**不用在 afc 里切换** —— 切换订阅是客户端的功能。afc 只处理「当前生效的那个订阅」，而且会自动跟着走：

- 节点定义和代理组都取自**内核当前正在跑的配置**，所以在客户端里换订阅后，下一次 `afc doctor` / `afc fix` 就是新订阅的环境
- 组名不一样也没关系：目标支持 `aliases`，而且匹配分两级 —— **先精确匹配**，再**忽略 emoji 前缀、大小写、空格/短横线/点号**匹配
- 真实例子：本机两个订阅，一个把 GPT 组叫 `GPT`，另一个叫 `🤖AI网站`，内置别名已经能自动认出这两种
- 定时任务跑的是 `fix --all`：**某个目标在当前订阅里不存在时会跳过并说明**，不会报错；只有一个都匹配不上时才以退出码 64 提示你补别名

```bash
afc groups          # 换订阅后先看一眼：现在有哪些组、哪些已被 afc 管理
afc fix --all       # 能管的都会照顾到；不存在的会明确写"跳过（当前订阅没有这个组）"
```

## 常见问题

**系统提示「App 后台活动」显示为 Node.js Foundation？**
正常，那就是本项目的任务。它执行的是 `node`，而 macOS 的后台项列表按被执行程序的**签名主体**归类，
`node` 的签名主体正好是 Node.js Foundation —— 不代表有别的软件被装到了你机器上。
`afc schedule status` 会直接告诉你"系统里显示为：Node.js Foundation"以及任务定义文件的路径。
查看或关闭：系统设置 → 通用 → 登录项与扩展。

**日志里的运行间隔不均匀（比如 05:33 → 06:15）？**
正常。`StartInterval` 型任务在电脑睡眠期间不触发，唤醒后会补跑一次。已用 `pmset -g log` 对齐过。

**会改我的 Clash 配置吗？**
不会。afc 只通过 mihomo 的控制端点切换代理组的选中节点，不写任何配置文件。
唯一写入的位置是 `~/Library/LaunchAgents/` 下的计划任务定义与 `~/Library/Logs/afc/` 下的日志，卸载时一起删除。

**为什么不用内核自带的自动测速组？**
因为实测 mihomo v1.19.27 的组健康检查**不看响应状态码**（`url-test` 完全忽略 `expected-status`，
`fallback` 只在手动指定节点时使用它），所以内核会把返回 403 的香港节点当成"健康"的。afc 自己发请求、自己读状态码。

**退出码**（方便写脚本）：

| 退出码 | 含义 |
|---|---|
| 0 | 成功（找到或保持可用节点） |
| 2 | 未找到可用节点 |
| 3 | 环境故障（控制端点不可达、内核缺失等） |
| 64 | 用法错误（命令写错、组名没配置、订阅里没有该组等） |

## 卸载

```bash
afc schedule uninstall                # 移除定时任务与日志
npm remove -g auto-fix-clash          # 移除全局命令（用哪个工具装的就用哪个卸载）
# 若当时是用 pnpm 装的：pnpm remove -g auto-fix-clash
```

卸载后 Clash 的行为与安装前完全一致（唯一残留是历史上被切换过的组选择，你可以在 Clash 里手动改回）。

## 给维护者

```bash
pnpm install
pnpm test        # 70 个测试
pnpm typecheck
npm pack         # 打包装产物（prepack 会自动构建）
npm publish      # 需要 npm 账号；包名 auto-fix-clash
```

源码结构：`src/controller`（控制端点发现与 API）、`src/probe`（隔离探针实例与判定）、
`src/heal`（粘性修复策略）、`src/schedule`（launchd）、`src/cli`（命令）。

设计依据与被推翻的早期结论：`openspec/changes/add-proxy-group-auto-heal/design.md`、
实测证据：`verification/README.md`。
