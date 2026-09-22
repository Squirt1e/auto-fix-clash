# Domain-Driven Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make domains the stable input to `afc fix` and scheduled repair, dynamically resolve all safely-confirmed mihomo policy groups, and support forced rotation to a different verified node.

**Architecture:** Add domain configuration and parsing first, then a pure ordered-rule resolver over live controller data, then generalize the existing isolated probe repair to accept a known group plus multiple probe policies. A coordinator joins resolution to repair and the CLI/scheduler expose that workflow while retaining explicit legacy group commands.

**Tech Stack:** Node.js 20.11+, TypeScript 5.8, Node test runner, YAML 2.8, mihomo external-controller API, existing launchd/systemd/cron/schtasks backends.

**Spec:** `docs/superpowers/specs/2026-09-22-domain-driven-repair-design.md`

## Global Constraints

- `*.example.com` includes the apex `example.com` and every subdomain.
- Repair every safely confirmed Selector once, including a Selector reached through `MATCH`; do not guess across opaque rules.
- Never rewrite mihomo rules or Clash configuration and never pin automatic groups or `DIRECT`/`REJECT` paths.
- Candidate probing stays in the isolated temporary mihomo instance; a group shared by several bindings requires every distinct probe policy to pass.
- `--force` excludes the current node and preserves it when no verified alternative exists; scheduled runs are never forced.
- Exit precedence is environment/incomplete (`3`) over no alternative (`2`) over success (`0`); invalid usage remains `64`.
- Preserve macOS, Linux, and Windows scheduling support and Node.js `>=20.11`.

## Review Focus

- A Unicode hostname, uppercase hostname, or trailing dot normalizes to one ASCII pattern; URL/path input is rejected rather than misparsed.
- An opaque rule before an otherwise matching domain rule makes that witness unresolved, while an unrelated opaque rule after a confirmed match does not.
- A Selector delegation cycle is reported once and cannot hang route resolution.
- If the user changes the Selector while candidates are being probed, afc does not overwrite the new selection.
- Adding the first scheduled domain to a config without `domains` retains the built-in `*.chatgpt.com` target.

---

### Task 1: Domain target model, validation, and configuration editing

**Files:**
- Create: `src/targets/domain.ts`
- Modify: `src/config.ts:1-470`
- Modify: `src/config-edit.ts:1-150`
- Create: `test/domain-targets.test.ts`
- Test: `test/config.test.ts`
- Test: `test/config-edit.test.ts`

**Interfaces:**
- Produces: `DomainPattern { input: string; apex: string; wildcard: boolean }`.
- Produces: `parseDomainPattern(input: string): DomainPattern`, `domainPatternMatches(pattern, host): boolean`, and `DEFAULT_DOMAIN_TARGETS`.
- Produces: `DomainTargetConfig { pattern: string; probe?: ProbeEndpoint; extraProbes: ProbeEndpoint[]; geoProbe?: GeoProbe; countryAllow: string[]; countryDeny: string[] }` and `AfcConfig.domains`.
- Produces: `addDomainToConfigText(text, domain, materializeDefaults)` and `removeDomainFromConfigText(text, pattern)`.

- [ ] **Step 1: Write failing normalization and matching tests**

```ts
test('wildcard includes apex and nested subdomains', () => {
  const p = parseDomainPattern('*.ChatGPT.com.');
  assert.deepEqual(p, { input: '*.chatgpt.com', apex: 'chatgpt.com', wildcard: true });
  assert.equal(domainPatternMatches(p, 'chatgpt.com'), true);
  assert.equal(domainPatternMatches(p, 'a.b.chatgpt.com'), true);
  assert.equal(domainPatternMatches(p, 'notchatgpt.com'), false);
});

test('IDN is normalized and URL/path/arbitrary glob are rejected', () => {
  assert.equal(parseDomainPattern('例子.测试').apex, 'xn--fsqu00a.xn--0zwm56d');
  for (const bad of ['https://chatgpt.com', 'chatgpt.com/path', '*gpt.com', '']) {
    assert.throws(() => parseDomainPattern(bad), UsageError);
  }
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `node --test test/domain-targets.test.ts`

Expected: FAIL because `src/targets/domain.ts` does not exist.

- [ ] **Step 3: Implement strict domain parsing and the built-in ChatGPT target**

```ts
export interface DomainPattern { input: string; apex: string; wildcard: boolean }

