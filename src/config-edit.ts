import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadConfig, type TargetConfig } from './config.ts';

/** 需要加引号的 YAML 标量（组名里可能有 emoji、冒号、井号等）。 */
function yamlScalar(value: string): string {
  if (/^[\p{L}\p{N}\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}][^:#]*$/u.test(value) && !value.endsWith(' ')) {
    return value;
  }
  return JSON.stringify(value);
}

/** 生成一段 targets 数组条目（保持人可读、与现有配置文件风格一致）。 */
export function renderTargetBlock(target: TargetConfig): string {
  const lines: string[] = [`- name: ${yamlScalar(target.name)}`];
  if (target.aliases.length > 0) {
    lines.push(`  aliases: [${target.aliases.map(yamlScalar).join(', ')}]`);
  }
  lines.push('  probe:');
  lines.push(`    url: ${target.probe.url}`);
  lines.push(`    expectedStatus: [${target.probe.expectedStatus.join(', ')}]`);
  if (target.probe.method && target.probe.method !== 'GET') lines.push(`    method: ${target.probe.method}`);
  if (target.extraProbes.length > 0) {
    lines.push('  extraProbes:');
    for (const extra of target.extraProbes) {
      lines.push(`    - url: ${extra.url}`);
      lines.push(`      expectedStatus: [${extra.expectedStatus.join(', ')}]`);
      if (extra.method && extra.method !== 'GET') lines.push(`      method: ${extra.method}`);
    }
  }
  if (target.geoProbe) {
    lines.push('  geoProbe:');
    lines.push(`    url: ${target.geoProbe.url}`);
    lines.push('    format: cloudflare-trace');
  }
  if (target.countryDeny.length > 0) lines.push(`  countryDeny: [${target.countryDeny.join(', ')}]`);
  if (target.countryAllow.length > 0) lines.push(`  countryAllow: [${target.countryAllow.join(', ')}]`);
  return lines.join('\n') + '\n';
}

const indent = (block: string, spaces: number): string =>
  block
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => (line === '' ? '' : ' '.repeat(spaces) + line))
    .join('\n') + '\n';

/** targets 段的结束位置（下一个顶层键之前）。 */
function findTargetsEnd(lines: string[], targetsIndex: number): number {
  for (let i = targetsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '' || line.startsWith('#') || /^\s/.test(line)) continue;
    return i;
  }
  return lines.length;
}

/**
 * 往配置文本里加一个目标条目。
 *
 * 用文本插入而不是 parse→stringify：后者会把用户配置里的注释全部抹掉，
 * 而那份文件里有大量解释性注释，抹掉等于让用户失去说明。
 */
export function addTargetToConfigText(text: string, target: TargetConfig): string {
  const block = indent(renderTargetBlock(target), 2);
  const lines = text.split('\n');
  const targetsIndex = lines.findIndex((line) => /^targets:/.test(line));

  if (targetsIndex < 0) {
    const base = text.replace(/\s*$/, '');
    return `${base}${base === '' ? '' : '\n\n'}targets:\n${block}`;
  }

  // `targets: []` 这种空数组写法要先展开
  const header = lines[targetsIndex]!;
  if (/^targets:\s*\[\s*\]\s*$/.test(header)) {
    const rest = [...lines.slice(0, targetsIndex), 'targets:', ...lines.slice(targetsIndex + 1)];
    return addTargetToConfigText(rest.join('\n'), target);
  }

  const end = findTargetsEnd(lines, targetsIndex);
  // 把插入点放在段内最后一行非空内容之后（保留原有的空行分隔）
  let insertAt = end;
  while (insertAt > targetsIndex + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt -= 1;

  return [
    ...lines.slice(0, insertAt),
    ...block.replace(/\n$/, '').split('\n'),
    ...lines.slice(insertAt),
  ].join('\n');
}

/** 从配置文本里删掉指定组名的目标条目；找不到时返回 undefined。 */
export function removeTargetFromConfigText(text: string, groupNames: readonly string[]): string | undefined {
  const lines = text.split('\n');
  const wanted = new Set(groupNames);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)- name:\s*(.+?)\s*$/.exec(lines[i]!);
    if (!match) continue;
    const name = match[2]!.replace(/^["']|["']$/g, '');
    if (wanted.has(name)) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;

  // 条目从 start 开始，到下一个同级 `- name:` 或顶层键为止
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*- name:\s*/.test(line) && /^\s{2}- /.test(line)) {
      end = i;
      break;
    }
    if (line.trim() === '' || line.startsWith('#') || /^\s/.test(line)) continue;
    end = i;
    break;
  }
  let trimmedEnd = end;
  while (trimmedEnd > start && (lines[trimmedEnd - 1] ?? '').trim() === '') trimmedEnd -= 1;

  const out = [...lines.slice(0, start), ...lines.slice(trimmedEnd)];

  // 删掉最后一条后不能留下悬空的 `targets:`（那样 YAML 里它是 null，配置会失效）
  const targetsIndex = out.findIndex((line) => /^targets:/.test(line));
  if (targetsIndex >= 0) {
    const sectionEnd = findTargetsEnd(out, targetsIndex);
    const hasEntry = out.slice(targetsIndex + 1, sectionEnd).some((line) => /^\s*- name:/.test(line));
    if (!hasEntry) out[targetsIndex] = 'targets: []';
  }

  return out.join('\n');
}

export interface ConfigWriteResult {
  path: string;
  /** 是否新建了配置文件。 */
  created: boolean;
}

/**
 * 原子写入：先写临时文件并校验能被正常加载，再改名为正式文件。
 * 校验不通过就丢弃临时文件并抛错，绝不留下半损坏的配置。
 */
export function writeConfigText(path: string, text: string): ConfigWriteResult {
  const created = !existsSync(path);
  const tmp = join(dirname(path), `.afc-${process.pid.toString(36)}-${Date.now().toString(36)}.tmp`);
  writeFileSync(tmp, text, 'utf8');
  try {
    loadConfig(tmp);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, path);
  return { path, created };
}
