# Route Rule Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let manual and scheduled domain repair pass provably irrelevant `no-resolve` IP rules and safely evaluate direct domain and unambiguous IP-CIDR routes.

**Architecture:** Enrich the live `/rules` stream with modifiers recovered from the active runtime YAML, then evaluate ordered rules with `match`/`miss`/`unknown` results. Use mihomo's `/dns/query` only when a target-IP rule requires resolution, branch across every A/AAAA answer, and confirm a route only when all branches reach the same effective policy.

**Tech Stack:** TypeScript ESM, Node.js 20.11+, Node test runner, `yaml`, mihomo external-controller API.

**Spec:** `docs/superpowers/specs/2026-09-27-route-rule-evaluation-design.md`

## Global Constraints

- The live controller remains authoritative for rule order, disabled state, proxies, and mode; runtime YAML only enriches missing modifiers.
- Never rewrite or reload mihomo configuration while resolving routes.
- Unknown metadata, DNS failure, conflicting address routes, and unsupported predicates remain incomplete with exit code 3 and must never trigger a Selector switch.
- Use controller DNS rather than operating-system DNS.
- `*.example.com` remains apex-inclusive and every generated witness is resolved independently.
- Manual `fix` and `fix --scheduled --quiet` must use the same `repairDomains` and route evaluator path.
- No new runtime dependency is required.

## Review Focus

- Missing or unreadable runtime YAML must leave target-IP modifiers unknown and prevent a switch; Task 2 adds this regression.
- A runtime rule whose index or normalized signature differs from `/rules` must not lend its `no-resolve` flag to another live rule; Task 1 tests misalignment.
- Multiple A/AAAA answers that reach different policies must report incomplete instead of selecting the first answer; Task 3 tests agreement and conflict.
- Malformed regex/CIDR payloads must return `unknown`, not crash or silently miss; Tasks 2 and 3 add literal malformed fixtures.
- Scheduled quiet execution must load the same runtime metadata and return the same incomplete/success status as interactive domain repair; Task 4 pins the shared dispatch path and log behavior.

---

## File structure

- Create `src/routes/runtime-rules.ts`: parse runtime YAML rule scalars, select the active runtime config, and enrich matching live rules.
- Create `src/routes/ip-cidr.ts`: dependency-free IPv4/IPv6 CIDR parsing and membership checks.
- Modify `src/paths.ts`: expose the top-level runtime `rules` array in `RuntimeConfigSummary`.
- Modify `src/controller/client.ts`: expose controller-backed A/AAAA resolution.
- Modify `src/routes/resolver.ts`: async three-state ordered evaluation and DNS branching.
- Modify `src/heal/domain-repair.ts`: pass enriched rules and controller DNS into the shared resolver.
- Modify `src/cli/commands/fix.ts`: load runtime rule metadata once for both interactive and scheduled domain modes.
- Modify `src/cli/format.ts` or `src/cli/commands/fix.ts`: render one-based rule numbers.
- Modify `test/route-resolver.test.ts`, `test/domain-repair.test.ts`, `test/cli-args.test.ts`, and controller tests; create focused metadata and CIDR tests.
- Modify `README.md` and `CHANGELOG.md`: document supported rule evaluation and remaining conservative boundaries.

### Task 1: Recover runtime rule modifiers safely

**Files:**
- Create: `src/routes/runtime-rules.ts`
- Modify: `src/controller/client.ts:20-32`
- Modify: `src/paths.ts:753-782`
- Create: `test/runtime-rules.test.ts`
- Modify: `test/paths.test.ts`

**Interfaces:**
- Produces: `RuntimeRuleMetadata { index: number; type: string; payload: string; proxy: string; noResolve: boolean }`.
- Produces: `RuntimeRulesSnapshot { path: string; rules: RuntimeRuleMetadata[] }`.
- Extends: `MihomoRule` with optional `noResolve?: boolean`; undefined means the active runtime configuration did not prove whether the modifier is present.
- Produces: `parseRuntimeRuleMetadata(entries: readonly unknown[]): RuntimeRuleMetadata[]`.
- Produces: `loadRuntimeRuleMetadata(explicitPath?: string): RuntimeRulesSnapshot | undefined`.
- Produces: `enrichLiveRules(live: readonly MihomoRule[], metadata?: readonly RuntimeRuleMetadata[]): MihomoRule[]`, where aligned IP rules receive `noResolve: true|false` and unaligned rules retain `noResolve === undefined`.

