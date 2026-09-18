# afc — 让 Clash 代理组自动选中「真正能用」的节点

机场节点经常失效，而"哪个节点能用"没法靠名称或延迟判断。afc 直接请求目标站点、读它的**真实响应**，
挑出能用的节点；当前节点坏掉时自动换掉。

## 它解决什么问题

用你这份真实订阅实测出来的三件事：

1. **延迟最低的节点往往最不能用。** GPT 组里最快的是香港节点（425ms），但它们对 OpenAI 全部返回 `403`，一个都用不了；能用的美国/日本/新加坡节点反而更慢（800–1000ms）。按延迟挑节点必然踩坑。
2. **节点名称会说谎。** 名为「香港 20」的节点，第一次实测出口在 **JP** 且可用，几小时后再测变成 **HK** 且被拒绝。所以只能每次实测。
3. **节点一直在变。** 同一批 38 个节点，几个小时内"能用 → 无响应 → 被拒绝"来回切换，长期有 **30%~45% 不可用**。

## 举个例子

体检 —— 一条命令看清每个节点到底行不行（下面是真实输出）：

```
$ afc doctor
代理组 GPT（当前：[Normal x0.5] 日本 02）
判据：chatgpt.com/backend-api/codex/responses + api.openai.com/v1/models

节点                          判定      状态码  出口  耗时     依据
  [Advanced x3] 香港 18       被拒绝    403     HK    425ms    目标站点拒绝该出口（HTTP 403）
  [Advanced x3] 香港 20       被拒绝    403     HK    441ms    目标站点拒绝该出口（HTTP 403）
  [Normal] 美国 03            可用      405     US    829ms    通过 405
  [Normal x0.5] 新加坡 04     可用      405     SG    860ms    通过 405
  [Priority x2] 日本 14       死节点    —       —     —        无 HTTP 响应（重试 2 次）
* [Normal x0.5] 日本 02       可用      405     JP    998ms    通过 405

汇总：可用 19 / 被拒绝 13 / 死节点 6（共 38，* 为当前节点）
```

修复 —— 当前节点坏掉时自动换（也是真实输出）：

```
$ afc fix --group GPT
2026-09-18 13:11:21 GPT: 已切换 [Normal x0.5] 日本 02 → [Normal x0.5] 日本 03
  依据：当前节点不可用（重试 2 次后仍无 HTTP 响应）；切换到实测可用节点（返回 405，出口 JP，625ms）
  已通过控制端点更新该组选择；未修改任何配置文件。
```

如果当前节点还是好的，它什么都不做，只探测这一个节点（约 2 秒）：

```
$ afc fix --group GPT
GPT: 保持 [Normal x0.5] 日本 03（可用，未做改动）
```

## 安装

**需要**：macOS、Node.js ≥ 22.6、以及**正在运行的** Clash Party（或 Clash Verge）。
afc 复用你现有的 mihomo 内核，不下载、不内置内核。

```bash
cd ~/Projects/AI/auto-fix-clash
pnpm install        # 安装依赖
pnpm add -g .       # 可选：把 afc 装成全局命令（之后任意目录都能用 afc）
```

验证一下：

```bash
afc doctor          # 能打印出上面那张体检表就装好了
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
- 只有当前节点不可用时，才扫描候选并切到实测可用的节点（找到即停）
- **不写任何 Clash 配置**，只通过控制端点改变该组的选中节点

### 想看看 / 想手动修

```bash
afc doctor                    # 体检（默认第一个已配置的组）
afc doctor --group GPT        # 指定组
afc doctor --json             # 机器可读，可直接喂给 jq
afc fix --group GPT           # 只在当前节点不可用时才换
afc fix --all                 # 修所有已配置的组
afc fix --dry-run             # 只看会怎么切，不动
```

### 给别的组也加上保护

只改 `afc.config.yaml`，不用改代码：

```yaml
targets:
  - name: Youtube                     # 组名，要和 Clash 里的组名一致
    probe:
      url: https://www.youtube.com/generate_204
      expectedStatus: [204]
    geoProbe:
      url: https://www.youtube.com/cdn-cgi/trace
      format: cloudflare-trace
    countryDeny: [CN]                 # 出口国家黑名单（可选）
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
| 64 | 用法错误（命令写错、组名没配置等） |

## 卸载

```bash
afc schedule uninstall        # 移除定时任务与日志
pnpm remove -g auto-fix-clash # 移除全局命令（如果装过）
```

卸载后 Clash 的行为与安装前完全一致（唯一残留是历史上被切换过的组选择，你可以在 Clash 里手动改回）。

## 想深入了解

- 设计与决策依据（含被否决的方案）：`openspec/changes/add-proxy-group-auto-heal/design.md`
- 实测证据与被推翻的早期结论：`verification/README.md`
- 需求规格：`openspec/changes/add-proxy-group-auto-heal/specs/`

开发：`pnpm typecheck`、`pnpm test`（58 个测试）。
