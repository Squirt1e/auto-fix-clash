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
- The node labelled “Hong Kong 20” exits in Japan, and yesterday's good node is dead today

## Install and use

```bash
npm i -g auto-fix-clash            # Node.js >= 20
afc                              # open the menu: groups / websites / timer / settings
afc fix '*.chatgpt.com'            # repair now (quote the * so your shell keeps it)
afc schedule install               # then re-check every 5 minutes
afc schedule add '*.example.com'   # manage another site: register its scope
afc schedule list                  # list registered scopes
```

For everyday use, run `afc`: use ↑↓ to select, ← to go back, and → or Enter to confirm a menu option. Left and right arrows still move the cursor in text inputs. The menu uses a separate screen for the current page, preserves selections and searches when you return, and restores your terminal on exit. Use PgUp/PgDn for long results; type to filter lists and press Tab to switch between the search field and menu options. The menu can inspect, probe and repair groups, add websites, and manage bindings and scheduled repairs. For binding changes, you exit and start Clash Party manually; the menu never restarts the client. Offline saves are marked as awaiting activation checks. The existing commands remain available through `afc --help`; pipes and scripts do not open the menu. Menu labels and messages are in Chinese.

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

## Bind a domain when route resolution fails

Binding initially supports **macOS Clash Party with inline node definitions**:

```bash
afc bind '*.chatgpt.com' --group 'GPT' --restart-client
afc bind '*.chatgpt.com' --group 'AFC-AI' --create --restart-client
afc fix '*.chatgpt.com'
```

For manual lifecycle control, exit Party yourself, then use `--offline --client-dir <Party data directory>` instead of `--restart-client`. AFC refuses offline writes while Party is running. Start Party yourself and verify with `afc bind --list`; offline saving does not prove activation.

The current subscription receives persistent overrides and leading domain rules. `--restart-client` permits a brief client restart, interrupting proxy connections. Use `--dry-run` to preview, `--replace` to change a binding or its probe policy, and `afc bind --list` to inspect bindings. Names are exact, not group indices. New groups automatically collect inline nodes after subscription updates.

`afc unbind '*.chatgpt.com' --restart-client` removes the binding, retaining created groups to protect external references. Existing groups retain their members and selection. Binding does not run repair or register a scheduled target. All probe policies of domains sharing a group constrain future repairs.

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
