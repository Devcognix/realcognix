/** Builds the real Fastify app on pglite (as realcognix_app) with Redis "down" (jobs go to job_outbox), for route tests. */
import Fastify from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { createAdapters, type LLMProvider } from '@realcognix/adapters';
import { PgAgentStore } from '@realcognix/agents';
import { loadConfig, type AppConfig } from '@realcognix/core';
import { buildApp } from '../app.js';
import type { AppContext } from '../context.js';
import { signAccessToken } from '../auth/providers.js';
import { createAuthProvider } from '../auth/providers.js';
import { subjectLookup } from '../auth/pg.js';
import { ProviderRegistry } from '../providers/registry.js';
import { SecretBox } from '../lib/secrets.js';
import { createTestDatabase, seedOrg, testDb, type SeededOrg } from './pglite.js';

export const TEST_KEY = Buffer.alloc(32, 7);

export interface TestApp {
  app: Awaited<ReturnType<typeof buildApp>>;
  pg: PGlite;
  ctx: AppContext;
  org: SeededOrg;
  other: SeededOrg;
  token(role?: string, org?: SeededOrg): string;
  as(role?: string, org?: SeededOrg): Record<string, string>;
  close(): Promise<void>;
}

export async function createTestApp(opts: { env?: Record<string, string>; fetchFn?: typeof fetch; llm?: LLMProvider } = {}): Promise<TestApp> {
  const pg = await createTestDatabase();
  const org = await seedOrg(pg, 'acme');
  const other = await seedOrg(pg, 'other');
  const db = testDb(pg);
  const config: AppConfig = loadConfig({
    NODE_ENV: 'test', WHATSAPP_PROVIDER: 'console', EMAIL_PROVIDER: 'console', LLM_PROVIDER: 'none', DEFAULT_ORG_ID: org.orgId,
    PROVIDER_CACHE_SECONDS: '30', ...opts.env,
  } as NodeJS.ProcessEnv);
  const adapters = createAdapters(config);
  if (opts.llm) adapters.llm = opts.llm;
  const store = new PgAgentStore(db);
  const redis = { status: 'end', publish: async () => 0, duplicate: () => ({}), ping: async () => 'PONG', quit: async () => 'OK' } as any;
  const failing = { add: () => Promise.reject(new Error('redis down')), close: async () => undefined, upsertJobScheduler: async () => undefined };
  const queues = Object.fromEntries(['intake', 'inbound', 'sla', 'cadence', 'visit-reminders', 'reports'].map((n) => [n, failing])) as any;
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const box = new SecretBox(TEST_KEY);
  const fetchFn = opts.fetchFn ?? (async () => { throw new Error('network disabled in tests'); }) as typeof fetch;
  const providers = new ProviderRegistry({ db, config, env: adapters, box, log, fetchFn });
  let auth: ReturnType<typeof createAuthProvider> | undefined;
  const ctx = {
    config, db, redis, adapters, queues, log, providers, secretBox: box, fetchFn,
    agents: { llm: adapters.llm, approvals: store, runs: store },
    get auth() { return (auth ??= createAuthProvider(config, subjectLookup(db))); },
  } as unknown as AppContext;
  const app = await buildApp(ctx, Fastify({ logger: false }));
  const token = (role = 'admin', o = org) => signAccessToken(config, { userId: o.users[role]!, orgId: o.orgId, role }).token;
  return {
    app, pg, ctx, org, other, token,
    as: (role = 'admin', o = org) => ({ authorization: `Bearer ${token(role, o)}` }),
    close: async () => { await app.close(); await pg.close(); },
  };
}
