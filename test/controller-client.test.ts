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
