/**
 * Boucle d'agent : « réfléchir → agir → observer », bornée en itérations.
 *
 * Invariants de sécurité :
 *  - le nombre d'appels LLM par tour est plafonné (AGENT_MAX_ITERATIONS) ;
 *  - à partir de AGENT_FORCE_FINAL_ITERATION, les outils sont retirés du
 *    contexte pour rendre la boucle finie même si le modèle boude la sortie ;
 *  - un même appel (outil + arguments) n'est exécuté qu'une fois par tour ;
 *  - aucun outil n'est exécuté sans validation d'arguments, et un outil
 *    `requiresApproval` attend un clic humain explicite ;
 *  - les sorties d'outils sont traitées comme des DONNÉES (cadre BEGIN_/END_).
 */
import type { AppConfig } from '../config.js';
import type { Store } from '../memory/store.js';
import { buildSystemPrompt, memoryContextBlock, FORCE_FINAL_INSTRUCTION } from './prompts.js';
import { asUntrusted, sanitizeText } from '../security/sanitizer.js';
import { executeToolCall, type ToolRegistry } from '../tools/registry.js';
import type { ApprovalGate } from '../security/approvals.js';
import type { AgentReply, ChatMessage, PendingApprovalView, ToolContext } from './types.js';
import type { LlmClient } from '../llm/providers.js';
import { LlmError } from '../llm/openai-compat.js';
import { log } from './logger.js';

/** Nombre max d'appels d'outils acceptés sur un seul tour de LLM. */
const MAX_TOOL_CALLS_PER_TURN = 4;

export interface AgentDeps {
  config: AppConfig;
  llm: LlmClient;
  store: Store;
  registry: ToolRegistry;
  gate: ApprovalGate;
}

export interface AgentTurnInput {
  chatId: number;
  userId: number;
  /** Texte (Telegram ou transcription d'appel) déjà autorisé par la liste blanche, non encore assaini. */
  text: string;
  title?: string | null;
  isGroup?: boolean;
  /**
   * `call` = un appel Live Voice : le prompt système passe en registre oral et la réponse
   * est streamée vers `onPartial`. C'est le MÊME agent — mêmes outils, même mémoire, mêmes
   * plafonds — seulement une autre façon de_renderir_sortir.
   */
  channel?: 'telegram' | 'call';
  /** Annulation (barge-in) : la requête LLM en cours est coupée, la facture avec elle. */
  signal?: AbortSignal;
  /** Fragments de la réponse finale, au fil du flux — utilisé par la synthèse vocale temps réel. */
  onPartial?: (text: string) => void;
}

export type AgentTurnResult = AgentReply;

