/**
 * Test harness: an in-process PostgreSQL (pglite) initialised the way the Docker image does it
 * (db/schema.sql, then 003 → 008 as the owner), with the API's Db talking to it AS realcognix_app
 * (NOBYPASSRLS, not an owner), so row-level security, grants and composite tenant FKs are all enforced.
 *
 * pglite is one connection, so the pool shim serialises transactions with a mutex. Not used in production code.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { Db } from '../lib/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const sqlFile = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const toNum = (v: string) => (v === null ? null : Number(v));
const PARSERS = { 1700: toNum, 20: toNum } as Record<number, (v: string) => unknown>;

let template: Promise<Uint8Array | Blob> | null = null;

/** A fresh database. The first call builds it from SQL; later calls restore a dump of that (fast). */
export async function createTestDatabase(): Promise<PGlite> {
  template ??= (async () => {
    const pg = await PGlite.create({ extensions: { vector, pgcrypto, citext } });
    await pg.exec(sqlFile('db/schema.sql'));
    for (const m of ['003_app_role', '004_job_outbox', '005_tenant_fks', '006_sales_close', '007_platform', '008_provider_registry']) {
      await pg.exec(sqlFile(`db/migrations/${m}.sql`));
    }
    const dump = await pg.dumpDataDir('none');
    await pg.close();
    return dump;
  })();
  const dump = await template;
  return PGlite.create({ loadDataDir: dump as Blob, extensions: { vector, pgcrypto, citext }, parsers: PARSERS });
}

type Result = { rows: any[]; rowCount: number };

/** pg.Pool look-alike on top of pglite. Every statement runs as realcognix_app. */
export function poolShim(pg: PGlite) {
  let chain: Promise<void> = Promise.resolve();
  const lock = () => {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = chain;
    chain = prev.then(() => next);
    return prev.then(() => release);
  };
  const run = async (sql: string, params?: unknown[]): Promise<Result> => {
    if ((!params || !params.length) && sql.includes(';')) {
      const out = await pg.exec(sql);
      const last = out[out.length - 1];
      return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? last?.rows.length ?? 0 };
    }
    const r = await pg.query(sql, params as any[], { parsers: PARSERS });
    return { rows: r.rows as any[], rowCount: r.affectedRows || r.rows.length };
  };
  return {
    async connect() {
      const release = await lock();
      return {
        query: (sql: string, params?: unknown[]) =>
          /^\s*BEGIN\b/i.test(sql) ? run(`${sql}; SET LOCAL ROLE realcognix_app`) : run(sql, params),
        release,
      };
    },
    async query(sql: string, params?: unknown[]) {
      const release = await lock();
      try {
        await pg.exec('SET ROLE realcognix_app');
        return await run(sql, params);
      } finally {
        await pg.exec('RESET ROLE').catch(() => undefined);
        release();
      }
    },
    async end() { /* closed by the test */ },
  };
}

/** The API's Db, wired to pglite as realcognix_app. */
export function testDb(pg: PGlite): Db {
  const db = new Db('postgres://unused@127.0.0.1:1/unused');
  void (db as unknown as { pool: { end(): Promise<void> } }).pool.end();
  (db as unknown as { pool: unknown }).pool = poolShim(pg);
  return db;
}

export interface SeededOrg {
  orgId: string;
  slug: string;
  roles: Record<string, string>;
  users: Record<string, string>; // role key -> user id
}

/** Creates an org with the system roles and one user per role (as the owner, bypassing RLS like an admin script). */
export async function seedOrg(pg: PGlite, slug = 'org-' + randomUUID().slice(0, 8)): Promise<SeededOrg> {
  const orgId = randomUUID();
  await pg.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, [orgId, `Org ${slug}`, slug]);
  const roles: Record<string, string> = {};
  const users: Record<string, string> = {};
  for (const key of ['owner', 'admin', 'manager', 'executive', 'client_viewer', 'partner']) {
    const roleId = randomUUID();
    roles[key] = roleId;
    await pg.query(`INSERT INTO roles (id, org_id, key, name, is_system) VALUES ($1, $2, $3, $4, true)`, [roleId, orgId, key, key]);
    const userId = randomUUID();
    users[key] = userId;
    await pg.query(
      `INSERT INTO users (id, org_id, role_id, full_name, email, languages, routing_weight) VALUES ($1, $2, $3, $4, $5, '{en}', $6)`,
      [userId, orgId, roleId, `${key} ${slug}`, `${key}@${slug}.test`, key === 'executive' ? 1 : 0],
    );
  }
  return { orgId, slug, roles, users };
}
