# afc — keep your Clash proxy group on a node that actually works

[中文](README.md) · Automatic health-checking and self-healing for Clash / mihomo (Clash Meta) proxy groups.

Give it a stable **domain scope** (e.g. `*.chatgpt.com`) and it resolves that scope against the live
mihomo rule list to find the group that actually carries your traffic, then **sends a real request to
the target site** and switches when the current node dies. It trusts neither latency nor node names:
`chatgpt.com/backend-api/codex/responses` returning `405` means usable, `403` means the exit is
country-blocked.

- Scoped by **domain**, not by group name: re-resolved from `/rules`, `/proxies`, `/configs` every run,
  so a renamed or reshuffled subscription keeps working
- Only switches the selected node through the control API — **never rewrites your Clash config**
- macOS / Linux / Windows, with Clash Party, Clash Verge (Rev), ClashX Meta or any mihomo kernel

## What it solves

- Codex or ChatGPT suddenly stops working and you end up trying nodes one by one in Clash
- The lowest-latency nodes (Hong Kong, 400ms) are exactly the unusable ones; the US node that works takes 900ms
- The node labelled “Hong Kong 20” exits in Japan, and yesterday's good node is dead today

## Install and use

```bash
npm i -g auto-fix-clash            # Node.js >= 20
afc fix '*.chatgpt.com'            # repair now (quote the * so your shell keeps it)
afc schedule install               # then re-check every 5 minutes
afc schedule add '*.example.com'   # manage another site: register its scope
afc schedule list                  # list registered scopes
```

`*.` includes the **apex domain itself** and every subdomain level. To stop: `afc schedule uninstall`.

## Output and commands

The CLI reports in Chinese: a `*.chatgpt.com → GPT` header, then one `规则 #N <TYPE>,<payload> → <group>`
evidence line per witness host, then the outcome line. `规则 #N` is the human-facing one-based rule number
(`--verbose` adds `(API index N-1)` for the control API). While the current node is healthy nothing is
changed and only that node is probed (~2s); `--force` rotates anyway.

| Command | Purpose |
|---|---|
| `afc fix '<domain>'` / `--force` / `--dry-run` | resolve the route and repair / rotate anyway / preview only |
| `afc schedule add`·`list`·`remove` | manage the domain scopes used by the timer |
| `afc schedule install`·`uninstall`·`status` | install / remove / inspect the scheduled task |
| `afc groups` / `afc doctor` | list proxy groups / probe every node (group-based, no domain argument) |

Add `--help` to any command. The legacy group-based mode (`afc add`, `afc fix --group/--all`) is still available.

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
scheduled domains explicitly.

## Requirements and troubleshooting

Node.js >= 20 (macOS / Linux / Windows). Probing nodes needs a mihomo executable — afc neither
downloads nor bundles a kernel, and normally finds the one next to your client.

Control endpoint not found, Windows named pipes, WSL, missing kernel, odd scheduled-task behaviour, or
an “incomplete” result: see [`docs/troubleshooting.md`](docs/troubleshooting.md) (in Chinese).

## License

MIT — see [LICENSE](LICENSE).
