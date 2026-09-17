# auto-fix-clash (`afc`)

为 Clash / mihomo 的代理组挑选**真正可用**的节点。判据不是延迟、也不是"能连上"，而是**目标站点是否真的接受这个出口**。

## 为什么需要它

机场订阅的节点会频繁失效，而"哪个节点能用"无法靠人工或靠名称判断。实测数据（本机真实订阅）：

- 38 个节点里长期有相当一部分整体不可用
- GPT 分组里的**香港节点全部不被 OpenAI 接受**（返回 403）
- **节点名称会说谎**：名为 `香港 20` 的节点实际出口在 JP 且完全可用

## 判据

| 探测端点 | 可用出口 | 被目标站点拒绝的出口 | 能否作判据 |
|---|---|---|---|
| `GET /backend-api/codex/responses` | **405** | **403** | ✅ |
| `GET https://api.openai.com/v1/models` | 401 | 403 | ✅ |
| `GET https://chatgpt.com/` | 403 | 403 | ❌ Cloudflare JS 挑战，无法区分 |

> ⚠️ 两个常见的错误做法：
> 1. 拿站点首页做判据 —— 它对**所有**出口都返回 Cloudflare JS 挑战 403，无法区分"可用"与"被拒绝"。
> 2. 依赖 mihomo 组上的 `expected-status` 让内核自愈 —— 实测 v1.19.27 中 `url-test` 完全忽略该字段、`fallback` 只在手动指定节点时使用它，**周期性健康检查不看状态码**。所以本工具自己发请求、自己读状态码。

## 两种用法

### 1. 手动体检与修复

```bash
afc doctor                 # 逐节点体检：判定 / 状态码 / 出口国家 / 耗时
afc doctor --json          # 机器可读，便于脚本消费
afc fix --group GPT        # 仅在当前节点不可用时才换
afc fix --all              # 修复全部已配置组
```

### 2. 周期性自动修复

```bash
afc schedule install       # 默认每 300 秒运行一次 afc fix --all
afc schedule status        # 查看是否已载入、间隔、最近运行情况
afc schedule uninstall     # 完全移除
```

安装后由 macOS 的 launchd 每隔一段时间拉起一个**一次性短命进程**（无常驻守护）：

- 先只验证该组**当前节点**（1 次探测）；可用就什么都不做 —— 这正是"只在当前节点不可用时才切换"
- 只有当前节点不可用时，才扫描候选并切到实测可用的节点
- **全程不写任何 Clash 配置**，只通过控制端点改变该组的选中节点

## 设计要点

- **通道隔离的探针实例**：探测时临时起一个只含本机节点定义的 mihomo 实例，每个并发通道使用**独立入站端口**并通过 `listeners[].proxy` 绑定到自己的选择器组。通道之间互不干扰，也完全不动你在用的实例。
- **按实测出口判定**，不按节点名称（名称与实际出口经常不一致）。
- **稳态成本受限**：当前节点可用时只有 1 次探测，不会周期性全量扫描整份订阅。
- **零配置写入**：`schedule uninstall` 之后不留任何痕迹，Proxy 行为与安装前一致。
- **只对 Selector 组执行切换**：自动选择型组（URLTest / Fallback）的手动指定会被内核下次体检覆盖，因此遇到这类组会明确报错而不是假装成功。

## 环境要求

- macOS（本期）；Node.js ≥ 22.6（直接运行 TypeScript）
- 本机已存在的 mihomo 内核（Clash Party / Clash Verge 自带；不下载、不内置）
- mihomo 的控制端点：优先从内核进程的 `-ext-ctl-unix` / `-ext-ctl` 参数发现，也支持运行时配置、套接字目录扫描与默认 TCP 端口；支持 secret 认证

## 开发

```bash
pnpm install
pnpm afc doctor            # 直接运行 TypeScript
pnpm typecheck
pnpm test
```

规划文档见 `openspec/changes/add-proxy-group-auto-heal/`（proposal / specs / design / tasks）；
实测证据与验证脚本见 `verification/`。
