import {
  FallbackLLM, buildAds, buildEmail, buildEmbeddings, buildLlm, buildMessaging, buildStorage,
  type AdPlatform, type Adapters, type AgentRoute, type Capability, type Connection, type EmailProvider, type LLMProvider,
  type MessageChannel, type StorageProvider,
} from '@realcognix/adapters';
import type { AppConfig } from '@realcognix/core';
import type { Db } from '../lib/db.js';
import type { SecretBox } from '../lib/secrets.js';

interface Logger { warn(obj: unknown, msg?: string): void; info(obj: unknown, msg?: string): void }
interface PubSub { publish(channel: string, message: string): Promise<unknown>; duplicate(): any; status?: string }

export interface ChainLink { connectionId: string; model?: string | null }

export interface ConfigRow {
  id: string; capability: Capability; provider: string; label: string; enabled: boolean; is_primary: boolean;
  config: Record<string, unknown>; secrets_enc: string | null; secret_hints: Record<string, string>;
  last_test_at: Date | null; last_test_ok: boolean | null; last_test_error: string | null; updated_at: Date;
}

export interface OrgProviders {
  orgId: string;
  loadedAt: number;
  whatsapp: MessageChannel;
  email: EmailProvider;
  storage: StorageProvider;
  ads: Partial<Record<'meta' | 'google', AdPlatform>>;
  embeddings: LLMProvider;
  /** The model chain for one agent (its own route, else the default route, else the primary connection, else env). */
  llmFor(agent: AgentRoute): LLMProvider;
  automations: { provider: 'n8n'; baseUrl: string; apiKey: string } | null;
  leadSources: Record<string, { enabled: boolean; config: Record<string, unknown>; secrets: Record<string, string> }>;
  /** Where each capability came from: the org's saved settings or the server's env fallback. */
  source: Record<Capability, 'db' | 'env'>;
  /** Settings that could not be built (bad config, undecryptable secret): the env fallback was used instead. */
  problems: Array<{ capability: string; connectionId?: string; error: string }>;
  routes: Partial<Record<AgentRoute, ChainLink[]>>;
}

export const INVALIDATE_CHANNEL = 'rc:providers:invalidate';

/**
 * Runtime provider registry. For each org: read provider_configs + ai_agent_routes (RLS-scoped), decrypt secrets,
 * build adapters; anything not configured (or broken) falls back to the env adapters. Cached per org for
 * PROVIDER_CACHE_SECONDS; a save calls invalidate(), which also tells other API/worker processes through Redis.
 */
export class ProviderRegistry {
  private cache = new Map<string, { at: number; value: Promise<OrgProviders> }>();

  constructor(private readonly deps: {
    db: Db; config: AppConfig; env: Adapters; box: SecretBox | null; log: Logger; fetchFn?: typeof fetch; redis?: PubSub; now?: () => number;
  }) {}

  private now() { return this.deps.now ? this.deps.now() : Date.now(); }

  forOrg(orgId: string): Promise<OrgProviders> {
    const ttl = this.deps.config.PROVIDER_CACHE_SECONDS * 1000;
    const hit = this.cache.get(orgId);
    if (hit && this.now() - hit.at < ttl) return hit.value;
    const value = this.deps.db.withOrg(orgId, () => this.build(orgId));
    this.cache.set(orgId, { at: this.now(), value });
    value.catch(() => this.cache.delete(orgId));
    return value;
  }

  /** Drop the cached adapters for an org (after a save). broadcast=true also tells the other processes. */
  invalidate(orgId: string, broadcast = true) {
    this.cache.delete(orgId);
    const r = this.deps.redis;
    if (broadcast && r && (r.status === undefined || r.status === 'ready')) {
      r.publish(INVALIDATE_CHANNEL, orgId).catch(() => undefined);
    }
  }

  /** Subscribe to invalidations from other processes. Returns a stop function. */
  listen(): () => Promise<void> {
    const r = this.deps.redis;
    if (!r) return async () => undefined;
    const sub = r.duplicate();
    sub.on?.('message', (_ch: string, orgId: string) => this.invalidate(orgId, false));
    sub.on?.('error', () => undefined);
    sub.subscribe?.(INVALIDATE_CHANNEL).catch(() => undefined);
    return async () => { await sub.quit?.().catch(() => undefined); };
  }

  /** Rows for the current org (call inside withOrg). */
  async rows(includeArchived = false): Promise<ConfigRow[]> {
    const { rows } = await this.deps.db.query<ConfigRow>(
      `SELECT id, capability, provider, label, enabled, is_primary, config, secrets_enc, secret_hints, last_test_at, last_test_ok, last_test_error, updated_at
         FROM provider_configs WHERE ($1 OR archived_at IS NULL) ORDER BY capability, is_primary DESC, created_at`, [includeArchived]);
    return rows;
  }

  decrypt(orgId: string, row: Pick<ConfigRow, 'id' | 'secrets_enc'>): Record<string, string> {
    if (!row.secrets_enc) return {};
    if (!this.deps.box) throw new Error('CONFIG_MASTER_KEY is not set, so saved secrets cannot be read');
    return this.deps.box.open(row.secrets_enc, `${orgId}:${row.id}`);
  }

