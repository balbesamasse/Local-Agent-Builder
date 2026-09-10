/**
 * Transcription : l'ouïe de l'agent.
 *
 * Groq Whisper d'abord (même clé, même base que le texte, donc aucun nouveau
 * compte à ouvrir), ElevenLabs Scribe en secours. La chaîne applique la politique
 * héritée du LLM : on ne bascule QUE sur erreur transitoire (429, 5xx, timeout).
 * Une 401 remonte telle quelle — masquer une clé refusée derrière un autre
 * fournisseur ferait tourner l'agent sur une jambe sans que personne le sache.
 *
 * Aucun octet n'est écrit sur le disque : le Buffer arrive en mémoire, repart en
 * multipart, et rien n'en reste. C'est plus solide qu'un `finally` de nettoyage,
 * qu'un refactor peut oublier.
 */
import { AudioError, retryableStatus, type AudioInput, type Transcript, type Transcriber } from './types.js';

export interface HttpOptions {
  timeoutMs: number;
}

/** Copie dans un `ArrayBuffer` propre : `Blob` attend un tampon détaché, pas un
 * `Uint8Array` sur-échangé (les types de Node et du DOM ne se recouvrent pas ici). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * Extensions admises par les fournisseurs de transcription. Elles sont jugées sur le
 * NOM de la partie multipart, pas sur son en-tête `Content-Type` : relevé sur l'API en
 * direct, un `voice_file_1` (le nom brut rendu par le serveur de fichiers de Telegram,
 * sans extension) est refusé `file must be one of the following types: [...]`, alors que
 * les MÊMES octets nommés `voice.ogg` passent. C'est ce qui a empêché tout vocal d'être
 * transcrit — silencieusement, puisqu'un 400 n'est pas transitoire et n'essaye donc pas
 * le fournisseur suivant.
 */
const AUDIO_EXTS = ['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'ogg', 'opus', 'wav', 'webm'];

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
  'audio/x-wav': 'wav',
  'video/mp4': 'mp4',
};

/**
 * Nom + mime à présenter au fournisseur, déduits de ce que le canal sait. Refuser ici est
 * volontairement non transitoire et SANS statut HTTP : ne rien envoyer coûte zéro, et le
 * canal distingue ainsi « on n'a pas de fichier exploitable » de « le fournisseur a
 * refusé » — deux réponses à faire à l'utilisateur qui n'ont rien de commun.
 */
export function resolveAudioPart(input: AudioInput): { fileName: string; mime: string } {
  const base = (input.fileName.split('/').pop() ?? '').trim();
  const clean = base === '' ? 'audio' : base;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 ? clean.slice(dot + 1).toLowerCase() : '';
  const mime = (input.mime ?? '').split(';')[0]!.trim().toLowerCase();
  if (ext !== '' && AUDIO_EXTS.includes(ext)) return { fileName: clean, mime: mime === '' ? `audio/${ext}` : mime };
  const guess = EXT_BY_MIME[mime];
  if (guess !== undefined) return { fileName: `${clean}.${guess}`, mime };
  throw new AudioError(
    `format audio non reconnu (${ext === '' ? JSON.stringify(mime || 'sans extension') : JSON.stringify(ext)} ; ` +
      `les fournisseurs attendent : ${AUDIO_EXTS.join(', ')})`,
    false,
  );
}

/** `FormData` natif (Node ≥ 18) : pas de dépendance de plus, et le boundary est posé par fetch. */
function form(file: Uint8Array, mime: string, fileName: string, fields: Record<string, string>): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([toArrayBuffer(file)], { type: mime }), fileName);
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  return fd;
}

async function post(url: string, headers: Record<string, string>, body: FormData, opts: HttpOptions): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(opts.timeoutMs) });
  } catch (error) {
    // Timeout ou réseau : transitoire, la chaîne a le droit d'essayer le suivant.
    throw new AudioError(`requête audio impossible : ${error instanceof Error ? error.name : 'erreur inconnue'}`, true);
  }
  if (!response.ok) {
    const status = response.status;
    throw new AudioError(
      `le fournisseur audio a répondu ${status}`,
      retryableStatus(status),
      status,
    );
  }
  return response;
}

export class GroqWhisper implements Transcriber {
  readonly name = 'groq-whisper';

  constructor(
    private readonly opts: { baseUrl: string; apiKey: string; model: string } & HttpOptions,
  ) {}

