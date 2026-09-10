/**
 * Types partagés du noyau.
 *
 * Aucune dépendance à Telegram ici : le noyau doit rester indépendant du canal
 * (Telegram aujourd'hui, webhook / Firebase / CLI demain — voir docs/ARCHITECTURE.md).
 */
import type { Store } from '../memory/store.js';
import type { AppConfig } from '../config.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Arguments bruts renvoyés par le modèle (JSON à valider avant exécution). */
  args: string;
}

/** Message au format « wire » OpenAI-compatible (ce que reçoit/retourne le LLM). */
export interface ChatMessage {
  role: Role;
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** Schéma de paramètres d'un outil (subset JSON Schema accepté par Groq/OpenAI). */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: false;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export interface ToolContext {
  chatId: number;
  userId: number;
  config: AppConfig;
  store: Store;
  /**
   * Outils non fiables (shell, écriture disque, achat…) : le tool doit appeler
   * `await ctx.requestApproval(...)` et annuler si le retour est false.
   */
  requestApproval: (toolName: string, args: Record<string, unknown>, reason: string) => Promise<boolean>;
}

export type ToolStatus = 'ok' | 'error' | 'denied' | 'invalid_args' | 'pending_approval' | 'unavailable';

export interface ToolResult {
  status: ToolStatus;
  /** Contenu injecté au modèle (court, déjà borné). */
  content: string;
  /** Message affiché tel quel à l'utilisateur s'il y a lieu (refus, statut). */
  userNotice?: string;
}

export interface StoredMessage {
  id: number;
  chatId: number;
  role: Role;
  content: string | null;
  toolName: string | null;
  createdAt: number;
  /** Comment la phrase est arrivée : écrite, ou prononcée pendant un appel. */
  channel?: 'telegram' | 'call';
}

export interface MemoryRow {
  id: number;
  chatId: number;
  kind: string;
  content: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

export interface ApprovalRow {
  id: number;
  chatId: number;
  userId: number;
  toolName: string;
  argsJson: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: number;
  expiresAt: number;
}

/** Demande d'approbation présentée au canal (le jeton n'est jamais stocké en base). */
export interface PendingApprovalView {
  id: number;
  token: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  expiresAt: number;
}

/** Résultat renvoyé par la boucle d'agent au canal. */
export interface AgentReply {
  text: string;
  /** Actions en attente d'un clic humain : le canal doit afficher les boutons. */
  pending: PendingApprovalView[];
  /**
   * Messages operatifs nes d'un refus d'outil (« compte non connecte », « quota atteint ») :
   * a afficher a l'utilisateur, mais JAMAIS prononces — une ligne de commande n'est pas une
   * phrase. Le champ `ToolResult.userNotice` etait declare et produit sans jamais etre consomme :
   * un canal qui ignore un champ de l'interface le rend fictif, et un outil qui « explique »
   * dans un champ lu par personne n'explique rien.
   */
  notices?: string[];
  iterations: number;
  toolCalls: number;
  provider: string;
  model: string;
}
