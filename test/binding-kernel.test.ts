import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { findKernelBinary } from '../src/paths.ts';
import { MihomoClient } from '../src/controller/client.ts';
import { rawRequest } from '../src/controller/http.ts';
import { planEdits, overlayId } from '../src/bindings/plan.ts';
import { commit, type Manifest, type Binding } from '../src/bindings/store.ts';
import { verifyBindings } from '../src/bindings/party.ts';
import { resolveDomainRoutes } from '../src/routes/resolver.ts';
import { parseDomainPattern } from '../src/targets/domain.ts';
let kernel: string | undefined;
try {
  kernel = findKernelBinary();
} catch {
  /* integration test requires a local kernel */
}

test(
  'isolated mihomo accepts generated bindings, refresh, replacement and removal',
  { skip: !kernel || process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'afc-bind-kernel-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      mkdirSync(join(root, 'rules'));
      mkdirSync(join(root, 'override'));
      writeFileSync(
        join(root, 'profile.yaml'),
        'current: test\nitems:\n  - id: test\n    override: []\n',
      );
      writeFileSync(join(root, 'override.yaml'), 'items: []\n');
      writeFileSync(join(root, 'rules/test.yaml'), 'prepend: ["DOMAIN,user.example,DIRECT"]\n');
      const path = join(root, 'manifest.json');
      let manifest: Manifest = { version: 1, bindings: [] };
      const binding: Binding = {
        root,
        profile: 'test',
        pattern: '*.chatgpt.com',
        group: 'AFC-Test',
        created: true,
        target: { pattern: '*.chatgpt.com', extraProbes: [], countryAllow: [], countryDeny: [] },
      };
      function apply(bindings: Binding[]): void {
        const journal = join(root, 'journal');
        commit(planEdits(root, 'test', manifest, bindings, path), journal);
        rmSync(journal);
        manifest = JSON.parse(readFileSync(path, 'utf8'));
      }
      let nodes = ['A', 'B'];
      // Reproduce the documented YAML +proxy-groups and native prepend merge boundaries.
      function render(): Record<string, unknown> {
        const overlay = parse(
          readFileSync(join(root, 'override', overlayId('test') + '.yaml'), 'utf8'),
        );
        const rules = parse(readFileSync(join(root, 'rules/test.yaml'), 'utf8'));
        return {
          mode: 'rule',
          'log-level': 'silent',
          'external-controller-unix': join(root, 'ctl.sock'),
          proxies: nodes.map((name) => ({ name, type: 'socks5', server: '127.0.0.1', port: 9 })),
          'proxy-groups': [
            ...overlay['+proxy-groups'],
            { name: 'Existing', type: 'select', proxies: nodes },
          ],
          rules: [...rules.prepend, 'MATCH,DIRECT'],
        };
      }
      apply([binding]);
      const config = join(root, 'config.yaml');
      writeFileSync(config, stringify(render()));
      let output = '';
      child = spawn(kernel!, ['-d', root, '-f', config], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (b) => {
        output += String(b);
      });
      child.stderr?.on('data', (b) => {
        output += String(b);
      });
      const endpoint = {
        kind: 'unix' as const,
        path: join(root, 'ctl.sock'),
        source: 'isolated-test',
      };
      const client = new MihomoClient(endpoint, 500);
      let ready = false;
      for (let i = 0; i < 50; i++) {
        try {
          await client.version();
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert.ok(ready, `isolated kernel starts (${kernel}): ${output}`);
      const rules = await client.rules(),
        proxies = await client.proxies();
      verifyBindings([binding], rules, proxies);
      assert.deepEqual(proxies['AFC-Test']!.all, ['A', 'B']);
      const routes = await resolveDomainRoutes(
        [parseDomainPattern('*.chatgpt.com')],
        rules,
        proxies,
        'rule',
        { explicitGroups: new Set(['AFC-Test']) },
      );
      assert.equal(routes.issues.length, 0);
      assert.equal(routes.bindings[0]?.group, 'AFC-Test');
      async function reload(): Promise<void> {
        const res = await rawRequest(endpoint, {
          method: 'PUT',
          path: '/configs?force=true',
          body: JSON.stringify({ payload: stringify(render()) }),
        });
        assert.equal(res.status, 204);
      }
      nodes = ['C'];
      await reload();
      assert.deepEqual((await client.proxies())['AFC-Test']!.all, ['C']);
      const existing = { ...binding, group: 'Existing', created: false };
      apply([existing]);
      await reload();
      verifyBindings([existing], await client.rules(), await client.proxies());
      apply([]);
      await reload();
      assert.equal((await client.rules())[0]?.payload, 'user.example');
      assert.deepEqual(manifest.bindings, []);
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);
