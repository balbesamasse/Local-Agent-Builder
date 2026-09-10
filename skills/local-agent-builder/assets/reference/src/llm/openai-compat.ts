/**
 * Abstraction fournisseur de LLM.
 *
 * Groq et OpenRouter exposent tous deux une API compatible « OpenAI Chat
 * Completions » : un seul client suffit, on ne change que baseUrl/model/headers.
 * Ajouter Claude, Ollama ou un modèle local = une nouvelle classe qui implémente
 * `LlmProvider`, sans toucher à la boucle d'agent.
 */
import type { ChatMessage, ToolDefinition } from '../core/types.js';

export interface LlmToolCall {
  id: string;
  name: string;
  args: string;
}

export interface LlmRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
  /** true si le modèle a demandé des outils (⇒ pas de réponse finale). */
  wantsTools: boolean;
  model: string;
  provider: string;
  usage?: { prompt: number; completion: number };
}

/** Erreur « récupérable par un autre fournisseur » (quota, surcharge, réseau). */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
  /**
   * Optionnel : `stream:true` + callback par morceaux. Un appel vocal l'exige pour commencer
   * à parler avant la fin de la phrase ; un texte écrit s'en passe. Une réponse avec tool_calls
   * est reconstruite intégralement à la fin (le flux ne change rien à la décision d'outils).
   */
  stream?(request: LlmRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<LlmResponse>;
}

export interface ChatCompletionOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  extraHeaders?: Record<string, string>;
}

interface WireMessage {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireChoice {
  message?: { content?: string | null; tool_calls?: WireToolCall[] };
  finish_reason?: string;
}

interface WireResponse {
  choices?: WireChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/**
 * Client HTTP unique pour API compatibles OpenAI : fetch + AbortSignal (timeout),
 * retries avec backoff exponentiel uniquement sur les erreurs transitoires,
 * jamais de log du corps de la requête (contenu privé).
 */
export class OpenAiCompatProvider implements LlmProvider {
  constructor(
    readonly name: string,
    private readonly opts: ChatCompletionOptions,
  ) {}

  get model(): string {
    return this.opts.model;
  }

  async complete(request: LlmRequest, outerSignal?: AbortSignal): Promise<LlmResponse> {
    const body = JSON.stringify({
      model: this.opts.model,
      messages: toWire(request.messages),
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? 1500,
      stream: false,
    });

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt += 1) {
      const signal = combineSignals(this.opts.timeoutMs, outerSignal);
      try {
        const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.apiKey}`,
            ...this.opts.extraHeaders,
          },
          body,
          signal: signal.signal,
        }).finally(() => signal.cleanup());

        if (res.status === 429 || res.status >= 500) {
          lastError = new LlmError(`${this.name} : HTTP ${res.status}`, true, res.status);
          // Backoff avant de réessayer / de passer au fournisseur suivant.
          await sleep(Math.min(8000, 500 * 2 ** attempt), signal.signal);
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          throw new LlmError(`${this.name} : clé API refusée (HTTP ${res.status})`, false, res.status);
        }
        if (!res.ok) {
          const text = await safeText(res);
          throw new LlmError(`${this.name} : HTTP ${res.status} ${text.slice(0, 200)}`, false, res.status);
        }

        const json = (await res.json()) as WireResponse;
        if (json.error?.message) {
          const retryable = /rate|quota|overload|timeout|unavailable/i.test(json.error.message);
          throw new LlmError(`${this.name} : ${json.error.message.slice(0, 200)}`, retryable);
        }
        return parseWire(json, this.opts.model, this.name);
      } catch (error) {
        if (error instanceof LlmError) {
          if (!error.retryable) throw error;
          lastError = error;
          continue;
        }
        const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
        if (!aborted) throw error;
        lastError = new LlmError(`${this.name} : délai dépassé (${this.opts.timeoutMs} ms)`, true);
      }
    }
    throw lastError instanceof LlmError
      ? lastError
      : new LlmError(`${this.name} : indisponible après ${this.opts.maxRetries + 1} tentative(s)`, true);
  }
  /**
   * Même contrat que `complete`, en flux : chaque fragment de texte est rendu à `onDelta`
   * dès qu'il arrive. C'est ce qui permet de parler pendant que le modèle écrit — en appel
   * vocal, attendre la fin de la réponse avant la première syllène ajoute une seconde et
   * demie de vide à chaque tour, ce que l'utilisateur entend comme une hésitation.
   */
  async stream(request: LlmRequest, onDelta: (text: string) => void, outerSignal?: AbortSignal): Promise<LlmResponse> {
    const body = JSON.stringify({
      model: this.opts.model,
      messages: toWire(request.messages),
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? 1500,
      stream: true,
    });

    let response: Response;
    const signal = combineSignals(this.opts.timeoutMs, outerSignal);
    try {
      response = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${this.opts.apiKey}`,
          ...this.opts.extraHeaders,
        },
        body,
        signal: signal.signal,
      });
    } catch (error) {
      signal.cleanup();
      const aborted = outerSignal?.aborted === true;
      throw new LlmError(
        aborted ? `${this.name} : appel annulé` : `${this.name} : flux indisponible (${error instanceof Error ? error.name : 'erreur réseau'})`,
        !aborted,
      );
    }

    if (!response.ok) {
      const status = response.status;
      const detail = await safeText(response);
      signal.cleanup();
      const retryable = status === 429 || status >= 500;
      throw new LlmError(`${this.name} : HTTP ${status} ${detail.slice(0, 160)}`, retryable, status);
    }
    if (response.body === null || typeof response.body.getReader !== 'function') {
      signal.cleanup();
      // Un relais qui ne sait pas streamer n'est pas une panne : on retombe sur `complete`.
      throw new LlmError(`${this.name} : flux refusé par le relais`, true);
    }

    const text: string[] = [];
    const calls = new ToolCallAccumulator();
    let usage: { prompt: number; completion: number } | undefined;
    let buffer = '';
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += Buffer.from(value as Uint8Array).toString('utf8');
        const { lines, rest } = drainSse(buffer);
        buffer = rest;
        for (const line of lines) {
          if (line === '[DONE]') continue;
          let payload: unknown;
          try {
            payload = JSON.parse(line);
          } catch {
            continue; // un fragment illisible ne doit pas couper la phrase en cours
          }
          const delta = parseStreamDelta(payload);
          if (delta === null) continue;
          if (delta.text !== '') {
            text.push(delta.text);
            onDelta(delta.text);
          }
          if (delta.calls.length > 0) calls.add(delta.calls);
          if (delta.usage !== undefined) usage = delta.usage;
        }
      }
    } finally {
      signal.cleanup();
      reader.releaseLock();
    }

    const toolCalls = calls.list();
    const full = text.join('').trim();
    if (toolCalls.length === 0 && full === '') {
      throw new LlmError(`${this.name} : flux sans contenu`, true);
    }
    return {
      text: full,
      toolCalls,
      wantsTools: toolCalls.length > 0,
      model: this.opts.model,
      provider: this.name,
      ...(usage ? { usage } : {}),
    };
  }
}



