import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { UsageError } from './errors.ts';

/** 单个探测端点：以「期望状态码」判定节点对该目标是否可用。 */
export interface ProbeEndpoint {
  /** 探测 URL。 */
  url: string;
  /**
   * 期望状态码。单个值表示精确匹配（如 [405]）；
   * 升序两值表示闭区间（如 [200, 299]）；多值表示枚举。
   */
  expectedStatus: number[];
  /** HTTP 方法，默认 GET。 */
  method?: 'GET' | 'POST';
}

/** 出口信息探测端点（用于取得出口国家与落地 IP）。 */
export interface GeoProbe {
  url: string;
  /** 响应格式；目前支持 Cloudflare 的 `cdn-cgi/trace` 文本格式。 */
  format: 'cloudflare-trace';
}

export interface TargetConfig {
  /** 组名，需与 mihomo 中的代理组名一致。 */
  name: string;
  /** 主判据。 */
  probe: ProbeEndpoint;
  /** 附加判据（任一通过即视为该组端点通过）。 */
  extraProbes: ProbeEndpoint[];
  /** 出口信息探测；省略时不做出口国家判定。 */
  geoProbe?: GeoProbe;
  /** 出口国家白名单（大写 ISO-3166 alpha-2）；为空表示不限。 */
  countryAllow: string[];
  /** 出口国家黑名单；命中即判不可用。 */
  countryDeny: string[];
}

export interface ProbeSettings {
  /** 同时处于探测中的节点数上限（限制对同一订阅同时打开的隧道数）。 */
  concurrency: number;
  /** 判定为失败后的重试次数。 */
  retries: number;
  /** 判定性探测的单次请求超时（毫秒）。 */
  timeoutMs: number;
  /**
   * 候选筛查阶段的超时（毫秒）。筛查只用来快速排除不通的节点，
   * 用较短超时可以显著缩短「当前节点失效 → 找到替代节点」的时间。
   */
  screenTimeoutMs: number;
  /** mihomo 内核二进制路径；省略时自动发现。 */
  kernelPath?: string;
  /** 运行时配置路径；省略时自动发现。 */
  runtimeConfigPath?: string;
}

export interface ScheduleSettings {
  /** 计划任务的运行间隔（秒）。 */
  intervalSeconds: number;
}

