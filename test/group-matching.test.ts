import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGroupName, normalizeGroupName, targetGroupNames } from '../src/config.ts';
import type { TargetConfig } from '../src/config.ts';

const target = (name: string, aliases: string[] = []): TargetConfig => ({
  name,
  aliases,
  probe: { url: 'https://example.com/', expectedStatus: [200] },
  extraProbes: [],
  countryAllow: [],
  countryDeny: [],
});

test('归一化保留数字，只去掉 emoji 与分隔符', () => {
  // 这条很关键：早期误用 \p{Emoji_Component} 会把数字一起吃掉，
  // 导致「香港 01」变成「香港」、「GPT-4」变成「gpt」而误匹配。
  assert.equal(normalizeGroupName('香港 01'), '香港01');
  assert.equal(normalizeGroupName('GPT-4'), 'gpt4');
  assert.equal(normalizeGroupName('GPT'), 'gpt');
  assert.equal(normalizeGroupName('🤖AI网站'), 'ai网站');
  assert.equal(normalizeGroupName('🇯🇵日本节点'), '日本节点');
  assert.equal(normalizeGroupName('♻️自动选择'), '自动选择');
  assert.equal(normalizeGroupName('ChatGPT 专用'), 'chatgpt专用');
});

test('精确匹配优先于归一化匹配', () => {
  const t = target('GPT', ['ChatGPT']);
  assert.equal(findGroupName(t, ['ChatGPT', 'GPT']), 'GPT');
  assert.equal(findGroupName(t, ['ChatGPT', 'Netflix']), 'ChatGPT');
});

test('归一化匹配能吸收 emoji 前缀与大小写差异', () => {
  // 真实案例：另一个订阅把同一个组叫 🤖AI网站
  const t = target('GPT', ['AI网站']);
  assert.equal(findGroupName(t, ['🚀节点选择', '🤖AI网站', '🎬媒体解锁']), '🤖AI网站');

  const upper = target('OpenAI');
  assert.equal(findGroupName(upper, ['OPENAI']), 'OPENAI');
});

test('不同名字不会被误当成同一个组', () => {
  const t = target('GPT', ['AI网站']);
  // GPT-4 与 GPT 归一化后不同，不应命中
  assert.equal(findGroupName(t, ['GPT-4', 'GPT-5']), undefined);
  // 归一化是相等比较而非包含比较
  assert.equal(findGroupName(t, ['AI网站专属']), undefined);
});

test('完全对不上时返回 undefined（交由上层给出指引）', () => {
  assert.equal(findGroupName(target('GPT'), ['Proxy', 'Netflix']), undefined);
});

test('targetGroupNames 返回主名在前、别名在后', () => {
  assert.deepEqual(targetGroupNames(target('GPT', ['ChatGPT', 'OpenAI'])), ['GPT', 'ChatGPT', 'OpenAI']);
});
