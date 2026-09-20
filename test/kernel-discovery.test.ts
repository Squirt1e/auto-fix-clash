import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KernelNotFoundError,
  isClientCommand,
  isClientImageName,
  scanKernelInDirs,
  siblingKernelPaths,
} from '../src/paths.ts';
import { setVerbose } from '../src/verbosity.ts';
import type { PlatformContext } from '../src/platform.ts';

const WIN: PlatformContext = { platform: 'win32', home: 'C:\\Users\\x', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } };

test('客户端主程序的镜像名与命令行都能认出来（不会把内核自己当成客户端）', () => {
  for (const name of ['Clash Verge.exe', 'clash-verge.exe', 'Clash Party.exe', 'mihomo-party.exe', 'verge.exe']) {
    assert.equal(isClientImageName(name), true, name);
  }
  // 内核进程不是客户端主程序，不能拿它的同级目录去猜
  for (const name of ['verge-mihomo.exe', 'mihomo.exe', 'chrome.exe', '']) {
    assert.equal(isClientImageName(name), false, name);
  }
  assert.equal(isClientCommand('/Applications/Clash Party.app/Contents/MacOS/Clash Party --flag'), true);
  assert.equal(isClientCommand('/Applications/Clash Verge.app/Contents/MacOS/Clash Verge'), true);
  assert.equal(isClientCommand('/Applications/Clash Party.app/Contents/Resources/sidecar/mihomo -d /tmp'), false);
});

test('内核就在客户端主程序旁边：Windows 自定义安装目录同样成立', () => {
  const paths = siblingKernelPaths('D:\\tools\\Clash Verge\\Clash Verge.exe');
  // Verge 的 externalBin 声明了两个内核
  assert.ok(paths.includes('D:\\tools\\Clash Verge\\verge-mihomo.exe'), paths.join('、'));
  assert.ok(paths.includes('D:\\tools\\Clash Verge\\verge-mihomo-alpha.exe'), paths.join('、'));
  // Clash Party 把内核放在 resources/sidecar 下
  assert.ok(paths.includes('D:\\tools\\Clash Verge\\resources\\sidecar\\mihomo.exe'));
  // 路径风格决定扩展名：Windows 路径就该配 .exe，与当前操作系统无关
  assert.ok(paths.every((p) => p.endsWith('.exe')));
});

test('macOS 的 .app 布局：从 Contents/MacOS 推到 Contents/Resources/sidecar', () => {
  const paths = siblingKernelPaths('/Applications/Clash Party.app/Contents/MacOS/Clash Party');
  assert.ok(paths.includes('/Applications/Clash Party.app/Contents/MacOS/mihomo'));
  assert.ok(paths.includes('/Applications/Clash Party.app/Contents/Resources/sidecar/mihomo'), paths.join('、'));
  assert.ok(paths.every((p) => !p.endsWith('.exe')));
  assert.deepEqual(siblingKernelPaths(undefined), []);
});

test('目录扫描能找到内核（含子目录），并跳过无关文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'afc-kernel-'));
  try {
    writeFileSync(join(root, 'verge-mihomo'), 'x');
    chmodSync(join(root, 'verge-mihomo'), 0o755);
    writeFileSync(join(root, 'notes.txt'), 'x');
    mkdirSync(join(root, 'resources', 'sidecar'), { recursive: true });
    writeFileSync(join(root, 'resources', 'sidecar', 'mihomo'), 'x');
    chmodSync(join(root, 'resources', 'sidecar', 'mihomo'), 0o755);
    // 太深的目录不扫（有限深度）
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c', 'mihomo'), 'x');
    chmodSync(join(root, 'a', 'b', 'c', 'mihomo'), 0o755);

    const found = scanKernelInDirs([root]);
    assert.ok(found.includes(join(root, 'verge-mihomo')));
    assert.ok(found.includes(join(root, 'resources', 'sidecar', 'mihomo')));
    assert.ok(!found.some((p) => p.endsWith('notes.txt')));
    assert.ok(!found.some((p) => p.includes(join('a', 'b', 'c'))), '超过深度上限的不扫');

    // POSIX 上要求可执行位
    const nonExec = join(root, 'clash-meta');
    writeFileSync(nonExec, 'x');
    chmodSync(nonExec, 0o644);
    assert.ok(!scanKernelInDirs([root]).includes(nonExec), 'POSIX 上没有可执行位不算内核');
    // Windows 上没有可执行位这一说：存在且是文件即可（否则会把能用的内核判死）
    assert.ok(scanKernelInDirs([root], WIN).includes(nonExec));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('找不到内核时：默认只给下一步，--verbose 才列全部位置', () => {
  const tried = ['C:\\Program Files\\Clash Verge\\verge-mihomo.exe', 'PATH 中的 mihomo'];
  try {
    const short = new KernelNotFoundError(tried, WIN).message;
    assert.match(short, /找不到 mihomo 内核二进制/);
    assert.match(short, /kernelPath/);
    assert.match(short, /--verbose/);
    assert.doesNotMatch(short, /Program Files/, '默认不该把 13 条路径倒出来');
    assert.ok(short.split('\n').length <= 8, `默认提示过长：\n${short}`);

    setVerbose(true);
    const long = new KernelNotFoundError(tried, WIN).message;
    assert.match(long, /已尝试的位置/);
    assert.match(long, /Program Files/);
  } finally {
    setVerbose(false);
  }
});