/** Morceau d'un flux SSE compatible OpenAI (les tool_calls arrivent fragmentés). */
export interface StreamDelta {
  text: string;
  calls: Array<{ id: string; index: number; name: string; args: string }>;
  usage?: { prompt: number; completion: number };
  finishReason: string | null;
}

/** Une ligne SSE d'un flux compatible OpenAI → delta exploitable (null = à ignorer). */
export function parseStreamDelta(payload: unknown): StreamDelta | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const choice = (payload as { choices?: Array<Record<string, unknown>> }).choices?.[0];
  if (choice === undefined) return null;
  const delta = (choice['delta'] ?? {}) as {
    content?: unknown;
    tool_calls?: Array<{ id?: unknown; index?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
  };
  const calls: StreamDelta['calls'] = [];
  for (const call of delta.tool_calls ?? []) {
    const fn = call.function ?? {};
    calls.push({
      id: typeof call.id === 'string' ? call.id : '',
      index: typeof call.index === 'number' ? call.index : 0,
      name: typeof fn.name === 'string' ? fn.name : '',
      args: typeof fn.arguments === 'string' ? fn.arguments : '',
    });
  }
  const usage = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  return {
    text: typeof delta.content === 'string' ? delta.content : '',
    calls,
    ...(usage && (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number')
      ? { usage: { prompt: Number(usage.prompt_tokens ?? 0), completion: Number(usage.completion_tokens ?? 0) } }
      : {}),
    finishReason: typeof choice['finish_reason'] === 'string' ? (choice['finish_reason'] as string) : null,
  };
}

/**
 * Accumulation des tool_calls fragmentés d'un flux. L'INDEX décide du regroupement, pas
 * l'ordre d'arrivée : Groq peut envoyer `arguments` du call 0 après le début du call 1, et
 * un appel d'outil mal recollé est un appel raté (ou pire, exécuté avec les mauvais arguments).
 */
export class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; args: string }>();

  add(calls: StreamDelta['calls']): void {
    for (const call of calls) {
      const current = this.byIndex.get(call.index) ?? { id: '', name: '', args: '' };
      this.byIndex.set(call.index, {
        id: call.id === '' ? current.id : call.id,
        name: current.name + call.name,
        args: current.args + call.args,
      });
    }
  }

  /** Identifiants fabriqués si le fournisseur n'en envoie pas en flux : ils doivent juste être uniques. */
  list(): LlmToolCall[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({ id: call.id === '' ? `call_${index}` : call.id, name: call.name, args: call.args }));
  }

  get size(): number {
    return this.byIndex.size;
  }
}

/** Découpe un buffer SSE en lignes `data: …` (le separateur exact varie selon les relais). */
export function drainSse(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  const lines: string[] = [];
  for (const block of parts) {
    for (const line of block.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) lines.push(trimmed.slice(5).trim());
    }
  }
  return { lines, rest };
}

function parseWire(json: WireResponse, model: string, provider: string): LlmResponse {
  const choice = json.choices?.[0];
  const rawCalls = choice?.message?.tool_calls ?? [];
  const toolCalls: LlmToolCall[] = [];
  for (const call of rawCalls) {
    if (!call || typeof call !== 'object') continue;
    const fn = call.function;
    if (typeof call.id !== 'string' || typeof fn?.name !== 'string') continue;
    toolCalls.push({
      id: call.id,
      name: fn.name,
      args: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }
  return {
    text: (choice?.message?.content ?? '').trim(),
    toolCalls,
    wantsTools: toolCalls.length > 0,
    model,
    provider,
    usage: json.usage
      ? { prompt: json.usage.prompt_tokens ?? 0, completion: json.usage.completion_tokens ?? 0 }
      : undefined,
  };
}

function toWire(messages: ChatMessage[]): WireMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content ?? (m.tool_calls ? null : ''),
    ...(m.name ? { name: m.name } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.tool_calls
      ? {
          tool_calls: m.tool_calls.map<WireToolCall>((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.args },
          })),
        }
      : {}),
  }));
}

function combineSignals(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onOuter = () => controller.abort(new Error('aborted'));
  outer?.addEventListener('abort', onOuter, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