- [ ] **Step 1: Write failing parser and alignment tests**

Add literal cases proving:

- `IP-CIDR,0.0.0.0/8,DIRECT,no-resolve` becomes index 0 with `noResolve: true`;
- an ordinary `IP-CIDR,1.1.1.0/24,PROXY` becomes `noResolve: false`;
- payloads containing commas keep the middle fields intact while recognized trailing modifiers are peeled from the end;
- a non-string YAML rule is omitted rather than guessed;
- enrichment requires the same index plus normalized type, payload, and proxy;
- a shifted or mismatched rule keeps `noResolve` undefined.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/runtime-rules.test.ts test/paths.test.ts`

Expected: FAIL because the new interfaces and `RuntimeConfigSummary.rules` do not exist.

- [ ] **Step 3: Extend `RuntimeConfigSummary` and implement runtime rule parsing**

Add `rules: unknown[]` to `readRuntimeConfig()`. Implement the interfaces above using `runtimeConfigPathCandidates(explicitPath)` in priority order and the first readable valid runtime config. Normalize controller rule spellings such as `DomainSuffix` and `DOMAIN-SUFFIX` before signature comparison. Do not return secrets or unrelated YAML fields from the new module.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `node --test test/runtime-rules.test.ts test/paths.test.ts && npm run typecheck`

Expected: all selected tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit the metadata boundary**

```bash
git add src/routes/runtime-rules.ts src/controller/client.ts src/paths.ts test/runtime-rules.test.ts test/paths.test.ts
git commit -m "feat: preserve live rule modifiers"
```

### Task 2: Introduce three-state domain evaluation and fix `no-resolve`

**Files:**
- Modify: `src/routes/resolver.ts`
- Modify: `src/heal/domain-repair.ts:20-45,131-145`
- Modify: `src/cli/commands/fix.ts:166-192`
- Modify: `test/route-resolver.test.ts`
- Modify: `test/domain-repair.test.ts`
- Modify: `test/cli-args.test.ts`

**Interfaces:**
- Consumes: `loadRuntimeRuleMetadata()` and `enrichLiveRules()` from Task 1.
- Consumes: the `MihomoRule.noResolve` metadata contract from Task 1.
- Produces: `RouteResolveOptions { runtimeRules?: readonly RuntimeRuleMetadata[]; resolveAddresses?: (host: string) => Promise<readonly string[]> }`.
- Changes: `resolveDomainRoutes(patterns, rules, proxies, mode, options?): Promise<RouteResolution>`.
- Extends: `RepairDomainsOptions` with `runtimeRules?: readonly RuntimeRuleMetadata[]`.

- [ ] **Step 1: Write failing route-evaluator tests**

Convert existing route-resolver tests to `async`/`await`, then add literal cases proving:

- a confirmed `IP-CIDR,...,no-resolve` before `DOMAIN-SUFFIX,chatgpt.com` is a definite miss and the suffix binds `MEDIA`;
- the same IP rule with `noResolve === undefined` remains `unresolved-rule`;
- prior exact domain matches still stop before a later opaque rule;
- `DOMAIN-KEYWORD`, `DOMAIN-WILDCARD`, and valid `DOMAIN-REGEX` obey first-match order;
- malformed regex returns an unresolved issue;
- unresolved diagnostics print rule number `index + 1` and retain API index in verbose data.

- [ ] **Step 2: Run route tests and verify RED**

Run: `node --test test/route-resolver.test.ts`

Expected: FAIL on the new `no-resolve` and domain predicate cases.

- [ ] **Step 3: Implement the three-state evaluator**

Define an internal `RuleDecision = { kind: 'match' } | { kind: 'miss' } | { kind: 'unknown'; reason: string }`. Normalize supported domain rule names, return `miss` for confirmed `noResolve` target-IP rules while destination resolution has not occurred, and keep every other unsupported or metadata-unknown predicate as `unknown`. Make `resolveDomainRoutes` async now so Task 3 can add DNS without another public signature change.

- [ ] **Step 4: Wire runtime metadata through the shared repair path**

Load one `RuntimeRulesSnapshot` in the domain branch of `fix.run()` and pass its `rules` to `repairDomains`; pass those rules into `resolveDomainRoutes`. This code must sit after domain/legacy dispatch so legacy group repair is unchanged. Add a `resolveFixRequest` test showing `{ scheduled: true }` with no positional argument selects the configured domains, and a `repairDomains` regression showing the scheduled/common target succeeds through a leading `no-resolve` rule.

- [ ] **Step 5: Run focused and adjacent tests**

Run: `node --test test/route-resolver.test.ts test/domain-repair.test.ts test/cli-args.test.ts test/runtime-rules.test.ts && npm run typecheck`

Expected: all selected tests pass; the existing opaque `RULE-SET` test remains incomplete.

- [ ] **Step 6: Commit the current-config fix**

```bash
git add src/controller/client.ts src/routes/resolver.ts src/heal/domain-repair.ts src/cli/commands/fix.ts test/route-resolver.test.ts test/domain-repair.test.ts test/cli-args.test.ts
git commit -m "fix: evaluate no-resolve domain routes"
```

### Task 3: Evaluate unambiguous IP-CIDR routes with mihomo DNS

**Files:**
- Create: `src/routes/ip-cidr.ts`
- Create: `test/ip-cidr.test.ts`
- Modify: `src/controller/client.ts`
- Modify: `test/controller-client.test.ts`
- Modify: `src/routes/resolver.ts`
- Modify: `test/route-resolver.test.ts`
- Modify: `src/heal/domain-repair.ts`
- Modify: `test/domain-repair.test.ts`

**Interfaces:**
- Produces: `ipInCidr(address: string, cidr: string): boolean | undefined`; address-family mismatch is a definite `false`, while undefined means malformed input.
- Produces: `MihomoClient.resolveHost(name: string): Promise<string[]>`, returning deduplicated A/AAAA answer data from `/dns/query` and throwing a diagnostic error for non-zero DNS status or malformed responses.
- Consumes: `RouteResolveOptions.resolveAddresses` from Task 2.

- [ ] **Step 1: Write failing CIDR tests**

Use literal IPv4 and IPv6 hit/miss boundaries, `/0`, host-width masks, malformed addresses, malformed masks, and family mismatch. Assert malformed input returns undefined rather than throwing.

- [ ] **Step 2: Run CIDR tests and verify RED**

Run: `node --test test/ip-cidr.test.ts`

Expected: FAIL because `ipInCidr` does not exist.

- [ ] **Step 3: Implement dependency-free CIDR matching**

Use `node:net` only for address-family recognition; parse IPv4 into 32 bits and expand compressed IPv6 into 128 bits before applying the prefix mask. Keep parsing isolated from the route evaluator.

- [ ] **Step 4: Write failing controller DNS tests**

Create a local HTTP controller fixture that asserts requests for both `?name=chatgpt.com&type=A` and `type=AAAA`. Test deduplication, empty AAAA results, non-zero DNS status, and malformed answer data.

- [ ] **Step 5: Implement `MihomoClient.resolveHost` and verify its tests**

Run: `node --test test/controller-client.test.ts`

Expected: controller tests pass and no operating-system DNS function is called.

- [ ] **Step 6: Write failing DNS-branch route tests**

Add cases proving:

- an ordinary CIDR miss continues to a later domain suffix;
- an ordinary CIDR hit selects its policy;
- multiple addresses whose first matching rules resolve to the same effective Selector are confirmed and retain all rule evidence;
- addresses reaching different policies produce one unresolved issue and no binding;
- empty answers and thrown DNS errors produce unresolved issues;
- a prior resolving IP rule causes a later confirmed `no-resolve` rule to evaluate against the already resolved address;
- malformed CIDR is unresolved.

- [ ] **Step 7: Implement lazy DNS branching and per-run caching**

Call `resolveAddresses(host)` only at the first target-IP rule that requires resolution. Cache its promise by witness host for the whole `resolveDomainRoutes` call. Replay ordered evaluation per returned address, then merge only branches whose effective policy resolution agrees; preserve one evidence entry per distinct matching rule.

- [ ] **Step 8: Connect controller DNS through `repairDomains`**

Pass `options.client.resolveHost.bind(options.client)` as `resolveAddresses`. Update fake clients only where an IP rule causes DNS; existing domain-only tests must not require a DNS stub.

- [ ] **Step 9: Run focused tests and typecheck**

Run: `node --test test/ip-cidr.test.ts test/controller-client.test.ts test/route-resolver.test.ts test/domain-repair.test.ts && npm run typecheck`

Expected: all selected tests pass, including agreeing/conflicting address branches.

- [ ] **Step 10: Commit DNS-aware IP routing**

```bash
git add src/routes/ip-cidr.ts src/controller/client.ts src/routes/resolver.ts src/heal/domain-repair.ts test/ip-cidr.test.ts test/controller-client.test.ts test/route-resolver.test.ts test/domain-repair.test.ts
git commit -m "feat: resolve IP CIDR routes with mihomo DNS"
```

### Task 4: Diagnostics, schedule regression, documentation, and live verification

**Files:**
- Modify: `src/cli/commands/fix.ts`
- Modify: `test/cli-args.test.ts`
- Modify: `test/domain-repair.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: async `resolveDomainRoutes`, runtime metadata, and controller DNS from Tasks 1–3.
- Produces no new public TypeScript interface.

