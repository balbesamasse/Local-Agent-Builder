/**
 * Approbation humaine des actions sensibles.
 *
 * Un outil marqué `requiresApproval` n'est jamais exécuté sur la seule parole du
 * LLM : on crée une ligne `pending_approvals`, on la présente à l'utilisateur
 * dans Telegram (boutons), et l'outil n'est exécuté qu'après un clic
 * d'approbation — par le même utilisateur, dans le même chat, avant expiration.
 *
 * Triple garde-fou :
 *   - `user_id` + `chat_id` doivent correspondre à celui qui clique (le clic est
 *     signé par Telegram, donc non falsifiable côté agent) ;
 *   - un jeton aléatoire est stocké sous forme d'empreinte SHA-256 et effacé à la
 *     consommation : un double-clic ou une capture du bouton ne rejoue rien ;
 *   - expiration à `APPROVAL_TTL_MINUTES`.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Store } from '../memory/store.js';
import type { ToolContext } from '../core/types.js';
import type { ApprovalRow } from '../core/types.js';
import { executeToolCall, type ToolRegistry } from '../tools/registry.js';
import { log } from '../core/logger.js';

export interface ApprovalTicket {
  id: number;
  /** Secret à usage unique, transmis uniquement dans le callback Telegram. */
  token: string;
  approval: ApprovalRow;
}

export interface ResolveOutcome {
  ok: boolean;
  /** Phrase à envoyer telle quelle dans Telegram. */
  message: string;
  /** Résultat brut de l'outil, à injecter dans la conversation si exécuté. */
  toolContent?: string;
  toolName?: string;
}

export class ApprovalGate {
  /**
   * Jetons des tickets vivants, uniquement en mémoire.
   * Seule leur empreinte SHA-256 est en base : redémarrer l'agent invalide les
   * boutons en attente (volontaire — une approbation ne survit pas à un restart).
   */
  private readonly tokens = new Map<number, string>();

  constructor(
    private readonly store: Store,
    private readonly registry: ToolRegistry,
    private readonly ttlMinutes: number,
  ) {}

  peekToken(id: number): string | null {
    return this.tokens.get(id) ?? null;
  }

  create(
    chatId: number,
    userId: number,
    toolName: string,
    args: Record<string, unknown>,
    reason: string,
  ): ApprovalTicket | null {
    const tool = this.registry.get(toolName);
    if (!tool) return null;
    const token = randomBytes(32).toString('base64url');
    const approval = this.store.createApproval({
      chatId,
      userId,
      toolName,
      args,
      reason,
      ttlMinutes: this.ttlMinutes,
      tokenFingerprint: fingerprint(token),
    });
    this.tokens.set(approval.id, token);
    log.info('approbation demandée', { id: approval.id, tool: toolName, chatId });
    return { id: approval.id, token, approval };
  }

  /** Tickets encore valides d'une conversation (pour ré-afficher les boutons). */
  pending(chatId: number): ApprovalRow[] {
    return this.store.pendingApprovalsForChat(chatId);
  }

  /**
   * Vérifie tout ce qui doit l'être, puis exécute. Ne lève jamais : renvoie un
   * message lisible, afin que le canal puisse répondre même en cas d'anomalie.
   */
  async resolve(input: {
    id: number;
    token: string;
    userId: number;
    chatId: number;
    approved: boolean;
    context: ToolContext;
  }): Promise<ResolveOutcome> {
    // Un ticket consommé disparaît de la mémoire : `/pending` ne peut plus le
    // rejouer, et la comparaison d'empreinte en base fait le reste.
    this.tokens.delete(input.id);

    if (!input.approved) {
      this.store.decideApproval(input.id, 'denied');
      return { ok: false, message: '❌ Action annulée — rien n’a été exécuté.' };
    }

    const approval = this.store.getApproval(input.id);
    if (!approval) return { ok: false, message: 'demande introuvable (base réinitialisée ?).' };
    if (approval.chatId !== input.chatId || approval.userId !== input.userId) {
      log.warn('approbation hors contexte refusée', { id: input.id, chatId: input.chatId });
      return { ok: false, message: 'refus : cette demande ne appartient pas à cette conversation.' };
    }
    if (approval.status === 'expired') {
      return { ok: false, message: '⏳ Délai dépassé : la demande a expiré, rien n’a été exécuté.' };
    }
    if (approval.status !== 'pending') {
      return { ok: false, message: `cette demande est déjà « ${approval.status} ».` };
    }
    if (approval.expiresAt <= Date.now()) {
      this.store.decideApproval(input.id, 'expired');
      return { ok: false, message: '⏳ Délai dépassé : la demande a expiré, rien n’a été exécuté.' };
    }
    if (this.store.getApprovalTokenFingerprint(input.id) !== fingerprint(input.token)) {
      log.warn('jeton d’approbation invalide', { id: input.id });
      return { ok: false, message: 'refus : jeton invalide ou déjà utilisé.' };
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(approval.argsJson) as Record<string, unknown>;
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('shape');
    } catch {
      return { ok: false, message: 'arguments de la demande illisibles : exécution annulée.' };
    }

    // Consommation AVANT exécution : un plantage en cours de route ne doit pas
    // laisser une approbation rejouable.
    this.store.consumeApprovalToken(input.id);
    this.store.decideApproval(input.id, 'approved');

    const outcome = await executeToolCall(this.registry, { name: approval.toolName, args: approval.argsJson }, input.context, {
      skipApproval: true,
    });

    if (outcome.kind === 'rejected') return { ok: false, message: `refus : ${outcome.reason}` };
    if (outcome.kind !== 'executed') {
      return { ok: false, message: 'conflit de configuration : cet outil redemande une approbation.' };
    }
    return {
      ok: outcome.executed.result.status === 'ok',
      message: `✅ ${approval.toolName} — ${outcome.executed.result.content}`,
      toolContent: outcome.executed.result.content,
      toolName: approval.toolName,
    };
  }
}

function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}
