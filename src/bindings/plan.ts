import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, isMap, isSeq } from 'yaml';
import { UsageError } from '../errors.ts';
import { parseDomainPattern } from '../targets/domain.ts';
import type { Binding, Edit, Manifest } from './store.ts';
export const overlayId = (profile: string): string =>
  `afc-${createHash('sha256').update(profile).digest('hex').slice(0, 20)}`;
export const ordered = (bindings: Binding[]): Binding[] =>
  [...bindings].sort((a, b) => {
    const x = parseDomainPattern(a.pattern),
      y = parseDomainPattern(b.pattern);
    return (
      y.apex.split('.').length - x.apex.split('.').length ||
      x.apex.localeCompare(y.apex) ||
      Number(x.wildcard) - Number(y.wildcard)
    );
  });
export function bindingRule(b: Binding): string {
  const p = parseDomainPattern(b.pattern);
  return `${p.wildcard ? 'DOMAIN-SUFFIX' : 'DOMAIN'},${p.apex},${b.group}`;
}
export function changedBindings(
  old: Binding[],
  requested: Binding,
  create: boolean,
  replace: boolean,
  remove = false,
  groupExists = false,
): Binding[] {
  const same = old.find((b) => b.pattern === requested.pattern);
  if (
    !remove &&
    same?.group === requested.group &&
    JSON.stringify(same.target) === JSON.stringify(requested.target)
  )
    return old;
  if (remove) return old.filter((b) => b.pattern !== requested.pattern);
  if (
    same &&
    (same.group !== requested.group ||
      JSON.stringify(same.target) !== JSON.stringify(requested.target)) &&
    !replace
  )
    throw new UsageError('该范围已有不同绑定或判据；用 --replace 替换');
  // `created` records ownership, not whether the group needs creating in this operation.
  if (!same && !create && requested.created && !groupExists)
    throw new UsageError('组不存在；用 --create 创建');
  return [...old.filter((b) => b.pattern !== requested.pattern), requested];
}
export function planEdits(
  root: string,
  profile: string,
  manifest: Manifest,
  next: Binding[],
  manifestFile: string,
): Edit[] {
  const old = manifest.bindings.filter((b) => b.root === root && b.profile === profile);
  const id = overlayId(profile);
  const paths = [
    join(root, 'profile.yaml'),
    join(root, 'override.yaml'),
    join(root, 'rules', `${profile}.yaml`),
    join(root, 'override', `${id}.yaml`),
  ];
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('无效订阅 ID');
  const edits: Edit[] = [];
  const docs = paths.map((path) => {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const doc = parseDocument(before ?? '{}\n');
    if (doc.errors.length || !isMap(doc.contents)) throw new Error(`不是有效 YAML 映射：${path}`);
    edits.push({ path, before, after: null });
    return doc;
  });
  const [profiles, overrides, rules, overlay] = docs as [
    (typeof docs)[number],
    (typeof docs)[number],
    (typeof docs)[number],
    (typeof docs)[number],
  ];
  const items = profiles.get('items', true);
  if (!isSeq(items)) throw new Error('profile.yaml 缺少订阅列表');
  const item = items.items.find((i) => isMap(i) && i.get('id') === profile);
  if (!isMap(item) || profiles.get('current') !== profile) throw new Error('当前订阅已变化');
  const rawRefs = item.get('override', true);
  const refs = isSeq(rawRefs) ? rawRefs : undefined;
  if (rawRefs && !isSeq(rawRefs)) throw new Error('订阅覆写列表格式无效');
  const refValues = (refs?.toJSON() as string[] | undefined) ?? [];
  const rawEntries = overrides.get('items', true);
  const entries = isSeq(rawEntries) ? rawEntries : undefined;
  if (rawEntries && !isSeq(rawEntries)) throw new Error('覆写登记格式无效');
  const ovItems = (entries?.toJSON() as Record<string, unknown>[] | undefined) ?? [];
  const oldCreated = new Set([
    ...(manifest.groups ?? [])
      .filter((g) => g.root === root && g.profile === profile)
      .map((g) => g.name),
    ...old.filter((b) => b.created).map((b) => b.group),
  ]);
  const newCreated = new Set(next.filter((b) => b.created).map((b) => b.group));
  // Keep created groups until explicit cleanup can prove they have no external references.
  const retained = new Set([...oldCreated, ...newCreated]);
  const managedGroups = [...retained]
    .sort()
    .map((name) => ({
      name,
      type: 'select',
      'include-all-proxies': true,
      'exclude-type': 'Direct|Reject|RejectDrop|Compatible|Pass|PassRule|Dns|Unknown',
    }));
  const expected = oldCreated.size
    ? {
        '+proxy-groups': [...oldCreated]
          .sort()
          .map((name) => ({
            name,
            type: 'select',
            'include-all-proxies': true,
            'exclude-type': 'Direct|Reject|RejectDrop|Compatible|Pass|PassRule|Dns|Unknown',
          })),
      }
    : {};
  if (oldCreated.size && edits[3]!.before === null)
    throw new Error('AFC 自有覆写缺失，拒绝猜测恢复');
  if (edits[3]!.before !== null && JSON.stringify(overlay.toJS()) !== JSON.stringify(expected))
    throw new Error('AFC 覆写已被手动修改，拒绝覆盖');
  const previousRules = ordered(old).map(bindingRule);
  const rawPrepend = rules.get('prepend', true);
  const prependNode = isSeq(rawPrepend) ? rawPrepend : undefined;
  if (rawPrepend && !isSeq(rawPrepend)) throw new Error('prepend 必须是列表');
  const prepend = (prependNode?.toJSON() as string[] | undefined) ?? [];
  if (previousRules.some((r, i) => prepend[i] !== r))
    throw new Error('AFC 前置规则已被外部修改，请先修复漂移');
  if (!prependNode) rules.set('prepend', rules.createNode([]));
  const seq = rules.get('prepend', true);
  if (!isSeq(seq)) throw new Error('无法编辑规则列表');
  seq.items.splice(
    0,
    previousRules.length,
    ...ordered(next).map((b) => rules.createNode(bindingRule(b))),
  );
  const deleted = rules.get('delete', true) as unknown;
  const deletedValues = isSeq(deleted) ? (deleted.toJSON() as string[]) : [];
  if (ordered(next).some((b) => deletedValues.includes(bindingRule(b))))
    throw new Error('用户 delete 规则会删除绑定，请先解决冲突');
  if (managedGroups.length) {
    overlay.set('+proxy-groups', overlay.createNode(managedGroups));
    if (!refValues.includes(id)) {
      if (!refs) item.set('override', profiles.createNode([]));
      (item.get('override', true) as NonNullable<typeof refs>).add(id);
    }
    if (!ovItems.some((i) => i.id === id)) {
      if (!entries) overrides.set('items', overrides.createNode([]));
      (overrides.get('items', true) as NonNullable<typeof entries>).add({
        id,
        name: 'AFC 域名专用组',
        type: 'local',
        ext: 'yaml',
        global: false,
      });
    } else {
      const registered = ovItems.find((i) => i.id === id)!;
      if (
        !oldCreated.size ||
        registered.ext !== 'yaml' ||
        registered.type !== 'local' ||
        registered.global !== false
      )
        throw new Error('覆写 ID 已被占用或登记被修改');
    }
  }
  docs.forEach((doc, i) => {
    edits[i]!.after =
      edits[i]!.before === null && i === 3 && !managedGroups.length ? null : doc.toString();
  });
  const bindings = [
    ...manifest.bindings.filter((b) => b.root !== root || b.profile !== profile),
    ...next,
  ];
  // Retained empty generated groups remain owned for future reuse and manual cleanup.
  edits.push({
    path: manifestFile,
    before: existsSync(manifestFile) ? readFileSync(manifestFile, 'utf8') : null,
    after:
      JSON.stringify(
        {
          version: 1,
          bindings,
          groups: [
            ...(manifest.groups ?? []).filter((g) => g.root !== root || g.profile !== profile),
            ...[...retained].map((name) => ({ root, profile, name })),
          ],
        },
        null,
        2,
      ) + '\n',
  });
  return edits.filter((e) => e.before !== e.after);
}
