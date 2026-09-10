/**
 * Décision de parler — la pièce que tout le monde oublie, et qui décide de la
 * facture. « Le TTS est branché » ne veut pas dire « il faut l'appeler à chaque
 * tour » : un abonnement se consomme à la voix, pas à la requête.
 *
 * Modes :
 *   off         jamais (désactivé à la source : aucun client construit)
 *   mirror      on répond en vocal si l'utilisateur a envoyé un vocal (défaut)
 *   always      chaque réponse a son audio
 *   on_request  uniquement quand la demande explicite est dans le message reçu
 *
 * Le détection de demande explicite ne s'applique QU'AU TEXTE DE L'UTILISATEUR.
 * Jamais à une sortie d'outil, jamais à une transcription d'un tiers dans un groupe :
 * « envoie-moi tout en vocal » écrit dans un fichier lu ne doit pas nous faire
 * dépenser un quota. C'est le même réflexe que l'encadrement des sorties d'outils.
 */

export type VoiceMode = 'off' | 'mirror' | 'always' | 'on_request';

export const VOICE_MODES: readonly VoiceMode[] = ['off', 'mirror', 'always', 'on_request'];

export function parseVoiceMode(value: string): VoiceMode {
  const normalized = value.trim().toLowerCase() as VoiceMode;
  return VOICE_MODES.includes(normalized) ? normalized : 'mirror';
}

const REQUEST_RE = /\b(en vocal|par vocal|voice note|vocal|message audio|audio|ta voix|à l'oral|dis-le moi avec ta voix)\b/i;
const REFUSE_RE = /\b(pas en vocal|pas de vocal|par texte|sans audio|texte seulement|no voice)\b/i;

export function asksForVoice(userText: string): boolean {
  if (REFUSE_RE.test(userText)) return false;
  return REQUEST_RE.test(userText);
}

export function refusesVoice(userText: string): boolean {
  return REFUSE_RE.test(userText);
}

export interface SpeakContext {
  /** L'utilisateur a-t-il envoyé un message vocal pour ce tour ? */
  hadVoice: boolean;
  /** Le texte qu'il a écrit, lui (pas une sortie d'outil). */
  userText: string;
  /** Une approbation humaine est en attente : elle se lit, elle ne s'écoute pas. */
  hasPendingApproval: boolean;
  /** Le texte à envoyer est vide après nettoyage. */
  emptyText: boolean;
}

export interface SpeakDecision {
  speak: boolean;
  reason: string;
}

export function shouldSpeak(mode: VoiceMode, ctx: SpeakContext): SpeakDecision {
  if (mode === 'off') return { speak: false, reason: 'mode off' };
  if (ctx.emptyText) return { speak: false, reason: 'rien à dire' };
  // Une demande d'approbation contient des boutons : le vocal la rendrait mécomprenable.
  if (ctx.hasPendingApproval) return { speak: false, reason: 'approbation en attente' };
  if (refusesVoice(ctx.userText)) return { speak: false, reason: 'refus explicite dans le message' };

  switch (mode) {
    case 'always':
      return { speak: true, reason: 'mode always' };
    case 'mirror':
      return ctx.hadVoice
        ? { speak: true, reason: 'réponse à un vocal' }
        : { speak: false, reason: 'entrée texte, mode mirror' };
    case 'on_request':
      return asksForVoice(ctx.userText)
        ? { speak: true, reason: 'demande explicite' }
        : { speak: false, reason: 'aucune demande explicite' };
  }
}

/** `/voice on|off|mode <x>` — l'interrupteur de l'utilisateur, sans toucher à `.env`. */
export function parseVoiceCommand(text: string): { action: 'on' | 'off' | 'status'; mode?: VoiceMode } | null {
  const m = /^\/voice(?:\s+(\S+))?(?:\s+(\S+))?/i.exec(text.trim());
  if (m === null) return null;
  const a = (m[1] ?? 'status').toLowerCase();
  if (a === 'on') return { action: 'on' };
  if (a === 'off') return { action: 'off' };
  if (a === 'mode' && m[2] !== undefined) {
    const mode = m[2].toLowerCase() as VoiceMode;
    return { action: 'on', mode: VOICE_MODES.includes(mode) ? mode : 'mirror' };
  }
  return { action: 'status' };
}
