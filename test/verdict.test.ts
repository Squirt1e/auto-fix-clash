import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideVerdict, parseTrace, statusMatches, shortEndpoint } from '../src/probe/verdict.ts';
import type { NodeObservation } from '../src/probe/verdict.ts';
import { DEFAULT_TARGETS } from '../src/config.ts';

const GPT = DEFAULT_TARGETS[0]!;
const CODEX = GPT.probe.url;
const OPENAI = GPT.extraProbes[0]!.url;
const TRACE = GPT.geoProbe!.url;

function observation(partial: Partial<NodeObservation> & { endpoints: NodeObservation['endpoints'] }): NodeObservation {
  return { node: 'n1', attempts: 1, ...partial };
}

test('statusMatches 支持精确值、区间与枚举', () => {
  assert.equal(statusMatches(405, [405]), true);
  assert.equal(statusMatches(403, [405]), false);
  assert.equal(statusMatches(250, [200, 299]), true);
  assert.equal(statusMatches(300, [200, 299]), false);
  assert.equal(statusMatches(401, [200, 401, 405]), true);
});

test('主端点返回期望状态码 → ok，并带出口信息', () => {
  const decision = decideVerdict(GPT, observation({
    endpoints: [{ endpoint: CODEX, statusCode: 405, ttfbMs: 120 }],
    geo: { loc: 'SG', ip: '1.2.3.4', warp: 'on' },
  }));
  assert.equal(decision.verdict, 'ok');
  assert.equal(decision.statusCode, 405);
  assert.equal(decision.country, 'SG');
  assert.equal(decision.matchedEndpoint, CODEX);
});

test('全部端点都被目标站点拒绝 → blocked（不是死节点）', () => {
  const decision = decideVerdict(GPT, observation({
    endpoints: [
      { endpoint: CODEX, statusCode: 403 },
      { endpoint: OPENAI, statusCode: 403 },
    ],
    geo: { loc: 'HK' },
  }));
  assert.equal(decision.verdict, 'blocked');
  assert.equal(decision.statusCode, 403);
  assert.equal(decision.country, 'HK');
  assert.match(decision.reason, /被目标站点拒绝/);
});

test('附加端点通过时也判为可用（任一通过即可）', () => {
  const decision = decideVerdict(GPT, observation({
    endpoints: [
      { endpoint: CODEX, statusCode: 403 },
      { endpoint: OPENAI, statusCode: 401 },
    ],
    geo: { loc: 'JP' },
  }));
  assert.equal(decision.verdict, 'ok');
  assert.equal(decision.matchedEndpoint, OPENAI);
});

test('没有任何 HTTP 响应 → dead，并体现重试次数', () => {
  const decision = decideVerdict(GPT, observation({
    attempts: 2,
    endpoints: [
      { endpoint: CODEX, error: '请求失败：ECONNRESET' },
      { endpoint: OPENAI, error: '请求失败：ECONNRESET' },
    ],
  }));
  assert.equal(decision.verdict, 'dead');
  assert.match(decision.reason, /重试 2 次/);
});

test('端点可用但出口在黑名单 → country-policy', () => {
  const decision = decideVerdict(GPT, observation({
    endpoints: [{ endpoint: CODEX, statusCode: 405 }],
    geo: { loc: 'hk' },
  }));
  assert.equal(decision.verdict, 'country-policy');
  assert.equal(decision.country, 'HK');
  assert.match(decision.reason, /黑名单/);
});

test('端点可用但出口不在白名单 → country-policy', () => {
  const target = { ...GPT, countryAllow: ['US', 'JP'], countryDeny: [] };
  const decision = decideVerdict(target, observation({
    endpoints: [{ endpoint: CODEX, statusCode: 405 }],
    geo: { loc: 'SG' },
  }));
  assert.equal(decision.verdict, 'country-policy');
  assert.match(decision.reason, /不在白名单/);
});

test('白名单为空时不限制出口国家', () => {
  const target = { ...GPT, countryAllow: [], countryDeny: [] };
  const decision = decideVerdict(target, observation({
    endpoints: [{ endpoint: CODEX, statusCode: 405 }],
    geo: { loc: 'DE' },
  }));
  assert.equal(decision.verdict, 'ok');
});

test('parseTrace 解析 Cloudflare 出口信息', () => {
  const geo = parseTrace('fl=abc\nh=chatgpt.com\nip=104.28.222.43\nloc=SG\nwarp=on\n');
  assert.deepEqual(geo, { ip: '104.28.222.43', loc: 'SG', warp: 'on' });
});

test('parseTrace 对非 trace 内容返回空对象', () => {
  assert.deepEqual(parseTrace('<html>403</html>'), {});
});

test('shortEndpoint 压缩为 host + path', () => {
  assert.equal(shortEndpoint('https://chatgpt.com/backend-api/codex/responses'), 'chatgpt.com/backend-api/codex/responses');
  assert.equal(shortEndpoint(TRACE), 'chatgpt.com/cdn-cgi/trace');
});
