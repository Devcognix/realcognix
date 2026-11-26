import type { Q } from './db.js';
import type { RequestAuth } from './auth.js';

/** One row in audit_log. Never put secret values in changes: name the key and say it changed. */
export async function audit(
  q: Q,
  e: { auth: Pick<RequestAuth, 'orgId' | 'userId' | 'kind'>; entityType: string; entityId?: string | null; action: string; changes?: unknown },
) {
  await q.query(
    `INSERT INTO audit_log (org_id, actor_type, actor_user_id, entity_type, entity_id, action, changes) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [e.auth.orgId, e.auth.kind === 'service' ? 'service' : 'user', e.auth.userId ?? null, e.entityType, e.entityId ?? null, e.action, JSON.stringify(e.changes ?? {})],
  );
}

/** Field-level diff of two flat objects, for audit entries. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = { from: before[k] ?? null, to: after[k] ?? null };
  }
  return out;
}
