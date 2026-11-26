import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../test/app.js';

test('integrations & AI: owner/admin only, secrets encrypted and masked, audit, cache invalidation, env fallback', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
    if (String(url).includes('graph.facebook.com')) return new Response(JSON.stringify({ verified_name: 'Acme Homes', display_phone_number: '+91 90000 00000' }));
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  const t = await createTestApp({ fetchFn });
  try {
    const { app } = t;
    // Role checks
    for (const role of ['manager', 'executive', 'client_viewer']) {
      assert.equal((await app.inject({ url: '/v1/admin/integrations', headers: t.as(role) })).statusCode, 403, role);
    }
    const cat = (await app.inject({ url: '/v1/admin/integrations/catalog', headers: t.as('owner') })).json();
    assert.ok(cat.providers.length > 20);

    // Nothing configured: env fallback everywhere.
    let list = (await app.inject({ url: '/v1/admin/integrations', headers: t.as() })).json();
    assert.equal(list.effective.source.messaging, 'env');
    assert.equal((await t.ctx.providers.forOrg(t.org.orgId)).whatsapp.name, 'console');

    // Validation: unknown provider, missing required, secret in the wrong place.
    assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/integrations', headers: t.as(), payload: { capability: 'messaging', provider: 'telegram' } })).statusCode, 400);
    const bad = await app.inject({ method: 'POST', url: '/v1/admin/integrations', headers: t.as(), payload: { capability: 'messaging', provider: 'whatsapp_cloud', config: { accessToken: 'x' } } });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().fields.phoneNumberId, 'required');
    assert.equal(bad.json().fields.accessToken, 'secret fields go in "secrets"');

    // Create WhatsApp: secrets never come back, only masked hints; ciphertext in the DB.
    const created = await app.inject({ method: 'POST', url: '/v1/admin/integrations', headers: t.as(), payload: {
      capability: 'messaging', provider: 'whatsapp_cloud', config: { phoneNumberId: '1234567890' },
      secrets: { accessToken: 'EAAGsecretTOKENvalue9876', verifyToken: 'verify-me' } } });
    assert.equal(created.statusCode, 201, created.body);
    const wa = created.json();
    assert.equal(wa.isPrimary, true, 'first of its capability becomes primary');
    assert.ok(!created.body.includes('EAAGsecretTOKENvalue9876'));
    assert.equal(wa.secrets.accessToken, 'EAAG…9876');
    const raw = (await t.pg.query<{ secrets_enc: string }>(`SELECT secrets_enc FROM provider_configs WHERE id = $1`, [wa.id])).rows[0]!;
    assert.match(raw.secrets_enc, /^v1\./);
    assert.ok(!raw.secrets_enc.includes('EAAG'));
    list = (await app.inject({ url: '/v1/admin/integrations', headers: t.as() })).json();
    assert.ok(!JSON.stringify(list).includes('secrets_enc') && !JSON.stringify(list).includes('EAAGsecret'));

    // Cache invalidated on save: the org now uses WhatsApp Cloud, the other org still the env console.
    assert.equal((await t.ctx.providers.forOrg(t.org.orgId)).whatsapp.name, 'whatsapp_cloud');
    assert.equal((await t.ctx.providers.forOrg(t.other.orgId)).whatsapp.name, 'console');
    // RLS: the other org cannot see or edit it.
    assert.equal((await app.inject({ url: '/v1/admin/integrations', headers: t.as('admin', t.other) })).json().data.length, 0);
    assert.equal((await app.inject({ method: 'PATCH', url: `/v1/admin/integrations/${wa.id}`, headers: t.as('admin', t.other), payload: { enabled: false } })).statusCode, 404);

    // Test connection: a real call with the decrypted token.
    const test1 = (await app.inject({ method: 'POST', url: `/v1/admin/integrations/${wa.id}/test`, headers: t.as() })).json();
    assert.equal(test1.ok, true, test1.message);
    assert.match(test1.message, /Acme Homes/);
    assert.equal(calls[0]!.headers.authorization, 'Bearer EAAGsecretTOKENvalue9876');

    // Patch: keep secrets not sent, replace one, remove one.
    const p = (await app.inject({ method: 'PATCH', url: `/v1/admin/integrations/${wa.id}`, headers: t.as(), payload: { secrets: { verifyToken: '' }, config: { templateLanguage: 'hi' } } })).json();
    assert.equal(p.secrets.verifyToken, undefined);
    assert.equal(p.secrets.accessToken, 'EAAG…9876');
    assert.equal(p.config.templateLanguage, 'hi');

    // Disable -> env fallback again.
    await app.inject({ method: 'PATCH', url: `/v1/admin/integrations/${wa.id}`, headers: t.as(), payload: { enabled: false } });
    assert.equal((await t.ctx.providers.forOrg(t.org.orgId)).whatsapp.name, 'console');

    // A broken saved secret (wrong key) does not take the org down: env fallback + a reported problem.
    await app.inject({ method: 'PATCH', url: `/v1/admin/integrations/${wa.id}`, headers: t.as(), payload: { enabled: true } });
    await t.pg.query(`UPDATE provider_configs SET secrets_enc = 'v1.deadbeef.a.b.c' WHERE id = $1`, [wa.id]);
    t.ctx.providers.invalidate(t.org.orgId);
    const broken = await t.ctx.providers.forOrg(t.org.orgId);
    assert.equal(broken.whatsapp.name, 'console');
    assert.match(broken.problems[0]!.error, /not configured/);

    // Audit trail without secret values.
    const auditRows = (await app.inject({ url: '/v1/admin/audit', headers: t.as() })).json().data;
    assert.deepEqual(auditRows.map((a: any) => a.action).reverse(), ['create', 'test', 'update', 'disable', 'enable']);
    assert.ok(!JSON.stringify(auditRows).includes('EAAGsecret'));
    assert.deepEqual(auditRows.find((a: any) => a.action === 'update').changes.secretsChanged, ['verifyToken']);
    assert.equal(auditRows[0].actor_name, 'admin acme');

    // Archive
    assert.equal((await app.inject({ method: 'DELETE', url: `/v1/admin/integrations/${wa.id}`, headers: t.as() })).statusCode, 204);
    assert.equal((await app.inject({ url: '/v1/admin/integrations', headers: t.as() })).json().data.length, 0);
  } finally { await t.close(); }
});

