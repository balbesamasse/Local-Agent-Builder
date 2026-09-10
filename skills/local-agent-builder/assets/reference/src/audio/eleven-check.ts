/**
 * Sonde ElevenLabs au démarrage : la voix et les modèles existent-ils sur CE compte ?
 *
 * Elle applique la même doctrine que `llm/model-check.ts`, pour la même raison : un
 * identifiant recopié depuis une doc ou un tutoriel n'est pas une garantie. La
 * différence est qu'ici l'échec est silencieux côté utilisateur — il ne paierait
 * qu'une erreur de synthèse au bout d'un tour complet, après avoir parlé.
 *
 * Deux inventaires, deux formes de réponse différentes :
 *   GET /v1/voices → { voices: [{ voice_id, name }] }
 *   GET /v1/models → { models:  [{ model_id, … }] }
 *
 * Une clé absente n'est pas une erreur : la voix est simplement désactivée.
 */
import type { AppConfig } from '../config.js';
import { AudioError } from './types.js';

export interface VoiceCheck {
  fatal: string | null;
  warnings: string[];
  verified: string[];
}

export interface List<T> {
  items: T[];
  field: string;
}

/**
 * L'inventaire ElevenLabs n'a pas de forme stable : `GET /v1/models` répond un
 * TABLEAU NU (9 entrées, vérifié sur un compte réel le 2026-09-02) alors que la doc
 * montre un objet enveloppant, et `GET /v1/voices` répond bien `{ voices: [...] }`.
 * Une sonde qui ne connaît qu'une forme lit « inventaire vide »… et se félicite de
 * n'avoir rien à redire. Les trois présentations sont donc acceptées explicitement.
 */
export function extractItems(payload: unknown, field: string): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (payload === null || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  for (const key of [field, 'items', 'data']) {
    const value = obj[key];
    if (Array.isArray(value)) return value as Record<string, unknown>[];
  }
  return [];
}

export async function listEndpoint(
  url: string,
  apiKey: string,
  field: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<List<Record<string, unknown>>> {
  const response = await fetcher(url, {
    headers: { 'xi-api-key': apiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401 || response.status === 403) {
    throw new AudioError(`ElevenLabs refuse la clé API (HTTP ${response.status})`, false, response.status);
  }
  if (!response.ok) throw new AudioError(`ElevenLabs a répondu ${response.status}`, true, response.status);
  const payload: unknown = await response.json().catch(() => null);
  return { items: extractItems(payload, field), field };
}

export async function checkVoiceAvailability(config: AppConfig, timeoutMs = 15000): Promise<VoiceCheck> {
  const out: VoiceCheck = { fatal: null, warnings: [], verified: [] };
  if (!config.elevenLabsApiKey) return out;

  let voices: List<Record<string, unknown>>;
  let models: List<Record<string, unknown>>;
  try {
    voices = await listEndpoint(`${config.elevenLabsBaseUrl}/voices`, config.elevenLabsApiKey, 'voices', timeoutMs);
    models = await listEndpoint(`${config.elevenLabsBaseUrl}/models`, config.elevenLabsApiKey, 'models', timeoutMs);
  } catch (error) {
    if (error instanceof AudioError && !error.retryable) {
      out.fatal = error.message;
      return out;
    }
    out.warnings.push(`ElevenLabs : inventaire des voix indisponible (${error instanceof AudioError ? error.message : 'erreur réseau'}) — voix non vérifiée.`);
    return out;
  }

  const voiceIds = voices.items.map((v) => String(v['voice_id'] ?? ''));
  const voiceNames = new Map(voices.items.map((v) => [String(v['voice_id'] ?? ''), String(v['name'] ?? '')]));


  if (config.voiceMode !== 'off' && config.elevenLabsVoiceId === '') {
    out.fatal =
      `VOICE_MODE est à « ${config.voiceMode} » mais ELEVENLABS_VOICE_ID est vide. ` +
      `Voix disponibles sur ce compte : ${[...voiceNames.entries()].slice(0, 6).map(([id, name]) => `${name || '(sans nom)'} → ${id}`).join(' · ') || '(aucune)'}\n` +
      `Colle l'identifiant voulu dans .env, ou mets VOICE_MODE="off" pour n'utiliser que le texte.`;
    return out;
  }

  if (config.elevenLabsVoiceId !== '' && voiceIds.length > 0 && !voiceIds.includes(config.elevenLabsVoiceId)) {
    out.fatal =
      `La voix « ${config.elevenLabsVoiceId} » n'existe pas sur ce compte. ` +
      `Identifiants disponibles : ${voiceIds.slice(0, 8).join(', ')}${voiceIds.length > 8 ? ` (+${voiceIds.length - 8} autres)` : ''}.`;
    return out;
  }
  if (config.elevenLabsVoiceId !== '') out.verified.push(`voix ${config.elevenLabsVoiceId}`);

  // `/v1/models` ne décrit QUE la synthèse. En juger le modèle de transcription
  // reviendrait à refuser une configuration valide — Scribe n'apparaît pas dans cet
  // inventaire (vérifié sur le compte réel). Le seul contrôle honnête pour lui est le
  // premier appel, et il est déjà encadré : la chaîne de transcription remonte l'erreur.
  const ttsModelIds = models.items
    .filter((m) => m['can_do_text_to_speech'] !== false)
    .map((m) => String(m['model_id'] ?? ''))
    .filter((id) => id !== '');
  const pinned = config.elevenLabsTtsModel;
  if (pinned !== '') {
    if (ttsModelIds.length === 0) {
      out.warnings.push(
        `ElevenLabs : aucun modèle de synthèse dans l'inventaire, « ${pinned} » n'a pas pu être vérifié.`,
      );
    } else if (!ttsModelIds.includes(pinned)) {
      out.fatal =
        `ELEVENLABS_TTS_MODEL « ${pinned} » n'est pas proposé par ce compte. ` +
        `Modèles de synthèse disponibles : ${ttsModelIds.slice(0, 10).join(', ')}.`;
      return out;
    } else {
      out.verified.push(`modèle ${pinned}`);
    }
  }

  return out;
}

/** Liste lisible pour l'humain : « quelles voix puis-je choisir ? ». */
export function describeVoices(voices: List<Record<string, unknown>>): string[] {
  return voices.items.map((v) => `${String(v['name'] ?? '(sans nom)')} — ${String(v['voice_id'] ?? '?')}`);
}
