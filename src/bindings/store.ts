import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { afcConfigDir, currentPlatform } from '../platform.ts';
import { parseDomainPattern } from '../targets/domain.ts';
import type { DomainTargetConfig } from '../targets/domain.ts';

export interface Binding {
  root: string;
  profile: string;
  pattern: string;
  group: string;
  created: boolean;
  target: DomainTargetConfig;
}
export interface Manifest {
  version: 1;
  bindings: Binding[];
  groups?: { root: string; profile: string; name: string }[];
}
export const stateDir = (): string => afcConfigDir(currentPlatform());
export const manifestPath = (): string => join(stateDir(), 'bindings.json');
export function readManifest(path = manifestPath()): Manifest {
  if (!existsSync(path)) return { version: 1, bindings: [] };
  const value = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (
    value.version !== 1 ||
    !Array.isArray(value.bindings) ||
    value.bindings.some(
      (b) =>
        !b ||
        !['root', 'profile', 'pattern', 'group'].every(
          (k) => typeof (b as unknown as Record<string, unknown>)[k] === 'string',
        ) ||
        !b.target ||
        typeof b.created !== 'boolean' ||
        !Array.isArray(b.target.extraProbes) ||
        !Array.isArray(b.target.countryAllow) ||
        !Array.isArray(b.target.countryDeny),
    )
  )
    throw new Error('绑定登记格式无效');
  if (
    value.groups !== undefined &&
    (!Array.isArray(value.groups) ||
      value.groups.some(
        (g) =>
          !g ||
          typeof g.root !== 'string' ||
          typeof g.profile !== 'string' ||
          typeof g.name !== 'string',
      ))
  )
    throw new Error('组所有权登记格式无效');
  for (const b of value.bindings) {
    if (
      !isAbsolute(b.root) ||
      !/^[a-zA-Z0-9_-]+$/.test(b.profile) ||
      !b.group ||
      /[,\r\n]/.test(b.group) ||
      parseDomainPattern(b.pattern).input !== b.pattern ||
      b.target.pattern !== b.pattern
    )
      throw new Error('绑定登记字段无效');
  }
  return value;
}
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.afc-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
export function acquireLock(dir = stateDir()): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'bindings.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('绑定锁损坏，请检查 bindings.lock');
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
          rmSync(path);
          continue;
        }
      }
      throw new Error('另一个 afc 正在处理绑定或修复，请稍后重试');
    }
  }
  throw new Error('无法获取绑定锁');
}
export interface Edit {
  path: string;
  before: string | null;
  after: string | null;
}
export function restore(edits: Edit[]): void {
  // Check every file before restoring any file: never overwrite concurrent external edits.
  for (const e of edits) {
    const now = existsSync(e.path) ? readFileSync(e.path, 'utf8') : null;
    if (now !== e.before && now !== e.after)
      throw new Error(`文件被外部修改，保留恢复记录：${e.path}`);
  }
  for (const e of [...edits].reverse()) {
    if (e.before === null) rmSync(e.path, { force: true });
    else atomicWrite(e.path, e.before);
  }
}
export function commit(edits: Edit[], journal: string): void {
  if (existsSync(journal)) throw new Error(`有未完成的绑定事务：${journal}`);
  for (const e of edits) {
    const now = existsSync(e.path) ? readFileSync(e.path, 'utf8') : null;
    if (now !== e.before) throw new Error(`文件已变化：${e.path}`);
  }
  atomicWrite(journal, JSON.stringify(edits));
  for (const e of edits) {
    if (e.after === null) rmSync(e.path, { force: true });
    else atomicWrite(e.path, e.after);
  }
}

/** Recovery must target the same client data directory as the original transaction. */
export function assertJournalScope(edits: Edit[], root: string, manifestFile: string): void {
  if (!Array.isArray(edits)) throw new Error('恢复记录格式无效');
  for (const edit of edits) {
    if (
      !edit ||
      typeof edit.path !== 'string' ||
      (edit.before !== null && typeof edit.before !== 'string') ||
      (edit.after !== null && typeof edit.after !== 'string')
    )
      throw new Error('恢复记录格式无效');
    // 用平台分隔符判断「跳出 root」：Windows 上 relative() 返回 ..\other\x，
    // 只认 ../ 会把另一个数据目录的恢复记录放过去（CI 在 windows-latest 上就是这么挂的）。
    const rel = relative(root, edit.path);
    const outsideRoot = isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
    if (edit.path !== manifestFile && outsideRoot)
      throw new Error('未完成事务属于另一个客户端数据目录，请使用原客户端恢复');
  }
}
