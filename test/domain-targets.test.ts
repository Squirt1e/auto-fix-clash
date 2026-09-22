import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UsageError } from '../src/errors.ts';
import { DEFAULT_DOMAIN_TARGETS, domainPatternMatches, parseDomainPattern } from '../src/targets/domain.ts';

test('通配符同时包含裸域和任意层级子域名', () => {
  const pattern = parseDomainPattern('*.ChatGPT.com.');
  assert.deepEqual(pattern, { input: '*.chatgpt.com', apex: 'chatgpt.com', wildcard: true });
  assert.equal(domainPatternMatches(pattern, 'chatgpt.com'), true);
  assert.equal(domainPatternMatches(pattern, 'a.b.chatgpt.com'), true);
  assert.equal(domainPatternMatches(pattern, 'notchatgpt.com'), false);
});

test('精确域名只匹配自身', () => {
  const pattern = parseDomainPattern('CHATGPT.com.');
  assert.deepEqual(pattern, { input: 'chatgpt.com', apex: 'chatgpt.com', wildcard: false });
  assert.equal(domainPatternMatches(pattern, 'chatgpt.com'), true);
  assert.equal(domainPatternMatches(pattern, 'www.chatgpt.com'), false);
});

test('IDN 会转成 ASCII，URL、路径和任意通配符会被拒绝', () => {
  assert.equal(parseDomainPattern('例子.测试').apex, 'xn--fsqu00a.xn--0zwm56d');
  for (const bad of ['https://chatgpt.com', 'chatgpt.com/path', 'chatgpt.com\\path', '*gpt.com', '', '.example.com', 'bad-.com']) {
    assert.throws(() => parseDomainPattern(bad), UsageError, bad);
  }
});

test('匹配时也会归一化大小写、尾点和 IDN', () => {
  const pattern = parseDomainPattern('*.例子.测试');
  assert.equal(domainPatternMatches(pattern, 'WWW.例子.测试.'), true);
});

test('内置 ChatGPT 域名目标沿用服务判据与国家策略', () => {
  const target = DEFAULT_DOMAIN_TARGETS[0]!;
  assert.equal(target.pattern, '*.chatgpt.com');
  assert.equal(target.probe?.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(target.probe?.expectedStatus, [405]);
  assert.equal(target.extraProbes[0]?.url, 'https://api.openai.com/v1/models');
  assert.ok(target.countryDeny.includes('HK'));
});
