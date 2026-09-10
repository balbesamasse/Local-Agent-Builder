/**
 * Synthèse vocale : la bouche de l'agent (ElevenLabs).
 *
 * Trois garde-fous qui ne sont pas du décor :
 *   1. le `voice_id` est validé par regex AVANT d'entrer dans l'URL — sinon une
 *      valeur venue de `.env` (ou d'un futur champ d'administration) permettrait
 *      d'écrire `../../v1/…` dans le chemin requis ;
 *   2. le texte est nettoyé du balisage Telegram avant d'être parlé : une réponse
 *      `<b>Résultat</b>` sinon dictée telle quelle ferait prononcer les noms des
 *      balises ;
 *   3. un budget en caractères borne la facture. Une réponse trop longue est coupée
 *      sur une fin de phrase et le drapeau `truncated` remonte — couper en silence
 *      serait mentir sur ce que l'utilisateur a entendu.
 */
import { AudioError, retryableStatus, type Speech, type Synthesizer } from './types.js';

/** Format qui plaît à Telegram pour un message vocal : OGG/Opus 48 kHz 64 kbps. */
export const TELEGRAM_VOICE_FORMAT = 'opus_48000_64';
const VOICE_ID_RE = /^[A-Za-z0-9]{10,64}$/;

/** Retire le balisage Telegram/Markdown et les pictogrammes, puis normalise les espaces. */
export function stripForSpeech(input: string): string {
  let text = input
    // <b>, <i>, <code>, <a href="…">…</a> : on garde le contenu, on jette la balise.
    .replace(/<a\s[^>]*>(.*?)<\/a>/gis, '$1')
    .replace(/<\/?(?:b|i|u|s|strong|em|code|pre|span|tg-spoiler)\s*>/gi, ' ')
    // Entités HTML écrites par l'échappement du canal.
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    // Restes de markdown, si un outil en a produit.
    .replace(/```[\s\S]*?```/g, ' (bloc de code omis) ')
    .replace(/[*_`#>|]/g, ' ')
    // Un TTS lit le nom du pictogramme à voix haute ; il n'a rien à y faire.
    .replace(/\p{Extended_Pictographic}/gu, ' ');

  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/** Coupe sur la dernière fin de phrase tenant dans le budget, sans tronquer au mot. */
export function clampForSpeech(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const window = text.slice(0, maxChars);
  const cut = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.lastIndexOf('. '),
    window.lastIndexOf('; '),
  );
  if (cut > maxChars * 0.4) return { text: window.slice(0, cut + 1), truncated: true };
  // L'ellipse se réserve son propre caractère : sans ça, une phrase sans ponctuation
  // dans la fenêtre sortait à maxChars + 1 — soit plus que le budget que la config
  // promet à l'utilisateur, qui est justement ce qui borne sa facture.
  return { text: `${window.slice(0, maxChars - 1).trimEnd()}…`, truncated: true };
}

export interface TtsOptions {
  apiKey: string;
  baseUrl: string;
  voiceId: string;
  modelId: string;
  /** 0 = plus naturel et plus varié, 1 = très stable. */
  stability: number;
  similarityBoost: number;
  maxChars: number;
  timeoutMs: number;
}

export class ElevenLabsTts implements Synthesizer {
  readonly name = 'elevenlabs-tts';

  constructor(private readonly opts: TtsOptions) {
    if (!VOICE_ID_RE.test(opts.voiceId)) {
      throw new AudioError(
        `ELEVENLABS_VOICE_ID refusé : « ${opts.voiceId.slice(0, 24)} » n'a pas la forme d'un identifiant de voix`,
        false,
      );
    }
  }

  async synthesize(rawText: string, voiceIdOverride?: string): Promise<Speech> {
    const clean = stripForSpeech(rawText);
    if (clean.length === 0) throw new AudioError('rien à énoncer après nettoyage du balisage', false);

    // La voix choisie dans la conversation vient d'un appui sur un bouton, donc d'une donnée
    // extérieure : même contrôle qu'au démarrage, avant l'URL qui facture.
    const voiceId = voiceIdOverride ?? this.opts.voiceId;
    if (!VOICE_ID_RE.test(voiceId)) {
      throw new AudioError('la voix demandée n’a pas la forme d’un identifiant ElevenLabs', false);
    }

    const { text, truncated } = clampForSpeech(clean, this.opts.maxChars);

    let response: Response;
    const url = `${this.opts.baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${TELEGRAM_VOICE_FORMAT}`;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.opts.apiKey,
          'content-type': 'application/json',
          accept: 'audio/ogg',
        },
        body: JSON.stringify({
          text,
          model_id: this.opts.modelId,
          voice_settings: {
            stability: this.opts.stability,
            similarity_boost: this.opts.similarityBoost,
          },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (error) {
      throw new AudioError(`synthèse vocale impossible : ${error instanceof Error ? error.name : 'erreur inconnue'}`, true);
    }

    if (!response.ok) {
      // Ni le corps ni l'URL (qui porte l'identifiant de voix) dans le message :
      // seul le statut aide l'utilisateur, le reste peut contenir la requête.
      throw new AudioError(`ElevenLabs a répondu ${response.status}`, retryableStatus(response.status), response.status);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new AudioError('ElevenLabs a renvoyé un audio vide', false);

    return {
      bytes,
      mime: 'audio/ogg',
      fileName: 'reponse.ogg',
      chars: text.length,
      truncated,
    };
  }
}

/** null = voix désactivée proprement (aucun appel réseau), et non « activée mais cassée ». */
export function buildSynthesizer(config: {
  elevenLabsApiKey: string;
  elevenLabsBaseUrl: string;
  elevenLabsVoiceId: string;
  elevenLabsTtsModel: string;
  elevenLabsStability: number;
  elevenLabsSimilarity: number;
  ttsMaxChars: number;
  llmTimeoutMs: number;
  voiceMode: string;
}): Synthesizer | null {
  if (config.voiceMode === 'off') return null;
  if (!config.elevenLabsApiKey || !config.elevenLabsVoiceId) return null;
  return new ElevenLabsTts({
    apiKey: config.elevenLabsApiKey,
    baseUrl: config.elevenLabsBaseUrl,
    voiceId: config.elevenLabsVoiceId,
    modelId: config.elevenLabsTtsModel,
    stability: config.elevenLabsStability,
    similarityBoost: config.elevenLabsSimilarity,
    maxChars: config.ttsMaxChars,
    timeoutMs: Math.max(config.llmTimeoutMs, 30000),
  });
}