  async transcribe(input: AudioInput): Promise<Transcript> {
    const part = resolveAudioPart(input);
    const response = await post(
      `${this.opts.baseUrl}/audio/transcriptions`,
      { Authorization: `Bearer ${this.opts.apiKey}` },
      form(input.bytes, part.mime, part.fileName, {
        model: this.opts.model,
        // Le texte reconnu est une DONNÉE : le provider ne doit pas la relire comme
        // une consigne. `prompt` sert uniquement à orienter la graphie (noms propres).
        ...(input.languageHint ? { language: input.languageHint } : {}),
      }),
      { timeoutMs: this.opts.timeoutMs },
    );

    const payload = (await response.json().catch(() => null)) as { text?: unknown; language?: unknown; duration?: unknown } | null;
    if (payload === null) throw new AudioError(`${this.name} : réponse illisible`, false);
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    return {
      text,
      provider: this.name,
      model: this.opts.model,
      language: typeof payload.language === 'string' ? payload.language : null,
      durationSec: typeof payload.duration === 'number' ? payload.duration : null,
    };
  }
}

export class ElevenLabsScribe implements Transcriber {
  readonly name = 'elevenlabs-scribe';

  constructor(
    private readonly opts: { baseUrl: string; apiKey: string; model: string } & HttpOptions,
  ) {}

  async transcribe(input: AudioInput): Promise<Transcript> {
    const part = resolveAudioPart(input);
    const response = await post(
      `${this.opts.baseUrl}/speech-to-text`,
      { 'xi-api-key': this.opts.apiKey },
      form(input.bytes, part.mime, part.fileName, {
        model_id: this.opts.model,
        ...(input.languageHint ? { language_code: input.languageHint } : {}),
      }),
      { timeoutMs: this.opts.timeoutMs },
    );

    const payload = (await response.json().catch(() => null)) as {
      text?: unknown;
      language_code?: unknown;
      audio_duration_secs?: unknown;
    } | null;
    if (payload === null) throw new AudioError(`${this.name} : réponse illisible`, false);
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    return {
      text,
      provider: this.name,
      model: this.opts.model,
      language: typeof payload.language_code === 'string' ? payload.language_code : null,
      durationSec: typeof payload.audio_duration_secs === 'number' ? payload.audio_duration_secs : null,
    };
  }
}

/**
 * Chaîne de transcription. `attempted` sert au journal : « qui a vraiment répondu »
 * doit être distinguable de « qui était configuré », sinon un secours permanent
 * passe inaperçu pendant des semaines.
 */
export class TranscriberChain implements Transcriber {
  readonly name = 'chaîne de transcription';
  private readonly attempted: string[] = [];

  constructor(private readonly providers: Transcriber[]) {
    if (providers.length === 0) throw new AudioError('aucun fournisseur de transcription disponible', false);
  }

  get tried(): string[] {
    return [...this.attempted];
  }

  async transcribe(input: AudioInput): Promise<Transcript> {
    this.attempted.length = 0;
    let last: AudioError | null = null;

    for (const provider of this.providers) {
      this.attempted.push(provider.name);
      try {
        return await provider.transcribe(input);
      } catch (error) {
        if (!(error instanceof AudioError)) {
          throw new AudioError('échec inattendu de la transcription', false);
        }
        last = error;
        if (!error.retryable) {
          // Erreur de contrat (clé refusée, format non supporté) : changer de
          // fournisseur ne ferait que cacher le problème.
          throw error;
        }
      }
    }

    throw last ?? new AudioError('transcription indisponible', false);
  }
}

/** Le canal ne sait pas quel fournisseur est joignable : il demande, on décide ici. */
export function buildTranscriber(config: {
  groqApiKey: string;
  groqBaseUrl: string;
  whisperModel: string;
  elevenLabsApiKey: string;
  elevenLabsBaseUrl: string;
  elevenLabsSttModel: string;
  transcriptionOrder: string;
  llmTimeoutMs: number;
}): TranscriberChain | null {
  const wanted = config.transcriptionOrder
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  const byName = new Map<string, Transcriber>();
  if (config.groqApiKey) {
    byName.set('groq', new GroqWhisper({
      baseUrl: config.groqBaseUrl,
      apiKey: config.groqApiKey,
      model: config.whisperModel,
      timeoutMs: Math.max(config.llmTimeoutMs, 30000),
    }));
  }
  if (config.elevenLabsApiKey) {
    byName.set('elevenlabs', new ElevenLabsScribe({
      baseUrl: config.elevenLabsBaseUrl,
      apiKey: config.elevenLabsApiKey,
      model: config.elevenLabsSttModel,
      timeoutMs: Math.max(config.llmTimeoutMs, 30000),
    }));
  }

  const chain = wanted.map((name) => byName.get(name)).filter((p): p is Transcriber => p !== undefined);
  if (chain.length === 0) return null;
  return new TranscriberChain(chain);
}
