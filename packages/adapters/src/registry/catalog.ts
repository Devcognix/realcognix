/**
 * Every provider the admin panel ("Integrations & AI") can choose, per capability, with the fields each one needs.
 * The web app renders its forms from this list (GET /v1/admin/integrations/catalog), so adding a provider here and a
 * builder in build.ts is all it takes to offer a new vendor. Fields with secret: true are encrypted at rest and never
 * sent back to the browser.
 */
export type Capability = 'llm' | 'embeddings' | 'messaging' | 'email' | 'storage' | 'ads' | 'lead_sources' | 'automations';
export const CAPABILITIES: Capability[] = ['llm', 'embeddings', 'messaging', 'email', 'storage', 'ads', 'lead_sources', 'automations'];

export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'url' | 'number' | 'boolean' | 'select' | 'secret';
  secret?: boolean;
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface ProviderSpec {
  id: string;
  capability: Capability;
  label: string;
  /** Free tier / free and open source: shown as a badge. */
  free?: boolean;
  description: string;
  fields: FieldSpec[];
  /** Capabilities where several providers can be on at once (llm connections, ads, lead sources). */
  multi?: boolean;
  docsUrl?: string;
  /** LLM only: OpenAI-compatible endpoint defaults. */
  llm?: { baseUrl?: string; defaultModel?: string; models?: string[]; embedModel?: string; jsonMode?: boolean; embeddings?: boolean; keyEnv?: string };
  /** Defaults a preset fills in (email presets). */
  presets?: Record<string, Record<string, string | number | boolean>>;
}

const apiKey = (help?: string, required = true): FieldSpec => ({ key: 'apiKey', label: 'API key', type: 'secret', secret: true, required, help });
const model = (def: string, help?: string): FieldSpec => ({ key: 'model', label: 'Default model', type: 'text', default: def, help });
const baseUrl = (def: string, required = false): FieldSpec => ({ key: 'baseUrl', label: 'Endpoint (OpenAI-compatible)', type: 'url', default: def, required });

