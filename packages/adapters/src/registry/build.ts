import { randomUUID } from 'node:crypto';
import { AdapterError } from '../errors.js';
import type { LLMProvider } from '../llm/types.js';
import { OpenAICompatibleLLM } from '../llm/openai-compatible.js';
import type { MessageChannel } from '../messaging/types.js';
import { WhatsAppCloudChannel } from '../messaging/whatsapp-cloud.js';
import { ConsoleChannel } from '../messaging/console.js';
import type { EmailProvider } from '../email/types.js';
import { SmtpEmailProvider } from '../email/smtp.js';
import { ConsoleEmailProvider } from '../email/console.js';
import type { StorageProvider } from '../storage/types.js';
import { LocalStorage } from '../storage/local.js';
import { S3Storage } from '../storage/s3.js';
import type { AdPlatform } from '../ads/types.js';
import { MetaMarketingAds } from '../ads/meta-marketing.js';
import { GoogleAdsPlatform } from '../ads/google-ads.js';
import { providerSpec, type Capability } from './catalog.js';

/** A provider_configs row with its secrets decrypted (server side only). */
export interface Connection {
  id: string;
  capability: Capability;
  provider: string;
  label?: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

const str = (v: unknown, d = '') => (v === undefined || v === null || v === '' ? d : String(v));
const num = (v: unknown, d: number) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? d : Number(v));
const bool = (v: unknown, d: boolean) => (v === undefined || v === null || v === '' ? d : v === true || v === 'true' || v === 1 || v === '1');

/** Chat model for an LLM connection. model overrides the connection's default model. */
export function buildLlm(c: Connection, model?: string, opts: { timeoutMs?: number; maxRetries?: number } = {}): LLMProvider {
  const spec = providerSpec('llm', c.provider);
  if (!spec) throw new AdapterError(c.provider, `unknown LLM provider "${c.provider}"`);
  const baseURL = str(c.config.baseUrl, spec.llm?.baseUrl ?? '');
  const m = str(model, str(c.config.model, spec.llm?.defaultModel ?? ''));
  if (!baseURL) throw new AdapterError(c.provider, 'endpoint URL is required');
  if (!m) throw new AdapterError(c.provider, 'model is required');
  return new OpenAICompatibleLLM({
    label: `${c.provider}:${m}`, baseURL, apiKey: c.secrets.apiKey ?? '', model: m, embedModel: str(c.config.embedModel, spec.llm?.embedModel ?? m),
    jsonMode: c.provider === 'custom' ? bool(c.config.jsonMode, true) : spec.llm?.jsonMode !== false,
    azure: c.provider === 'azure_openai' ? { apiVersion: str(c.config.apiVersion, '2024-10-21') } : undefined,
    headers: c.provider === 'openrouter' ? { 'HTTP-Referer': 'https://realcognix.com', 'X-Title': 'RealCognix OS' } : undefined,
    timeoutMs: opts.timeoutMs, maxRetries: opts.maxRetries,
  });
}

export function buildEmbeddings(c: Connection): LLMProvider {
  const spec = providerSpec('embeddings', c.provider) ?? providerSpec('llm', c.provider);
  if (!spec?.llm?.embeddings) throw new AdapterError(c.provider, `"${c.provider}" has no embeddings API`);
  const embedModel = str(c.config.embedModel, spec.llm.embedModel ?? '');
  if (!embedModel) throw new AdapterError(c.provider, 'embedding model is required');
  return new OpenAICompatibleLLM({
    label: `${c.provider}:${embedModel}`, baseURL: str(c.config.baseUrl, spec.llm.baseUrl ?? ''), apiKey: c.secrets.apiKey ?? '',
    model: str(c.config.model, embedModel), embedModel,
    embedDimensions: c.provider === 'openai' || c.provider === 'azure_openai' ? num(c.config.dimensions, 768) : undefined,
    azure: c.provider === 'azure_openai' ? { apiVersion: str(c.config.apiVersion, '2024-10-21') } : undefined,
  });
}

