import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipInCidr } from '../src/routes/ip-cidr.ts';

test('IPv4 CIDR 支持命中、边界、全网段和主机掩码', () => {
  assert.equal(ipInCidr('23.101.24.70', '23.0.0.0/8'), true);
  assert.equal(ipInCidr('24.0.0.1', '23.0.0.0/8'), false);
  assert.equal(ipInCidr('203.0.113.9', '0.0.0.0/0'), true);
  assert.equal(ipInCidr('203.0.113.9', '203.0.113.9/32'), true);
  assert.equal(ipInCidr('203.0.113.10', '203.0.113.9/32'), false);
});

test('IPv6 CIDR 支持压缩地址、边界和主机掩码', () => {
  assert.equal(ipInCidr('2001:db8::1', '2001:db8::/32'), true);
  assert.equal(ipInCidr('2001:db9::1', '2001:db8::/32'), false);
  assert.equal(ipInCidr('fe80::1', '::/0'), true);
  assert.equal(ipInCidr('2001:db8::1', '2001:db8::1/128'), true);
  assert.equal(ipInCidr('2001:db8::2', '2001:db8::1/128'), false);
});

test('地址族不同是确定未命中，非法输入返回 undefined', () => {
  assert.equal(ipInCidr('2001:db8::1', '10.0.0.0/8'), false);
  assert.equal(ipInCidr('10.0.0.1', '2001:db8::/32'), false);
  assert.equal(ipInCidr('not-an-ip', '10.0.0.0/8'), undefined);
  assert.equal(ipInCidr('10.0.0.1', '10.0.0.0/33'), undefined);
  assert.equal(ipInCidr('2001:db8::1', '2001:db8::/129'), undefined);
  assert.equal(ipInCidr('10.0.0.1', 'not-a-cidr'), undefined);
});
