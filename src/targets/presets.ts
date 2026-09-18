import { normalizeGroupName, type GeoProbe, type ProbeEndpoint } from '../config.ts';

const TRACE: GeoProbe = { url: 'https://chatgpt.com/cdn-cgi/trace', format: 'cloudflare-trace' };

/** 通用可达性探针：只用来判断"节点是不是彻底不通"，不涉及任何国家/解锁判断。 */
export const GENERIC_PROBE: ProbeEndpoint = {
  url: 'https://www.cloudflare.com/cdn-cgi/trace',
  expectedStatus: [200],
};

export const GENERIC_GEO_PROBE: GeoProbe = {
  url: 'https://www.cloudflare.com/cdn-cgi/trace',
  format: 'cloudflare-trace',
};

export interface GroupPreset {
  /** 目标主名（报告里用它标识用途）。 */
  name: string;
  /** 组名匹配用（归一化后相等即命中）。 */
  matchNames: string[];
  probe: ProbeEndpoint;
  extraProbes: ProbeEndpoint[];
  geoProbe?: GeoProbe;
  countryDeny: string[];
  /**
   * 判据可信度：
   * - `high`：状态码足以判定"能不能用"，可由 --auto 自动接管
   * - `low`：状态码判不出真正可用的条件（流媒体解锁等），只在 `afc init` 生成的配置里以注释给出
   */
  confidence: 'high' | 'low';
  note?: string;
}

const GPT_DENY = ['HK', 'CN', 'MO', 'RU', 'IR', 'KP', 'CU', 'SY', 'AF', 'BY', 'VE', 'MM'];
const REDIRECT_OK = [200, 301, 302, 307, 308];

export const PRESETS: GroupPreset[] = [
  {
    name: 'GPT',
    matchNames: ['GPT', 'ChatGPT', 'OpenAI', 'AI网站', 'AI 专用', '人工智能', 'AI'],
    confidence: 'high',
    // 可用出口返回 405；被 OpenAI 拒绝的出口（如香港）返回 403。
    // 不要用 chatgpt.com 首页：它对所有出口都返回 Cloudflare 挑战 403。
    probe: { url: 'https://chatgpt.com/backend-api/codex/responses', expectedStatus: [405], method: 'GET' },
    extraProbes: [{ url: 'https://api.openai.com/v1/models', expectedStatus: [401], method: 'GET' }],
    geoProbe: TRACE,
    countryDeny: GPT_DENY,
  },
  {
    name: 'Telegram',
    matchNames: ['Telegram', 'TG', '电报', 'Telegram 专用'],
    confidence: 'high',
    probe: { url: 'https://telegram.org/', expectedStatus: REDIRECT_OK },
    extraProbes: [],
    geoProbe: TRACE,
    countryDeny: [],
  },
  {
    name: 'Google',
    matchNames: ['Google', '谷歌', 'Google 专用'],
    confidence: 'high',
    probe: { url: 'https://www.google.com/generate_204', expectedStatus: [204] },
    extraProbes: [],
    geoProbe: TRACE,
    countryDeny: [],
  },
  {
    name: 'Github',
    matchNames: ['Github', 'GitHub', '代码托管'],
    confidence: 'high',
    probe: { url: 'https://github.com/', expectedStatus: REDIRECT_OK },
    extraProbes: [],
    geoProbe: TRACE,
    countryDeny: [],
  },
  {
    name: 'Youtube',
    matchNames: ['Youtube', 'YouTube', '油管', 'Youtube 专用'],
    confidence: 'low',
    note: '状态码只能说明"能连上"，判不出 Premium 是否解锁、地区是否正确',
    probe: { url: 'https://www.youtube.com/generate_204', expectedStatus: [204] },
    extraProbes: [],
    geoProbe: TRACE,
    countryDeny: [],
  },
  {
    name: 'Netflix',
    matchNames: ['Netflix', '奈飞', '网飞'],
    confidence: 'low',
    note: 'Netflix 首页对所有地区都返回 200，判不出是否解锁，需自行确认',
    probe: { url: 'https://www.netflix.com/', expectedStatus: REDIRECT_OK },
    extraProbes: [],
    geoProbe: TRACE,
    countryDeny: [],
  },
  {
    name: 'Spotify',
    matchNames: ['Spotify'],
    confidence: 'low',
    note: '同上：状态码判不出解锁地区',
    probe: { url: 'https://open.spotify.com/', expectedStatus: REDIRECT_OK },
    extraProbes: [],
    geoProbe: TRACE,
    countryDeny: [],
  },
  {
    name: 'Disney',
    matchNames: ['Disney', 'Disney+', '迪士尼'],
    confidence: 'low',
    note: '同上：状态码判不出解锁地区',
    probe: { url: 'https://www.disneyplus.com/', expectedStatus: REDIRECT_OK },
    extraProbes: [],
    geoProbe: TRACE,
    countryDeny: [],
  },
];

/** 按组名匹配预设（精确与归一化都试，high 优先）。 */
export function matchPreset(groupName: string): GroupPreset | undefined {
  const wanted = normalizeGroupName(groupName);
  const hits = PRESETS.filter((preset) =>
    preset.matchNames.some((n) => normalizeGroupName(n) === wanted));
  if (hits.length === 0) return undefined;
  return hits.find((p) => p.confidence === 'high') ?? hits[0];
}

/** 由预设或通用探针构造一个可直接使用的目标配置。 */
export function presetToTarget(preset: GroupPreset, groupName: string) {
  return {
    name: groupName,
    aliases: [] as string[],
    probe: preset.probe,
    extraProbes: preset.extraProbes,
    ...(preset.geoProbe ? { geoProbe: preset.geoProbe } : {}),
    countryAllow: [] as string[],
    countryDeny: preset.countryDeny,
  };
}

/** 通用可达性目标：只判断节点是否彻底不通。 */
export function genericTarget(groupName: string) {
  return {
    name: groupName,
    aliases: [] as string[],
    probe: GENERIC_PROBE,
    extraProbes: [] as ProbeEndpoint[],
    geoProbe: GENERIC_GEO_PROBE,
    countryAllow: [] as string[],
    countryDeny: [] as string[],
  };
}