test('integrations & AI: per-agent model chains with fallback, free preset, primary switching', async () => {
  const t = await createTestApp();
  try {
    const { app } = t;
    const preset = await app.inject({ method: 'POST', url: '/v1/admin/integrations/presets/free', headers: t.as('owner'), payload: { groqApiKey: 'gsk_test_key_123456', geminiApiKey: 'AIza_test_key_98765' } });
    assert.equal(preset.statusCode, 201, preset.body);
    const ids = preset.json();
    const p = await t.ctx.providers.forOrg(t.org.orgId);
    assert.equal(p.source.llm, 'db');
    assert.equal(p.llmFor('lead_qualifier').name, 'groq:llama-3.3-70b-versatile>gemini:gemini-2.0-flash>ollama:qwen2.5:7b');
    assert.equal(p.llmFor('reporting').name, 'gemini:gemini-2.0-flash>groq:llama-3.3-70b-versatile>ollama:qwen2.5:7b');
    assert.equal(p.embeddings.name, 'gemini:text-embedding-004');

    // Admin changes the creative agent to OpenRouter's free model first, Groq second.
    const or = (await app.inject({ method: 'POST', url: '/v1/admin/integrations', headers: t.as(), payload: { capability: 'llm', provider: 'openrouter', secrets: { apiKey: 'sk-or-v1-abcdefghijkl' } } })).json();
    assert.equal(or.isPrimary, false, 'groq stays primary');
    const r = await app.inject({ method: 'PUT', url: '/v1/admin/ai/routes/creative', headers: t.as(), payload: { chain: [{ connectionId: or.id, model: 'deepseek/deepseek-chat-v3-0324:free' }, { connectionId: ids.groq }] } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal((await t.ctx.providers.forOrg(t.org.orgId)).llmFor('creative').name, 'openrouter:deepseek/deepseek-chat-v3-0324:free>groq:llama-3.3-70b-versatile');
    // A link must be an LLM connection of this org.
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/admin/ai/routes/creative', headers: t.as(), payload: { chain: [{ connectionId: ids.embeddings }] } })).statusCode, 422);
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/admin/ai/routes/creative', headers: t.as('admin', t.other), payload: { chain: [{ connectionId: or.id }] } })).statusCode, 422);
    assert.equal((await app.inject({ method: 'PUT', url: '/v1/admin/ai/routes/nope', headers: t.as(), payload: { chain: [] } })).statusCode, 400);

    // Make OpenRouter the primary LLM: exactly one primary per capability.
    await app.inject({ method: 'PATCH', url: `/v1/admin/integrations/${or.id}`, headers: t.as(), payload: { isPrimary: true } });
    const prim = await t.pg.query<{ provider: string }>(`SELECT provider FROM provider_configs WHERE org_id = $1 AND capability = 'llm' AND is_primary`, [t.org.orgId]);
    assert.deepEqual(prim.rows.map((x) => x.provider), ['openrouter']);
    // Other org untouched: env LLM.
    assert.equal((await t.ctx.providers.forOrg(t.other.orgId)).source.llm, 'env');
  } finally { await t.close(); }
});
