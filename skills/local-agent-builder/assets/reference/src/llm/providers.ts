/**
 * Composition des fournisseurs : Groq (principal) → Groq modèle de secours →
 * OpenRouter (si une clé est fournie).
 *
 * Politique de bascule : on ne bascule QUE sur erreur transitoire (quota 429,
 * surcharge 5xx, timeout). Une erreur de requête (400 : mauvais modèle, JSON
 * invalide) remonte immédiatement — masquer ce genre d'erreur rendrait le debug
 * impossible et pourrait cacher une régression.
 */
import type { AppConfig } from '../config.js';
import { log } from '../core/logger.js';
import {
  LlmError,
  OpenAiCompatProvider,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from './openai-compat.js';

// Base URL par défaut, surchargeable via GROQ_BASE_URL / OPENROUTER_BASE_URL
// (relais, miroir local, tests d'intégration).
// Exportées : la sonde de modèles (model-check.ts) doit interroger exactement la même
// base que le client, sinon on vérifierait un endpoint différent de celui qu'on appelle.
export const GROQ_BASE = 'https://api.groq.com/openai/v1';
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export function buildProviders(config: AppConfig): LlmProvider[] {
  const providers: LlmProvider[] = [];

  if (config.groqApiKey) {
    providers.push(
      new OpenAiCompatProvider('groq', {
        apiKey: config.groqApiKey,
        baseUrl: config.groqBaseUrl || GROQ_BASE,
        model: config.groqModel,
        timeoutMs: config.llmTimeoutMs,
        maxRetries: config.llmMaxRetries,
      }),
    );
    if (config.groqFallbackModel && config.groqFallbackModel !== config.groqModel) {
      providers.push(
        new OpenAiCompatProvider('groq-fallback', {
          apiKey: config.groqApiKey,
          baseUrl: config.groqBaseUrl || GROQ_BASE,
          model: config.groqFallbackModel,
          timeoutMs: config.llmTimeoutMs,
          maxRetries: config.llmMaxRetries,
        }),
      );
    }
  }

  if (config.openRouterApiKey) {
    providers.push(
      new OpenAiCompatProvider('openrouter', {
        apiKey: config.openRouterApiKey,
        baseUrl: config.openRouterBaseUrl || OPENROUTER_BASE,
        model: config.openRouterModel,
        timeoutMs: config.llmTimeoutMs,
        maxRetries: config.llmMaxRetries,
        // En-têtes conseillés par OpenRouter pour identifier l'application.
        extraHeaders: {
          'http-referer': 'https://localhost/opengravity',
          'x-title': config.agentName,
        },
      }),
    );
  }

  if (providers.length === 0) {
    throw new LlmError('Aucun fournisseur LLM configuré (GROQ_API_KEY ou OPENROUTER_API_KEY requis).', false);
  }
  return providers;
}

/** Contrat minimal attendu par la boucle d'agent (permet de la tester sans réseau). */
export interface LlmClient {
  complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
  /** Optionnel : un faux fournisseur de test n'a aucune obligation de streamer. */
  stream?(request: LlmRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<LlmResponse>;
}

export class LlmChain implements LlmClient {
  constructor(private readonly providers: LlmProvider[]) {}

  get primary(): LlmProvider {
    return this.providers[0]!;
  }

  /**
   * Même politique de bascule que `complete`, avec une règle de plus : si le flux casse
   * APRÈS avoir rendu du texte, on ne rejoue pas le tour chez le fournisseur suivant — une
   * demi-phrase déjà lue à voix haute ne peut pas être remplacée proprement. On remonte
   * l'erreur, et c'est à l'appelant (la session) de finir l'énoncé tel quel.
   */
  async stream(request: LlmRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<LlmResponse> {
    let lastError: unknown;
    for (const provider of this.providers) {
      if (typeof provider.stream !== 'function') {
        lastError = new LlmError(`${provider.name} : flux non supporté`, true);
        continue;
      }
      let emitted = 0;
      try {
        const response = await provider.stream(request, (delta) => {
          emitted += 1;
          onDelta(delta);
        }, signal);
        if (!response.wantsTools && response.text === '') throw new LlmError(`${provider.name} : réponse vide`, true);
        return response;
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof LlmError) || error.retryable;
        if (emitted > 0 || !retryable) throw error instanceof Error ? error : new LlmError('flux interrompu', false);
        log.warn('fournisseur indisponible (flux), bascule', {
          provider: provider.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw lastError instanceof Error ? lastError : new LlmError('Tous les fournisseurs sont indisponibles.', false);
  }

  async complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    let lastError: unknown;
    for (const provider of this.providers) {
      try {
        const response = await provider.complete(request, signal);
        // Un texte vide sans tool_call est une réponse inutile : on tente le suivant.
        if (!response.wantsTools && response.text === '') {
          throw new LlmError(`${provider.name} : réponse vide`, true);
        }
        return response;
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof LlmError) || error.retryable;
        if (!retryable) throw error;
        log.warn('fournisseur indisponible, bascule', {
          provider: provider.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw lastError instanceof Error ? lastError : new LlmError('Tous les fournisseurs sont indisponibles.', false);
  }
}
