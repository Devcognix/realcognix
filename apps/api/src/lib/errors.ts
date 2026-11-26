import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { isForeignKeyViolation } from './db.js';

/**
 * One error mapping for every route. Database errors that a caller can cause are answered as 4xx, never 500:
 *  - 22P02 (invalid text representation, e.g. a malformed uuid) -> 400 invalid_input
 *  - 23503 (foreign key violation). Since 005_tenant_fks every reference between org-scoped tables is a composite
 *    (org_id, <col>) FK, so an id from another org (or one that does not exist) fails here even if a code-level
 *    guard missed it -> 422 invalid_reference. The constraint detail (it contains key values) is logged, not returned.
 */
export function httpErrorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ZodError) return reply.code(400).send({ error: 'validation_failed', issues: err.issues });
  const code = (err as { code?: string }).code;
  if (code === '22P02') return reply.code(400).send({ error: 'invalid_input' });
  if (isForeignKeyViolation(err)) {
    const e = err as { constraint?: string; table?: string };
    req.log.warn({ constraint: e.constraint, table: e.table }, 'foreign key violation (cross-org or missing reference)');
    return reply.code(422).send({ error: 'invalid_reference', message: 'a referenced record does not exist in this organization' });
  }
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) req.log.error(err);
  return reply.code(status).send({ error: status >= 500 ? 'internal_error' : (err as Error).message });
}
