import { z } from 'zod';

/**
 * Single source of truth for runtime configuration.
 * Every provider choice is a plain env var, so swapping a vendor is a config change.
 */
const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');
const blank = (v: unknown) => (v === '' ? undefined : v);
const optStr = z.preprocess(blank, z.string().optional());

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  API_TOKEN: z.string().min(8).default('dev-token-change-me'),
  INTAKE_SHARED_SECRET: z.string().min(8).default('dev-intake-secret'),
  DEFAULT_ORG_ID: z.guid().default('00000000-0000-0000-0000-000000000001'),

  // Comma-separated allowed browser origins for CORS; empty = reflect any origin (dev).
  CORS_ORIGINS: z.string().default(''),
  // Trust X-Forwarded-For (req.ip, login rate limits) only behind your own proxy: false (default) | true | hop count | IPs/CIDRs.
  TRUST_PROXY: z.string().default('false'),

  // Auth: 'local' = built-in email + password with HS256 access tokens; 'oidc' = Keycloak/Supabase RS256 tokens via JWKS
  AUTH_PROVIDER: z.enum(['local', 'oidc']).default('local'),
  JWT_SECRET: z.preprocess(blank, z.string().min(32).default('dev-only-jwt-secret-change-me-0000000000')),
  JWT_ISSUER: z.string().default('realcognix'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5), // per email+IP per window
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  LOGIN_LOCK_THRESHOLD: z.coerce.number().int().min(1).default(10), // consecutive failures before the account locks
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
  OIDC_ISSUER: optStr,
  OIDC_JWKS_URL: optStr,
  OIDC_AUDIENCE: optStr,

  DATABASE_URL: z.string().default('postgres://realcognix:realcognix@localhost:5432/realcognix'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Request paths give BullMQ this long, then write the job to job_outbox instead (Redis down or slow).
  ENQUEUE_TIMEOUT_MS: z.coerce.number().int().min(50).default(1500),
  // Worker: how often the outbox drainer moves unsent rows into BullMQ, and after how many failed tries it gives up on a row.
  OUTBOX_DRAIN_MS: z.coerce.number().int().min(1000).default(15_000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),

  // Public URL of the web app (invite links, microsite links). Set at deploy, e.g. https://app.realcognix.example
  PUBLIC_WEB_URL: z.string().default('http://localhost:8080'),
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).default(72),
  PARTNER_OWNERSHIP_DAYS: z.coerce.number().int().min(1).default(90),

  // Provider registry: per-org vendor settings live in provider_configs; their secrets are AES-256-GCM encrypted with
  // this key (32 bytes, hex or base64). Required in production to save secrets. Old key for rotation: *_PREVIOUS.
  CONFIG_MASTER_KEY: optStr,
  CONFIG_MASTER_KEY_PREVIOUS: optStr,
  PROVIDER_CACHE_SECONDS: z.coerce.number().int().min(0).default(30),

  // LLM env fallback (used when an org has nothing configured in Integrations & AI).
  // LLM_BACKEND=litellm talks to LLM_BASE_URL (the LiteLLM proxy) with alias LLM_MODEL; any other value calls that
  // provider's OpenAI-compatible endpoint directly with its *_API_KEY and default model (LLM_MODEL overrides it).
  LLM_BACKEND: z.enum(['litellm', 'groq', 'gemini', 'openrouter', 'ollama', 'mistral', 'together', 'cerebras', 'openai', 'anthropic', 'custom']).default('litellm'),
  LLM_DIRECT_BASE_URL: optStr, // for LLM_BACKEND=custom (or to override a provider's default endpoint)
  OLLAMA_BASE_URL: z.string().default('http://ollama:11434/v1'),
  GROQ_API_KEY: optStr,
  GEMINI_API_KEY: optStr,
  OPENROUTER_API_KEY: optStr,
  MISTRAL_API_KEY: optStr,
  TOGETHER_API_KEY: optStr,
  CEREBRAS_API_KEY: optStr,
  OPENAI_API_KEY: optStr,
  ANTHROPIC_API_KEY: optStr,

  // Automations (n8n REST API) for listing / toggling workflows from the Automations screen.
  N8N_API_URL: optStr, // e.g. http://n8n:5678
  N8N_API_KEY: optStr,

  // LLM — OpenAI-compatible endpoint (LiteLLM proxy by default; can point straight at Ollama/Groq/Gemini-compat)
  LLM_PROVIDER: z.enum(['openai_compatible', 'none']).default('openai_compatible'),
  LLM_BASE_URL: z.string().default('http://localhost:4001/v1'),
  LLM_API_KEY: z.string().default('sk-litellm-dev'),
  LLM_MODEL: z.string().default('default'), // LiteLLM alias: default (ollama) | groq | gemini
  LLM_EMBED_MODEL: z.string().default('embed'),
  LLM_SCORING_ENABLED: bool,

  // WhatsApp
  WHATSAPP_PROVIDER: z.enum(['whatsapp_cloud', 'console']).default('console'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().default('dev-verify-token'),
  WHATSAPP_GRAPH_VERSION: z.string().default('v21.0'),
  WHATSAPP_TEMPLATE_LANG: z.string().default('en'),

  // Email
  EMAIL_PROVIDER: z.enum(['smtp', 'console']).default('smtp'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('RealCognix <no-reply@realcognix.test>'),

  // Lead sources
  META_APP_SECRET: z.string().optional(),
  META_VERIFY_TOKEN: z.string().default('dev-verify-token'),
  META_PAGE_ACCESS_TOKEN: z.string().optional(),
  META_GRAPH_VERSION: z.string().default('v21.0'),

  // Ads
  ADS_META_ENABLED: bool,
  META_ADS_ACCESS_TOKEN: z.string().optional(),
  META_AD_ACCOUNT_ID: z.string().optional(), // without act_ prefix
  ADS_GOOGLE_ENABLED: bool,
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_CUSTOMER_ID: z.string().optional(),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().optional(),
  GOOGLE_ADS_OAUTH_ACCESS_TOKEN: z.string().optional(),

  // Storage
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  // S3-compatible (Cloudflare R2, MinIO, Supabase Storage, AWS S3)
  S3_ENDPOINT: optStr, // https://<account>.r2.cloudflarestorage.com | http://minio:9000 | https://<ref>.supabase.co/storage/v1/s3
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: optStr,
  S3_ACCESS_KEY_ID: optStr,
  S3_SECRET_ACCESS_KEY: optStr,
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false', '1', '0']).default('true').transform((v) => v === 'true' || v === '1'),
  S3_PUBLIC_BASE_URL: optStr,

  // Sales engine rules
  SLA_MINUTES: z.coerce.number().default(5),
  SLA_MAX_REASSIGNS: z.coerce.number().default(2),
  QUIET_HOURS_START: z.coerce.number().min(0).max(23).default(21), // IST
  QUIET_HOURS_END: z.coerce.number().min(0).max(23).default(9), // IST
  CADENCE_DAYS: z.string().default('0,1,3,7,14,30'),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

/**
 * Fastify's trustProxy from TRUST_PROXY. 'false'/'' (default) = never trust X-Forwarded-For, so clients cannot spoof
 * req.ip (which keys the login rate limit). 'true' = trust any peer. Otherwise a comma-separated list of proxy
 * addresses/CIDRs or proxy-addr names, e.g. '127.0.0.1' or 'loopback,uniquelocal' (Docker/private networks).
 * Hop counts are refused: Fastify 5 ignores them (it fails closed), which would silently break per-IP limits.
 */
export function parseTrustProxy(v: string | undefined): boolean | string[] {
  const t = (v ?? '').trim().toLowerCase();
  if (t === '' || t === 'false' || t === '0') return false;
  if (t === 'true') return true;
  if (/^\d+$/.test(t)) throw new Error(`TRUST_PROXY=${t}: hop counts are not supported; list your proxy addresses (e.g. loopback,uniquelocal) or use true`);
  return t.split(',').map((x) => x.trim()).filter(Boolean);
}
