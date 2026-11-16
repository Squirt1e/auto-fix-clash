# afc — keep your Clash proxy group on a node that actually works

[中文](README.md) · Automatic health-checking and self-healing for Clash / mihomo (Clash Meta) proxy groups.

Give it a stable **domain scope** (e.g. `*.chatgpt.com`) and it resolves that scope against the live
mihomo rule list to find the group that actually carries your traffic, then **sends a real request to
the target site** and switches when the current node dies. It trusts neither latency nor node names:
`chatgpt.com/backend-api/codex/responses` returning `405` means usable, `403` means the exit is
country-blocked.

- Scoped by **domain**, not by group name: re-resolved from `/rules`, `/proxies`, `/configs` every run,
  so a renamed or reshuffled subscription keeps working
- `fix` switches nodes only through the control API; explicit `bind` / `unbind` manage persistent client overrides and routing rules
- macOS / Linux / Windows, with Clash Party, Clash Verge (Rev), ClashX Meta or any mihomo kernel

## What it solves

- Codex or ChatGPT suddenly stops working and you end up trying nodes one by one in Clash
- The lowest-latency nodes (Hong Kong, 400ms) are exactly the unusable ones; the US node that works takes 900ms
- The node labelled “Hong Kong” actually exits in Japan, and yesterday's good node is dead today

## Install

```bash
npm i -g auto-fix-clash   # Node.js >= 20
afc                       # open the menu
```

## Usage

Run `afc` to open the menu: 代理组 (repair / probe / list nodes), 网站 (add, repair, bind, timer), 定时
(on/off and interval) and 设置 (client connection, probe settings). ↑↓ select, Enter confirm, ← back,
Ctrl+C exit; pipes and scripts get plain output instead of the menu. Binding and unbinding from the menu
require you to quit and restart Clash Party yourself — the menu never restarts the client.

Commands for scripts:

| Command | Purpose |
|---|---|
| `afc fix '<domain>'` | resolve the route and switch the site to a usable node (`--force` rotates anyway, `--dry-run` previews) |
| `afc schedule add`·`list`·`remove` | manage the domain scopes used by the timer (`add` accepts `--url` / `--expect`) |
| `afc schedule install`·`status`·`uninstall` | install / inspect / remove the scheduled task (default every 300s) |
| `afc bind`·`unbind`·`--list` | bind / unbind / inspect domain bindings (`--restart-client` allows a brief restart) |
| `afc groups` / `afc doctor` | list groups / probe nodes per group |

Binding supports macOS Clash Party with inline node definitions and applies to the current subscription
only, e.g. `afc bind '*.chatgpt.com' --group 'my-group' --restart-client` (`--create` makes a new group);
choose `afc fix` afterwards or wait for the timer, and unbinding keeps created groups. `*.chatgpt.com`
covers the apex and every subdomain; `afc --help` and `afc <command> --help` list every option.

## Output

The CLI reports in Chinese: a `*.chatgpt.com → GPT` header, then one `规则 #N <TYPE>,<payload> → <group>`
evidence line per witness host, then the outcome line. `规则 #N` is the human-facing one-based rule number
(`--verbose` adds `(API index N-1)` for the control API). While the current node is healthy nothing is
changed and only that node is probed (~2s); `--force` rotates anyway. Examples in this document are
anonymized.

## Behaviour and limits

- Never touches built-in policies such as `DIRECT`/`REJECT`, and never pins URLTest, Fallback or
  LoadBalance groups; routes falling through to `MATCH` are repaired too
- Route evaluation **never guesses**: what can be proven is confirmed — `no-resolve` is recovered from
  the running config and `IP-CIDR`/`IP-CIDR6` are validated through mihomo's own DNS, one address at a
  time. `RULE-SET`, `GEOSITE`, `GEOIP`/`IP-ASN`, process and inbound conditions cannot be proven, so the
  run reports “incomplete” and exits with code `3` instead of switching on a guess
- Other domains default to an HTTPS 200–399 check, which proves reachability only — not login or full service

**Exit codes**: `0` success, `2` no usable node, `3` incomplete or environment failure, `64` usage error

## Configuration

Optional. Lookup order: `--config <path>` → `./afc.config.yaml` → `~/.config/afc/config.yaml`.
See [`afc.config.yaml`](afc.config.yaml) for every field and default; `domains: []` disables all
scheduled domains explicitly. Settings changed in the menu are written back to the same file.

## Requirements and troubleshooting

Node.js >= 20 (macOS / Linux / Windows). Probing nodes needs a mihomo executable — afc neither
downloads nor bundles a kernel, and normally finds the one next to your client.

Control endpoint not found, Windows named pipes, WSL, missing kernel, odd scheduled-task behaviour, or
an “incomplete” result: see [`docs/troubleshooting.md`](docs/troubleshooting.md) (in Chinese).

## License

MIT — see [LICENSE](LICENSE).