export async function runAgent(deps: AgentDeps, input: AgentTurnInput): Promise<AgentTurnResult> {
  const { config, store, registry, gate } = deps;
  const text = sanitizeText(input.text, config.maxMessageChars);
  const chatId = input.chatId;

  store.touchChat(chatId, input.title ?? null, input.isGroup ?? false);
  const priorHistory = store.recentMessages(chatId, config.historyLimit);
  // Le canal est persisté avec la phrase : « dit à l'oral » et « écrit » ne se relisent pas
  // de la même façon au tour suivant (une dictée peut être mal transcrite, une réponse parlée
  // ne se retrouve pas en relançant l'appel).
  store.addMessage({ chatId, role: 'user', content: text, channel: input.channel ?? 'telegram' });

  // Les souvenirs ne sont chargés que si la question semble personnelle : ça
  // économise des tokens et ça réduit la surface d'injection.
  const memories = store.searchMemories(chatId, keywordsOf(text), 6);
  const memoryBlock = memoryContextBlock(memories);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        agentName: config.agentName,
        timezone: config.systemTimezone,
        toolNames: registry.visible().map((t) => t.name),
        approvedByOwnerOnly: true,
        channel: input.channel ?? 'telegram',
      }),
    },
  ];
  if (memoryBlock !== '') messages.push({ role: 'system', content: memoryBlock });
  for (const m of priorHistory) {
    if (!m.content) continue;
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: 'user', content: text });

  const pending: PendingApprovalView[] = [];
  /** Refus d'outils a montrer a l'utilisateur (voir AgentReply.notices). */
  const notices: string[] = [];
  let finalText = '';
  let iterations = 0;
  let toolCallCount = 0;
  let provider = '';
  let model = '';
  const alreadyRun = new Set<string>();
  let forced = false;

  for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
    iterations = iteration;
    const mustFinish = config.forceFinalIteration > 0 && iteration >= config.forceFinalIteration;
    const tools = mustFinish ? [] : registry.definitions();
    if (mustFinish && !forced) {
      forced = true;
      // Une instruction « système » en milieu de conversation est refusée par
      // certains fournisseurs : on l'injecte comme message utilisateur balisé.
      messages.push({ role: 'user', content: asUntrusted('SYSTEM', FORCE_FINAL_INSTRUCTION) });
    }

    let response;
    // En appel, la réponse est streamée : commencer à parler avant la fin de la phrase économise
    // ~1,5 s par tour, ce qui est exactement la différence entre « il réfléchit » et « il me
    // répond ». Deux réserves, toutes deux structurelles :
    //  - le dernier tour forcé (`mustFinish`) reste en `complete()` : la consigne « réponds sans
    //    outil » merite la voie simple et eprouvee ;
    //  - les outils sont PASSES au stream (outillage du 1er tour en appel) : retirer les outils
    //    pour pouvoir streamer aurait rendu l'agent amorphe des qu'on l'appelle. Un tour qui
    //    aboutit a un tool_call n'a rien dit — `onPartial` na rien recu, et la synthese part du
    //    texte final complet. Le flux ne facture donc que ce qui etait de toute facon prononce.
    const canStream = input.onPartial !== undefined && !mustFinish && typeof deps.llm.stream === 'function';
    try {
      response = canStream
        ? await deps.llm.stream!({ messages, tools, temperature: 0.3 }, (delta) => input.onPartial?.(delta), input.signal)
        : await deps.llm.complete({ messages, tools, temperature: 0.3 }, input.signal);
    } catch (error) {
      if (input.signal?.aborted === true) throw new Error('tour interrompu (barge-in)');
      const raw = error instanceof Error ? error.message : String(error);
      const quota = error instanceof LlmError && error.status === 429;
      // Le détail complet va dans les journaux locaux, pas dans la conversation :
      // un message de fournisseur peut contenir des éléments de la requête.
      log.error('échec du LLM', { chatId, iteration, quota, error: raw });
      return {
        text: quota
          ? '⚠️ Quota atteint chez Groq et sur les secours configurés. Réessaie dans quelques minutes, ou ajoute une clé OpenRouter dans `.env`.'
          : '⚠️ Je n’ai pas pu joindre le modèle (timeout, quota ou erreur réseau). Réessaie dans un instant — le détail est dans les journaux locaux.',
        pending,
        iterations,
        toolCalls: toolCallCount,
        provider: 'erreur',
        model: '—',
      };
    }

    provider = response.provider;
    model = response.model;

    if (!response.wantsTools) {
      finalText = response.text;
      // C'est ICI seulement que le texte est considéré comme prononçable : le flux n'a servi
      // qu'a demarrer la synthese en avance. Si le fournisseur a rendu un texte different de ce
      // qui a ete streamed (normalisation, tool_call avorte), `spokenChars` dans la session fait
      // la part des choses et ne resynthetise que le surplus.
      break;
    }

    messages.push({
      role: 'assistant',
      content: response.text || null,
      tool_calls: response.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
    });

    const calls = response.toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
    for (const call of calls) {
      toolCallCount += 1;
      const dedupeKey = `${call.name}:${call.args}`;
      let content: string;

      if (alreadyRun.has(dedupeKey)) {
        content = 'appel déjà effectué à ce tour : résultat identique, ne répète pas l’appel';
      } else {
        alreadyRun.add(dedupeKey);
        const ctx = makeToolContext(deps, chatId, input.userId);
        const outcome = await executeToolCall(registry, call, ctx);

        if (outcome.kind === 'rejected') {
          content = `refusé : ${outcome.reason}`;
        } else if (outcome.kind === 'needs_approval') {
          const ticket = gate.create(chatId, input.userId, outcome.tool.name, outcome.args, approvalReason(outcome.tool.name, outcome.args));
          if (!ticket) {
            content = 'outil indisponible (configuration)';
          } else {
            pending.push({
              id: ticket.id,
              token: ticket.token,
              toolName: ticket.approval.toolName,
              args: outcome.args,
              reason: ticket.approval.reason,
              expiresAt: ticket.approval.expiresAt,
            });
            content = `action sensible mise en attente d’approbation humaine (réf. ${ticket.id}). N’AFFIRME PAS qu’elle est faite : dis à l’utilisateur qu’une demande l’attend.`;
          }
        } else {
          content = asUntrusted(`TOOL_OUTPUT_${call.name}`, outcome.executed.result.content);
          const notice = outcome.executed.result.userNotice;
          if (typeof notice === 'string' && notice.trim() !== '' && !notices.includes(notice.trim())) {
            notices.push(notice.trim());
          }
        }
      }

      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content });
    }

    if (iteration === config.maxIterations) {
      finalText =
        finalText !== ''
          ? finalText
          : `J'ai atteint ma limite de ${config.maxIterations} itérations sans conclusion. Dernier état : ${calls.length > 0 ? 'j’attendais le résultat d’outils' : 'aucune réponse exploitable'}.`;
    }
  }

  const reply = finalText === '' ? 'Le modèle a renvoyé une réponse vide. Reformule ta demande.' : finalText;
  store.addMessage({ chatId, role: 'assistant', content: reply, channel: input.channel ?? 'telegram' });
  store.pruneMessages(chatId, Math.max(config.historyLimit * 4, 200));

  return { text: reply, pending, notices, iterations, toolCalls: toolCallCount, provider, model };
}

