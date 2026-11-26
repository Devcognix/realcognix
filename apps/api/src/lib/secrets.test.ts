import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecretBox, maskSecret, parseMasterKey, secretBoxFromConfig } from './secrets.js';

test('secrets: AES-256-GCM round trip, bound to org+row (AAD), tamper-evident, key rotation', () => {
  const k1 = Buffer.alloc(32, 1), k2 = Buffer.alloc(32, 2);
  const box = new SecretBox(k1);
  const sealed = box.seal({ apiKey: 'gsk_live_123456789' }, 'org-a:row-1');
  assert.match(sealed, /^v1\.[0-9a-f]{8}\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!sealed.includes('gsk_live'), 'no plaintext');
  assert.notEqual(sealed, box.seal({ apiKey: 'gsk_live_123456789' }, 'org-a:row-1'), 'fresh IV each time');
  assert.deepEqual(box.open(sealed, 'org-a:row-1'), { apiKey: 'gsk_live_123456789' });
  assert.throws(() => box.open(sealed, 'org-b:row-1'), 'copied to another org: refused');
  const parts = sealed.split('.');
  parts[4] = Buffer.from('x' + Buffer.from(parts[4]!, 'base64url').toString('latin1').slice(1), 'latin1').toString('base64url');
  assert.throws(() => box.open(parts.join('.'), 'org-a:row-1'), 'tampered ciphertext: refused');
  // Rotation: the new key reads old rows while CONFIG_MASTER_KEY_PREVIOUS holds the old one.
  const rotated = new SecretBox(k2, [k1]);
  assert.deepEqual(rotated.open(sealed, 'org-a:row-1'), { apiKey: 'gsk_live_123456789' });
  assert.equal(rotated.needsRotation(sealed), true);
  assert.throws(() => new SecretBox(k2).open(sealed, 'org-a:row-1'), /not configured/);
});

test('secrets: master key parsing, production without a key, masking', () => {
  assert.equal(parseMasterKey('ab'.repeat(32)).length, 32);
  assert.equal(parseMasterKey(Buffer.alloc(32, 9).toString('base64')).length, 32);
  assert.throws(() => parseMasterKey('short'));
  assert.equal(secretBoxFromConfig({ NODE_ENV: 'production' }), null);
  assert.equal(secretBoxFromConfig({ NODE_ENV: 'development' })!.ephemeral, true);
  assert.equal(secretBoxFromConfig({ NODE_ENV: 'production', CONFIG_MASTER_KEY: 'cd'.repeat(32) })!.ephemeral, false);
  assert.equal(maskSecret('gsk_abcdefghijklmnopqrstuvwxyz1234'), 'gsk_…1234');
  assert.equal(maskSecret('abc'), '•••');
});
