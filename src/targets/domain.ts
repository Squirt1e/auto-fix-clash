import { domainToASCII } from 'node:url';
import type { GeoProbe, ProbeEndpoint } from '../config.ts';
import { UsageError } from '../errors.ts';

export interface DomainPattern {
  input: string;
  apex: string;
  wildcard: boolean;
}

export interface DomainTargetConfig {
  pattern: string;
  probe?: ProbeEndpoint;
  extraProbes: ProbeEndpoint[];
  geoProbe?: GeoProbe;
  countryAllow: string[];
  countryDeny: string[];
  /** 配置文件里显式出现过的可选字段；用于区分“省略”与“显式空数组”。 */
  overrides?: {
    extraProbes?: true;
    geoProbe?: true;
    countryAllow?: true;
    countryDeny?: true;
  };
}

const CHATGPT_COUNTRY_DENY = ['HK', 'CN', 'MO', 'RU', 'IR', 'KP', 'CU', 'SY', 'AF', 'BY', 'VE', 'MM'];

export const DEFAULT_DOMAIN_TARGETS: DomainTargetConfig[] = [
  {
    pattern: '*.chatgpt.com',
    probe: {
      url: 'https://chatgpt.com/backend-api/codex/responses',
      expectedStatus: [405],
      method: 'GET',
    },
    extraProbes: [
      { url: 'https://api.openai.com/v1/models', expectedStatus: [401], method: 'GET' },
    ],
    geoProbe: { url: 'https://chatgpt.com/cdn-cgi/trace', format: 'cloudflare-trace' },
    countryAllow: [],
    countryDeny: CHATGPT_COUNTRY_DENY,
  },
];

export function parseDomainPattern(input: string): DomainPattern {
  const value = input.trim().toLowerCase().replace(/\.$/, '');
  const wildcard = value.startsWith('*.');
  const rawHost = wildcard ? value.slice(2) : value;

  if (value.includes('://') || /[\\/?#]/.test(rawHost) || rawHost.includes('*')) {
    throw new UsageError(`无效域名范围：${input}`);
  }

  const apex = domainToASCII(rawHost);
  if (
    !apex ||
    apex.length > 253 ||
    apex.split('.').some((label) =>
      label.length === 0 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new UsageError(`无效域名范围：${input}`);
  }

  return { input: wildcard ? `*.${apex}` : apex, apex, wildcard };
}

export function domainPatternMatches(pattern: DomainPattern, host: string): boolean {
  let normalized: DomainPattern;
  try {
    normalized = parseDomainPattern(host);
  } catch {
    return false;
  }
  if (normalized.wildcard) return false;
  return normalized.apex === pattern.apex ||
    (pattern.wildcard && normalized.apex.endsWith(`.${pattern.apex}`));
}