export function parseDomainPattern(input: string): DomainPattern {
  const value = input.trim().toLowerCase().replace(/\.$/, '');
  const wildcard = value.startsWith('*.');
  const rawHost = wildcard ? value.slice(2) : value;
  if (value.includes('://') || /[/?#]/.test(rawHost) || rawHost.includes('*')) {
    throw new UsageError(`无效域名范围：${input}`);
  }
  const apex = domainToASCII(rawHost);
  if (!apex || apex.length > 253 || apex.split('.').some((label) =>
    label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new UsageError(`无效域名范围：${input}`);
  }
  return { input: wildcard ? `*.${apex}` : apex, apex, wildcard };
}
```

Define `DEFAULT_DOMAIN_TARGETS` with pattern `*.chatgpt.com`, the existing ChatGPT 405/401 probes, trace geo probe, and deny-country policy.

- [ ] **Step 4: Write failing config load/edit tests**

```ts
test('missing domains uses the built-in target while explicit empty disables it', () => {
  assert.deepEqual(loadConfig(fixtureWithoutDomains).domains.map((d) => d.pattern), ['*.chatgpt.com']);
  assert.deepEqual(loadConfig(fixtureWithEmptyDomains).domains, []);
});

test('first add materializes default and preserves comments', () => {
  const next = addDomainToConfigText('# mine\n', genericDomainTarget('example.com'), true);
  assert.match(next, /# mine/);
  assert.match(next, /pattern: "?\*\.chatgpt\.com"?/);
  assert.match(next, /pattern: example\.com/);
});
```

- [ ] **Step 5: Extend config validation and comment-preserving config edits**

Parse `domains` independently from legacy `targets`, reuse `normalizeEndpoint`, reject duplicate normalized patterns, and clone defaults deeply. Add render/insert/remove helpers for a top-level `domains:` sequence; make `writeConfigText()` validate the temporary result as it does today. Removal of the last entry renders `domains: []`.

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test test/domain-targets.test.ts test/config.test.ts test/config-edit.test.ts`

Expected: PASS.

```bash
git add src/targets/domain.ts src/config.ts src/config-edit.ts test/domain-targets.test.ts test/config.test.ts test/config-edit.test.ts
git commit -m "feat: add domain repair targets"
```

### Task 2: Live rule and group route resolver

**Files:**
- Create: `src/routes/resolver.ts`
- Modify: `src/controller/client.ts:3-133`
- Create: `test/route-resolver.test.ts`
- Create: `test/controller-client.test.ts`

**Interfaces:**
- Consumes: `DomainPattern` and `ProxyInfo` from Task 1/current controller code.
- Produces: `MihomoRule { index: number; type: string; payload: string; proxy: string; extra?: { disabled?: boolean } }` and `MihomoClient.rules()`.
- Produces: `RouteEvidence`, `ResolvedBinding { pattern, witness, rule, policy, group }`, `RouteIssue { pattern, witness?, kind, reason }`, and `resolveDomainRoutes(patterns, rules, proxies, mode): RouteResolution`.

- [ ] **Step 1: Add failing controller and ordered-rule tests**

```ts
test('client reads normalized /rules response', async () => {
  const rules = await client.rules();
  assert.deepEqual(rules[0], { index: 0, type: 'DOMAIN', payload: 'api.example.com', proxy: 'API' });
});

test('wildcard confirms exact, suffix and MATCH routes in rule order', () => {
  const result = resolveDomainRoutes(
    [parseDomainPattern('*.example.com')],
    [
      rule(0, 'DOMAIN', 'api.example.com', 'API'),
      rule(1, 'DOMAIN-SUFFIX', 'media.example.com', 'MEDIA'),
      rule(2, 'MATCH', '', 'DEFAULT'),
    ],
    proxyGraph(),
    'rule',
  );
  assert.deepEqual(result.bindings.map((b) => b.group).sort(), ['API', 'DEFAULT', 'MEDIA']);
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `node --test test/controller-client.test.ts test/route-resolver.test.ts`

Expected: FAIL because `rules()` and the resolver are missing.

- [ ] **Step 3: Add typed `/rules` access and pure rule matching**

Implement `MihomoClient.rules()` as `GET /rules`. In the resolver, normalize rule type/payload, ignore disabled rules, and evaluate only `DOMAIN`, `DOMAIN-SUFFIX`, and `MATCH`. Generate witnesses from the apex, every intersecting exact-domain payload, every intersecting suffix payload, and a deterministic remainder host such as `afc-route-probe.<apex>` with numeric suffixes until it avoids all explicit exact names. Evaluate each witness from rule index zero; any earlier unsupported predicate makes that witness unresolved. Stop at the first supported match.

- [ ] **Step 4: Add failing ambiguity, shadowing, mode, and delegation tests**

```ts
test('opaque predecessor makes only affected witnesses unresolved', () => {
  const result = resolveDomainRoutes([pattern], [
    rule(0, 'RULE-SET', 'private', 'PRIVATE'),
    rule(1, 'DOMAIN-SUFFIX', 'example.com', 'PROXY'),
  ], proxies, 'rule');
  assert.equal(result.bindings.length, 0);
  assert.equal(result.issues[0]?.kind, 'unresolved-rule');
});

test('delegation chooses deepest mutable selector and detects cycles', () => {
  assert.equal(resolvePolicy('OUTER', delegatedProxies()).group, 'INNER');
  assert.equal(resolvePolicy('A', cyclicProxies()).issue?.kind, 'group-cycle');
});
```

Also pin: a confirmed earlier `DOMAIN` ignores a later opaque rule; `DIRECT` and `REJECT` are skipped; URLTest/Fallback terminal paths are skipped; duplicate routes deduplicate by final Selector while retaining evidence; `global` and `direct` controller modes return explicit issues instead of pretending rule mode.

- [ ] **Step 5: Implement policy-chain resolution and result deduplication**

Follow `ProxyInfo.now` with a visited set. Record each hop. Return the deepest `Selector` before a real node; return a skip issue for built-ins/automatic terminal groups and a cycle issue for repeats. Deduplicate `(pattern, witness, rule)` evidence under the final group without discarding witnesses.

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test test/controller-client.test.ts test/route-resolver.test.ts`

Expected: PASS.

```bash
git add src/controller/client.ts src/routes/resolver.ts test/controller-client.test.ts test/route-resolver.test.ts
git commit -m "feat: resolve domains to live policy groups"
```

### Task 3: Multi-policy probing and forced repair

**Files:**
- Modify: `src/probe/engine.ts:1-260`
- Modify: `src/heal/plan.ts:1-110`
- Modify: `src/heal/repair.ts:48-202`
- Test: `test/engine.test.ts`
- Test: `test/plan.test.ts`
- Create: `test/repair.test.ts`

**Interfaces:**
- Produces: `ProbePolicy { label: string; target: TargetConfig; confidence: 'service' | 'reachability' }`.
- Produces: `ProbeEngine.probeAll(node, policies, channel, timeoutMs?): Promise<NodeProbeResult>` and `findFirstUsableForAll(nodes, policies, screenTimeoutMs)`.
- Produces: `repairGroup(options: { config; groupName; policies; client; force?; dryRun?; ... }): Promise<RepairOutcome>`.
- Retains: `repairTarget(options)` as the legacy adapter resolving the configured group and calling `repairGroup` with one policy.

- [ ] **Step 1: Write failing all-policies probe tests**

```ts
test('candidate passes only when every distinct policy passes', async () => {
  const result = await engine.probeAll('node-a', [chatgptPolicy, genericPolicy], 0);
  assert.equal(result.verdict, 'blocked');
  assert.match(result.reason, /generic example\.com/);
});

test('duplicate policies are executed once', async () => {
  await engine.probeAll('node-a', [chatgptPolicy, chatgptPolicy], 0);
  assert.equal(transport.callsFor(CHATGPT_URL), 1);
});
```

- [ ] **Step 2: Run engine tests and confirm failure**

Run: `node --test test/engine.test.ts`

Expected: FAIL because multi-policy methods do not exist.

- [ ] **Step 3: Implement composite probing**

Deduplicate policies by a stable serialization of probe URLs, methods, expected statuses, geo probe, and country lists. Probe each required policy on the selected channel. Return `ok` only if every result is `ok`, sum attempts, retain the slowest TTFB for ranking, and make the first failing policy and reason visible. Batch candidate search using the existing channel/concurrency rules and perform the existing full confirmation before accepting a screened candidate.

- [ ] **Step 4: Write failing force and race tests**

```ts
test('force ignores a healthy current node and selects another usable node', () => {
  const plan = planRepair({ force: true, current: 'A', currentResult: ok('A'), candidateResults: [ok('B')] });
  assert.deepEqual({ action: plan.action, from: plan.from, to: plan.to }, { action: 'switch', from: 'A', to: 'B' });
});

test('force with no alternative preserves the current selection', async () => {
  const outcome = await repairGroup(forceOptionsWithNoAlternative());
  assert.equal(outcome.plan.action, 'no-candidate');
  assert.equal(client.selectCalls.length, 0);
});

test('selection changed during probing is not overwritten', async () => {
  const outcome = await repairGroup(optionsWhoseSecondProxyReadReturns('USER-CHOICE'));
  assert.equal(outcome.plan.action, 'stale');
  assert.equal(client.selectCalls.length, 0);
});
```

- [ ] **Step 5: Generalize repair around an explicit group**

Add `force?: boolean` to `PlanInput`, add `stale` to `RepairAction`, and bypass the healthy-current early return when forced. `repairGroup` loads candidates for the explicit Selector, always excludes its starting current node from replacement candidates, uses composite probing, and immediately before `client.select` calls `client.proxy(groupName)`; if `now` differs from the starting value it returns a stale plan. Keep `repairTarget` behavior unchanged through the adapter. Update summaries to distinguish “没有其它可用节点” from ordinary failure.

- [ ] **Step 6: Run repair tests and commit**

Run: `node --test test/engine.test.ts test/plan.test.ts test/repair.test.ts`

Expected: PASS.

```bash
git add src/probe/engine.ts src/heal/plan.ts src/heal/repair.ts test/engine.test.ts test/plan.test.ts test/repair.test.ts
git commit -m "feat: support forced multi-policy repair"
```

### Task 4: Domain coordinator and `afc fix <domain>` CLI

**Files:**
- Create: `src/heal/domain-repair.ts`
- Modify: `src/targets/presets.ts:1-170`
- Modify: `src/cli/index.ts:35-145`
- Modify: `src/cli/commands/fix.ts:1-115`
- Modify: `src/cli/help.ts:1-190`
- Create: `test/domain-repair.test.ts`
- Test: `test/cli-args.test.ts`
- Test: `test/exit-codes.test.ts`

**Interfaces:**
- Consumes: `resolveDomainRoutes`, `repairGroup`, and `AfcConfig.domains`.
- Produces: `policyForDomain(target, witness): ProbePolicy`, using ChatGPT service policy when the target intersects `*.chatgpt.com`, explicit overrides when supplied, otherwise `GET https://<witness>/` with expected `[200, 399]`.
- Produces: `repairDomains(options): Promise<DomainRepairReport>` with `bindings`, `outcomes`, `issues`, and aggregate `exitCode`.

- [ ] **Step 1: Write failing coordinator tests**

```ts
test('repairs every confirmed group once and combines its policies', async () => {
  const report = await repairDomains(domainScenarioWithSharedGroup());
  assert.deepEqual(repairCalls.map((c) => c.groupName).sort(), ['DEFAULT', 'GPT']);
  assert.equal(repairCalls.find((c) => c.groupName === 'GPT')?.policies.length, 2);
});

test('an unresolved route makes exit 3 without hiding successful groups', async () => {
  const report = await repairDomains(mixedConfirmedAndOpaqueScenario());
  assert.equal(report.outcomes.length, 1);
  assert.equal(report.exitCode, EXIT_ENVIRONMENT);
});
```

- [ ] **Step 2: Run coordinator tests and confirm failure**

Run: `node --test test/domain-repair.test.ts`

Expected: FAIL because the coordinator is missing.

- [ ] **Step 3: Implement probe-policy selection and repair aggregation**

Read `client.configs()` for mode, `client.rules()`, and `client.proxies()` once per run. Resolve every requested target together, group bindings by final Selector, map each binding to a service/explicit/generic policy, and call `repairGroup` sequentially so output remains deterministic. Aggregate exit status as `3` for any route/environment issue, otherwise `2` for any `no-candidate`, otherwise `0`. Preserve successful outcomes even when another route is incomplete.

- [ ] **Step 4: Write failing CLI mode/usage/output tests**

```ts
test('fix positional selects domain mode and forwards force', async () => {
  const code = await main(['fix', '*.chatgpt.com', '--force', '--dry-run']);
  assert.equal(code, 0);
  assert.deepEqual(domainRepairCall.targets, ['*.chatgpt.com']);
  assert.equal(domainRepairCall.force, true);
});

test('domain and --group cannot be combined', async () => {
  assert.equal(await main(['fix', 'example.com', '--group', 'GPT']), EXIT_USAGE);
});
```

Also cover: no positional loads configured domains; `--scheduled` is rejected with `--force`; legacy `--group`, `--all`, and `--no-auto` still route to the old flow; quiet logs remain timestamped; normal output includes pattern, witness/rule evidence, group and confidence; unresolved and skipped sections are distinct.

- [ ] **Step 5: Wire domain mode into argument parsing and fix output**

Add internal boolean `scheduled` to `parseArgs`. In `fix.run`, select domain mode for a positional target, `--scheduled`, or no legacy group flags; select legacy mode only for `--group`, `--all`, or `--no-auto`. Reject contradictory combinations. Pass `force`, `dryRun`, and notices to the coordinator. Update help so examples quote wildcard arguments and explain reachability versus service verification.

- [ ] **Step 6: Run focused CLI tests and commit**

Run: `node --test test/domain-repair.test.ts test/cli-args.test.ts test/exit-codes.test.ts`

Expected: PASS.

```bash
git add src/heal/domain-repair.ts src/targets/presets.ts src/cli/index.ts src/cli/commands/fix.ts src/cli/help.ts test/domain-repair.test.ts test/cli-args.test.ts test/exit-codes.test.ts
git commit -m "feat: repair live routes by domain"
```

### Task 5: Scheduled domain management and backend migration

**Files:**
- Modify: `src/cli/commands/schedule.ts:1-147`
- Modify: `src/schedule/types.ts:4-23`
- Modify: `src/schedule/launchd.ts:45-75`
- Modify: `src/schedule/systemd.ts:35-85`
- Modify: `src/schedule/cron.ts:45-80`
- Modify: `src/schedule/schtasks.ts:40-85`
- Create: `test/schedule-domains.test.ts`
- Test: `test/schedule-backends.test.ts`

**Interfaces:**
- Consumes: Task 1 config editors and `AfcConfig.domains`.
- Produces: `schedule add <pattern>`, `schedule list`, `schedule remove <pattern>`.
- Changes: `scheduleCliArgs()` emits `['fix', '--scheduled', '--quiet', ...]`.

- [ ] **Step 1: Write failing schedule domain-management tests**

```ts
test('schedule add retains the implicit ChatGPT default', async () => {
  await runSchedule(['add', 'example.com'], tempConfigContext());
  assert.deepEqual(loadConfig(tempPath).domains.map((d) => d.pattern), ['*.chatgpt.com', 'example.com']);
});

test('schedule remove normalizes the requested pattern', async () => {
  await runSchedule(['remove', '*.CHATGPT.com.'], existingConfigContext());
  assert.deepEqual(loadConfig(tempPath).domains, []);
});
```

Test `list` for built-in/default source, explicit empty list, explicit config path, and duplicate-add usage error.

- [ ] **Step 2: Run management tests and confirm failure**

Run: `node --test test/schedule-domains.test.ts`

Expected: FAIL because the subcommands are not implemented.

- [ ] **Step 3: Implement add/list/remove without controller discovery**

Resolve the write path with the existing stable user-config rule. `add` validates the pattern, materializes the implicit default when `domains` is absent, accepts the existing paired `--url`/`--expect` and optional `--country-deny` flags as its explicit probe override, and performs an atomic comment-preserving write. `remove` requires a real source file and writes `domains: []` when removing the last entry. `list` prints pattern, policy source, and config source. None of these commands contacts mihomo. Add tests that one-sided `--url`/`--expect` is usage error and that the round-tripped override retains its expected statuses and country deny list.

- [ ] **Step 4: Update failing backend expectations**

```ts
test('scheduleCliArgs runs scheduled domain repair', () => {
  assert.deepEqual(scheduleCliArgs(OPTIONS), ['fix', '--scheduled', '--quiet']);
});
```

Update launchd/systemd/cron/schtasks preview assertions to require `fix --scheduled --quiet` and forbid `fix --all --quiet`.

- [ ] **Step 5: Update scheduler generation and user-facing status**

Route every backend through `scheduleCliArgs`; remove the launchd-local hard-coded old arguments. Installation output names configured domain ranges, status/list exposes them, and migration text says an existing task must be reinstalled to replace the old group-wide command. Ensure scheduled invocations never include `--force`.

- [ ] **Step 6: Run schedule tests and commit**

Run: `node --test test/schedule-domains.test.ts test/schedule-backends.test.ts test/launchd.test.ts`

Expected: PASS.

```bash
git add src/cli/commands/schedule.ts src/schedule/types.ts src/schedule/launchd.ts src/schedule/systemd.ts src/schedule/cron.ts src/schedule/schtasks.ts test/schedule-domains.test.ts test/schedule-backends.test.ts test/launchd.test.ts
git commit -m "feat: schedule domain-based repairs"
```

### Task 6: Documentation, sample configuration, and full regression

**Files:**
- Modify: `README.md`
- Modify: `afc.config.yaml`
- Modify: `CHANGELOG.md`
- Modify: `package.json`
- Test: all files under `test/`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a documented migration and a release-ready build with no type/test regressions.

- [ ] **Step 1: Update end-user documentation and sample config**

Document these exact workflows:

```bash
afc fix '*.chatgpt.com'
afc fix '*.chatgpt.com' --force
afc schedule add '*.chatgpt.com'
afc schedule list
afc schedule remove '*.chatgpt.com'
afc schedule install
```

Explain that `*.` includes the apex, generic HTTPS proves only reachability, opaque rules produce an incomplete result, `MATCH` is eligible, automatic groups and built-ins are skipped, and upgrading users must rerun `schedule install`. Keep the explicit legacy `--group` section. Add a `domains` sample before legacy `targets`, and mark `targets` as legacy explicit-group configuration.

- [ ] **Step 2: Add changelog entry and bump the minor version**

Set `package.json` to the next minor version because default scheduled scope and CLI behavior change. Record domain routing, forced rotation, new schedule subcommands, incomplete-route behavior, and reinstall migration in `CHANGELOG.md`.

- [ ] **Step 3: Run formatting-independent checks**

Run: `git diff --check`

Expected: no output and exit `0`.

- [ ] **Step 4: Run type checking and the full suite**

Run: `npm run typecheck && npm test`

Expected: both commands exit `0`; all existing legacy tests and new domain tests pass.

- [ ] **Step 5: Build the distributable output**

Run: `npm run build`

Expected: exit `0` and TypeScript emits without errors.

- [ ] **Step 6: Perform CLI smoke checks without mutating system tasks**

Run:

```bash
node src/cli/index.ts fix --help
node src/cli/index.ts schedule --help
node src/cli/index.ts schedule list --config afc.config.yaml
node src/cli/index.ts schedule install --dry-run --config afc.config.yaml
```

Expected: help contains positional-domain and `--force` semantics; list shows `*.chatgpt.com`; dry-run contains `fix --scheduled --quiet` and does not install a task.

- [ ] **Step 7: Commit documentation and verified release state**

```bash
git add README.md afc.config.yaml CHANGELOG.md package.json pnpm-lock.yaml
git commit -m "docs: document domain-driven repair migration"
```

- [ ] **Step 8: Review the complete branch diff**

Run: `git status --short && git log --oneline --decorate -8 && git diff d291eff..HEAD --stat`

Expected: clean worktree; commits correspond to Tasks 1–6; diff contains only domain repair, scheduling, tests, and documentation described by the approved spec.
