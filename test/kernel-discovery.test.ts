import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  KernelNotFoundError,
  listClientProcesses,
  listKernelProcesses,
  execPathFromCommand,
  isClientCommand,
  isClientImageName,
  kernelPathCandidatesFromProcesses,
  mergeWindowsProcessDetails,
  parseWindowsProcessJson,
  pidsNeedingDetails,
  processDirectories,
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

    // 可执行位的语义只在 POSIX 上成立：Windows 的 chmod 只管只读位，
    // 所以这条断言必须按平台分开，否则在 Windows CI 上必然失败。
    const nonExec = join(root, 'clash-meta');
    writeFileSync(nonExec, 'x');
    if (process.platform !== 'win32') {
      chmodSync(nonExec, 0o644);
      assert.ok(!scanKernelInDirs([root]).includes(nonExec), 'POSIX 上没有可执行位不算内核');
    }
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

test('tasklist 只给名字和 PID，必须把 PowerShell 的 ExecutablePath 合进来', () => {
  // 这正是「客户端装在哪」的唯一线索：Windows 上 tasklist 不带路径，
  // 若只合并命令行而丢掉 ExecutablePath，就永远找不到自定义安装目录里的内核
  const tasklist = [
    { pid: 100, name: 'Clash Verge.exe' },
    { pid: 200, name: 'verge-mihomo.exe' },
    { pid: 300, name: 'chrome.exe' },
  ];
  const details = new Map([
    [100, { command: '"D:\\tools\\Clash Verge\\Clash Verge.exe"', execPath: 'D:\\tools\\Clash Verge\\Clash Verge.exe' }],
    [200, { command: '"D:\\tools\\Clash Verge\\verge-mihomo.exe" -d "C:\\Users\\x\\AppData\\Roaming\\io.github.clash-verge-rev.clash-verge-rev"' }],
  ]);
  const merged = mergeWindowsProcessDetails(tasklist, details);
  assert.equal(merged[0]!.execPath, 'D:\\tools\\Clash Verge\\Clash Verge.exe');
  assert.equal(merged[1]!.command?.includes('-d'), true);
  // 没查详情的进程原样保留，不影响其它逻辑
  assert.equal(merged[2]!.execPath, undefined);
});

test('要查详情的 PID 包含客户端主程序，而不只是内核', () => {
  const pids = pidsNeedingDetails([
    { pid: 100, name: 'Clash Verge.exe' },
    { pid: 200, name: 'verge-mihomo.exe' },
    { pid: 300, name: 'chrome.exe' },
  ]);
  assert.deepEqual(pids, [100, 200]);
});

test('客户端同级的内核是候选：Windows 自定义安装目录也成立', () => {
  const candidates = kernelPathCandidatesFromProcesses(
    [],
    [{ pid: 1, command: 'Clash Verge.exe', execPath: 'D:\\tools\\Clash Verge\\Clash Verge.exe' }],
  );
  assert.ok(candidates.includes('D:\\tools\\Clash Verge\\verge-mihomo.exe'), candidates.join('、'));
  assert.ok(candidates.includes('D:\\tools\\Clash Verge\\verge-mihomo-alpha.exe'));
  // 内核自己的路径优先（它就在跑）
  const withKernel = kernelPathCandidatesFromProcesses(
    [{ pid: 2, command: 'mihomo.exe', execPath: 'E:\\green\\mihomo.exe' }],
    [],
  );
  assert.equal(withKernel[0], 'E:\\green\\mihomo.exe');
});

test('从命令行取路径要躲开「未加引号且带空格」的截断（macOS 上踩过）', () => {
  const real = '/Applications/Clash Party.app/Contents/Resources/sidecar/mihomo';
  const exists = (p: string): boolean => p === real;
  // ps 输出不带引号，按空格切会得到 /Applications/Clash —— 必须取「存在的最长前缀」
  assert.equal(execPathFromCommand(`${real} -d /tmp/work -ext-ctl-unix /tmp/x.sock`, exists), real);
  // 加引号的形式
  assert.equal(execPathFromCommand(`"${real}" -d /tmp`, exists), real);
  // 什么都对不上时宁可没有，也不要把半截路径传出去（否则兜底扫描会去扫 /Applications）
  assert.equal(execPathFromCommand('/Applications/Clash Party.app/x -d /tmp', exists), undefined);
  assert.equal(execPathFromCommand('not-a-path -x', exists), undefined);
  // Windows：反斜杠路径同样按「存在的最长前缀」取
  const winExe = 'D:\\tools\\Clash Verge\\verge-mihomo.exe';
  assert.equal(
    execPathFromCommand(`${winExe} -d "C:\\Users\\x"`, (p) => p === winExe),
    winExe,
  );
});

test('兜底扫描只扫内核与客户端进程所在目录，不扫整个 /Applications', () => {
  const dirs = processDirectories(
    [{ pid: 1, command: 'mihomo', execPath: '/Applications/Clash Party.app/Contents/Resources/sidecar/mihomo' }],
    [{ pid: 2, command: 'Clash Party', execPath: '/Applications/Clash Party.app/Contents/MacOS/Clash Party' }],
  );
  assert.deepEqual(dirs, [
    '/Applications/Clash Party.app/Contents/Resources/sidecar',
    '/Applications/Clash Party.app/Contents/MacOS',
  ]);
  assert.ok(!dirs.includes('/Applications'), '不能退化成一扫一大片');
});

test('PowerShell 的 ExecutablePath 会被解析出来（服务模式下可能为空）', () => {
  const parsed = parseWindowsProcessJson(JSON.stringify([
    { ProcessId: 1, Name: 'verge-mihomo.exe', CommandLine: '"D:\\a\\verge-mihomo.exe" -d D:\\w', ExecutablePath: 'D:\\a\\verge-mihomo.exe' },
    { ProcessId: 2, Name: 'verge-mihomo.exe', CommandLine: null, ExecutablePath: null },
  ]));
  assert.equal(parsed[0]!.execPath, 'D:\\a\\verge-mihomo.exe');
  assert.equal(parsed[1]!.execPath, undefined);
});

test('进程推导出的内核路径必须真实存在（不许把截断的半截路径传出去）', () => {
  const procs = [...listKernelProcesses(), ...listClientProcesses()];
  for (const proc of procs) {
    if (!proc.execPath) continue;
    assert.ok(existsSync(proc.execPath), `${proc.execPath} 不存在，说明路径被截断了（命令行按空格切的老毛病）`);
  }
});
