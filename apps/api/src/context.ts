import { Redis } from 'ioredis';
import { createAdapters, type Adapters } from '@realcognix/adapters';
import { PgAgentStore, type AgentDeps } from '@realcognix/agents';
import type { AppConfig } from '@realcognix/core';
import { Db } from './lib/db.js';
import { createQueues, type Queues } from './queues/index.js';
import { createAuthProvider, type AuthProvider } from './auth/providers.js';
import { subjectLookup } from './auth/pg.js';
import { ProviderRegistry } from './providers/registry.js';
import { secretBoxFromConfig, type SecretBox } from './lib/secrets.js';
import type { AgentRoute } from '@realcognix/adapters';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface AppContext {
  config: AppConfig;
  db: Db;
  redis: Redis;
  adapters: Adapters;
  queues: Queues;
  /** Env-configured agent deps (fallback). Use agentDeps(ctx, orgId, agent) to get the org's own model routing. */
  agents: AgentDeps;
  /** Per-org providers chosen in Integrations & AI (DB first, env fallback). */
  providers: ProviderRegistry;
  /** Encrypts provider secrets at rest; null in production without CONFIG_MASTER_KEY. */
  secretBox: SecretBox | null;
  fetchFn: typeof fetch;
  /** Built on first use, so the worker never needs auth settings. */
  readonly auth: AuthProvider;
  log: Logger;
}

export function createContext(config: AppConfig, log: Logger): AppContext {
  const db = new Db(config.DATABASE_URL);
  // BullMQ requires maxRetriesPerRequest: null on its connections
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const adapters = createAdapters(config);
  const store = new PgAgentStore(db); // scoped: agents only run inside db.withOrg (requests, worker jobs)
  let auth: AuthProvider | undefined;
  const secretBox = secretBoxFromConfig(config);
  if (secretBox?.ephemeral) log.warn({}, 'CONFIG_MASTER_KEY not set: using the development key for provider secrets (never do this in production)');
  if (!secretBox) log.warn({}, 'CONFIG_MASTER_KEY not set: provider secrets cannot be saved; env settings are used');
  const providers = new ProviderRegistry({ db, config, env: adapters, box: secretBox, log, redis });
  return {
    config,
    db,
    redis,
    adapters,
    queues: createQueues(redis),
    agents: { llm: adapters.llm, approvals: store, runs: store },
    providers,
    secretBox,
    fetchFn: fetch,
    get auth() {
      return (auth ??= createAuthProvider(config, subjectLookup(db)));
    },
    log,
  };
}

export async function closeContext(ctx: AppContext) {
  await Promise.allSettled(Object.values(ctx.queues).map((q) => q.close()));
  await ctx.redis.quit().catch(() => undefined);
  await ctx.db.close();
}

export const consoleLogger: Logger = {
  info: (o, m) => console.log(JSON.stringify({ level: 'info', msg: m, ...(typeof o === 'object' ? o : { data: o }) })),
  warn: (o, m) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...(typeof o === 'object' ? o : { data: o }) })),
  error: (o, m) => console.error(JSON.stringify({ level: 'error', msg: m, ...(typeof o === 'object' ? o : { data: o }) })),
};

/** Agent dependencies for one org and one agent: its model chain from Integrations & AI (env fallback). */
export async function agentDeps(ctx: Pick<AppContext, 'agents' | 'providers'>, orgId: string, agent: AgentRoute): Promise<AgentDeps> {
  const p = await ctx.providers.forOrg(orgId);
  return { ...ctx.agents, llm: p.llmFor(agent) };
}
