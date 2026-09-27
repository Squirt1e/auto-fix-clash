# afc — 让 Clash 代理组自动选中「真正能用」的节点

[English](README.en.md) · Clash / mihomo（Clash Meta）代理组自动测速与自愈。

给它一个稳定的**域名范围**（如 `*.chatgpt.com`），它按当前 mihomo 规则找出实际承载流量的代理组，
再**直接请求目标站点看真实响应**，当前节点挂了自动换。不信延迟也不信节点名：直连
`chatgpt.com/backend-api/codex/responses`，回 `405` 才算可用，`403` 说明出口被地区封。

- 认**域名**而不是组名：每次从 `/rules`、`/proxies`、`/configs` 实时解析，订阅改名改组后自己重新定位
- 只通过控制端点切换组的选中节点，**不写任何 Clash 配置**
- 支持 macOS / Linux / Windows，兼容 Clash Party、Clash Verge（Rev）、ClashX Meta 与任意 mihomo 内核

## 解决什么问题

- 打开 Codex 或 ChatGPT 突然用不了，只能去 Clash 里一个个节点试，试到能连为止
- 延迟最低的那批节点（香港，400ms）偏偏全都用不了；能用的美国节点反而要 900ms
- 叫「香港 20」的节点实测出口在日本，昨天挑好的节点今天又挂了

## 安装与使用

```bash
npm i -g auto-fix-clash            # 要求 Node.js ≥ 20
afc fix '*.chatgpt.com'            # 立即修复（引号避免 shell 展开 *）
afc schedule install               # 装好后每 5 分钟自动巡检
afc schedule add '*.example.com'   # 想管别的站点：登记范围
afc schedule list                  # 查看已登记范围
```

`*.` **同时包含裸域**和任意层级子域名。不想用了：`afc schedule uninstall`。自定义站点若不能用通用状态码判断，给 `afc schedule add` 加 `--url` / `--expect`（还可加 `--country-deny`），详见 `afc schedule --help`。

## 看看效果

```bash
$ afc fix '*.chatgpt.com'
*.chatgpt.com → GPT
  chatgpt.com：规则 #1904 DOMAIN-SUFFIX,chatgpt.com → GPT（功能已验证）
  afc-route-probe.chatgpt.com：规则 #1904 DOMAIN-SUFFIX,chatgpt.com → GPT（功能已验证）
GPT：已切换 [Normal x0.5] 日本 02 → [Normal x0.5] 日本 03
```

`规则 #N` 是人看的一基编号（`--verbose` 时另附 `(API index N-1)` 供对照控制 API）。当前节点可用时
什么都不做，只探测这一个节点（约 2 秒），最后一行变成 `GPT：保持 …（可用）`；`--force` 会主动轮换。

## 常用命令

| 命令 | 作用 |
|---|---|
| `afc fix '<域名>'` / `--force` / `--dry-run` | 解析路由并修复 / 强制轮换 / 只看不切 |
| `afc schedule add`·`list`·`remove` | 管理定时修复的域名范围 |
| `afc schedule install`·`uninstall`·`status` | 安装 / 卸载 / 查看定时任务 |
| `afc groups` / `afc doctor` | 看当前订阅的组 / 逐节点体检（按组，不接受域名参数） |

任何命令加 `--help` 看详细用法。旧版按组模式（`afc add`、`afc fix --group/--all`）仍然保留。

## 行为边界

- 不碰 `DIRECT`/`REJECT` 等内建策略，也不强行钉住 URLTest、Fallback、LoadBalance 等自动组；
  落到 `MATCH`（兜底规则）的路径同样会修复
- 路由判定**不猜**：能证明的才确认 —— 从当前运行配置补回 `no-resolve`，用 mihomo 自己的 DNS 逐个地址
  验证 `IP-CIDR`/`IP-CIDR6`；`RULE-SET`、`GEOSITE`、GEOIP/ASN、进程或入站条件等证明不了的规则会报
  「不完整」并返回退出码 3，绝不猜一个组去切换
- 其它域名默认按 HTTPS 200–399 判定，只代表“可达”，不代表登录或全部业务功能可用

**退出码**：`0` 成功　`2` 未找到可用节点　`3` 结果不完整或环境故障　`64` 用法错误

## 配置

可选，字段与默认值见 [`afc.config.yaml`](afc.config.yaml)。查找顺序：`--config` → `./afc.config.yaml` → `~/.config/afc/config.yaml`；`domains: []` 表示禁用全部定时域名。

## 要求与排查

Node.js ≥ 20（macOS / Linux / Windows）。探测节点需要一个 mihomo 可执行文件——afc 不下载、不内置内核，
通常能自动找到你客户端旁边的那个。

认不到控制端点、Windows 命名管道、WSL、找不到内核、定时任务异常、结果报「不完整」等，见
[`docs/troubleshooting.md`](docs/troubleshooting.md)。

## License

MIT — 见 [LICENSE](LICENSE)。
