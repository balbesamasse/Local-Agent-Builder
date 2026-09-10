/**
 * Types partagés de la couche audio.
 *
 * Deux contrats minces (`Transcriber`, `Synthesizer`) suffisent : le canal Telegram
 * fournit des octets et en reçoit, `core/` n'en voit jamais. La raison est la même
 * que pour le reste du projet — un changement de messagerie ne doit pas obliger à
 * réécrire le raisonnement, et l'audio ne doit pas devenir une dépendance cachée
 * de grammy.
 */

/** Erreur audio, avec la même politique de bascule que le LLM : on ne change de
 * fournisseur que sur erreur transitoire. Une 401 doit rester visible. */
export class AudioError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(message: string, retryable: boolean, status: number | null = null) {
    super(message);
    this.name = 'AudioError';
    this.retryable = retryable;
    this.status = status;
  }
}

/** Un statut HTTP devient « transitoire » ou « définitif ». Le corps de la réponse
 * n'est jamais recopié ici : il peut contenir la requête, donc la clé. */
export function retryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export interface Transcript {
  /** Texte reconnu, vide si l'audio ne contenait rien d'exploitable. */
  text: string;
  provider: string;
  model: string;
  language: string | null;
  durationSec: number | null;
}

export interface AudioInput {
  bytes: Uint8Array;
  mime: string;
  /**
   * Nom de fichier transmis au fournisseur. Pas décoratif : Groq juge le type d'audio sur
   * l'EXTENSION de ce nom et rejette un `voice_file_1` sans extension, même avec les bons
   * octets et le bon `Content-Type`. `resolveAudioPart` en garantit une.
   */
  fileName: string;
  /** Indice de langue, quand le canal le connaît (langue du profil Telegram). */
  languageHint?: string;
}

export interface Transcriber {
  readonly name: string;
  transcribe(input: AudioInput): Promise<Transcript>;
}

export interface Speech {
  bytes: Uint8Array;
  /** `audio/ogg` pour un vocal Telegram ; `audio/mpeg` sinon. */
  mime: string;
  fileName: string;
  /** Nombre de caractères effectivement donnés au synthétiseur (facturation). */
  chars: number;
  /** La réponse a été coupée pour tenir dans le budget : à dire à l'utilisateur. */
  truncated: boolean;
}

export interface Synthesizer {
  readonly name: string;
  /**
   * Peut lever AudioError. Doit être appelé UNIQUEMENT quand la décision de parler est
   * prise. `voiceId` : voix de substitution pour ce tour (choix par conversation via
   * `/voice`) ; absent = `ELEVENLABS_VOICE_ID`. Un identifiant refusé l'est AVANT l'appel,
   * jamais après facture.
   */
  synthesize(text: string, voiceId?: string): Promise<Speech>;
}
