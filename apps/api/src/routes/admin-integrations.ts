import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AGENT_ROUTES, CAPABILITIES, PROVIDER_CATALOG, providerSpec, testConnection,
  type AgentRoute, type Capability, type ProviderSpec,
} from '@realcognix/adapters';
import type { AppContext } from '../context.js';
import { requireRole, useApiAuth } from '../lib/auth.js';
import { audit, diff } from '../lib/audit.js';
import { maskSecret } from '../lib/secrets.js';
import type { ConfigRow } from '../providers/registry.js';

const Cap = z.enum(CAPABILITIES as [Capability, ...Capability[]]);
const Values = z.record(z.string(), z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]));
const Create = z.object({
  capability: Cap,
  provider: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().default(true),
  isPrimary: z.boolean().optional(),
  config: Values.default({}),
  secrets: z.record(z.string(), z.string().max(8000)).default({}),
});
const Patch = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
  config: Values.optional(),
  /** Only the secrets being changed. An empty string removes that secret. Omitted keys are kept. */
  secrets: z.record(z.string(), z.string().max(8000)).optional(),
});
const Link = z.object({ connectionId: z.guid(), model: z.string().trim().max(200).nullable().optional() });

export class FieldError extends Error {
  statusCode = 400;
  constructor(readonly fields: Record<string, string>) { super('invalid_fields'); }
}

/** Keeps only the catalog's fields, coerces types, checks required ones. Secrets and settings are kept apart. */
export function cleanFields(spec: ProviderSpec, config: Record<string, unknown>, secrets: Record<string, string>, existingSecretKeys: string[] = []) {
  const errors: Record<string, string> = {};
  const outConfig: Record<string, unknown> = {};
  const outSecrets: Record<string, string> = {};
  const known = new Set(spec.fields.map((f) => f.key));
  for (const k of Object.keys(config)) if (!known.has(k)) errors[k] = 'unknown field';
  for (const k of Object.keys(secrets)) if (!known.has(k)) errors[k] = 'unknown field';
  for (const f of spec.fields) {
    if (f.secret) {
      if (f.key in config) errors[f.key] = 'secret fields go in "secrets"';
      const v = secrets[f.key];
      if (v !== undefined && v !== '') outSecrets[f.key] = v.trim();
      const present = (v !== undefined ? v !== '' : existingSecretKeys.includes(f.key));
      if (f.required && !present && !errors[f.key]) errors[f.key] = 'required';
      continue;
    }
    if (f.key in secrets) errors[f.key] = 'not a secret field';
    let v = config[f.key];
    if (v === undefined || v === null || v === '') {
      if (f.default !== undefined && f.default !== '') v = f.default;
      else { if (f.required) errors[f.key] = 'required'; continue; }
    }
    if (f.type === 'number') { const n = Number(v); if (isNaN(n)) { errors[f.key] = 'must be a number'; continue; } v = n; }
    else if (f.type === 'boolean') v = v === true || v === 'true' || v === 1 || v === '1';
    else if (f.type === 'url') {
      const s = String(v).trim();
      if (!/^https?:\/\/[^\s]+$/i.test(s)) { errors[f.key] = 'must be an http(s) URL'; continue; }
      v = s;
    } else if (f.type === 'select') {
      if (f.options && !f.options.some((o) => o.value === v)) { errors[f.key] = 'not one of the options'; continue; }
    } else v = String(v).trim();
    outConfig[f.key] = v;
  }
  if (Object.keys(errors).length) throw new FieldError(errors);
  return { config: outConfig, secrets: outSecrets };
}

const hints = (secrets: Record<string, string>) => Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, maskSecret(v)]));

/** What the browser may see of a row: never the ciphertext, only masked hints. */
export function publicRow(r: ConfigRow) {
  return {
    id: r.id, capability: r.capability, provider: r.provider, label: r.label, enabled: r.enabled, isPrimary: r.is_primary,
    config: r.config, secrets: r.secret_hints ?? {}, lastTest: r.last_test_at ? { at: r.last_test_at, ok: r.last_test_ok, error: r.last_test_error } : null,
    updatedAt: r.updated_at,
  };
}

