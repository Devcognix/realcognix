import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { z } from 'zod';
import { httpErrorHandler } from './errors.js';

const pgError = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('pg error'), { code, ...extra });

test('errors: composite tenant FK violation (23503) -> 422 invalid_reference, no key values leaked', async () => {
  const app = Fastify({ logger: false });
  app.setErrorHandler(httpErrorHandler);
  app.get('/fk', async () => {
    throw pgError('23503', {
      constraint: 'site_visits_host_user_id_fkey', table: 'site_visits',
      detail: 'Key (org_id, host_user_id)=(00000000-0000-0000-0000-000000000001, 00000000-0000-0000-00ff-000000000002) is not present in table "users".',
    });
  });
  app.get('/uuid', async () => { throw pgError('22P02'); });
  app.get('/zod', async () => z.object({ a: z.string() }).parse({}));
  app.get('/404', async () => { throw Object.assign(new Error('lead not found'), { statusCode: 404 }); });
  app.get('/boom', async () => { throw new Error('secret internals'); });

  const fk = await app.inject('/fk');
  assert.equal(fk.statusCode, 422);
  assert.equal(fk.json().error, 'invalid_reference');
  assert.ok(!fk.body.includes('00ff'), 'constraint detail (other org id) is not returned');
  assert.equal((await app.inject('/uuid')).statusCode, 400);
  assert.equal((await app.inject('/zod')).json().error, 'validation_failed');
  const nf = await app.inject('/404');
  assert.deepEqual([nf.statusCode, nf.json().error], [404, 'lead not found']);
  const boom = await app.inject('/boom');
  assert.deepEqual([boom.statusCode, boom.json().error], [500, 'internal_error']);
  await app.close();
});
