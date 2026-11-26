import type { z } from 'zod';
import { AdapterError } from '../errors.js';
import type { ChatMessage, ChatOptions, ChatResult, LLMProvider } from './types.js';

/**
 * Tries each provider in order; the first that answers wins. Used for per-agent model routing
 * (e.g. Groq first, Gemini if Groq is rate-limited or down, local Ollama last).
 * The caller's opts.model is dropped: each link in the chain carries its own model.
 */
export class FallbackLLM implements LLMProvider {
  readonly name: string;
  constructor(private readonly chain: LLMProvider[], private readonly onFallback?: (from: string, err: Error) => void) {
    if (!chain.length) throw new Error('FallbackLLM needs at least one provider');
    this.name = chain.map((c) => c.name).join('>');
  }

  get providers(): readonly LLMProvider[] {
    return this.chain;
  }

  private async attempt<T>(fn: (p: LLMProvider) => Promise<T>): Promise<T> {
    const errors: string[] = [];
    for (const p of this.chain) {
      try {
        return await fn(p);
      } catch (err) {
        errors.push((err as Error).message);
        this.onFallback?.(p.name, err as Error);
      }
    }
    throw new AdapterError(this.name, `all ${this.chain.length} model(s) failed: ${errors.join(' | ')}`);
  }

  chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const { model: _m, ...rest } = opts;
    return this.attempt((p) => p.chat(messages, rest));
  }

  json<S extends z.ZodType>(messages: ChatMessage[], schema: S, opts: ChatOptions = {}) {
    const { model: _m, ...rest } = opts;
    return this.attempt((p) => p.json(messages, schema, rest));
  }

  embed(texts: string[], opts: { model?: string } = {}): Promise<number[][]> {
    return this.attempt((p) => p.embed(texts, opts));
  }

  async health() {
    const first = this.chain[0]!;
    return first.health ? first.health() : { ok: true, latencyMs: 0 };
  }
}
