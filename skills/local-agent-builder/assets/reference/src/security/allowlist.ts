/**
 * Liste blanche d'accès — la première ligne de défense.
 *
 * Politique : deny-by-default. Un identifiant absent, ambigu ou absent du tout
 * → refus. Aucun message n'atteint le LLM dans ce cas.
 *
 * Ce module reste volontairement sans dépendance au canal (pas d'import de
 * `grammy`) : la décision « cet identifiant a-t-il le droit de parler à l'agent »
 * doit pouvoir être rejouée à l'identique par Telegram, un webhook, une Cloud
 * Function ou un CLI. C'est `check_invariants.py` (règle « layering ») qui
 * garantit que cette propriété ne se dégrade pas avec le temps.
 */
import type { AppConfig } from '../config.js';
import { log } from '../core/logger.js';

export function isAllowed(config: AppConfig, userId: unknown): userId is number {
  return typeof userId === 'number' && Number.isSafeInteger(userId) && config.allowedUserIds.has(userId);
}

export interface AuthorizationRequest {
  /** Identifiant de l'auteur réel de l'update (signé par le fournisseur du canal). */
  userId: unknown;
  /** L'update provient-il d'une conversation identifiable ? */
  hasChat: boolean;
}

export interface AuthorizationDecision {
  allow: boolean;
  /** Réponse à renvoyer telle quelle, ou null pour un refus silencieux. */
  reply: string | null;
}

/**
 * Décide, sans rien écrire et sans connaître le canal.
 *
 * La réponse de refus est volontairement générique : « vous n'êtes pas autorisé »
 * confirmerait à un attaquant qu'il a touché un bot réel et pourquoi il échoue.
 */
export function authorize(config: AppConfig, request: AuthorizationRequest): AuthorizationDecision {
  if (isAllowed(config, request.userId) && request.hasChat) return { allow: true, reply: null };

  log.warn('accès refusé', {
    userId: typeof request.userId === 'number' ? request.userId : 'absent',
    hasChat: request.hasChat,
  });
  return { allow: false, reply: request.hasChat ? 'Message non traité.' : null };
}
