import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { planEdits, bindingRule, ordered, changedBindings } from '../src/bindings/plan.ts';
import {
  commit,
  restore,
  acquireLock,
  type Binding,
  type Manifest,
} from '../src/bindings/store.ts';
import { verifyBindings } from '../src/bindings/party.ts';
import { resolvePolicy } from '../src/routes/resolver.ts';
const entry = (pattern = '*.example.com', group = 'AI'): Binding => ({
  root: '/fixture',
  profile: 'id',
  pattern,
  group,
  created: true,
  target: { pattern, extraProbes: [], countryAllow: [], countryDeny: [] },
});
function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'afc-binding-test-'));
  try {
    mkdirSync(join(root, 'rules'));
    writeFileSync(
      join(root, 'profile.yaml'),
      '# keep profile\ncurrent: id\nitems:\n  - id: id\n    name: hello\n    override: []\n',
    );
    writeFileSync(join(root, 'override.yaml'), '# keep overrides\nitems: []\n');
    writeFileSync(
      join(root, 'rules/id.yaml'),
      '# user rules\nprepend:\n  - DOMAIN,user.example.com,DIRECT # keep comment\nappend: []\nunknown: hello\n',
    );
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('domain and suffix rules preserve exact scope and specificity', () => {
  const values = [entry('*.example.com'), entry('example.com'), entry('*.api.example.com')];
  assert.deepEqual(
    ordered(values).map((b) => b.pattern),
    ['*.api.example.com', 'example.com', '*.example.com'],
  );
  assert.equal(bindingRule(entry('example.com')), 'DOMAIN,example.com,AI');
});
test('replace is explicit and missing groups require create', () => {
  assert.throws(() => changedBindings([], entry(), false, false));
  assert.throws(() => changedBindings([entry()], entry('*.example.com', 'Other'), true, false));
  assert.equal(
    changedBindings([entry()], entry('*.example.com', 'Other'), true, true)[0]?.group,
    'Other',
  );
});
test('a second domain can reuse an existing AFC-created group without --create', () => {
  const first = entry('*.chatgpt.com', 'AFC-AI');
  const second = entry('auth.openai.com', 'AFC-AI');
  const bindings = changedBindings([first], second, false, false, false, true);
  assert.deepEqual(bindings, [first, second]);
  assert.equal(bindings[1]?.created, true, 'reuse preserves AFC ownership');
  assert.throws(
    () => changedBindings([first], second, false, false, false, false),
    /组不存在/,
    'an actually missing group still requires explicit creation',
  );
});
test('installation preserves user comments and unrelated fields; replacement and unbind keep ownership', () =>
  fixture((root) => {
    const b = { ...entry(), root },
      path = join(root, 'manifest.json');
    let manifest: Manifest = { version: 1, bindings: [] };
    let edits = planEdits(root, 'id', manifest, [b], path);
    const journal = join(root, 'tx');
    commit(edits, journal);
    rmSync(journal);
    const rules = readFileSync(join(root, 'rules/id.yaml'), 'utf8');
    assert.match(rules, /# keep comment/);
    assert.match(rules, /# user rules/);
    assert.equal(parse(rules).unknown, 'hello');
    assert.equal(parse(rules).prepend[0], bindingRule(b));
    assert.match(readFileSync(join(root, 'profile.yaml'), 'utf8'), /# keep profile/);
    manifest = JSON.parse(readFileSync(path, 'utf8'));
    edits = planEdits(root, 'id', manifest, [], path);
    commit(edits, journal);
    rmSync(journal);
    assert.deepEqual(parse(readFileSync(join(root, 'rules/id.yaml'), 'utf8')).prepend, [
      'DOMAIN,user.example.com,DIRECT',
    ]);
    manifest = JSON.parse(readFileSync(path, 'utf8'));
    assert.doesNotThrow(() => planEdits(root, 'id', manifest, [b], path));
  }));
test('user delete conflicts are rejected before writing', () =>
  fixture((root) => {
    writeFileSync(join(root, 'rules/id.yaml'), stringify({ delete: [bindingRule(entry())] }));
    assert.throws(
      () =>
        planEdits(
          root,
          'id',
          { version: 1, bindings: [] },
          [{ ...entry(), root }],
          join(root, 'm'),
        ),
      /delete/,
    );
  }));
test('transaction rollback restores absent and existing files', () =>
  fixture((root) => {
    const p = join(root, 'new');
    const q = join(root, 'profile.yaml');
    const before = readFileSync(q, 'utf8');
    const edits = [
      { path: p, before: null, after: 'new' },
      { path: q, before, after: 'changed' },
    ];
    commit(edits, join(root, 'journal'));
    restore(edits);
    assert.equal(existsSync(p), false);
    assert.equal(readFileSync(q, 'utf8'), before);
  }));
test('rollback never overwrites external edits and does not partially restore', () =>
  fixture((root) => {
    const p = join(root, 'a'),
      q = join(root, 'b');
    writeFileSync(p, 'a');
    writeFileSync(q, 'external');
    assert.throws(
      () =>
        restore([
          { path: p, before: null, after: 'a' },
          { path: q, before: null, after: 'b' },
        ]),
      /外部/,
    );
    assert.equal(readFileSync(p, 'utf8'), 'a');
  }));
test('lock prevents concurrent bind and fix', () =>
  fixture((root) => {
    const release = acquireLock(root);
    try {
      assert.throws(() => acquireLock(root), /另一个/);
    } finally {
      release();
    }
    const again = acquireLock(root);
    again();
  }));
test('runtime evidence rejects shadowed, disabled and wrong group rules', () => {
  const b = entry();
  const proxies = {
    AI: { name: 'AI', type: 'Selector', now: 'DIRECT', all: ['node'] },
    node: { name: 'node', type: 'Shadowsocks' },
  };
  const rule = { index: 0, type: 'DomainSuffix', payload: 'example.com', proxy: 'AI', size: 0 };
  assert.doesNotThrow(() => verifyBindings([b], [rule], proxies));
  assert.throws(() => verifyBindings([b], [{ ...rule, proxy: 'Other' }], proxies));
  assert.throws(() => verifyBindings([b], [{ ...rule, extra: { disabled: true } }], proxies));
  assert.throws(() => verifyBindings([b], [{ ...rule, type: 'GEOIP' }], proxies));
  assert.equal(resolvePolicy('AI', proxies, new Set(['AI'])).group, 'AI');
  assert.equal(resolvePolicy('AI', proxies).group, undefined);
});

test('idempotent rebinding preserves sibling order', () => {
  const a = entry('a.example.com'),
    b = entry('b.example.com');
  assert.deepEqual(changedBindings([a, b], a, false, false), [a, b]);
});

test('retained generated overlay cannot be replaced by foreign content', () =>
  fixture((root) => {
    const b = { ...entry(), root },
      path = join(root, 'manifest.json');
    commit(planEdits(root, 'id', { version: 1, bindings: [] }, [b], path), join(root, 'tx'));
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const overlay = join(root, 'override', `afc-${awaitHash('id')}.yaml`);
    writeFileSync(overlay, '+proxy-groups: []\n');
    assert.throws(() => planEdits(root, 'id', manifest, [], path), /手动修改/);
  }));
import { createHash } from 'node:crypto';
const awaitHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 20);

import { inspectOfflineParty } from '../src/bindings/party.ts';
import { findKernelBinary } from '../src/paths.ts';
test(
  'offline snapshot reads explicit profile and rejects any running Party process',
  { skip: process.platform !== 'darwin' },
  () =>
    fixture((root) => {
      writeFileSync(join(root, 'config.yaml'), 'diffWorkDir: false\n');
      mkdirSync(join(root, 'work'));
      writeFileSync(
        join(root, 'work/config.yaml'),
        stringify({
          mode: 'rule',
          proxies: [{ name: 'node', type: 'ss' }],
          'proxy-groups': [{ name: 'Existing', type: 'select', proxies: ['node'] }],
          rules: ['MATCH,Existing'],
        }),
      );
      assert.throws(
        () =>
          inspectOfflineParty(root, undefined, [
            { pid: 1, command: '/Applications/Clash Party.app/Contents/MacOS/Clash Party' },
          ]),
        /仍在运行/,
      );
      if (process.platform === 'darwin') {
        const snapshot = inspectOfflineParty(root, findKernelBinary(), []);
        assert.equal(snapshot.party.profile, 'id');
        assert.equal(snapshot.proxies.Existing?.type, 'Selector');
        assert.deepEqual(snapshot.proxies.Existing?.all, ['node']);
      }
    }),
);

import { assertJournalScope } from '../src/bindings/store.ts';
test('recovery rejects a journal for another client before restoring files', () => {
  assert.throws(
    () =>
      assertJournalScope(
        [{ path: '/other/profile.yaml', before: 'old', after: 'new' }],
        '/current',
        '/afc/manifest.json',
      ),
    /另一个/,
  );
  assert.doesNotThrow(() =>
    assertJournalScope(
      [
        { path: '/current/profile.yaml', before: 'old', after: 'new' },
        { path: '/afc/manifest.json', before: null, after: 'new' },
      ],
      '/current',
      '/afc/manifest.json',
    ),
  );
});