- [ ] **Step 1: Add failing user-visible diagnostic tests**

Assert that an unsupported rule at API index 7 is rendered as `规则 #8` and that quiet scheduled output emits a bounded timestamped issue without interactive headings. Assert scheduled requests still reject `--force` and consume persisted domain targets.

- [ ] **Step 2: Run CLI/domain tests and verify RED**

Run: `node --test test/cli-args.test.ts test/domain-repair.test.ts`

Expected: FAIL on one-based rendering or the new quiet scheduled assertion.

- [ ] **Step 3: Implement diagnostic formatting and update docs**

Render one-based rule numbers by default and include `(API index N)` only under verbose output. Update README's FAQ to explain `no-resolve`, controller DNS, and the remaining `RULE-SET`/context-dependent limitations. Amend the 1.3.0 changelog entry so it no longer claims all IP predicates are unconditionally opaque.

- [ ] **Step 4: Run the full verification suite**

Run: `npm run typecheck && npm run build && npm test`

Expected: typecheck/build exit 0; test summary has zero failures, with only the existing platform skip allowed.

- [ ] **Step 5: Verify the original manual symptom without switching**

Run: `afc fix '*.chatgpt.com' --dry-run --verbose --config /Users/Squirtle/.config/afc/config.yaml`

Expected: the leading private `no-resolve` CIDRs no longer cause an unresolved issue; route evidence reaches the live ChatGPT policy. Because this is `--dry-run`, no Selector is changed.

- [ ] **Step 6: Verify the scheduled command uses the same result**

Run the built CLI with `fix --scheduled --quiet --dry-run` against a temporary afc config containing `*.chatgpt.com`, while using the same live controller/runtime configuration.

Expected: the scheduled path exits with the same route-resolution class as Step 5 and emits only bounded quiet log lines. Do not modify the user's persisted scheduled-domain list.

- [ ] **Step 7: Commit documentation and diagnostics**

```bash
git add src/cli/commands/fix.ts test/cli-args.test.ts test/domain-repair.test.ts README.md CHANGELOG.md
git commit -m "docs: explain reliable domain route evaluation"
```

- [ ] **Step 8: Inspect final branch state**

Run: `git status --short && git log --oneline -6`

Expected: clean worktree and the four implementation commits above following this plan commit.
