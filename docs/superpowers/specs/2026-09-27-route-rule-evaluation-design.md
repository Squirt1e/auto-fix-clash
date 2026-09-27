# Route rule evaluation hardening

## Intent and success criteria

`afc fix <domain>` must continue through rules that are provably irrelevant to the requested domain instead of treating every unsupported rule type as an immediate ambiguity. In particular, a target-IP rule carrying `no-resolve` cannot match a domain before any earlier rule has resolved that domain, so it must not hide a later `DOMAIN-SUFFIX` rule.

The resolver remains conservative: it may switch a group only when ordered mihomo rule evaluation proves the route. Missing metadata, conflicting DNS answers, provider-backed rules, process conditions, and other context-dependent predicates remain incomplete rather than guessed. The change must solve the current Clash Party configuration, where private `IP-CIDR,...,no-resolve` rules precede `DOMAIN-SUFFIX,chatgpt.com`, without weakening the existing no-guess guarantee.

Success means:

- `afc fix 'chatgpt.com'` and `afc fix '*.chatgpt.com'` can pass the leading private `no-resolve` IP rules and confirm the later ChatGPT policy.
- ordinary target-IP CIDR rules can be evaluated using mihomo's own DNS answers when their result is unambiguous;
- directly evaluable domain rule types participate with correct first-match ordering;
- uncertain routing still produces exit code 3 and never changes a Selector;
- diagnostics use a human-facing one-based rule number while preserving the API's zero-based index when useful.

## Authority and rule enrichment

The live controller remains the authority for current rule order, disabled state, hit metadata, proxies, and mode. The `/rules` response does not expose modifiers such as `no-resolve`, so AFC also reads the runtime YAML path it already discovers for the active mihomo process.

Build an enriched rule stream as follows:

1. Read `/rules` and preserve its zero-based `index` ordering.
2. Parse the top-level runtime `rules` sequence without modifying the file.
3. Align each YAML rule to its controller rule only when index, normalized type, payload, and proxy agree.
4. Copy recognized modifiers such as `no-resolve` into the live rule model.
5. If the files are unavailable or an entry does not align, leave its modifiers unknown. Unknown metadata must never be treated as the absence of a modifier.

The resolver must not depend on subscription source files because they may differ from the running configuration. It must not reload or rewrite mihomo configuration.

## Three-state ordered evaluator

Replace the current supported/unsupported split with a sequential evaluator that returns one of:

- `match`: the predicate definitely matches; stop at this rule;
- `miss`: the predicate definitely does not match; continue;
- `unknown`: available evidence cannot decide; stop and report incomplete.

Evaluation context contains the concrete witness host, optional A/AAAA answers, whether destination resolution has already been triggered, and the rule-enrichment confidence. Disabled rules remain skipped.

### Domain predicates

Evaluate `DOMAIN`, `DOMAIN-SUFFIX`/`DomainSuffix`, `DOMAIN-KEYWORD`, `DOMAIN-WILDCARD`, and `DOMAIN-REGEX` locally with mihomo-compatible normalization. Invalid regex or malformed payload is `unknown`, not `miss`. `MATCH` always returns `match`.

### Target-IP predicates

For `IP-CIDR` and `IP-CIDR6`:

- if `no-resolve` is confirmed and no earlier rule has triggered destination resolution, return `miss` without a DNS query;
- otherwise query both A and AAAA, as enabled by the running core, through the controller's `/dns/query` endpoint and mark the context resolved;
- evaluate the CIDR against every returned destination address;
- if all possible addresses produce the same ordered routing outcome, that outcome may be confirmed;
- if answers split across different first-match policies, DNS fails, or required modifier metadata is unknown, return `unknown`.

The evaluator must use controller DNS rather than operating-system DNS because fake-IP, nameserver policy, fallback, and cache behavior can differ. DNS answers are cached once per witness for the duration of a repair run.

Other target-IP predicates such as `GEOIP`, `IP-ASN`, and `IP-SUFFIX` remain `unknown` until equivalent semantics can be proven.

### Context-dependent and provider predicates

`RULE-SET`, `GEOSITE`, source-IP, process, inbound, port, network, logical, and sub-rule predicates remain `unknown` unless a later dedicated evaluator can reproduce their full semantics and precedence. A future live-observation fallback may corroborate exact real hosts, but it is outside this change and must never be used to claim exhaustive wildcard coverage.

## DNS branching and route confirmation

Multiple DNS answers cannot be collapsed with an arbitrary `any` or `first` rule. For a witness that needs destination IP evaluation, replay the remaining ordered rules for each address. Confirm a binding only when every viable address reaches the same effective policy resolution. If one answer reaches a different group, a skipped built-in policy, or an unknown predicate, report the witness as unresolved.

Wildcard handling keeps the current apex-inclusive semantics and witness generation. Each witness is evaluated independently; bindings that resolve to the same final mutable Selector are deduplicated while retaining all evidence.

## Component changes

- `controller/client`: add the typed controller DNS query and retain controller rule indexes.
- `runtime-config/rules`: parse and align active YAML rule modifiers without exposing unrelated configuration or secrets.
- `routes/resolver`: introduce the three-state evaluator and asynchronous DNS-aware route traversal. Policy-chain resolution remains separate and unchanged.
- `heal/domain-repair` and CLI coordination: await route resolution, aggregate incomplete results as today, and perform no switch when a required witness is unresolved.
- output formatting: display `rule.index + 1`; optionally add `API index N` in verbose diagnostics.

Rule parsing, metadata enrichment, predicate evaluation, DNS lookup, and policy-chain resolution must remain separate units so each can be tested without a live controller.

## Failure handling and diagnostics

Diagnostics should state what evidence was missing rather than labeling every rule type generically:

- confirmed `no-resolve` skip: verbose evidence only, not an error;
- runtime rule metadata unavailable or misaligned: identify the API index and missing modifier confidence;
- DNS failure: identify witness and query type;
- conflicting A/AAAA routes: list the conflicting policies without choosing one;
- unsupported predicate: name its one-based rule number, type, and payload.

Exit-code priority remains unchanged: incomplete routing or environment failure is 3, no verified alternative is 2, success is 0, and invalid usage is 64.

## Verification

Unit tests must cover:

- leading `IP-CIDR,...,no-resolve` rules followed by a matching domain suffix;
- a missing or misaligned runtime rule entry remaining unknown;
- ordinary IPv4 and IPv6 CIDR hit and miss using literal controller DNS fixtures;
- multiple DNS answers that agree versus conflict;
- DNS failure and empty answers;
- domain keyword, wildcard, and regex ordering and shadowing;
- prior resolution causing a later `no-resolve` IP rule to participate;
- disabled rules, `MATCH`, exact hosts, wildcard apex and subdomain witnesses;
- one-based user diagnostics versus zero-based API indexes;
- unresolved witnesses preventing every associated switch.

Integration tests should feed a runtime YAML rule list and matching `/rules` response through the real enrichment and resolver boundaries. The existing full suite, typecheck, build, and a live `--dry-run` against the current Clash Party configuration must pass before installation or release.

## Delivery stages

The implementation may be committed in two functional stages while preserving a green tree:

1. rule enrichment plus `no-resolve` and direct domain-predicate evaluation, which fixes the current configuration;
2. controller DNS plus unambiguous IP-CIDR branching.

Live connection/log observation for provider-backed and context-dependent rules is explicitly deferred. It requires a separate design because generating traffic introduces side effects and still cannot prove an infinite wildcard domain set.