/**
 * Après un clic sur « Approuver » : on exécute, puis on laisse l'agent commenter
 * le résultat en une phrase (un seul appel LLM, sans outils).
 */
export async function resolveApproval(
  deps: AgentDeps,
  input: { chatId: number; userId: number; id: number; token: string; approved: boolean },
): Promise<{ message: string; commentary?: string }> {
  const ctx = makeToolContext(deps, input.chatId, input.userId);
  const outcome = await deps.gate.resolve({ ...input, context: ctx });

  if (outcome.toolContent !== undefined) {
    // Trace lisible pour les tours suivants ; marquée « système » pour que le
    // modèle ne la prenne pas pour une parole de l'utilisateur.
    deps.store.addMessage({
      chatId: input.chatId,
      role: 'assistant',
      content: `[action approuvée] ${outcome.toolName} → ${outcome.toolContent}`,
    });
  }
  return { message: outcome.message };
}

function makeToolContext(deps: AgentDeps, chatId: number, userId: number): ToolContext {
  return {
    chatId,
    userId,
    config: deps.config,
    store: deps.store,
    // Les outils ne demandent jamais l'approbation eux-mêmes : c'est la boucle
    // d'agent qui la déclenche, pour qu'il n'y ait qu'un seul chemin d'audit.
    requestApproval: async () => false,
  };
}

function approvalReason(toolName: string, args: Record<string, unknown>): string {
  const preview = JSON.stringify(args);
  return `${toolName} — ${preview.length > 240 ? `${preview.slice(0, 240)}…` : preview}`;
}

/** Mots-clés de recherche mémoire : mots de 3+ lettres, ignorés si requête courte. */
function keywordsOf(text: string): string {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
    .slice(0, 6)
    .join(' ');
}