  toConnection(orgId: string, row: ConfigRow): Connection {
    return { id: row.id, capability: row.capability, provider: row.provider, label: row.label, config: row.config ?? {}, secrets: this.decrypt(orgId, row) };
  }

  private async build(orgId: string): Promise<OrgProviders> {
    const env = this.deps.env;
    const problems: OrgProviders['problems'] = [];
    const rows = (await this.rows()).filter((r) => r.enabled);
    const routesRes = await this.deps.db.query<{ agent: AgentRoute; chain: ChainLink[] }>(`SELECT agent, chain FROM ai_agent_routes`);
    const routes: OrgProviders['routes'] = {};
    for (const r of routesRes.rows) routes[r.agent] = Array.isArray(r.chain) ? r.chain : [];

    const conns = new Map<string, Connection>();
    for (const row of rows) {
      try {
        conns.set(row.id, this.toConnection(orgId, row));
      } catch (e) {
        problems.push({ capability: row.capability, connectionId: row.id, error: (e as Error).message });
      }
    }
    const of = (cap: Capability) => rows.filter((r) => r.capability === cap && conns.has(r.id)).map((r) => ({ row: r, conn: conns.get(r.id)! }));
    const primary = (cap: Capability) => { const all = of(cap); return all.find((x) => x.row.is_primary) ?? all[0]; };
    const source = {} as OrgProviders['source'];

    function pick<T>(cap: Capability, fallback: T, make: (c: Connection) => T): T {
      const p = primary(cap);
      if (!p) { source[cap] = 'env'; return fallback; }
      try {
        const v = make(p.conn);
        source[cap] = 'db';
        return v;
      } catch (e) {
        problems.push({ capability: cap, connectionId: p.row.id, error: (e as Error).message });
        source[cap] = 'env';
        return fallback;
      }
    }

    const whatsapp = pick('messaging', env.whatsapp, buildMessaging);
    const email = pick('email', env.email, buildEmail);
    const storage = pick('storage', env.storage, (c) => buildStorage(c, this.deps.config.PUBLIC_API_URL, this.deps.fetchFn));
    const embeddings = pick('embeddings', env.llm, buildEmbeddings);

    const adsRows = of('ads');
    const ads: OrgProviders['ads'] = adsRows.length ? {} : env.ads;
    source.ads = adsRows.length ? 'db' : 'env';
    for (const a of adsRows) {
      try { ads[a.conn.provider as 'meta' | 'google'] = buildAds(a.conn); } catch (e) { problems.push({ capability: 'ads', connectionId: a.row.id, error: (e as Error).message }); }
    }

    const leadSources: OrgProviders['leadSources'] = {};
    for (const l of of('lead_sources')) leadSources[l.conn.provider] = { enabled: true, config: l.conn.config, secrets: l.conn.secrets };
    source.lead_sources = Object.keys(leadSources).length ? 'db' : 'env';

    const auto = primary('automations');
    let automations: OrgProviders['automations'] = null;
    if (auto && auto.conn.provider === 'n8n') {
      automations = { provider: 'n8n', baseUrl: String(auto.conn.config.baseUrl ?? ''), apiKey: auto.conn.secrets.apiKey ?? '' };
      source.automations = 'db';
    } else if (auto) {
      source.automations = 'db';
    } else {
      source.automations = 'env';
      if (this.deps.config.N8N_API_URL && this.deps.config.N8N_API_KEY) automations = { provider: 'n8n', baseUrl: this.deps.config.N8N_API_URL, apiKey: this.deps.config.N8N_API_KEY };
    }

    // ---- LLM chains per agent
    const llmConns = of('llm');
    source.llm = llmConns.length ? 'db' : 'env';
    const linkCache = new Map<string, LLMProvider>();
    const link = (l: ChainLink): LLMProvider | null => {
      const conn = conns.get(l.connectionId);
      if (!conn || conn.capability !== 'llm') return null;
      const key = `${l.connectionId}|${l.model ?? ''}`;
      if (!linkCache.has(key)) {
        try { linkCache.set(key, buildLlm(conn, l.model ?? undefined)); } catch (e) {
          problems.push({ capability: 'llm', connectionId: l.connectionId, error: (e as Error).message });
          return null;
        }
      }
      return linkCache.get(key)!;
    };
    const log = this.deps.log;
    const chainCache = new Map<string, LLMProvider>();
    const llmFor = (agent: AgentRoute): LLMProvider => {
      if (chainCache.has(agent)) return chainCache.get(agent)!;
      const chain = (routes[agent]?.length ? routes[agent]! : routes.default ?? []).map(link).filter((x): x is LLMProvider => !!x);
      if (!chain.length) {
        const p = primary('llm');
        const only = p ? link({ connectionId: p.row.id }) : null;
        if (only) chain.push(only);
      }
      const out = chain.length ? new FallbackLLM(chain, (from, err) => log.warn({ agent, from, err: err.message }, 'llm fallback')) : env.llm;
      chainCache.set(agent, out);
      return out;
    };

    return { orgId, loadedAt: this.now(), whatsapp, email, storage, ads, embeddings, llmFor, automations, leadSources, source, problems, routes };
  }
}
