import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseEndpointString } from './controller/discovery.ts';
import { UsageError } from './errors.ts';
import { afcConfigPath, currentPlatform } from './platform.ts';

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
  /**
   * 备用组名。不同订阅可能给同一用途的组起不同名字
   * （例如 A 订阅叫 `GPT`、B 订阅叫 `ChatGPT`），用别名即可一套配置通用。
   */
  aliases: string[];
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

/**
 * 归一化组名，用于「宽容匹配」。
 *
 * 动机来自真实数据：同一个用途的组在不同机场里可能叫 `GPT`、`🤖AI网站`、
 * `AI 网站`、`ChatGPT专用`。去掉 emoji、空白与常见分隔符后比较，
 * 一套 aliases 才能同时适配多个订阅。
 */
export function normalizeGroupName(name: string): string {
  return name
    // 只去「图形类」emoji 与区域指示符（国旗）、变体选择符、零宽连接符。
    // 注意不能用 \p{Emoji_Component}：它把数字和 # * 也算作 emoji 组件，
    // 会把「香港 01」变成「香港」、「GPT-4」变成「gpt」，造成误匹配。
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu, '')
    .replace(/[\s_\-·.,:：（）()【】\[\]{}]/g, '')
    .toLowerCase();
}

/**
 * 在当前订阅实际存在的组里，找出该目标对应的组名。
 *
 * 两级匹配：先按主名与别名精确匹配（可预期），都没命中时再按归一化名匹配
 * （用于吸收 emoji 前缀、大小写、分隔符差异）。
 */
export function findGroupName(target: TargetConfig, availableGroups: readonly string[]): string | undefined {
  const wanted = targetGroupNames(target);
  for (const candidate of wanted) {
    if (availableGroups.includes(candidate)) return candidate;
  }
  const normalizedWanted = wanted.map(normalizeGroupName);
  for (const normalized of normalizedWanted) {
    const hit = availableGroups.find((group) => normalizeGroupName(group) === normalized);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 该目标声明的全部候选组名（主名 + 别名）。 */
export function targetGroupNames(target: TargetConfig): string[] {
  return [target.name, ...target.aliases];
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

/**
 * 内核控制端点的设置。
 *
 * 为什么需要它：客户端界面上的「混合代理端口」是给浏览器/系统代理用的，
 * 与 afc 需要的「外部控制地址」是两回事；两边都可以改端口，因此必须有一个
 * 地方能明确告诉 afc 控制端点在哪个端口上（尤其是定时任务，它不带任何命令行参数）。
 */
export interface ControllerSettings {
  /**
   * 显式指定的控制端点，支持三种写法：
   * `127.0.0.1:9097`、`unix:/tmp/mihomo-party.sock`、`pipe:\\.\pipe\MihomoParty\mihomo`。
   * 省略时自动发现。
   */
  endpoint?: string;
  /** 控制端点的密钥（mihomo 的 secret / 客户端的「外部控制访问密钥」）。省略时从运行时配置里读。 */
  secret?: string;
  /** 自动发现时额外要试的控制端口（把「外部控制地址」改成非默认端口时用）。 */
  ports: number[];
}

export interface AfcConfig {
  probe: ProbeSettings;
  schedule: ScheduleSettings;
  controller: ControllerSettings;
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
    // 各机场对同一个用途的叫法差别很大；归一化匹配还能吸收 emoji 前缀差异
    aliases: ['ChatGPT', 'OpenAI', 'AI网站', 'AI 专用', 'ChatGPT 专用', '人工智能'],
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

export const DEFAULT_CONTROLLER: ControllerSettings = {
  ports: [],
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
    afcConfigPath(currentPlatform()),
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

function normalizeStringList(
  raw: unknown,
  where: string,
  problems: string[],
  uppercase = true,
): string[] {
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
      const trimmed = v.trim();
      return uppercase ? trimmed.toUpperCase() : trimmed;
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

  // 组名命中内置预设时继承其别名（显式写 [] 表示不要别名）
  const rawAliases = raw['aliases'];
  const aliases = rawAliases === undefined || rawAliases === null
    ? (preset ? [...preset.aliases] : [])
    : normalizeStringList(rawAliases, `${where}.aliases`, problems, false);

  return {
    name: name.trim(),
    aliases,
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

/**
 * 归一化 controller 段。
 *
 * 端点写法在这里就先校验：写错端口/路径时在「读配置」阶段报错，比等到发现阶段
 * 抛个底层错误好定位（错误信息里会带上配置文件路径）。
 */
function normalizeController(raw: unknown, problems: string[]): ControllerSettings {
  const out: ControllerSettings = { ports: [] };
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) {
    problems.push('controller 必须是对象（可写 endpoint / secret / ports）');
    return out;
  }

  const endpoint = raw['endpoint'];
  if (endpoint !== undefined) {
    if (!isNonEmptyString(endpoint)) {
      problems.push('controller.endpoint 必须是非空字符串（如 127.0.0.1:9097 或 pipe:\\\\.\\pipe\\MihomoParty\\mihomo）');
    } else {
      try {
        parseEndpointString(endpoint.trim());
        out.endpoint = endpoint.trim();
      } catch (err) {
        problems.push(`controller.endpoint 无效：${(err as Error).message}`);
      }
    }
  }

  const secret = raw['secret'];
  if (secret !== undefined) {
    if (!isNonEmptyString(secret)) problems.push('controller.secret 必须是非空字符串');
    else out.secret = secret.trim();
  }

  const ports = raw['ports'];
  if (ports !== undefined && ports !== null) {
    if (!Array.isArray(ports)) {
      problems.push('controller.ports 必须是端口号数组（如 [9191]）');
    } else {
      for (const item of ports) {
        const port = typeof item === 'string' ? Number(item) : item;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
          problems.push(`controller.ports 含非法端口：${JSON.stringify(item)}（应为 1–65535 的整数）`);
          continue;
        }
        if (!out.ports.includes(port)) out.ports.push(port);
      }
    }
  }

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
  const controller = normalizeController(rawDoc['controller'], problems);
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
  // 显式的 `targets: []` 是合法状态：表示"不在配置里声明任何目标"，
  // 此时只按自动模式处理（你用 Clash 手动钉了节点的组）。

  // 组名与别名不允许跨目标重复：否则一个组会同时被两个目标管理，行为不可预期
  const seen = new Map<string, string>();
  for (const t of targets) {
    for (const groupName of targetGroupNames(t)) {
      const owner = seen.get(groupName);
      if (owner !== undefined) {
        problems.push(
          `组名 “${groupName}” 被多个目标使用（${owner} 与 ${t.name}）——` +
          '同一个组只能由一个目标管理',
        );
        continue;
      }
      seen.set(groupName, t.name);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const config: AfcConfig = { probe, schedule, controller, targets };
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
