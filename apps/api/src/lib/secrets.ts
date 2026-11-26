import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for provider secrets (API keys, tokens, SMTP passwords) in provider_configs.secrets_enc.
 *
 *   AES-256-GCM, a fresh 12-byte IV per value, and Additional Authenticated Data = "<org id>:<row id>", so a ciphertext
 *   copied to another org or another row fails to decrypt. Format: v1.<key id>.<iv>.<tag>.<ciphertext> (base64url);
 *   key id = first 8 hex of sha256(key), which lets CONFIG_MASTER_KEY_PREVIOUS keep old rows readable during rotation.
 *
 * The master key comes from CONFIG_MASTER_KEY (32 bytes as 64 hex chars or base64). Never stored in the database.
 */
export class SecretBox {
  private readonly keys: Map<string, Buffer>;
  readonly currentKeyId: string;

  constructor(current: Buffer, previous: Buffer[] = [], readonly ephemeral = false) {
    if (current.length !== 32) throw new Error('CONFIG_MASTER_KEY must be 32 bytes (64 hex characters or 44 base64 characters)');
    this.currentKeyId = keyId(current);
    this.keys = new Map([[this.currentKeyId, current], ...previous.map((k) => [keyId(k), k] as [string, Buffer])]);
  }

  seal(value: Record<string, string>, aad: string): string {
    const key = this.keys.get(this.currentKeyId)!;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return ['v1', this.currentKeyId, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  open(sealed: string, aad: string): Record<string, string> {
    const [v, kid, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1' || !kid || !iv || !tag || ct === undefined) throw new Error('secrets: unknown format');
    const key = this.keys.get(kid);
    if (!key) throw new Error('secrets: encrypted with a key that is not configured (set CONFIG_MASTER_KEY_PREVIOUS during rotation)');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    const pt = Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
    return JSON.parse(pt.toString('utf8'));
  }

  needsRotation(sealed: string) {
    return sealed.split('.')[1] !== this.currentKeyId;
  }
}

const keyId = (k: Buffer) => createHash('sha256').update(k).digest('hex').slice(0, 8);

export function parseMasterKey(v: string): Buffer {
  const t = v.trim();
  const b = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64');
  if (b.length !== 32) throw new Error('CONFIG_MASTER_KEY must be 32 bytes (openssl rand -hex 32)');
  return b;
}

/**
 * The SecretBox for this process. Production without CONFIG_MASTER_KEY gets null: secrets cannot be saved or read
 * (the admin screen says so) and env settings keep working. Development falls back to a fixed, clearly-insecure key.
 */
export function secretBoxFromConfig(c: { NODE_ENV: string; CONFIG_MASTER_KEY?: string; CONFIG_MASTER_KEY_PREVIOUS?: string }): SecretBox | null {
  const prev = (c.CONFIG_MASTER_KEY_PREVIOUS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(parseMasterKey);
  if (c.CONFIG_MASTER_KEY) return new SecretBox(parseMasterKey(c.CONFIG_MASTER_KEY), prev);
  if (c.NODE_ENV === 'production') return null;
  return new SecretBox(createHash('sha256').update('realcognix-dev-only-config-key (not secret)').digest(), prev, true);
}

/** "gsk_abcd…wxyz" style preview: enough to recognise a key, never enough to use it. */
export function maskSecret(v: string): string {
  if (!v) return '';
  if (v.length <= 8) return '•'.repeat(v.length);
  const head = v.length > 16 ? v.slice(0, 4) : v.slice(0, 2);
  return `${head}…${v.slice(-4)}`;
}