export function buildMessaging(c: Connection): MessageChannel {
  if (c.provider === 'console') return new ConsoleChannel(c.secrets.verifyToken ?? 'console');
  if (c.provider === 'whatsapp_cloud') {
    return new WhatsAppCloudChannel({
      phoneNumberId: str(c.config.phoneNumberId), accessToken: c.secrets.accessToken ?? '', appSecret: c.secrets.appSecret,
      verifyToken: c.secrets.verifyToken ?? '', graphVersion: str(c.config.graphVersion, 'v21.0'), defaultLanguage: str(c.config.templateLanguage, 'en'),
    });
  }
  throw new AdapterError(c.provider, `unknown messaging provider "${c.provider}"`);
}

export function buildEmail(c: Connection): EmailProvider {
  if (c.provider === 'console') return new ConsoleEmailProvider();
  if (c.provider === 'smtp' || c.provider === 'mailpit') {
    const preset = providerSpec('email', 'smtp')!.presets![str(c.config.preset, 'custom')] ?? {};
    const host = str(c.config.host, str(preset.host, c.provider === 'mailpit' ? 'mailpit' : ''));
    if (!host) throw new AdapterError('smtp', 'host is required');
    return new SmtpEmailProvider({
      host, port: num(c.config.port, num(preset.port, c.provider === 'mailpit' ? 1025 : 587)),
      secure: c.provider === 'mailpit' ? false : bool(c.config.secure, bool(preset.secure, false)),
      user: str(c.config.user) || undefined, pass: c.secrets.pass, from: str(c.config.from, 'RealCognix <no-reply@realcognix.test>'),
    });
  }
  throw new AdapterError(c.provider, `unknown email provider "${c.provider}"`);
}

export function buildStorage(c: Connection, publicApiUrl: string, fetchFn?: typeof fetch): StorageProvider {
  if (c.provider === 'local') return new LocalStorage(str(c.config.dir, './storage'), publicApiUrl);
  if (c.provider === 's3') {
    const preset = providerSpec('storage', 's3')!.presets![str(c.config.preset, 'r2')] ?? {};
    return new S3Storage({
      endpoint: str(c.config.endpoint, str(preset.endpoint)), region: str(c.config.region, str(preset.region, 'auto')), bucket: str(c.config.bucket),
      accessKeyId: c.secrets.accessKeyId ?? '', secretAccessKey: c.secrets.secretAccessKey ?? '',
      forcePathStyle: bool(c.config.forcePathStyle, bool(preset.forcePathStyle, true)), publicBaseUrl: str(c.config.publicBaseUrl) || undefined, fetchFn,
    });
  }
  throw new AdapterError(c.provider, `unknown storage provider "${c.provider}"`);
}

export function buildAds(c: Connection): AdPlatform {
  if (c.provider === 'meta') {
    return new MetaMarketingAds({ accessToken: c.secrets.accessToken ?? '', adAccountId: str(c.config.adAccountId), graphVersion: str(c.config.graphVersion, 'v21.0') });
  }
  if (c.provider === 'google') {
    return new GoogleAdsPlatform({
      developerToken: c.secrets.developerToken ?? '', customerId: str(c.config.customerId), loginCustomerId: str(c.config.loginCustomerId) || undefined,
      accessToken: c.secrets.oauthAccessToken ?? '',
    });
  }
  throw new AdapterError(c.provider, `unknown ads provider "${c.provider}"`);
}

export interface TestResult { ok: boolean; message: string; latencyMs: number; details?: Record<string, unknown> }

async function getJson(fetchFn: typeof fetch, url: string, headers: Record<string, string>) {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok) {
    const msg = typeof body === 'object' ? body?.error?.message ?? body?.message ?? JSON.stringify(body).slice(0, 200) : String(body).slice(0, 200);
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }
  return body;
}

