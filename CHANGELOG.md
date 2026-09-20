# 更新日志

## 1.1.1

修掉 Windows 上认不到 Clash Verge / Clash Party 控制端点的问题。

- 控制端点发现补齐 Windows 实际形态：运行时配置里的 `external-controller-pipe`、按用户 SID 推导的
  Clash Verge 管道（`\\.\pipe\verge-mihomo-sidecar-<release|dev>-<hash>`）、命名管道枚举、
  Clash Party 的 `\\.\pipe\MihomoParty\mihomo`、内核实际监听的端口，以及 Verge 的默认端口 9097。
- 内核进程在服务模式下读不到命令行时改用镜像名识别；配置里的 `secret` 会自动补到其它候选上。
- 认不到端点时的输出重做：标出每个候选的来源，直接给出发现的可用端点与可粘贴的 `--controller` 写法，
  `--verbose` 在发现失败时也会打印「afc 找了哪些地方」。

## 1.1.0

- 支持 macOS / Linux / Windows 三平台，兼容 Clash Verge (Rev)、ClashX Meta 等其它客户端与任意 mihomo 内核。
- 发布走 npm trusted publishing：打 `v*` tag 自动出包并发版。

## 1.0.0

- 首个可用版本：按目标站点的真实响应判定节点可用性，坏节点自动切换，并装好定时巡检。
