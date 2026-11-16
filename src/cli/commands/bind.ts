import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../config.ts';
import { isRealNode } from '../../controller/client.ts';
import { UsageError } from '../../errors.ts';
import { parseDomainPattern } from '../../targets/domain.ts';
import {
  acquireLock,
  manifestPath,
  readManifest,
  stateDir,
  commit,
  restore,
  assertJournalScope,
  type Binding,
  type Edit,
} from '../../bindings/store.ts';
import { changedBindings, planEdits } from '../../bindings/plan.ts';
import {
  inspectParty,
  currentProfile,
  start,
  stop,
  validateConfig,
  verifyBindings,
  exactDefinitions,
  inspectOfflineParty,
} from '../../bindings/party.ts';
import { openRuntime } from '../runtime.ts';
import { optBoolean, optString, type CommandContext } from '../context.ts';

export async function run(context: CommandContext, remove = false): Promise<number> {
  const release = acquireLock();
  try {
    const offline = optBoolean(context.values, 'offline');
    const clientDir = optString(context.values, 'client-dir');
    if (offline && (!clientDir || optBoolean(context.values, 'restart-client')))
      throw new UsageError('--offline 必须提供 --client-dir，且不能与 --restart-client 同用');
    if (!offline && clientDir) throw new UsageError('--client-dir 只用于 --offline');
    const config = loadConfig(optString(context.values, 'config'));
    const snapshot = offline ? inspectOfflineParty(clientDir!, config.probe.kernelPath) : undefined;
    const party = snapshot?.party ?? (await inspectParty(await openRuntime(context)));
    const expectedProfile = optString(context.values, 'expected-profile');
    if (expectedProfile && party.profile !== expectedProfile)
      throw new Error('当前订阅已变化，请返回网站列表重新选择；尚未写入配置');
    const path = manifestPath(),
      manifest = readManifest(path);
    const pending = join(stateDir(), 'binding-transaction.json');
    if (existsSync(pending)) {
      if (
        (!offline && !optBoolean(context.values, 'restart-client')) ||
        optBoolean(context.values, 'dry-run')
      )
        throw new Error('有未完成事务；先启动 Party，再执行 bind --restart-client 恢复');
      const pendingEdits = JSON.parse(readFileSync(pending, 'utf8')) as Edit[];
      assertJournalScope(pendingEdits, party.root, path);
      if (!offline) await stop(party);
      try {
        const saved = JSON.parse(readFileSync(pending, 'utf8')) as Edit[];
        assertJournalScope(saved, party.root, path);
        restore(saved);
        rmSync(pending);
      } finally {
        if (!offline) await start(party);
      }
      process.stderr.write('已恢复上次中断事务，请重新执行原命令。\n');
      return 3;
    }
    const old = manifest.bindings.filter(
      (b) => b.root === party.root && b.profile === party.profile,
    );
    const [proxies, configs, rules] = snapshot
      ? [snapshot.proxies, snapshot.configs, snapshot.rules]
      : await Promise.all([party.client.proxies(), party.client.configs(), party.client.rules()]);
    if (optBoolean(context.values, 'list')) {
      if (offline) throw new UsageError('--list 用于在线验证，请先手动启动 Party');
      if (context.positionals.length || remove) throw new UsageError('--list 不能与域名同时使用');
      const rows = old.map((b) => {
        let active = true;
        try {
          verifyBindings(old, rules, proxies);
        } catch {
          active = false;
        }
        return { pattern: b.pattern, group: b.group, created: b.created, active };
      });
      process.stdout.write(
        optBoolean(context.values, 'json')
          ? JSON.stringify(rows, null, 2) + '\n'
          : rows
              .map((b) => `${b.pattern} → ${b.group}（${b.active ? '生效' : '漂移'}）`)
              .join('\n') + '\n',
      );
      return 0;
    }
    if (context.positionals.length !== 1)
      throw new UsageError('用法：afc bind <域名> --group <名称> [--create] [--restart-client]');
    const pattern = parseDomainPattern(context.positionals[0]!).input;
    const same = old.find((b) => b.pattern === pattern);
    if (remove && !same) {
      process.stdout.write('该域名没有绑定。\n');
      return 0;
    }
    const group = remove ? same!.group : optString(context.values, 'group');
    if (!group || /[,\r\n]/.test(group))
      throw new UsageError('--group 必填，名称不能包含逗号或换行');
    if (configs['mode'] !== 'rule') throw new UsageError('请先将 Clash 切换到 rule 模式');
    const info = proxies[group];
    if (!remove) {
      if (info && info.type !== 'Selector') throw new UsageError('目标必须是手动选择组 Selector');
      if (!info && !optBoolean(context.values, 'create'))
        throw new UsageError('组不存在；使用 --create 创建');
      const definitions = exactDefinitions(party) as { name?: string }[];
      const names = new Set(definitions.map((n) => n.name));
      const candidates = info
        ? (info.all ?? []).filter((n) => isRealNode(proxies[n]))
        : Object.keys(proxies).filter((n) => isRealNode(proxies[n]));
      if (!candidates.length || candidates.some((n) => !names.has(n)))
        throw new UsageError('候选节点缺少当前订阅的内联定义，暂不支持 provider-only 或跨订阅定义');
    }
    const target = config.domains.find((d) => d.pattern === pattern) ?? {
      pattern,
      extraProbes: [],
      countryAllow: [],
      countryDeny: [],
    };
    const requested: Binding = {
      root: party.root,
      profile: party.profile,
      pattern,
      group,
      created:
        (manifest.groups ?? []).some(
          (g) => g.root === party.root && g.profile === party.profile && g.name === group,
        ) || !info,
      target,
    };
    const next = changedBindings(
      old,
      requested,
      optBoolean(context.values, 'create'),
      optBoolean(context.values, 'replace'),
      remove,
      info !== undefined,
    );
    if (JSON.stringify(old) === JSON.stringify(next)) {
      if (!offline) verifyBindings(old, rules, proxies);
      process.stdout.write(
        offline ? '登记无需改动；启动后用 bind --list 核对生效。\n' : '绑定已生效，无需改动。\n',
      );
      return 0;
    }
    planEdits(party.root, party.profile, manifest, next, path); // ownership/conflict preflight
    validateConfig(party, next);
    const sourceSnapshot = readFileSync(party.runtimePath, 'utf8');
    process.stdout.write(
      `${remove ? '解除' : '绑定'}：${pattern} → ${group}\n作用域：当前订阅 ${party.profile}\n`,
    );
    if (optBoolean(context.values, 'dry-run')) {
      process.stdout.write('仅预览，未写入、未重启。\n');
      return 0;
    }
    if (!offline && !optBoolean(context.values, 'restart-client'))
      throw new UsageError('需要短暂重启 Clash Party，请添加 --restart-client；尚未写入配置');
    const journal = join(stateDir(), 'binding-transaction.json');
    if (!offline) await stop(party);
    let edits: Edit[] = [];
    try {
      if (existsSync(journal)) {
        const saved = JSON.parse(readFileSync(journal, 'utf8')) as Edit[];
        assertJournalScope(saved, party.root, path);
        restore(saved);
        rmSync(journal);
        throw new Error('已恢复上次中断的事务，请重新执行绑定');
      }
      if (readFileSync(party.runtimePath, 'utf8') !== sourceSnapshot)
        throw new Error('运行配置在准备期间变化，取消写入');
      if (currentProfile(party.root) !== party.profile)
        throw new Error('退出前订阅发生变化，取消写入');
      const latestManifest = readManifest(path);
      if (JSON.stringify(latestManifest) !== JSON.stringify(manifest))
        throw new Error('绑定登记已被外部修改，取消写入');
      edits = planEdits(party.root, party.profile, latestManifest, next, path);
      commit(edits, journal);
      if (offline) {
        rmSync(journal, { force: true });
        process.stdout.write(
          '已离线保存，尚未验证生效。请手动启动 Party，再执行 afc bind --list 核对。\n',
        );
        return 0;
      }
      const active = await start(party);
      const [liveRules, liveProxies, liveConfig] = await Promise.all([
        active.client.rules(),
        active.client.proxies(),
        active.client.configs(),
      ]);
      if (liveConfig['mode'] !== 'rule') throw new Error('重启后不是 rule 模式');
      verifyBindings(next, liveRules, liveProxies);
      for (const b of next.filter((b) => !b.created)) {
        if (
          next.some((n) => n.group === b.group) &&
          (liveProxies[b.group]?.now !== proxies[b.group]?.now ||
            JSON.stringify(liveProxies[b.group]?.all) !== JSON.stringify(proxies[b.group]?.all))
        )
          throw new Error('已有组的选择或成员在重启后变化');
      }
      rmSync(journal, { force: true });
      process.stdout.write(
        `已验证生效。${remove ? '自建组保留，避免删除外部引用。' : `下一步：afc fix '${pattern}'`}\n`,
      );
      return 0;
    } catch (error) {
      if (!offline) await stop(party);
      try {
        if (edits.length && existsSync(journal)) {
          restore(edits);
          rmSync(journal, { force: true });
        }
      } finally {
        if (!offline) await start(party);
      }
      throw error;
    }
  } finally {
    release();
  }
}