/** "Test connection": one real, harmless call to the provider with the saved settings. */
export async function testConnection(c: Connection, deps: { fetchFn?: typeof fetch; publicApiUrl?: string; model?: string } = {}): Promise<TestResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const t = Date.now();
  const done = (ok: boolean, message: string, details?: Record<string, unknown>): TestResult => ({ ok, message, latencyMs: Date.now() - t, details });
  try {
    switch (c.capability) {
      case 'llm': {
        const llm = buildLlm(c, deps.model, { timeoutMs: 20_000, maxRetries: 0 });
        const r = await llm.chat([{ role: 'user', content: 'Reply with the single word OK.' }], { temperature: 0, maxTokens: 5 });
        return done(true, `Model answered: "${r.text.trim().slice(0, 40)}"`, { model: r.model });
      }
      case 'embeddings': {
        const v = await buildEmbeddings(c).embed(['RealCognix connection test']);
        const dims = v[0]?.length ?? 0;
        return done(dims > 0, `Got a ${dims}-dimension vector${dims !== 768 ? ' (knowledge search expects 768; set dimensions or pick a 768-d model)' : ''}`, { dimensions: dims });
      }
      case 'messaging': {
        if (c.provider === 'console') return done(true, 'Console mode: messages are logged, not sent');
        buildMessaging(c);
        const body = await getJson(fetchFn, `https://graph.facebook.com/${str(c.config.graphVersion, 'v21.0')}/${encodeURIComponent(str(c.config.phoneNumberId))}?fields=display_phone_number,verified_name,quality_rating`,
          { authorization: `Bearer ${c.secrets.accessToken ?? ''}` });
        return done(true, `Connected to ${body.verified_name ?? 'WhatsApp'} ${body.display_phone_number ?? ''}`.trim(), { quality: body.quality_rating });
      }
      case 'email': {
        if (c.provider === 'console') return done(true, 'Console mode: emails are logged, not sent');
        const ok = await (buildEmail(c) as SmtpEmailProvider).verify();
        return done(ok, ok ? 'SMTP server accepted the login' : 'Could not connect or log in to the SMTP server');
      }
      case 'storage': {
        const s = buildStorage(c, deps.publicApiUrl ?? '', fetchFn);
        const key = `_rc-test/${randomUUID()}.txt`;
        await s.put(key, Buffer.from('ok'), 'text/plain');
        const back = (await s.get(key)).toString();
        await s.delete(key);
        return done(back === 'ok', back === 'ok' ? 'Wrote, read and deleted a test file' : 'Read back different content');
      }
      case 'ads': {
        if (c.provider === 'meta') {
          const b = await getJson(fetchFn, `https://graph.facebook.com/${str(c.config.graphVersion, 'v21.0')}/act_${encodeURIComponent(str(c.config.adAccountId))}?fields=name,account_status,currency`,
            { authorization: `Bearer ${c.secrets.accessToken ?? ''}` });
          return done(true, `Ad account "${b.name}" (${b.currency ?? ''})`, { status: b.account_status });
        }
        const b = await getJson(fetchFn, 'https://googleads.googleapis.com/v18/customers:listAccessibleCustomers',
          { authorization: `Bearer ${c.secrets.oauthAccessToken ?? ''}`, 'developer-token': c.secrets.developerToken ?? '' });
        return done(true, `${(b.resourceNames ?? []).length} accessible Google Ads account(s)`);
      }
      case 'lead_sources': {
        if (c.provider === 'meta_lead_ads') {
          const b = await getJson(fetchFn, `https://graph.facebook.com/v21.0/${encodeURIComponent(str(c.config.pageId))}?fields=name`, { authorization: `Bearer ${c.secrets.pageAccessToken ?? ''}` });
          return done(true, `Page "${b.name}" reachable with this token`);
        }
        if (c.provider === 'generic_webhook') return done(!!c.secrets.webhookSecret, c.secrets.webhookSecret ? 'Secret set; POST leads with header x-intake-secret' : 'Set a shared secret');
        return done(true, 'Nothing to call: this source pushes leads to RealCognix');
      }
      case 'automations': {
        if (c.provider === 'none') return done(true, 'Built-in automations only');
        const b = await getJson(fetchFn, `${str(c.config.baseUrl).replace(/\/+$/, '')}/api/v1/workflows?limit=100`, { 'X-N8N-API-KEY': c.secrets.apiKey ?? '' });
        return done(true, `n8n reachable: ${(b.data ?? []).length} workflow(s)`);
      }
    }
    return done(false, 'unknown capability');
  } catch (e) {
    return done(false, (e as Error).message.slice(0, 500));
  }
}
