# afc — 让 Clash 代理组自动选中「真正能用」的节点

[English](README.en.md) · Clash / mihomo（Clash Meta）代理组自动测速与自愈。

给它一个稳定的**域名范围**（如 `*.chatgpt.com`），它按当前 mihomo 规则找出实际承载流量的代理组，
再**直接请求目标站点看真实响应**，当前节点挂了自动换。不信延迟也不信节点名：直连
`chatgpt.com/backend-api/codex/responses`，回 `405` 才算可用，`403` 说明出口被地区封。

- 认**域名**而不是组名：每次从 `/rules`、`/proxies`、`/configs` 实时解析，订阅改名改组后自己重新定位
- `fix` 只通过控制端点切换节点；`bind` / `unbind` 管理客户端的持久化覆写与前置规则
- 支持 macOS / Linux / Windows，兼容 Clash Party、Clash Verge（Rev）、ClashX Meta 与任意 mihomo 内核

## 解决什么问题

- 打开 Codex 或 ChatGPT 突然用不了，只能去 Clash 里一个个节点试，试到能连为止
- 延迟最低的那批节点（香港，400ms）偏偏全都用不了；能用的美国节点反而要 900ms
- 名字写着「香港」的节点，实测出口却在日本；昨天挑好的节点今天又挂了

## 安装

```bash
npm i -g auto-fix-clash   # 要求 Node.js ≥ 20
afc                       # 打开菜单
```

## 使用

输入 `afc` 打开菜单：代理组（修复 / 检测 / 查看节点）、网站（添加、修复、绑定、定时）、定时（开关与
间隔）、设置（连接客户端、探测参数）。↑↓ 选择，Enter 确认，← 返回，Ctrl+C 退出；管道和脚本里不会
打开菜单。在菜单里绑定和解绑需要你手动退出并重新启动 Clash Party，菜单不会重启客户端。

脚本里直接用命令：

| 命令 | 作用 |
|---|---|
| `afc fix '<域名>'` | 立即解析路由并把该网站换到可用节点（`--force` 强制轮换，`--dry-run` 只看不切） |
| `afc schedule add`·`list`·`remove` | 管理定时巡检的域名范围（`add` 可加 `--url` / `--expect` 自定义判据） |
| `afc schedule install`·`status`·`uninstall` | 安装 / 查看 / 卸载定时任务（默认每 300 秒） |
| `afc bind`·`unbind`·`--list` | 绑定 / 解除 / 查看域名绑定（`--restart-client` 允许短暂重启客户端） |
| `afc groups` / `afc doctor` | 看当前订阅的组 / 按组体检节点 |

首版绑定只支持 macOS Clash Party（内联节点订阅），且只作用于当前订阅。例如
`afc bind '*.chatgpt.com' --group '示例组' --restart-client` 把网站固定到某个组（`--create` 建新组）；
绑定后用 `afc fix` 或等定时巡检，解除时自建组会保留。`*.chatgpt.com` 同时包含裸域和所有子域名；
完整参数见 `afc --help` 与 `afc <命令> --help`。

## 看看效果

示例输出（组名、节点名与规则编号均为脱敏后的示意）：

```bash
$ afc fix '*.chatgpt.com'
*.chatgpt.com → GPT
  chatgpt.com：规则 #12 DOMAIN-SUFFIX,chatgpt.com → GPT（功能已验证）
  afc-route-probe.chatgpt.com：规则 #12 DOMAIN-SUFFIX,chatgpt.com → GPT（功能已验证）
GPT：已切换 [示例] 日本 01 → [示例] 日本 02
```

`规则 #N` 是人看的一基编号（`--verbose` 时另附 `(API index N-1)` 供对照控制 API）。当前节点可用时
什么都不做，只探测这一个节点（约 2 秒），最后一行变成 `GPT：保持 …（可用）`；`--force` 会主动轮换。

## 行为边界

- 不碰 `DIRECT`/`REJECT` 等内建策略，也不强行钉住 URLTest、Fallback、LoadBalance 等自动组；
  落到 `MATCH`（兜底规则）的路径同样会修复
- 路由判定**不猜**：能证明的才确认 —— 从当前运行配置补回 `no-resolve`，用 mihomo 自己的 DNS 逐个地址
  验证 `IP-CIDR`/`IP-CIDR6`；`RULE-SET`、`GEOSITE`、GEOIP/ASN、进程或入站条件等证明不了的规则会报
  「不完整」并返回退出码 3，绝不猜一个组去切换
- 其它域名默认按 HTTPS 200–399 判定，只代表“可达”，不代表登录或全部业务功能可用

**退出码**：`0` 成功　`2` 未找到可用节点　`3` 结果不完整或环境故障　`64` 用法错误

## 配置

可选，字段与默认值见 [`afc.config.yaml`](afc.config.yaml)。查找顺序：`--config` → `./afc.config.yaml`
→ `~/.config/afc/config.yaml`；`domains: []` 表示禁用全部定时域名。菜单改设置时写回同一份配置。

## 要求与排查

Node.js ≥ 20（macOS / Linux / Windows）。探测节点需要一个 mihomo 可执行文件——afc 不下载、不内置内核，
通常能自动找到你客户端旁边的那个。

认不到控制端点、Windows 命名管道、WSL、找不到内核、定时任务异常、结果报「不完整」等，见
[`docs/troubleshooting.md`](docs/troubleshooting.md)。

## License

MIT — 见 [LICENSE](LICENSE)。
