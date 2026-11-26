import OpenAI, { AzureOpenAI } from 'openai';
import type { z } from 'zod';
import { AdapterError } from '../errors.js';
import type { ChatMessage, ChatOptions, ChatResult, LLMProvider } from './types.js';

export interface OpenAICompatibleConfig {
  baseURL: string; // http://litellm:4000/v1 | http://ollama:11434/v1 | https://api.groq.com/openai/v1
  apiKey: string;
  model: string; // alias configured in LiteLLM (default | groq | gemini) or a raw model id
  embedModel: string;
  timeoutMs?: number;
  /** Send response_format=json_object (default true). Off for endpoints that reject it (e.g. Anthropic's). */
  jsonMode?: boolean;
  /** Ask the embeddings endpoint for this many dimensions (OpenAI text-embedding-3-*). pgvector column is 768. */
  embedDimensions?: number;
  /** Azure OpenAI: baseURL is the resource endpoint, model is the deployment name. */
  azure?: { apiVersion: string };
  /** Label for errors and run logs, e.g. 'groq'. */
  label?: string;
  headers?: Record<string, string>;
  maxRetries?: number;
}

export class OpenAICompatibleLLM implements LLMProvider {
  readonly name: string;
  private readonly client: OpenAI;

  constructor(private readonly cfg: OpenAICompatibleConfig) {
    this.name = cfg.label ?? 'openai_compatible';
    const common = { apiKey: cfg.apiKey || 'none', timeout: cfg.timeoutMs ?? 60_000, maxRetries: cfg.maxRetries ?? 2, defaultHeaders: cfg.headers };
    this.client = cfg.azure
      ? new AzureOpenAI({ ...common, endpoint: cfg.baseURL, apiVersion: cfg.azure.apiVersion, deployment: cfg.model })
      : new OpenAI({ ...common, baseURL: cfg.baseURL });
  }

  get model() {
    return this.cfg.model;
  }

  /** One tiny real completion: proves the URL, key and model all work. */
  async health(): Promise<{ ok: boolean; model?: string; latencyMs: number; error?: string }> {
    const t = Date.now();
    try {
      const r = await this.complete([{ role: 'user', content: 'Reply with the single word OK.' }], { temperature: 0, maxTokens: 5 }, false);
      return { ok: true, model: r.model, latencyMs: Date.now() - t };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t, error: (e as Error).message };
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    return this.complete(messages, opts, false);
  }

  async json<S extends z.ZodType>(messages: ChatMessage[], schema: S, opts: ChatOptions = {}) {
    const first = await this.complete(messages, { temperature: 0, ...opts }, true);
    const parsed = tryParse(schema, first.text);
    if (parsed.ok) return { data: parsed.data as z.infer<S>, result: first };

    // One repair attempt: show the model its own output and the validation error.
    const repair = await this.complete(
      [
        ...messages,
        { role: 'assistant', content: first.text },
        { role: 'user', content: `That was not valid JSON for the required schema (${parsed.error}). Reply with corrected JSON only.` },
      ],
      { temperature: 0, ...opts },
      true,
    );
    const second = tryParse(schema, repair.text);
    if (!second.ok) throw new AdapterError(this.name, `LLM returned invalid JSON: ${second.error}`);
    return { data: second.data as z.infer<S>, result: repair };
  }

  async embed(texts: string[], opts: { model?: string } = {}): Promise<number[][]> {
    try {
      const res = await this.client.embeddings.create({
        model: opts.model ?? this.cfg.embedModel, input: texts, encoding_format: 'float', // many compatible servers ignore base64
        ...(this.cfg.embedDimensions ? { dimensions: this.cfg.embedDimensions } : {}),
      });
      return res.data.map((d) => d.embedding);
    } catch (err) {
      throw new AdapterError(this.name, `embeddings failed for model "${opts.model ?? this.cfg.embedModel}": ${(err as Error).message}`, (err as { status?: number }).status);
    }
  }

  private async complete(messages: ChatMessage[], opts: ChatOptions, asJson: boolean): Promise<ChatResult> {
    const model = opts.model ?? this.cfg.model;
    try {
      const res = await this.client.chat.completions.create({
        model,
        messages,
        temperature: opts.temperature ?? 0.3,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(asJson && this.cfg.jsonMode !== false ? { response_format: { type: 'json_object' as const } } : {}),
      });
      return {
        text: res.choices[0]?.message?.content ?? '',
        model: res.model ?? model,
        tokensIn: res.usage?.prompt_tokens,
        tokensOut: res.usage?.completion_tokens,
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new AdapterError(this.name, `chat completion failed for model "${model}": ${(err as Error).message}`, status);
    }
  }
}

function tryParse(schema: z.ZodType, text: string): { ok: true; data: unknown } | { ok: false; error: string } {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  let value: unknown;
  try {
    value = JSON.parse(cleaned);
  } catch (e) {
    return { ok: false, error: `JSON.parse: ${(e as Error).message}` };
  }
  const r = schema.safeParse(value);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error.message.slice(0, 500) };
}
