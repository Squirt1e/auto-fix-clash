import { isIP } from 'node:net';

function ipv4Value(address: string): bigint | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const byte = Number(part);
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return undefined;
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

function expandEmbeddedIpv4(parts: string[]): string[] | undefined {
  const expanded: string[] = [];
  for (const part of parts) {
    if (!part.includes('.')) {
      expanded.push(part);
      continue;
    }
    const value = ipv4Value(part);
    if (value === undefined) return undefined;
    expanded.push(((value >> 16n) & 0xffffn).toString(16), (value & 0xffffn).toString(16));
  }
  return expanded;
}

function ipv6Value(address: string): bigint | undefined {
  if ((address.match(/::/g) ?? []).length > 1) return undefined;
  const hasCompression = address.includes('::');
  const [leftText, rightText = ''] = address.split('::');
  const left = expandEmbeddedIpv4(leftText ? leftText.split(':') : []);
  const right = expandEmbeddedIpv4(rightText ? rightText.split(':') : []);
  if (!left || !right) return undefined;
  const missing = 8 - left.length - right.length;
  if ((hasCompression && missing < 1) || (!hasCompression && missing !== 0)) return undefined;
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (parts.length !== 8) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
    value = (value << 16n) | BigInt(`0x${part}`);
  }
  return value;
}

function ipValue(address: string, family: 4 | 6): bigint | undefined {
  return family === 4 ? ipv4Value(address) : ipv6Value(address);
}

export function ipInCidr(address: string, cidr: string): boolean | undefined {
  const parts = cidr.split('/');
  if (parts.length !== 2) return undefined;
  const [network, prefixText] = parts;
  if (!network || !prefixText || !/^\d+$/.test(prefixText)) return undefined;
  const addressFamily = isIP(address);
  const networkFamily = isIP(network);
  if (addressFamily === 0 || networkFamily === 0) return undefined;
  const bits = networkFamily === 4 ? 32 : 128;
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return undefined;
  if (addressFamily !== networkFamily) return false;
  const addressValue = ipValue(address, addressFamily as 4 | 6);
  const networkValue = ipValue(network, networkFamily as 4 | 6);
  if (addressValue === undefined || networkValue === undefined) return undefined;
  const shift = BigInt(bits - prefix);
  return (addressValue >> shift) === (networkValue >> shift);
}
