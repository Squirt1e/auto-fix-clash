# 更新日志

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