/** Integrations & AI: owner/admin only. Every change is audited and invalidates the org's provider cache. */
export async function adminIntegrationRoutes(app: FastifyInstance, ctx: AppContext) {
  useApiAuth(app, ctx);
  const admin = { preHandler: requireRole('admin') };

  const needBox = (secrets: Record<string, string>) => {
    if (Object.keys(secrets).length && !ctx.secretBox) {
      throw Object.assign(new Error('CONFIG_MASTER_KEY is not set on the server, so secrets cannot be stored. Set it and restart the API.'), { statusCode: 503 });
    }
  };
  const seal = (orgId: string, id: string, secrets: Record<string, string>) =>
    Object.keys(secrets).length ? ctx.secretBox!.seal(secrets, `${orgId}:${id}`) : null;

  async function loadRow(orgId: string, id: string) {
    const r = await ctx.db.one<ConfigRow & { archived_at: Date | null }>(
      `SELECT id, capability, provider, label, enabled, is_primary, config, secrets_enc, secret_hints, last_test_at, last_test_ok, last_test_error, updated_at, archived_at
         FROM provider_configs WHERE id = $1 AND org_id = $2`, [id, orgId]);
    if (!r || r.archived_at) throw Object.assign(new Error('integration not found'), { statusCode: 404 });
    return r;
  }

  app.get('/admin/integrations/catalog', admin, async () => ({
    capabilities: CAPABILITIES,
    agents: AGENT_ROUTES,
    providers: PROVIDER_CATALOG,
    masterKey: { configured: !!ctx.secretBox && !ctx.secretBox.ephemeral, devKey: !!ctx.secretBox?.ephemeral },
  }));

  app.get('/admin/integrations', admin, async (req) => {
    const org = req.auth.orgId;
    const rows = await ctx.providers.rows();
    const routes = await ctx.db.query(`SELECT agent, chain, temperature, updated_at FROM ai_agent_routes ORDER BY agent`);
    const p = await ctx.providers.forOrg(org);
    const env = ctx.adapters;
    return {
      data: rows.map(publicRow),
      routes: routes.rows,
      effective: {
        source: p.source,
        problems: p.problems,
        env: { llm: env.llm.name, whatsapp: env.whatsapp.name, email: env.email.name, storage: env.storage.name, ads: Object.keys(env.ads), llmBackend: ctx.config.LLM_BACKEND },
      },
    };
  });

  app.post('/admin/integrations', admin, async (req, reply) => {
    const b = Create.parse(req.body);
    const spec = providerSpec(b.capability, b.provider);
    if (!spec) return reply.code(400).send({ error: 'unknown_provider', message: `"${b.provider}" is not a ${b.capability} provider` });
    const clean = cleanFields(spec, b.config, b.secrets);
    needBox(clean.secrets);
    const org = req.auth.orgId;
    const row = await ctx.db.tx(org, async (q) => {
      const existing = (await q.query(`SELECT count(*)::int AS n FROM provider_configs WHERE capability = $1 AND archived_at IS NULL`, [b.capability])).rows[0].n as number;
      const primary = b.isPrimary ?? existing === 0;
      if (primary) await q.query(`UPDATE provider_configs SET is_primary = false WHERE capability = $1 AND is_primary`, [b.capability]);
      const id = (await q.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
      const r = (await q.query(
        `INSERT INTO provider_configs (id, org_id, capability, provider, label, enabled, is_primary, config, secrets_enc, secret_hints, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
        [id, org, b.capability, b.provider, b.label ?? spec.label, b.enabled, primary, JSON.stringify(clean.config),
         seal(org, id, clean.secrets), JSON.stringify(hints(clean.secrets)), req.auth.userId])
      ).rows[0] as ConfigRow;
      await audit(q, { auth: req.auth, entityType: 'provider_config', entityId: id, action: 'create',
        changes: { capability: b.capability, provider: b.provider, enabled: b.enabled, isPrimary: primary, config: clean.config, secretsSet: Object.keys(clean.secrets) } });
      return r;
    });
    ctx.providers.invalidate(org);
    return reply.code(201).send(publicRow(row));
  });

  app.patch<{ Params: { id: string } }>('/admin/integrations/:id', admin, async (req) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const b = Patch.parse(req.body);
    const org = req.auth.orgId;
    const row = await loadRow(org, id);
    const spec = providerSpec(row.capability, row.provider)!;
    let secrets = ctx.providers.decrypt(org, row);
    const secretChanges: string[] = [];
    if (b.secrets) {
      secrets = { ...secrets };
      for (const [k, v] of Object.entries(b.secrets)) {
        secretChanges.push(k);
        if (v === '') delete secrets[k]; else secrets[k] = v;
      }
    }
    const merged = b.config ? { ...row.config, ...b.config } : row.config;
    const clean = cleanFields(spec, merged, secrets);
    needBox(clean.secrets);
    const updated = await ctx.db.tx(org, async (q) => {
      if (b.isPrimary) await q.query(`UPDATE provider_configs SET is_primary = false WHERE capability = $1 AND is_primary AND id <> $2`, [row.capability, id]);
      const r = (await q.query(
        `UPDATE provider_configs SET label = COALESCE($2, label), enabled = COALESCE($3, enabled), is_primary = COALESCE($4, is_primary),
                config = $5, secrets_enc = $6, secret_hints = $7, updated_by = $8 WHERE id = $1 RETURNING *`,
        [id, b.label ?? null, b.enabled ?? null, b.isPrimary ?? null, JSON.stringify(clean.config),
         secretChanges.length ? seal(org, id, clean.secrets) : row.secrets_enc, JSON.stringify(secretChanges.length ? hints(clean.secrets) : row.secret_hints), req.auth.userId])
      ).rows[0] as ConfigRow;
      const action = b.enabled === false ? 'disable' : b.enabled === true && !row.enabled ? 'enable' : b.isPrimary ? 'select' : 'update';
      await audit(q, { auth: req.auth, entityType: 'provider_config', entityId: id, action, changes: {
        ...diff({ label: row.label, enabled: row.enabled, isPrimary: row.is_primary, ...row.config }, { label: r.label, enabled: r.enabled, isPrimary: r.is_primary, ...r.config }),
        ...(secretChanges.length ? { secretsChanged: secretChanges } : {}),
      } });
      return r;
    });
    ctx.providers.invalidate(org);
    return publicRow(updated);
  });

  app.delete<{ Params: { id: string } }>('/admin/integrations/:id', admin, async (req, reply) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const org = req.auth.orgId;
    const row = await loadRow(org, id);
    await ctx.db.tx(org, async (q) => {
      await q.query(`UPDATE provider_configs SET archived_at = now(), is_primary = false, enabled = false, updated_by = $2 WHERE id = $1`, [id, req.auth.userId]);
      await audit(q, { auth: req.auth, entityType: 'provider_config', entityId: id, action: 'archive', changes: { capability: row.capability, provider: row.provider } });
    });
    ctx.providers.invalidate(org);
    return reply.code(204).send();
  });

  /** Real call with the saved settings (or, with a body, unsaved edits on top of them). */
  app.post<{ Params: { id: string } }>('/admin/integrations/:id/test', admin, async (req) => {
    const { id } = z.object({ id: z.guid() }).parse(req.params);
    const b = z.object({ model: z.string().max(200).optional(), config: Values.optional(), secrets: z.record(z.string(), z.string()).optional() }).parse(req.body ?? {});
    const org = req.auth.orgId;
    const row = await loadRow(org, id);
    const conn = ctx.providers.toConnection(org, row);
    if (b.config) Object.assign(conn.config, b.config);
    if (b.secrets) for (const [k, v] of Object.entries(b.secrets)) if (v) conn.secrets[k] = v;
    const res = await testConnection(conn, { fetchFn: ctx.fetchFn, publicApiUrl: ctx.config.PUBLIC_API_URL, model: b.model });
    await ctx.db.tx(org, async (q) => {
      await q.query(`UPDATE provider_configs SET last_test_at = now(), last_test_ok = $2, last_test_error = $3 WHERE id = $1`, [id, res.ok, res.ok ? null : res.message]);
      await audit(q, { auth: req.auth, entityType: 'provider_config', entityId: id, action: 'test', changes: { ok: res.ok, message: res.message.slice(0, 300) } });
    });
    return res;
  });

  /** Test a provider before saving it. */
  app.post('/admin/integrations/test', admin, async (req, reply) => {
    const b = Create.parse(req.body);
    const spec = providerSpec(b.capability, b.provider);
    if (!spec) return reply.code(400).send({ error: 'unknown_provider' });
    const clean = cleanFields(spec, b.config, b.secrets);
    return testConnection({ id: 'draft', capability: b.capability, provider: b.provider, config: clean.config, secrets: clean.secrets },
      { fetchFn: ctx.fetchFn, publicApiUrl: ctx.config.PUBLIC_API_URL });
  });

  // ---------------------------------------------------------------- per-agent model routing
  app.get('/admin/ai/routes', admin, async () => {
    const { rows } = await ctx.db.query(`SELECT agent, chain, temperature, updated_at FROM ai_agent_routes ORDER BY agent`);
    return { agents: AGENT_ROUTES, data: rows };
  });

  app.put<{ Params: { agent: string } }>('/admin/ai/routes/:agent', admin, async (req) => {
    const agent = z.enum(AGENT_ROUTES as unknown as [AgentRoute, ...AgentRoute[]]).parse(req.params.agent);
    const b = z.object({ chain: z.array(Link).max(6), temperature: z.number().min(0).max(2).nullable().optional() }).parse(req.body);
    const org = req.auth.orgId;
    if (b.chain.length) {
      const ids = [...new Set(b.chain.map((l) => l.connectionId))];
      const ok = await ctx.db.query(`SELECT id FROM provider_configs WHERE id = ANY($1::uuid[]) AND capability = 'llm' AND archived_at IS NULL`, [ids]);
      if (ok.rowCount !== ids.length) throw Object.assign(new Error('every link must be an LLM connection of this organization'), { statusCode: 422 });
    }
    const before = await ctx.db.one(`SELECT chain FROM ai_agent_routes WHERE agent = $1`, [agent]);
    const row = await ctx.db.tx(org, async (q) => {
      const r = (await q.query(
        `INSERT INTO ai_agent_routes (org_id, agent, chain, temperature, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (org_id, agent) DO UPDATE SET chain = EXCLUDED.chain, temperature = EXCLUDED.temperature, updated_by = EXCLUDED.updated_by
         RETURNING agent, chain, temperature, updated_at`,
        [org, agent, JSON.stringify(b.chain.map((l) => ({ connectionId: l.connectionId, model: l.model || null }))), b.temperature ?? null, req.auth.userId])).rows[0];
      await audit(q, { auth: req.auth, entityType: 'ai_route', entityId: agent, action: 'update', changes: { from: before?.chain ?? [], to: r.chain } });
      return r;
    });
    ctx.providers.invalidate(org);
    return row;
  });

  /**
   * One click to the free stack: Groq (fast) + Gemini (smart) + local Ollama as last resort, Gemini or Ollama embeddings,
   * and routes: qualifier / follow-up / scoring = Groq > Gemini > Ollama; reporting / creative = Gemini > Groq > Ollama.
   */
  app.post('/admin/integrations/presets/free', admin, async (req, reply) => {
    const b = z.object({ groqApiKey: z.string().trim().optional(), geminiApiKey: z.string().trim().optional(), ollamaBaseUrl: z.string().url().optional() }).parse(req.body ?? {});
    const secrets = { ...(b.groqApiKey ? { g: b.groqApiKey } : {}), ...(b.geminiApiKey ? { m: b.geminiApiKey } : {}) };
    needBox(secrets);
    const org = req.auth.orgId;
    const out = await ctx.db.tx(org, async (q) => {
      const has = (await q.query(`SELECT count(*)::int AS n FROM provider_configs WHERE capability IN ('llm','embeddings') AND archived_at IS NULL`)).rows[0].n as number;
      const mk = async (capability: Capability, provider: string, label: string, config: Record<string, unknown>, sec: Record<string, string>, primary: boolean) => {
        const id = (await q.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
        if (primary) await q.query(`UPDATE provider_configs SET is_primary = false WHERE capability = $1 AND is_primary`, [capability]);
        await q.query(
          `INSERT INTO provider_configs (id, org_id, capability, provider, label, enabled, is_primary, config, secrets_enc, secret_hints, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
          [id, org, capability, provider, label, provider === 'ollama' || Object.keys(sec).length > 0, primary, JSON.stringify(config), seal(org, id, sec), JSON.stringify(hints(sec)), req.auth.userId]);
        return id;
      };
      const groq = await mk('llm', 'groq', 'Groq (fast)', { model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' }, b.groqApiKey ? { apiKey: b.groqApiKey } : {}, has === 0);
      const gemini = await mk('llm', 'gemini', 'Gemini (smart)', { model: 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' }, b.geminiApiKey ? { apiKey: b.geminiApiKey } : {}, false);
      const ollama = await mk('llm', 'ollama', 'Ollama (local fallback)', { model: 'qwen2.5:7b', baseUrl: b.ollamaBaseUrl ?? 'http://ollama:11434/v1' }, {}, false);
      const emb = b.geminiApiKey
        ? await mk('embeddings', 'gemini', 'Gemini embeddings', { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', embedModel: 'text-embedding-004', dimensions: 768 }, { apiKey: b.geminiApiKey }, true)
        : await mk('embeddings', 'ollama', 'Ollama nomic-embed-text', { baseUrl: b.ollamaBaseUrl ?? 'http://ollama:11434/v1', embedModel: 'nomic-embed-text', dimensions: 768 }, {}, true);
      const fast = [{ connectionId: groq, model: null }, { connectionId: gemini, model: null }, { connectionId: ollama, model: null }];
      const smart = [{ connectionId: gemini, model: null }, { connectionId: groq, model: null }, { connectionId: ollama, model: null }];
      const routes: Record<string, typeof fast> = { default: fast, lead_qualifier: fast, follow_up: fast, scoring: fast, reporting: smart, creative: smart };
      for (const [agent, chain] of Object.entries(routes)) {
        await q.query(
          `INSERT INTO ai_agent_routes (org_id, agent, chain, updated_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (org_id, agent) DO UPDATE SET chain = EXCLUDED.chain, updated_by = EXCLUDED.updated_by`,
          [org, agent, JSON.stringify(chain), req.auth.userId]);
      }
      await audit(q, { auth: req.auth, entityType: 'provider_config', action: 'preset_free',
        changes: { created: { groq, gemini, ollama, embeddings: emb }, secretsSet: Object.keys(secrets).length ? ['groq', 'gemini'].filter((_, i) => (i === 0 ? b.groqApiKey : b.geminiApiKey)) : [] } });
      return { groq, gemini, ollama, embeddings: emb };
    });
    ctx.providers.invalidate(org);
    return reply.code(201).send(out);
  });

  app.get('/admin/audit', admin, async (req) => {
    const f = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), entityType: z.string().max(40).optional() }).parse(req.query);
    const { rows } = await ctx.db.query(
      `SELECT a.id, a.actor_type, a.actor_user_id, u.full_name AS actor_name, a.entity_type, a.entity_id, a.action, a.changes, a.created_at
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ($1::text IS NULL OR a.entity_type = $1) ORDER BY a.created_at DESC, a.id DESC LIMIT $2`, [f.entityType ?? null, f.limit]);
    return { data: rows };
  });
}
