/**
 * Ce que le canal Telegram doit savoir faire pour piloter un appel, sans rien savoir du
 * websocket, des fournisseurs ni de la boucle de tour de parole.
 *
 * Un fichier à part pour une raison précise : si ces types vivaient dans `hub.ts`, le canal
 * importerait la couche transport (et donc `ws`) ; s'ils vivaient dans `bot.ts`, le hub
 * importerait le canal — un cycle. Le contrat est le seul des trois qui puisse être importé
 * dans les deux sens.
 */
import type { CallSummary } from './session.js';

export interface RealtimeChannelDeps {
  /** Une URL dont le jeton vit dans le fragment (`#t=`), ou `null` si rien n'est écouté. */
  linkFor(chatId: number, userId: number): string | null;
  status(chatId: number): { active: boolean; turns: number } | null;
  end(chatId: number, reason: string): Promise<boolean>;
  /** Le bilan d'appel part dans le chat, pas dans la page : la page peut être déjà fermée. */
  onEnded?: (chatId: number, summary: CallSummary) => void;
  /** Ce que l'agent doit à l'utilisateur quand un tour n'a pas pu être parlé. */
  writeChatText(chatId: number, text: string): Promise<void>;
  /**
   * Le hub est vivant (port ouvert) : sans ça, `/call` promet un lien qui ne répond pas.
   * Mutable volontairement : le port n'est certain qu'après l'écoute, et promettre un lien
   * avant enverrait l'utilisateur sur une adresse vide. Un `as const` ici serait un piège.
   */
  listening: boolean;
}
