import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MihomoClient } from '../src/controller/client.ts';

test('控制客户端读取 /rules 的完整规则字段', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, '/rules');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rules: [
      { index: 0, type: 'DOMAIN', payload: 'api.example.com', proxy: 'API', size: -1 },
    ] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法取得测试端口');
  try {
    const client = new MihomoClient({ kind: 'tcp', host: '127.0.0.1', port: address.port, source: 'test' });
    assert.deepEqual(await client.rules(), [
      { index: 0, type: 'DOMAIN', payload: 'api.example.com', proxy: 'API', size: -1 },
    ]);
  } finally {
    server.close();
  }
});

test('控制客户端通过 /dns/query 合并并去重 A/AAAA 回答', async () => {
  const urls: string[] = [];
  const server = createServer((req, res) => {
    urls.push(req.url ?? '');
    const type = new URL(req.url ?? '/', 'http://controller').searchParams.get('type');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(type === 'A'
      ? { Status: 0, Answer: [{ type: 1, data: '23.101.24.70' }, { type: 1, data: '23.101.24.70' }] }
      : { Status: 0, Answer: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法取得测试端口');
  try {
    const client = new MihomoClient({ kind: 'tcp', host: '127.0.0.1', port: address.port, source: 'test' });
    assert.deepEqual(await client.resolveHost('chatgpt.com'), ['23.101.24.70']);
    assert.deepEqual(urls.sort(), [
      '/dns/query?name=chatgpt.com&type=A',
      '/dns/query?name=chatgpt.com&type=AAAA',
    ]);
  } finally {
    server.close();
  }
});

test('控制器 DNS 状态失败或回答畸形时拒绝返回猜测结果', async () => {
  for (const response of [
    { Status: 3, Answer: [] },
    { Status: 0, Answer: [{ type: 1, data: 123 }] },
  ]) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('无法取得测试端口');
    try {
      const client = new MihomoClient({ kind: 'tcp', host: '127.0.0.1', port: address.port, source: 'test' });
      await assert.rejects(client.resolveHost('chatgpt.com'), /DNS/);
    } finally {
      server.close();
    }
  }
});
