import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afcStateDir, currentPlatform } from '../platform.ts';
import { UsageError } from '../errors.ts';

/**
 * `afc groups` 打印的编号 → 组名 的映射缓存。
 *
 * 为什么需要落盘：组名常带 emoji 与中文（`🤖AI网站`、`🇭🇰 香港 01`），在终端里又难打又容易打错，
 * 用户希望「afc groups 里第 3 个」就能直接拿去 add。编号只在打印那一刻有意义，
 * 所以把这份清单存下来，命令之间才能对上号。
 *
 * 放在运行状态目录而不是配置目录：它只是缓存，删掉只会让编号失效，不该混进用户配置。
 */
export interface IndexedGroup {
  index: number;
  name: string;
  type: string;
}

export interface GroupsIndex {
  savedAt: string;
  /** 该清单来自哪个控制端点（换客户端后编号含义会变，据此提示）。 */
  endpoint: string;
  groups: IndexedGroup[];
}

export function groupsIndexPath(): string {
  return join(afcStateDir(currentPlatform()), 'groups-index.json');
}

/** 记录本次 `afc groups` 的打印顺序；失败不影响命令本身。 */
export function writeGroupsIndex(endpoint: string, groups: readonly { name: string; type: string }[]): void {
  try {
    const path = groupsIndexPath();
    mkdirSync(dirname(path), { recursive: true });
    const payload: GroupsIndex = {
      savedAt: new Date().toISOString(),
      endpoint,
      groups: groups.map((g, i) => ({ index: i + 1, name: g.name, type: g.type })),
    };
    writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch {
    // 缓存写不进去（只读目录等）不能影响主流程
  }
}

export function readGroupsIndex(): GroupsIndex | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(groupsIndexPath(), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const rec = parsed as { savedAt?: unknown; endpoint?: unknown; groups?: unknown };
  if (typeof rec.endpoint !== 'string' || !Array.isArray(rec.groups)) return undefined;
  const groups: IndexedGroup[] = [];
  for (const item of rec.groups) {
    if (typeof item !== 'object' || item === null) continue;
    const g = item as { index?: unknown; name?: unknown; type?: unknown };
    if (typeof g.index === 'number' && typeof g.name === 'string' && typeof g.type === 'string') {
      groups.push({ index: g.index, name: g.name, type: g.type });
    }
  }
  if (groups.length === 0) return undefined;
  return {
    savedAt: typeof rec.savedAt === 'string' ? rec.savedAt : '',
    endpoint: rec.endpoint,
    groups,
  };
}

/** 参数是不是「编号」（纯数字）。 */
export function isGroupIndexArg(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

/**
 * 把参数解析成组名：数字按最近一次 `afc groups` 的编号查，其它原样返回。
 *
 * 解析不出来时给出可执行的下一步（重跑 afc groups），而不是含糊地说"找不到"。
 */
export function resolveGroupArg(value: string): string {
  if (!isGroupIndexArg(value)) return value;
  const wanted = Number(value.trim());
  const index = readGroupsIndex();
  const hit = index?.groups.find((g) => g.index === wanted);
  if (hit) return hit.name;

  const detail = index
    ? `最近一次 afc groups（${index.endpoint}）打印的编号是 1–${index.groups.length}。\n`
    : '还没有可用的编号：编号来自最近一次 afc groups。\n';
  throw new UsageError(
    `没有编号 ${value} 对应的组。\n` + detail +
    '先运行 afc groups，再用它打印的编号操作（组名带 emoji 时尤其推荐这样用）。',
  );
}