const LLM: ProviderSpec[] = [
  { id: 'groq', capability: 'llm', label: 'Groq', free: true, multi: true, docsUrl: 'https://console.groq.com/keys',
    description: 'Very fast Llama / Qwen models. Free tier with rate limits. Default for fast agents.',
    llm: { baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen/qwen3-32b', 'openai/gpt-oss-20b'], keyEnv: 'GROQ_API_KEY' },
    fields: [apiKey('gsk_...'), model('llama-3.3-70b-versatile'), baseUrl('https://api.groq.com/openai/v1')] },
  { id: 'gemini', capability: 'llm', label: 'Google Gemini', free: true, multi: true, docsUrl: 'https://aistudio.google.com/apikey',
    description: 'Gemini through Google\'s OpenAI-compatible endpoint. Free tier. Default for smart agents (reports, creatives).',
    llm: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', defaultModel: 'gemini-2.0-flash', models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'], embedModel: 'text-embedding-004', embeddings: true, keyEnv: 'GEMINI_API_KEY' },
    fields: [apiKey('From Google AI Studio'), model('gemini-2.0-flash'), baseUrl('https://generativelanguage.googleapis.com/v1beta/openai/')] },
  { id: 'openrouter', capability: 'llm', label: 'OpenRouter', free: true, multi: true, docsUrl: 'https://openrouter.ai/keys',
    description: 'One key for hundreds of models, including free ones (model ids ending in :free).',
    llm: { baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'meta-llama/llama-3.3-70b-instruct:free', models: ['meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-chat-v3-0324:free', 'google/gemini-2.0-flash-exp:free', 'qwen/qwen-2.5-72b-instruct:free'], keyEnv: 'OPENROUTER_API_KEY' },
    fields: [apiKey('sk-or-...'), model('meta-llama/llama-3.3-70b-instruct:free'), baseUrl('https://openrouter.ai/api/v1')] },
  { id: 'ollama', capability: 'llm', label: 'Ollama (local)', free: true, multi: true, docsUrl: 'https://ollama.com/library',
    description: 'Runs on your own server. Private and free; needs RAM/GPU. The Docker stack includes it.',
    llm: { baseUrl: 'http://ollama:11434/v1', defaultModel: 'qwen2.5:7b', models: ['qwen2.5:7b', 'llama3.1:8b', 'gemma2:9b'], embedModel: 'nomic-embed-text', embeddings: true },
    fields: [baseUrl('http://ollama:11434/v1', true), model('qwen2.5:7b')] },
  { id: 'mistral', capability: 'llm', label: 'Mistral', free: true, multi: true, docsUrl: 'https://console.mistral.ai/api-keys',
    description: 'Mistral La Plateforme (free experiment tier).',
    llm: { baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', models: ['mistral-small-latest', 'mistral-large-latest', 'open-mistral-nemo'], embedModel: 'mistral-embed', embeddings: true, keyEnv: 'MISTRAL_API_KEY' },
    fields: [apiKey(), model('mistral-small-latest'), baseUrl('https://api.mistral.ai/v1')] },
  { id: 'together', capability: 'llm', label: 'Together AI', multi: true, docsUrl: 'https://api.together.ai/settings/api-keys',
    description: 'Open models as a service; some free endpoints.',
    llm: { baseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'], embeddings: true, embedModel: 'togethercomputer/m2-bert-80M-8k-retrieval', keyEnv: 'TOGETHER_API_KEY' },
    fields: [apiKey(), model('meta-llama/Llama-3.3-70B-Instruct-Turbo-Free'), baseUrl('https://api.together.xyz/v1')] },
  { id: 'cerebras', capability: 'llm', label: 'Cerebras', free: true, multi: true, docsUrl: 'https://cloud.cerebras.ai',
    description: 'Very fast inference with a free tier.',
    llm: { baseUrl: 'https://api.cerebras.ai/v1', defaultModel: 'llama-3.3-70b', models: ['llama-3.3-70b', 'llama3.1-8b', 'qwen-3-32b'], keyEnv: 'CEREBRAS_API_KEY' },
    fields: [apiKey(), model('llama-3.3-70b'), baseUrl('https://api.cerebras.ai/v1')] },
  { id: 'openai', capability: 'llm', label: 'OpenAI', multi: true, docsUrl: 'https://platform.openai.com/api-keys',
    description: 'Paid. GPT-4o mini is a cheap, strong default.',
    llm: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'], embedModel: 'text-embedding-3-small', embeddings: true, keyEnv: 'OPENAI_API_KEY' },
    fields: [apiKey('sk-...'), model('gpt-4o-mini'), baseUrl('https://api.openai.com/v1')] },
  { id: 'anthropic', capability: 'llm', label: 'Anthropic (Claude)', multi: true, docsUrl: 'https://console.anthropic.com/settings/keys',
    description: 'Paid. Native OpenAI-compatible endpoint; or route Claude through LiteLLM (alias "claude").',
    llm: { baseUrl: 'https://api.anthropic.com/v1/', defaultModel: 'claude-3-5-haiku-latest', models: ['claude-3-5-haiku-latest', 'claude-sonnet-4-0'], jsonMode: false, keyEnv: 'ANTHROPIC_API_KEY' },
    fields: [apiKey('sk-ant-...'), model('claude-3-5-haiku-latest'), baseUrl('https://api.anthropic.com/v1/')] },
  { id: 'azure_openai', capability: 'llm', label: 'Azure OpenAI', multi: true,
    description: 'Your Azure OpenAI resource. Model = deployment name.',
    llm: { embeddings: true },
    fields: [
      { key: 'baseUrl', label: 'Resource endpoint', type: 'url', required: true, placeholder: 'https://my-resource.openai.azure.com' },
      apiKey(), { key: 'model', label: 'Deployment name', type: 'text', required: true },
      { key: 'apiVersion', label: 'API version', type: 'text', default: '2024-10-21' },
    ] },
  { id: 'litellm', capability: 'llm', label: 'LiteLLM proxy', free: true, multi: true, docsUrl: 'https://docs.litellm.ai',
    description: 'The bundled gateway (infra/litellm/config.yaml). Aliases: default (Ollama), fast (Groq), smart (Gemini), gpt, claude.',
    llm: { baseUrl: 'http://litellm:4001/v1', defaultModel: 'default', models: ['default', 'fast', 'smart', 'gpt', 'claude'], embedModel: 'embed', embeddings: true },
    fields: [baseUrl('http://litellm:4001/v1', true), { key: 'apiKey', label: 'Master key', type: 'secret', secret: true, help: 'LLM_API_KEY of the proxy' }, model('default')] },
  { id: 'custom', capability: 'llm', label: 'Custom OpenAI-compatible URL', multi: true,
    description: 'Any server that speaks the OpenAI chat completions API (vLLM, LM Studio, DeepInfra, Fireworks ...).',
    llm: { embeddings: true },
    fields: [baseUrl('', true), { key: 'apiKey', label: 'API key', type: 'secret', secret: true }, { key: 'model', label: 'Default model', type: 'text', required: true },
      { key: 'jsonMode', label: 'Supports JSON mode (response_format)', type: 'boolean', default: true }] },
];

const EMBED: ProviderSpec[] = LLM.filter((p) => p.llm?.embeddings).map((p) => ({
  ...p, capability: 'embeddings' as const, multi: false,
  description: p.id === 'ollama' ? 'nomic-embed-text (768 dimensions) on your own server. Free.' : p.id === 'gemini' ? 'text-embedding-004 (768 dimensions). Free tier.' : p.description,
  fields: [
    ...p.fields.filter((f) => f.key !== 'model' && f.key !== 'jsonMode'),
    { key: 'embedModel', label: 'Embedding model', type: 'text' as const, default: p.llm?.embedModel ?? '', required: !p.llm?.embedModel },
    { key: 'dimensions', label: 'Dimensions', type: 'number' as const, default: 768, help: 'Knowledge search stores 768-dimension vectors. Sent to providers that support it (OpenAI).' },
  ],
}));

const MESSAGING: ProviderSpec[] = [
  { id: 'whatsapp_cloud', capability: 'messaging', label: 'WhatsApp Cloud API (Meta)', free: true, docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
    description: 'Official WhatsApp Business Platform. The API is free; Meta charges per template conversation (service replies are free).',
    fields: [
      { key: 'phoneNumberId', label: 'Phone number ID', type: 'text', required: true },
      { key: 'businessAccountId', label: 'WhatsApp Business Account ID', type: 'text' },
      { key: 'accessToken', label: 'Permanent access token', type: 'secret', secret: true, required: true },
      { key: 'appSecret', label: 'App secret (webhook signatures)', type: 'secret', secret: true },
      { key: 'verifyToken', label: 'Webhook verify token', type: 'secret', secret: true },
      { key: 'graphVersion', label: 'Graph API version', type: 'text', default: 'v21.0' },
      { key: 'templateLanguage', label: 'Template language', type: 'text', default: 'en' },
    ] },
  { id: 'console', capability: 'messaging', label: 'Console (log only)', free: true, description: 'Messages are logged, never sent. For setup and testing.', fields: [] },
];

const EMAIL: ProviderSpec[] = [
  { id: 'smtp', capability: 'email', label: 'SMTP', free: true,
    description: 'Any SMTP server. Presets for Brevo (300/day free), Gmail / Google Workspace (app password), Zoho Mail.',
    presets: {
      brevo: { host: 'smtp-relay.brevo.com', port: 587, secure: false },
      gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
      zoho: { host: 'smtp.zoho.in', port: 465, secure: true },
      custom: {},
    },
    fields: [
      { key: 'preset', label: 'Preset', type: 'select', default: 'brevo', options: [{ value: 'brevo', label: 'Brevo (free 300/day)' }, { value: 'gmail', label: 'Gmail / Google Workspace' }, { value: 'zoho', label: 'Zoho Mail (India)' }, { value: 'custom', label: 'Custom' }] },
      { key: 'host', label: 'Host', type: 'text', required: true, default: 'smtp-relay.brevo.com' },
      { key: 'port', label: 'Port', type: 'number', required: true, default: 587 },
      { key: 'secure', label: 'TLS on connect (port 465)', type: 'boolean', default: false },
      { key: 'user', label: 'Username', type: 'text' },
      { key: 'pass', label: 'Password / SMTP key', type: 'secret', secret: true },
      { key: 'from', label: 'From', type: 'text', required: true, placeholder: 'RealCognix <hello@yourdomain.in>' },
    ] },
  { id: 'mailpit', capability: 'email', label: 'Mailpit (dev inbox)', free: true, description: 'Catches every email at http://localhost:8025. Development only.',
    fields: [{ key: 'host', label: 'Host', type: 'text', default: 'mailpit' }, { key: 'port', label: 'Port', type: 'number', default: 1025 }, { key: 'from', label: 'From', type: 'text', default: 'RealCognix <no-reply@realcognix.test>' }] },
  { id: 'console', capability: 'email', label: 'Console (log only)', free: true, description: 'Emails are logged, never sent.', fields: [] },
];

const STORAGE: ProviderSpec[] = [
  { id: 'local', capability: 'storage', label: 'Local disk', free: true, description: 'Files on the API server volume. Fine for one server; back it up.',
    fields: [{ key: 'dir', label: 'Directory', type: 'text', default: '/app/storage' }] },
  { id: 's3', capability: 'storage', label: 'S3-compatible', free: true,
    description: 'Cloudflare R2 (10 GB free, no egress fees), MinIO (self-hosted), Supabase Storage, or AWS S3.',
    presets: {
      r2: { region: 'auto', forcePathStyle: true },
      minio: { endpoint: 'http://minio:9000', region: 'us-east-1', forcePathStyle: true },
      supabase: { region: 'ap-south-1', forcePathStyle: true },
      aws: { region: 'ap-south-1', forcePathStyle: false },
    },
    fields: [
      { key: 'preset', label: 'Preset', type: 'select', default: 'r2', options: [{ value: 'r2', label: 'Cloudflare R2' }, { value: 'minio', label: 'MinIO' }, { value: 'supabase', label: 'Supabase Storage' }, { value: 'aws', label: 'AWS S3' }] },
      { key: 'endpoint', label: 'Endpoint', type: 'url', required: true, placeholder: 'https://<account-id>.r2.cloudflarestorage.com' },
      { key: 'region', label: 'Region', type: 'text', default: 'auto' },
      { key: 'bucket', label: 'Bucket', type: 'text', required: true },
      { key: 'forcePathStyle', label: 'Path-style URLs', type: 'boolean', default: true },
      { key: 'publicBaseUrl', label: 'Public base URL (optional)', type: 'url' },
      { key: 'accessKeyId', label: 'Access key ID', type: 'secret', secret: true, required: true },
      { key: 'secretAccessKey', label: 'Secret access key', type: 'secret', secret: true, required: true },
    ] },
];

const ADS: ProviderSpec[] = [
  { id: 'meta', capability: 'ads', label: 'Meta Ads (Facebook / Instagram)', multi: true, description: 'Reads spend and results; budget changes still need approval. Off until you enable it.',
    fields: [{ key: 'adAccountId', label: 'Ad account ID (without act_)', type: 'text', required: true }, { key: 'accessToken', label: 'System user access token', type: 'secret', secret: true, required: true }, { key: 'graphVersion', label: 'Graph API version', type: 'text', default: 'v21.0' }] },
  { id: 'google', capability: 'ads', label: 'Google Ads', multi: true, description: 'Reads spend and conversions. Needs an approved developer token. Off until you enable it.',
    fields: [{ key: 'customerId', label: 'Customer ID', type: 'text', required: true }, { key: 'loginCustomerId', label: 'Manager (MCC) ID', type: 'text' },
      { key: 'developerToken', label: 'Developer token', type: 'secret', secret: true, required: true }, { key: 'oauthAccessToken', label: 'OAuth access token', type: 'secret', secret: true, required: true }] },
];

const LEAD_SOURCES: ProviderSpec[] = [
  { id: 'website_form', capability: 'lead_sources', label: 'Website & microsite forms', free: true, multi: true, description: 'Forms post to /webhooks/forms/<intake key>. Each microsite gets its own key.', fields: [] },
  { id: 'meta_lead_ads', capability: 'lead_sources', label: 'Meta Lead Ads', free: true, multi: true, description: 'Instant forms on Facebook / Instagram, delivered by webhook in seconds.',
    fields: [{ key: 'pageId', label: 'Facebook page ID', type: 'text', required: true }, { key: 'pageAccessToken', label: 'Page access token', type: 'secret', secret: true, required: true },
      { key: 'appSecret', label: 'App secret', type: 'secret', secret: true }, { key: 'verifyToken', label: 'Webhook verify token', type: 'secret', secret: true }] },
  { id: 'portal_email', capability: 'lead_sources', label: 'Portal emails (99acres, MagicBricks, Housing)', free: true, multi: true,
    description: 'n8n reads the enquiry mailbox (IMAP) and posts each email to /webhooks/portal-email.', fields: [{ key: 'mailbox', label: 'Mailbox read by n8n', type: 'text', placeholder: 'leads@yourdomain.in' }] },
  { id: 'generic_webhook', capability: 'lead_sources', label: 'Generic webhook', free: true, multi: true,
    description: 'Any tool can POST leads to /webhooks/org/<your org slug>/intake with header x-intake-secret.',
    fields: [{ key: 'webhookSecret', label: 'Shared secret', type: 'secret', secret: true, required: true }] },
];

const AUTOMATIONS: ProviderSpec[] = [
  { id: 'n8n', capability: 'automations', label: 'n8n', free: true, docsUrl: 'https://docs.n8n.io/api/', description: 'Lists and switches your n8n workflows from the Automations screen.',
    fields: [{ key: 'baseUrl', label: 'n8n URL', type: 'url', required: true, default: 'http://n8n:5678' }, { key: 'apiKey', label: 'n8n API key', type: 'secret', secret: true, required: true }] },
  { id: 'none', capability: 'automations', label: 'Built-in only', free: true, description: 'Cadences and reports run in the RealCognix worker; no external automation tool.', fields: [] },
];

export const PROVIDER_CATALOG: ProviderSpec[] = [...LLM, ...EMBED, ...MESSAGING, ...EMAIL, ...STORAGE, ...ADS, ...LEAD_SOURCES, ...AUTOMATIONS];

export function providerSpec(capability: Capability, id: string): ProviderSpec | undefined {
  return PROVIDER_CATALOG.find((p) => p.capability === capability && p.id === id);
}

/** Agents whose model can be chosen separately, in the order the admin screen shows them. */
export const AGENT_ROUTES = ['default', 'lead_qualifier', 'follow_up', 'reporting', 'creative', 'scoring'] as const;
export type AgentRoute = (typeof AGENT_ROUTES)[number];