export interface AfcConfig {
  probe: ProbeSettings;
  schedule: ScheduleSettings;
  targets: TargetConfig[];
  /** 配置文件的实际来源路径；使用内置默认时为 undefined。 */
  sourcePath?: string;
}

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`配置有误：\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** 已知被目标站点拒绝的国家/地区，作为附加兜底判据（主判据始终是实测响应码）。 */
const GPT_COUNTRY_DENY = ['HK', 'CN', 'MO', 'RU', 'IR', 'KP', 'CU', 'SY', 'AF', 'BY', 'VE', 'MM'];

export const DEFAULT_TARGETS: TargetConfig[] = [
  {
    name: 'GPT',
    probe: {
      // 可用出口返回 405；被目标站点拒绝的出口（如香港）返回 403。
      // 注意：不要用 https://chatgpt.com/ 首页做判据 —— 它对所有出口都返回
      // Cloudflare JS 挑战 403，无法区分「可用」与「被拒绝」。
      url: 'https://chatgpt.com/backend-api/codex/responses',
      expectedStatus: [405],
      method: 'GET',
    },
    extraProbes: [
      { url: 'https://api.openai.com/v1/models', expectedStatus: [401], method: 'GET' },
    ],
    geoProbe: { url: 'https://chatgpt.com/cdn-cgi/trace', format: 'cloudflare-trace' },
    countryAllow: [],
    countryDeny: GPT_COUNTRY_DENY,
  },
];

export const DEFAULT_PROBE: ProbeSettings = {
  concurrency: 2,
  retries: 1,
  timeoutMs: 15000,
  screenTimeoutMs: 5000,
};

export const DEFAULT_SCHEDULE: ScheduleSettings = {
  intervalSeconds: 300,
};

export const MIN_SCHEDULE_INTERVAL_SECONDS = 60;

/** 按优先级查找配置文件。显式路径不存在时报错，候选路径不存在时返回 undefined。 */
export function resolveConfigPath(explicit?: string): string | undefined {
  if (explicit) {
    const abs = isAbsolute(explicit) ? explicit : resolve(explicit);
    if (!existsSync(abs)) throw new Error(`指定的配置文件不存在：${abs}`);
    return abs;
  }
  const candidates = [
    resolve('afc.config.yaml'),
    join(homedir(), '.config', 'afc', 'config.yaml'),
  ];
  return candidates.find((p) => existsSync(p));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function normalizeEndpoint(raw: unknown, where: string, problems: string[]): ProbeEndpoint | undefined {
  if (!isPlainObject(raw)) {
    problems.push(`${where} 必须是对象`);
    return undefined;
  }
  const url = raw['url'];
  if (!isNonEmptyString(url)) {
    problems.push(`${where}.url 缺失或为空`);
    return undefined;
  }
  if (!/^https:\/\//.test(url)) {
    problems.push(`${where}.url 必须是 https 地址（探测经 CONNECT 隧道发起）：${url}`);
    return undefined;
  }
  const rawStatus = raw['expectedStatus'] ?? raw['expected-status'];
  let expectedStatus: number[] | undefined;
  if (Array.isArray(rawStatus)) {
    const nums = rawStatus.map((v) => (typeof v === 'string' ? Number(v) : v));
    if (nums.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 100 || n > 599)) {
      problems.push(`${where}.expectedStatus 只能包含 100–599 的整数：${JSON.stringify(rawStatus)}`);
    } else {
      expectedStatus = nums as number[];
    }
  } else if (typeof rawStatus === 'number') {
    expectedStatus = [rawStatus];
  } else {
    problems.push(`${where}.expectedStatus 缺失，需声明期望状态码（如 [405]）`);
  }
  const method = raw['method'];
  if (method !== undefined && method !== 'GET' && method !== 'POST') {
    problems.push(`${where}.method 只能是 GET 或 POST`);
  }
  if (!expectedStatus) return undefined;
  const endpoint: ProbeEndpoint = { url, expectedStatus };
  if (method === 'GET' || method === 'POST') endpoint.method = method;
  return endpoint;
}

function normalizeStringList(raw: unknown, where: string, problems: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push(`${where} 必须是字符串数组`);
    return [];
  }
  return raw
    .map((v) => {
      if (!isNonEmptyString(v)) {
        problems.push(`${where} 含非字符串项`);
        return '';
      }
      return v.trim().toUpperCase();
    })
    .filter((v) => v !== '');
}

function normalizeTarget(raw: unknown, index: number, problems: string[]): TargetConfig | undefined {
  const where = `targets[${index}]`;
  if (!isPlainObject(raw)) {
    problems.push(`${where} 必须是对象`);
    return undefined;
  }
  const name = raw['name'];
  if (!isNonEmptyString(name)) {
    problems.push(`${where}.name 缺失或为空`);
    return undefined;
  }
  const preset = DEFAULT_TARGETS.find((t) => t.name === name);
  const probe = normalizeEndpoint(raw['probe'], `${where}.probe`, problems);
  if (!probe) return undefined;

  let extraProbes: ProbeEndpoint[];
  const rawExtras = raw['extraProbes'];
  if (rawExtras === undefined || rawExtras === null) {
    // 组名命中内置预设时继承其附加判据；显式写 [] 表示不要任何附加判据。
    extraProbes = preset ? preset.extraProbes.map((e) => ({ ...e })) : [];
  } else if (!Array.isArray(rawExtras)) {
    problems.push(`${where}.extraProbes 必须是数组`);
    extraProbes = [];
  } else {
    extraProbes = [];
    rawExtras.forEach((e, i) => {
      const ep = normalizeEndpoint(e, `${where}.extraProbes[${i}]`, problems);
      if (ep) extraProbes.push(ep);
    });
  }

  let geoProbe: GeoProbe | undefined;
  const rawGeo = raw['geoProbe'];
  if (rawGeo === undefined || rawGeo === null) {
    geoProbe = preset?.geoProbe;
  } else if (isPlainObject(rawGeo) && isNonEmptyString(rawGeo['url'])) {
    const format = rawGeo['format'] ?? 'cloudflare-trace';
    if (format !== 'cloudflare-trace') {
      problems.push(`${where}.geoProbe.format 目前只支持 cloudflare-trace`);
    } else if (!/^https:\/\//.test(rawGeo['url'])) {
      problems.push(`${where}.geoProbe.url 必须是 https 地址`);
    } else {
      geoProbe = { url: rawGeo['url'], format: 'cloudflare-trace' };
    }
  } else {
    problems.push(`${where}.geoProbe 必须是 { url: string } 对象（可省略以禁用出口国家判定）`);
  }

  return {
    name: name.trim(),
    probe,
    extraProbes,
    ...(geoProbe ? { geoProbe } : {}),
    countryAllow: raw['countryAllow'] === undefined
      ? (preset?.countryAllow ?? [])
      : normalizeStringList(raw['countryAllow'], `${where}.countryAllow`, problems),
    countryDeny: raw['countryDeny'] === undefined
      ? (preset?.countryDeny ?? [])
      : normalizeStringList(raw['countryDeny'], `${where}.countryDeny`, problems),
  };
}

function normalizeProbeSettings(raw: unknown, problems: string[]): ProbeSettings {
  if (raw === undefined || raw === null) return { ...DEFAULT_PROBE };
  if (!isPlainObject(raw)) {
    problems.push('probe 必须是对象');
    return { ...DEFAULT_PROBE };
  }
  const out: ProbeSettings = { ...DEFAULT_PROBE };
  const concurrency = raw['concurrency'];
  if (concurrency !== undefined) {
    if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
      problems.push('probe.concurrency 必须是 1–4 的整数（用于限制对同一订阅同时打开的隧道数）');
    } else {
      out.concurrency = concurrency;
    }
  }
  const retries = raw['retries'];
  if (retries !== undefined) {
    if (typeof retries !== 'number' || !Number.isInteger(retries) || retries < 0 || retries > 5) {
      problems.push('probe.retries 必须是 0–5 的整数');
    } else {
      out.retries = retries;
    }
  }
  const timeout = raw['timeoutMs'];
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1000) {
      problems.push('probe.timeoutMs 必须是 >= 1000 的整数');
    } else {
      out.timeoutMs = timeout;
    }
  }
  const screenTimeout = raw['screenTimeoutMs'];
  if (screenTimeout !== undefined) {
    if (typeof screenTimeout !== 'number' || !Number.isInteger(screenTimeout) || screenTimeout < 1000) {
      problems.push('probe.screenTimeoutMs 必须是 >= 1000 的整数');
    } else if (screenTimeout > out.timeoutMs) {
      problems.push('probe.screenTimeoutMs 不应大于 probe.timeoutMs（筛查应当比判定更快）');
    } else {
      out.screenTimeoutMs = screenTimeout;
    }
  }
  if (isNonEmptyString(raw['kernelPath'])) out.kernelPath = raw['kernelPath'];
  if (isNonEmptyString(raw['runtimeConfigPath'])) out.runtimeConfigPath = raw['runtimeConfigPath'];
  return out;
}

function normalizeSchedule(raw: unknown, problems: string[]): ScheduleSettings {
  if (raw === undefined || raw === null) return { ...DEFAULT_SCHEDULE };
  if (!isPlainObject(raw)) {
    problems.push('schedule 必须是对象');
    return { ...DEFAULT_SCHEDULE };
  }
  const interval = raw['intervalSeconds'];
  if (interval === undefined) return { ...DEFAULT_SCHEDULE };
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < MIN_SCHEDULE_INTERVAL_SECONDS) {
    problems.push(`schedule.intervalSeconds 必须是 >= ${MIN_SCHEDULE_INTERVAL_SECONDS} 的整数秒（避免过度探测触发机场限流）`);
    return { ...DEFAULT_SCHEDULE };
  }
  return { intervalSeconds: interval };
}

/**
 * 加载并校验配置。未找到配置文件时使用内置默认（含 GPT/Codex 预设）。
 * 校验问题汇总后一次性抛出，便于一次修完。
 */
export function loadConfig(explicitPath?: string): AfcConfig {
  const path = resolveConfigPath(explicitPath);
  const problems: string[] = [];
  let rawDoc: Record<string, unknown> = {};

  if (path) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(`无法读取配置文件 ${path}：${(err as Error).message}`);
    }
    const parsed: unknown = parseYaml(text);
    if (parsed === null || parsed === undefined) {
      rawDoc = {};
    } else if (!isPlainObject(parsed)) {
      throw new ConfigError([`${path} 的顶层必须是映射（key: value）`]);
    } else {
      rawDoc = parsed;
    }
  }

  const probe = normalizeProbeSettings(rawDoc['probe'], problems);
  const schedule = normalizeSchedule(rawDoc['schedule'], problems);

  let targets: TargetConfig[];
  const rawTargets = rawDoc['targets'];
  if (rawTargets === undefined) {
    targets = DEFAULT_TARGETS.map((t) => ({ ...t }));
  } else if (!Array.isArray(rawTargets)) {
    problems.push('targets 必须是数组');
    targets = [];
  } else {
    targets = rawTargets
      .map((t, i) => normalizeTarget(t, i, problems))
      .filter((t): t is TargetConfig => t !== undefined);
  }
  if (rawTargets !== undefined && targets.length === 0) {
    problems.push('targets 为空：至少需要配置一个目标组');
  }

  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.name)) problems.push(`targets 中存在重复的组名：${t.name}`);
    seen.add(t.name);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const config: AfcConfig = { probe, schedule, targets };
  if (path) config.sourcePath = path;
  return config;
}

/** 按组名查找目标；找不到时抛出带指引的错误。 */
export function requireTarget(config: AfcConfig, groupName: string): TargetConfig {
  const target = config.targets.find((t) => t.name === groupName);
  if (!target) {
    const known = config.targets.map((t) => t.name).join(', ');
    throw new UsageError(
      `没有为代理组 “${groupName}” 配置探测目标。已配置的组：${known || '（无）'}\n` +
      '请在 afc.config.yaml 的 targets 下新增该组，示例：\n' +
      '  targets:\n' +
      `    - name: ${groupName}\n` +
      '      probe:\n' +
      '        url: https://example.com/\n' +
      '        expectedStatus: [200]',
    );
  }
  return target;
}
