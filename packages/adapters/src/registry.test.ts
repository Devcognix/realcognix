import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { z } from 'zod';
import { S3Storage } from './storage/s3.js';
import { FallbackLLM } from './llm/fallback.js';
import { AdapterError } from './errors.js';
import { PROVIDER_CATALOG, providerSpec } from './registry/catalog.js';
import { buildLlm, testConnection } from './registry/build.js';
import { envLlm } from './factory.js';
import { loadConfig } from '@realcognix/core';
import type { LLMProvider } from './llm/types.js';

test('s3: SigV4 presigned URL matches the AWS documentation example', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  const s3 = new S3Storage({ endpoint: 'https://s3.amazonaws.com', region: 'us-east-1', bucket: 'examplebucket', forcePathStyle: false,
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
  const url = s3.presign('test.txt', 86400, new Date('2013-05-24T00:00:00Z'));
  assert.match(url, /^https:\/\/examplebucket\.s3\.amazonaws\.com\/test\.txt\?/);
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test('s3: header-signed requests go to path-style URLs with an Authorization header', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const store = new Map<string, Buffer>();
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    if (init.method === 'PUT') { store.set(url, Buffer.from(init.body as Buffer)); return new Response('', { status: 200 }); }
    if (init.method === 'GET') return new Response(store.get(url) ?? null, { status: store.has(url) ? 200 : 404 });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const s3 = new S3Storage({ endpoint: 'http://minio:9000', region: 'us-east-1', bucket: 'rc', accessKeyId: 'k', secretAccessKey: 's', fetchFn });
  await s3.put('brochures/a b.pdf', Buffer.from('hi'), 'application/pdf');
  assert.equal((await s3.get('brochures/a b.pdf')).toString(), 'hi');
  await s3.delete('brochures/a b.pdf');
  assert.equal(seen[0]!.url, 'http://minio:9000/rc/brochures/a%20b.pdf');
  assert.match(seen[0]!.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=k\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
});

const fake = (name: string, fn: () => Promise<string>): LLMProvider => ({
  name,
  chat: async () => ({ text: await fn(), model: name }),
  json: (async (_m: unknown, schema: z.ZodType) => ({ data: schema.parse(JSON.parse(await fn())), result: { text: '', model: name } })) as LLMProvider['json'],
  embed: async () => [[1]],
});

test('fallback LLM: first provider that answers wins; all failing raises one error naming each', async () => {
  const fallbacks: string[] = [];
  const down = fake('groq', async () => { throw new AdapterError('groq', 'HTTP 429 rate limited', 429); });
  const up = fake('gemini', async () => '{"ok":true}');
  const llm = new FallbackLLM([down, up], (from) => fallbacks.push(from));
  assert.equal((await llm.chat([{ role: 'user', content: 'hi' }], { model: 'fast' })).model, 'gemini');
  assert.deepEqual((await llm.json([{ role: 'user', content: 'hi' }], z.object({ ok: z.boolean() }))).data, { ok: true });
  assert.deepEqual(fallbacks, ['groq', 'groq']);
  const dead = new FallbackLLM([down, fake('ollama', async () => { throw new Error('ECONNREFUSED'); })]);
  await assert.rejects(dead.chat([{ role: 'user', content: 'x' }]), /all 2 model\(s\) failed: \[groq\] HTTP 429.*ECONNREFUSED/);
});

test('catalog: every capability has providers; LLM list covers the free and paid vendors; secrets are typed', () => {
  for (const cap of ['llm', 'embeddings', 'messaging', 'email', 'storage', 'ads', 'lead_sources', 'automations']) {
    assert.ok(PROVIDER_CATALOG.some((p) => p.capability === cap), cap);
  }
  const llms = PROVIDER_CATALOG.filter((p) => p.capability === 'llm').map((p) => p.id);
  for (const id of ['groq', 'gemini', 'openrouter', 'ollama', 'mistral', 'together', 'cerebras', 'openai', 'anthropic', 'azure_openai', 'litellm', 'custom']) assert.ok(llms.includes(id), id);
  for (const p of PROVIDER_CATALOG) for (const f of p.fields) assert.equal(!!f.secret, f.type === 'secret', `${p.id}.${f.key}`);
  assert.ok(providerSpec('embeddings', 'ollama'));
  assert.equal(providerSpec('embeddings', 'groq'), undefined, 'groq has no embeddings API');
});

/** A tiny OpenAI-compatible server: proves the real HTTP path (URL, bearer key, model, JSON mode). */
async function openAiServer() {
  const calls: Array<{ path: string; auth?: string; body: any }> = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ path: req.url!, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer good-key') { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'invalid api key' } })); return; }
      if (req.url!.endsWith('/embeddings')) { res.end(JSON.stringify({ data: [{ embedding: new Array(768).fill(0.1), index: 0 }], model: body.model })); return; }
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: body.response_format ? '{"ok":true}' : 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('build + test connection: real OpenAI-compatible calls with the key and model; bad key reported', async () => {
  const s = await openAiServer();
  try {
    const conn = { id: 'c1', capability: 'llm' as const, provider: 'custom', config: { baseUrl: s.url, model: 'llama-x' }, secrets: { apiKey: 'good-key' } };
    const ok = await testConnection(conn);
    assert.equal(ok.ok, true, ok.message);
    assert.equal(s.calls[0]!.body.model, 'llama-x');
    const j = await buildLlm(conn, 'other-model').json([{ role: 'user', content: 'x' }], z.object({ ok: z.boolean() }));
    assert.deepEqual(j.data, { ok: true });
    assert.equal(s.calls[1]!.body.model, 'other-model');
    assert.deepEqual(s.calls[1]!.body.response_format, { type: 'json_object' });
    const bad = await testConnection({ ...conn, secrets: { apiKey: 'nope' } });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /401/);
    const emb = await testConnection({ id: 'e', capability: 'embeddings', provider: 'custom', config: { baseUrl: s.url, embedModel: 'nomic-embed-text' }, secrets: { apiKey: 'good-key' } });
    assert.equal(emb.ok, true);
    assert.equal(emb.details?.dimensions, 768);
    // Anthropic's endpoint is called without response_format.
    await buildLlm({ ...conn, provider: 'anthropic' }).json([{ role: 'user', content: 'x' }], z.object({}).passthrough()).catch(() => undefined);
    assert.equal(s.calls.at(-1)!.body.response_format, undefined);
  } finally { await s.close(); }
});

test('env fallback: LLM_BACKEND picks the provider endpoint, its key and default model', () => {
  const groq = envLlm(loadConfig({ LLM_BACKEND: 'groq', GROQ_API_KEY: 'gsk_x' } as NodeJS.ProcessEnv));
  assert.equal(groq.name, 'groq:llama-3.3-70b-versatile');
  const lite = envLlm(loadConfig({} as NodeJS.ProcessEnv));
  assert.equal(lite.name, 'litellm:default');
  const gem = envLlm(loadConfig({ LLM_BACKEND: 'gemini', LLM_MODEL: 'gemini-2.5-flash' } as NodeJS.ProcessEnv));
  assert.equal(gem.name, 'gemini:gemini-2.5-flash');
});
