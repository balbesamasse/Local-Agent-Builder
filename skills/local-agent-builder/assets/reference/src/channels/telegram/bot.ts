/**
 * Canal Telegram (grammy, long polling — aucun port ouvert sur la machine).
 *
 * Ordre de traitement d'un update :
 *   1. `/id` (seule commande ouverte à tous — voir le commentaire du bootstrap)
 *   2. liste blanche stricte
 *   3. rate-limit
 *   4. commande explicite OU tour d'agent
 *
 * Les updates d'une même conversation sont traités en série : deux tours
 * parallèles se répondraient l'un à l'autre dans le désordre.
 */
import { Bot, InputFile, type Context } from 'grammy';
import { authorize } from '../../security/allowlist.js';
import { RateLimiter } from '../../security/rate-limit.js';
import { runAgent, resolveApproval, type AgentDeps } from '../../core/agent.js';
import { toTelegramHtml, splitForTelegram, fallbackPlain, preview } from './format.js';
import { downloadTelegramFile } from './files.js';
import { shouldSpeak, parseVoiceMode, type VoiceMode } from '../../audio/policy.js';
import { stripForSpeech } from '../../audio/synthesize.js';
import {
  VOICE_PICK_LIMIT,
  matchVoices,
  sortVoices,
  type VoiceCandidate,
  type VoiceCatalog,
} from '../../audio/voices.js';
import { AudioError } from '../../audio/types.js';
import type { RealtimeChannelDeps } from '../../realtime/channel.js';
import type { Synthesizer, Transcriber } from '../../audio/types.js';
import { log } from '../../core/logger.js';

/** Structure brute attendue par Telegram (grammy n'expose pas de type bouton dédié ici). */
type TelegramKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

/** Middleware grammY, typé localement pour ne pas dépendre d'un export instable. */
type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void>;

/**
 * Garde d'accès du canal. Elle ne contient AUCUNE politique de sécurité : elle
 * traduit un update Telegram en `{ userId, hasChat }`, demande la décision à
 * `security/allowlist.ts`, puis l'applique. Un autre canal écrit ses trois lignes
 * à lui et bénéficie des mêmes règles et des mêmes tests.
 */
function allowlistMiddleware(config: AgentDeps['config']): Middleware {
  return async (ctx, next) => {
    const decision = authorize(config, { userId: ctx.from?.id, hasChat: chatIdOf(ctx) !== null });
    if (!decision.allow) {
      if (decision.reply !== null) await ctx.reply(decision.reply).catch(() => {});
      return;
    }
    await next();
  };
}

/** `callback_data` ≤ 64 octets → `a:<id>:<token 43 car.>` = 48 max. */
const VOICE_PREFIX = 'vo:';
const VOICE_CLEAR = 'vo:clear';
const VOICE_REFRESH = 'vo:refresh';
const CALL_PREFIX = 'cb:call:';
const APPROVE_PREFIX = 'a:';
const DENY_PREFIX = 'd:';

/** Ce que le canal doit savoir pour entendre et parler. Tout est optionnel :
 * sans clé ElevenLabs, `synthesizer` est null et le bot reste textuel — il ne
 * « tombe pas » en mode texte, il y est configuré. */
export interface VoiceKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/**
 * Clavier de sélection : deux voix par ligne, la voix en cours marquée d'un ✓.
 *
 * Le `callback_data` porte l'identifiant de voix, pas un index : un index cesserait de
 * désigner la même voix si l'inventaire se rechargeait entre l'affichage et l'appui — et
 * l'identifiant, lui, est revérifié contre le catalogue avant tout usage.
 */
export function voiceKeyboard(candidates: VoiceCandidate[], currentId: string | null): VoiceKeyboard {
  // Le tri est ici, pas chez l'appelant : « la voix courante en tête » est une regle de
  // lisibilite, et une regle qu'on peut oublier est une regle qui sera oubliee.
  const ordered = sortVoices(candidates, currentId ?? '');
  const rows: VoiceKeyboard['inline_keyboard'] = [];
  for (let i = 0; i < ordered.length; i += 2) {
    const row: VoiceKeyboard['inline_keyboard'][number] = [];
    for (const v of ordered.slice(i, i + 2)) {
      row.push({ text: `${v.id === currentId ? '✓ ' : ''}${v.label}`, callback_data: `${VOICE_PREFIX}${v.id}` });
    }
    rows.push(row);
  }
  rows.push([
    { text: '🔄 Recharger la liste', callback_data: VOICE_REFRESH },
    { text: '↩︎ Revenir au défaut (.env)', callback_data: VOICE_CLEAR },
  ]);
  return { inline_keyboard: rows };
}

export interface VoiceStatusView {
  mode: string;
  modeSource: string;
  listening: boolean;
  speaking: boolean;
  /** Nom de la voix en cours, ou son identifiant si l'inventaire ne le connaît pas. */
  currentVoice: string;
  voiceSource: string;
  shown: number;
  total: number;
  selectable: boolean;
}

/** Le texte d'état est une fonction pure : c'est lui que l'utilisateur lit, il est testé. */
export function voiceStatusText(v: VoiceStatusView): string {
  const lines = [
    `Voix : ${v.currentVoice} (${v.voiceSource})`,
    `mode : ${v.mode} — ${v.modeSource}`,
    `écoute : ${v.listening ? 'activée' : 'désactivée'} · parole : ${v.speaking ? 'activée' : 'désactivée'}`,
  ];
  if (!v.selectable) {
    lines.push('Aucune sélection possible : pas de clé ElevenLabs (ou inventaire indisponible).');
    return lines.join('\n');
  }
  lines.push(
    v.total > v.shown
      ? `${v.shown} voix sur ${v.total} affichées — les autres par nom : /voice <début de nom>.`
      : `${v.total} voix sur ce compte. Touche pour choisir (${v.shown} affichées).`,
  );
  lines.push('Usage : /voice on · /voice off · /voice mode always|on_request|mirror|off · /voice par-defaut');
  return lines.join('\n');
}

/** Préférence de voix d'une conversation : lue et écrite par le canal, stockée ailleurs. */
export interface VoicePreference {
  get(chatId: number): string | null;
  set(chatId: number, voiceId: string | null): void;
}

export interface VoiceChannelDeps {
  transcriber: Transcriber | null;
  synthesizer: Synthesizer | null;
  mode: VoiceMode;
  mediaMaxBytes: number;
  /** Inventaire des voix du compte ; `null` = pas de clé, donc pas de sélection possible. */
  catalog: VoiceCatalog | null;
  /** Préférence persistée par conversation ; `null` = pas d'endroit où persister. */
  preference: VoicePreference | null;
}

export interface TelegramChannelDeps {
  config: AgentDeps['config'];
  agent: AgentDeps;
  voice?: VoiceChannelDeps;
  /**
   * Live Voice. `undefined`/`null` = la commande /call existe (le menu ne doit pas mentir par
   * omission) mais explique pourquoi elle est fermee — un bot qui fait semblant de ne pas
   * connaitre sa propre fonctionnalite est plus difficile a debugger qu'un bot qui dit non.
   */
  realtime?: RealtimeChannelDeps | null;
  /**
   * Google Workspace. Comme pour `/call` : la commande existe MÊME quand la capacité est
   * éteinte ou le compte non connecté — elle explique l'état et nomme la commande qui répare.
   * Un bot qui fait semblant d'ignorer sa propre fonctionnalité est plus difficile à débugger
   * qu'un bot qui dit non.
   */
  google?: GoogleChannelDeps | null;
}

export interface GoogleChannelDeps {
  /** Résumé d'état, renvoyé tel quel : services, compte, écritures, ce qui manque. */
  status: () => Promise<string>;
}

export function createTelegramBot(deps: TelegramChannelDeps): Bot {
  const { config, agent } = deps;
  const realtime = deps.realtime ?? null;
  const voice: VoiceChannelDeps = deps.voice ?? {
    transcriber: null,
    synthesizer: null,
    mode: parseVoiceMode(config.voiceMode),
    mediaMaxBytes: config.mediaMaxBytes,
    catalog: null,
    preference: null,
  };
  // Interrupteur par conversation (`/voice off`) : volontairement en mémoire seule.
  // Un redémarrage revient à VOICE_MODE, ce qui est le comportement attendu d'un
  // réglage de session — et ça évite d'écrire une préférence dans une base qui, elle,
  // contient des conversations.
  const voiceOverride = new Map<number, VoiceMode>();
  // apiRoot : laisse la possibilité d'un serveur Bot API auto-hébergé ou d'un
  // relais, sans changer le reste du code (et rend le parcours testable en local).
  const bot = config.telegramApiRoot
    ? new Bot(config.telegramBotToken, { client: { apiRoot: config.telegramApiRoot } })
    : new Bot(config.telegramBotToken);
  const limiter = new RateLimiter({ burst: config.rateLimitBurst, perMinute: config.rateLimitPerMinute });
  const queues = new Map<number, Promise<void>>();
  limiter.startSweeping();

  // --- 1. Bootstrap : /id ----------------------------------------------
  // Trade-off assumé : c'est le seul moyen commode pour le propriétaire de
  // récupérer son chat id avant de l'avoir mis dans la liste blanche. Elle ne
  // renvoie QUE l'id de celui qui la demande (qu'il connaît déjà) et n'appelle
  // ni le LLM, ni la mémoire, ni un outil. À couper après installation avec
  // TELEGRAM_ID_COMMAND_ENABLED=false.
  if (config.idCommandEnabled) {
    bot.command('id', async (ctx) => {
      const id = ctx.from?.id;
      if (typeof id !== 'number') return;
      const allowed = config.allowedUserIds.has(id);
      await ctx.reply(
        `Ton chat id : <code>${id}</code>\n` +
          (allowed ? 'Il figure dans TELEGRAM_ALLOWED_USER_IDS ✅' : 'Il n’est PAS dans TELEGRAM_ALLOWED_USER_IDS ❌'),
        { parse_mode: 'HTML' },
      );
    });
  }

  // --- 2. Liste blanche → 3. rate-limit --------------------------------
  bot.use(allowlistMiddleware(config));

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (typeof userId === 'number' && !limiter.allow(userId)) {
      const wait = limiter.retryAfterSeconds(userId);
      await ctx.reply(`⏳ Trop de requêtes. Réessaie dans ~${wait}s.`).catch(() => {});
      log.warn('rate-limit appliqué', { userId, wait });
      return;
    }
    await next();
  });

  // --- 4. Commandes ----------------------------------------------------
  bot.command('start', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (chatId === null) return;
    await ctx.reply(
      toTelegramHtml(
        `Je suis **${config.agentName}**, ton agent local.\n\n` +
          '• Écris-moi en langage naturel : je réfléchis, j’appelle des outils, je me souviens.\n' +
          '• `/help` les commandes · `/tools` mes capacités réelles\n' +
          '• `/memory` mes souvenirs · `/forget` oublier cette conversation\n\n' +
          `Fuseau : ${config.systemTimezone} · budget : ${config.maxIterations} itérations par demande.`,
      ),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('help', async (ctx) => {
    // Une seule source pour « ce que le bot sait faire » : /help et le menu Telegram
    // (setMyCommands) la lisent tous les deux. Les deux textes ont divergé une fois —
    // /voice était codé, documenté dans /help, et absent du menu, donc invisible.
    const body = CHANNEL_COMMANDS.map((c) => {
      const usage = c.args === '' ? c.command : `${c.command} ${c.args}`;
      return `\`${usage}\` — ${c.help}`;
    }).join('\n');
    await ctx.reply(toTelegramHtml(`**Commandes**\n${body}`), { parse_mode: 'HTML' });
  });

  bot.command('tools', async (ctx) => {
    const defs = agent.registry.definitions();
    const body =
      defs.length === 0
        ? 'Aucun outil disponible.'
        : defs.map((d) => `• \`${d.function.name}\` — ${shorten(d.function.description)}`).join('\n');
    await ctx.reply(toTelegramHtml(`**Outils déclarés auprès du modèle**\n${body}\n\n_Le modèle ne peut appeler que cette liste._`), {
      parse_mode: 'HTML',
    });
  });

  bot.command('google', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (chatId === null) return;
    const google = deps.google ?? null;
    let body: string;
    if (google === null) {
      body =
        '🔑 Google Workspace — non câblé dans ce processus.\n' +
        'Activation : GOOGLE_ENABLED=true dans .env, compte connecté par « npm run google:login » ' +
        'sur la machine de l\'agent, puis redémarrage.\n' +
        '« npm run google:check » dit exactement où tu en es (client, compte, services, écritures).';
    } else {
      try {
        body = await google.status();
      } catch (error) {
        // Un échec de diagnostic doit être dit, pas remplacé par un silence : c'est ce silence
        // qui a fait passer un lien d'appel jamais reçu pour un utilisateur distrait.
        const reason = error instanceof Error ? error.message.slice(0, 160) : 'erreur inconnue';
        log.warn('diagnostic google en échec', { chatId, raison: reason });
        body = `🔑 Google Workspace — état illisible (${reason}). Le compte n'est pas déconnecté pour autant : « npm run google:check` ;
      }
    }
    await ctx.reply(toTelegramHtml(body)).catch(async (error: unknown) => {
      log.warn('réponse /google non reçue par Telegram', { chatId, erreur: String(error).slice(0, 120) });
    });
  });

  bot.command('forget', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (chatId === null) return;
    const removed = agent.store.clearHistory(chatId);
    await ctx.reply(
      `🧹 ${removed} message(s) d’historique supprimé(s). Les souvenirs de longue durée sont intacts (voir /memory).`,
    );
  });

  bot.command('memory', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (chatId === null) return;
    const query = String(ctx.match ?? '').trim();
    const rows = query === '' ? agent.store.listMemories(chatId, 15) : agent.store.searchMemories(chatId, query, 15);
    if (rows.length === 0) {
      await ctx.reply(query === '' ? 'Mémoire vide.' : `Aucun souvenir ne correspond à « ${query} ».`);
      return;
    }
    const body = rows.map((r) => `• [${r.id}] ${r.content.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
    await ctx.reply(toTelegramHtml(`**${rows.length} souvenir(s)**\n${body}\n\n/forget_memory <id> pour supprimer.`), {
      parse_mode: 'HTML',
    });
  });

  bot.command('forget_memory', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (chatId === null) return;
    const id = Number.parseInt(String(ctx.match ?? '').trim(), 10);
    if (!Number.isSafeInteger(id) || id <= 0) {
      await ctx.reply('Usage : `/forget_memory 12` — l’id est affiché par /memory.');
      return;
    }
    await ctx.reply(agent.store.deleteMemory(id, chatId) ? `🗑 Souvenir ${id} supprimé.` : `Rien à supprimer pour l’id ${id}.`);
  });

  bot.command('stats', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (chatId === null) return;
    const audit = agent.store.recentAudit(chatId, 5);
    const lines = audit.length === 0 ? ['aucun appel d’outil journalisé'] : audit.map((a) => `• \`${a.toolName}\` → ${a.status}`);
    await ctx.reply(
      toTelegramHtml(
        `**${config.agentName}**\n` +
          `modèle : \`${config.groqModel}\` · secours : \`${config.groqFallbackModel || '—'}\`${config.openRouterApiKey ? ' + openrouter' : ''}\n` +
          `mémoire : ${agent.store.countMemories(chatId)} souvenir(s) · base : \`${config.dbPath}\`\n` +
          `accès : ${config.allowedUserIds.size} utilisateur(s) autorisé(s)\n\n` +
          `**Derniers appels d’outils**\n${lines.join('\n')}`,
      ),
      { parse_mode: 'HTML' },
    );
  });

  bot.command('pending', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (chatId === null) return;
    const pending = agent.gate.pending(chatId);
    if (pending.length === 0) {
      await ctx.reply('Aucune demande d’approbation en attente.');
      return;
    }
    for (const row of pending) {
      // Le jeton n'est jamais stocké en base (seule son empreinte l'est) : après
      // un redémarrage, les boutons d'avant restent inutilisables, d'où ce texte.
      const token = agent.gate.peekToken(row.id);
      await ctx
        .reply(approvalPrompt(row.toolName, row.reason), {
          parse_mode: 'HTML',
          reply_markup: approvalKeyboard(row.id, token, token === null),
        })
        .catch(() => {});
    }
  });

  // --- Approbation : clic sur un bouton --------------------------------
  // --- /voice : etat, interrupteur de session, et choix de la voix --------
  // Deux reglages, deux portees, et l'asymetrie est deliberee :
  //   le MODE (miroir, toujours, …) reste un reglage de session en memoire seule — un
  //   redemarrage revient a VOICE_MODE, et rien de privé ne trainerait dans la base ;
  //   la VOIX est une identite : elle se persiste (`chats.voice_id`), sinon l'agent
  //   « oublie » qui il parle a chaque arret. Un identifiant opaque n'est pas un contenu.
  const currentVoiceId = (chatId: number): string | null => voice.preference?.get(chatId) ?? null;

  /** Liste triee, voix en cours en tete — meme fonction pour le clavier et le texte. */
  async function loadVoicesFor(chatId: number, refresh: boolean): Promise<VoiceCandidate[]> {
    if (voice.catalog === null) return [];
    const items = await voice.catalog.list({ refresh });
    return sortVoices(items, currentVoiceId(chatId) ?? config.elevenLabsVoiceId);
  }

  /** Un seul endroit ecrit la preference : le message qui la confirme ne peut donc pas diverger. */
  const chooseVoice = (chatId: number, candidate: VoiceCandidate | null): string => {
    if (voice.preference === null) {
      return "Réglage non persistable ici : le canal n'a pas d'endroit où l'écrire.";
    }
    if (candidate === null) {
      voice.preference.set(chatId, null);
      log.info('choix de voix effacé', { chatId });
      const fallback = config.elevenLabsVoiceId === '' ? 'aucune (voix coupée)' : 'celle du .env';
      return `↩︎ Préférence effacée : je reprends la voix par défaut, ${fallback}.`;
    }
    voice.preference.set(chatId, candidate.id);
    // Nom de voix dans le journal, jamais l'identifiant complet : c'est ce que l'humain
    // doit pouvoir retrouver quand quelqu'un demande « pourquoi il a changé de voix ».
    log.info('choix de voix appliqué', { chatId, voix: candidate.name });
    // Pas d'echantillon audio : choisir ne doit couter un appel a personne (decision de
    // l'utilisateur du 2026-09-02). La voix ne s'entend qu'a la reponse suivante.
    return `🎙 Voix : ${candidate.name}. Elle s'applique dès la prochaine réponse parlée — je n'envoie pas d'échantillon, pour ne rien consommer au choix.`;
  };

  async function renderVoiceStatus(
    chatId: number,
    refresh: boolean,
  ): Promise<{ text: string; keyboard: VoiceKeyboard | null }> {
    const mode = voiceOverride.get(chatId) ?? voice.mode;
    const modeSource = voiceOverride.has(chatId) ? 'réglage de session' : `VOICE_MODE=${config.voiceMode}`;
    const savedId = currentVoiceId(chatId);
    const shownId = savedId ?? config.elevenLabsVoiceId;
    let candidates: VoiceCandidate[] = [];
    let loadError: string | null = null;
    try {
      candidates = await loadVoicesFor(chatId, refresh);
    } catch (error) {
      loadError = error instanceof AudioError ? error.message : 'inventaire indisponible';
    }
    const named = candidates.find((v) => v.id === shownId);
    const text = voiceStatusText({
      mode,
      modeSource,
      listening: voice.transcriber !== null,
      speaking: voice.synthesizer !== null,
      // Un identifiant brut n'eclaire personne : on ne l'affiche que si l'inventaire ne
      // connaît pas la voix (compte modifie, cache peime).
      currentVoice: named?.name ?? (shownId === '' ? 'aucune' : `identifiant ${shownId.slice(0, 6)}…`),
      voiceSource:
        savedId !== null
          ? 'choix de cette conversation'
          : config.elevenLabsVoiceId !== ''
            ? 'défaut du .env'
            : 'aucune voix configurée',
      shown: Math.min(candidates.length, VOICE_PICK_LIMIT),
      total: candidates.length,
      selectable: candidates.length > 0,
    });
    if (loadError !== null) {
      return { text: `${text}\n\nRechargement raté : ${loadError}\nLa voix affichée reste celle en cours.`, keyboard: null };
    }
    const keyboard =
      candidates.length > 0 ? voiceKeyboard(candidates.slice(0, VOICE_PICK_LIMIT), savedId ?? config.elevenLabsVoiceId) : null;
    return { text, keyboard };
  }

  bot.command('voice', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (chatId === null) return;
    const args = String(ctx.match ?? '').trim().toLowerCase();
    const say = (text: string, keyboard?: VoiceKeyboard): Promise<unknown> =>
      ctx
        .reply(toTelegramHtml(text), keyboard === undefined ? { parse_mode: 'HTML' } : { parse_mode: 'HTML', reply_markup: keyboard })
        .catch(() => {});

    if (args === '' || args === 'status') {
      const view = await renderVoiceStatus(chatId, false);
      await say(view.text, view.keyboard ?? undefined);
      return;
    }
    if (args === 'on') {
      voiceOverride.set(chatId, 'mirror');
      await say('🔊 Vocal activé en miroir : je réponds en audio quand tu m’écris en audio.');
      return;
    }
    if (args === 'off') {
      voiceOverride.set(chatId, 'off');
      await say('🔇 Vocal désactivé pour cette conversation (jusqu’au prochain redémarrage).');
      return;
    }
    if (args === 'par-defaut' || args === 'par défaut' || args === 'defaut' || args === 'default') {
      await say(chooseVoice(chatId, null));
      return;
    }
    if (args === 'rafraichir' || args === 'refresh') {
      const view = await renderVoiceStatus(chatId, true);
      await say(view.text, view.keyboard ?? undefined);
      return;
    }
    const [head, tail] = args.split(/\s+/);
    if (head === 'mode' && tail !== undefined) {
      const known = ['off', 'mirror', 'always', 'on_request'];
      if (!known.includes(tail)) {
        await say(`Mode inconnu. Choix : ${known.join(', ')}.`);
        return;
      }
      voiceOverride.set(chatId, tail as VoiceMode);
      await say(`🎛 Mode voix de cette conversation : ${tail}.`);
      return;
    }

    // `/voice <debut de nom>` : la voie texte du meme selecteur — utile au-dela des
    // 24 boutons affiches, et quand on sait deja ce qu'on veut.
    if (voice.catalog === null) {
      await say('Pas de clé ElevenLabs : aucune voix à choisir. Le mode miroir, lui, reste réglable (/voice on ou off).');
      return;
    }
    let candidates: VoiceCandidate[];
    try {
      candidates = await loadVoicesFor(chatId, false);
    } catch (error) {
      await say(
        `Inventaire des voix indisponible : ${error instanceof AudioError ? error.message : 'erreur réseau'}.\nRéessaie avec /voice rafraichir.`,
      );
      return;
    }
    const hits = matchVoices(candidates, args);
    if (hits.length === 0) {
      const sample = candidates.slice(0, 4).map((v) => v.name).join(', ');
      await say(
        `Aucune voix ne correspond à « ${args} ».${sample === '' ? '' : ` Exemples : ${sample}.`}${
          candidates.length > 4 ? ` et ${candidates.length - 4} autres.` : ''
        }\n/voice seul affiche la liste à toucher.`,
      );
      return;
    }
    if (hits.length > 1) {
      await say(
        `« ${args} » désigne ${hits.length} voix : ${hits.slice(0, 8).map((v) => v.name).join(', ')}${hits.length > 8 ? '…' : ''}.\nPrécise, ou touche un bouton (/voice).`,
      );
      return;
    }
    const only = hits[0]!;
    await say(chooseVoice(chatId, only));
  });

  // --- Appel vocal en direct --------------------------------------------
  // Le lien est a usage unique et meurt au bout de REALTIME_TICKET_TTL_SECONDS : un
  // `editMessageText` ferait croire que le vieux bouton marche encore. On renvoie donc un
  // message NEUF a chaque demande, avec deux lignes de securite — l'utilisateur doit savoir
  // ou va son micro avant de l'ouvrir.
  const replyCall = async (ctx: Context, action: 'new' | 'stop' | 'status'): Promise<void> => {
    const chatId = chatIdOf(ctx);
    if (chatId === null) return;
    const say = async (text: string, keyboard?: TelegramKeyboard): Promise<void> => {
      // Un `.catch(() => {})` ici avait transforme un refus de l'API Telegram en « rien ne se
      // passe » : ni reponse, ni log, ni test rouge. Une reponse qui ne part pas se nomme.
      try {
        await ctx.reply(
          toTelegramHtml(text),
          keyboard === undefined ? { parse_mode: 'HTML' } : { parse_mode: 'HTML', reply_markup: keyboard },
        );
      } catch (error) {
        log.warn('réponse /call non envoyée', {
          motif: error instanceof Error ? error.message.slice(0, 140) : 'erreur inconnue',
        });
      }
    };

    if (action === 'stop') {
      if (realtime === null) {
        await say('Aucun appel en cours (mode live voice coupé côté service).');
        return;
      }
      if (await realtime.end(chatId, 'raccroché depuis Telegram')) {
        await say('📴 Appel terminé. La conversation reste dans ma mémoire, comme un message écrit.');
      } else {
        await say('Aucun appel ouvert pour cette conversation.');
      }
      return;
    }

    if (action === 'status') {
      const status = realtime?.status(chatId) ?? null;
      await say(status === null ? 'Aucun appel ouvert.' : `Appel en cours : ${status.turns} échange(s). /call stop pour raccrocher.`);
      return;
    }

    if (realtime === null || !realtime.listening) {
      await say(
        'Le mode appel est coupé côté service (REALTIME_ENABLED=false, ou hub non démarré).\n' +
          'Les messages vocaux n’ont pas besoin de ce hub : envoie-moi un vocal, je l’écoute et je réponds.',
      );
      return;
    }
    const userId = ctx.from?.id;
    if (typeof userId !== 'number') return;
    log.info('appel demandé', { chatId });
    const link = realtime.linkFor(chatId, userId);
    if (link === null) {
      log.warn('lien d’appel impossible à émettre', { chatId });
      await say('Le lien de connexion n’a pas pu être émis (le hub ne répond pas).');
      return;
    }
    await say(
      `📞 Ouvre cet appel — usage unique, ${config.realtimeTicketTtlSeconds} s pour le saisir :\n${link}\n\n` +
        'Le son ne passe pas par Telegram : l’API Bot ne transporte pas d’appel. La page ouvre un flux direct avec l’agent ' +
        `(${config.realtimeBind}:${config.realtimePort}), ton micro n’est jamais écrit sur le disque, et tu peux me couper la parole.\n` +
        `_${config.realtimeMaxMinutes} min maximum, ${config.realtimeMaxTurns} échanges._`,
      callKeyboard(),
    );
  };

  bot.command('call', async (ctx) => {
    const args = String(ctx.match ?? '').trim().toLowerCase();
    if (args === 'stop' || args === 'raccrocher' || args === 'end') return replyCall(ctx, 'stop');
    if (args === 'etat' || args === 'status') return replyCall(ctx, 'status');
    if (args === '' || args === 'new' || args === 'démarrer' || args === 'demarrer' || args === 'link' || args === 'lien') {
      return replyCall(ctx, 'new');
    }
    await ctx
      .reply(toTelegramHtml('Usage : `/call` (un lien d’appel), `/call stop`, `/call etat`.'), { parse_mode: 'HTML' })
      .catch(() => {});
  });

  bot.on('callback_query:data', async (ctx) => {
    const chatId = chatIdOf(ctx);
    const data = ctx.callbackQuery.data;

    // /call depuis un bouton : on rend la meme decision que la commande, sans dupliquer la
    // logique (un clic n'est pas un droit supplementaire, et un lien doit mourir pareil).
    if (data.startsWith(CALL_PREFIX)) {
      if (chatId === null) {
        await ctx.answerCallbackQuery({ text: 'Contexte de conversation introuvable.' }).catch(() => {});
        return;
      }
      const action = data.slice(CALL_PREFIX.length);
      await ctx
        .answerCallbackQuery({
          text: action === 'stop' ? 'Appel fermé' : action === 'status' ? 'appel ouvert ou non' : 'Nouveau lien émis',
        })
        .catch(() => {});
      // Un clic n'ajoute aucun droit : la décision est celle de la commande, pas d'un raccourci.
      if (action === 'stop') await replyCall(ctx, 'stop');
      else if (action === 'status') await replyCall(ctx, 'status');
      else await replyCall(ctx, 'new');
      return;
    }

    // Touches du selecteur de voix. L'identifiant vient d'un clic, donc du monde exterieur :
    // il n'est jamais fait confiance a sa forme — il doit exister dans l'inventaire que NOUS
    // avons recharge, sinon la requete de synthese partirait avec une voix inventee.
    if (data.startsWith(VOICE_PREFIX)) {
      if (chatId === null) {
        await ctx.answerCallbackQuery({ text: 'Contexte de conversation introuvable.' });
        return;
      }
      const rest = data.slice(VOICE_PREFIX.length);
      let notice: string;
      if (rest === 'clear') {
        notice = chooseVoice(chatId, null);
      } else if (rest === 'refresh') {
        notice = 'Inventaire rechargé.';
      } else {
        let candidates: VoiceCandidate[];
        try {
          candidates = await loadVoicesFor(chatId, false);
        } catch (error) {
          await ctx
            .answerCallbackQuery({ text: `Inventaire indisponible : ${error instanceof AudioError ? error.message : 'erreur réseau'}` })
            .catch(() => {});
          return;
        }
        const picked = candidates.find((v) => v.id === rest);
        if (picked === undefined) {
          log.warn('choix de voix refusé : identifiant absent de l’inventaire', { attendu: rest.slice(0, 6) + '…' });
          await ctx
            .answerCallbackQuery({ text: 'Cette voix n’est plus sur le compte — recharge la liste.', show_alert: true })
            .catch(() => {});
          return;
        }
        notice = chooseVoice(chatId, picked);
      }
      await ctx.answerCallbackQuery({ text: rest === 'clear' ? 'Voix par défaut' : 'Voix enregistrée' }).catch(() => {});
      const view = await renderVoiceStatus(chatId, rest === 'refresh');
      try {
        await ctx.editMessageText(toTelegramHtml(view.text), {
          parse_mode: 'HTML',
          ...(view.keyboard === null ? {} : { reply_markup: view.keyboard }),
        });
      } catch {
        // Le message d'origine a pu etre supprime, ou le texte est identique : on repond
        // par un message neuf plutot que de perdre la confirmation.
        await ctx.reply(toTelegramHtml(`${notice}

${view.text}`), { parse_mode: 'HTML' }).catch(() => {});
      }
      return;
    }

    const approved = data.startsWith(APPROVE_PREFIX);
    if (!approved && !data.startsWith(DENY_PREFIX)) {
      await ctx.answerCallbackQuery();
      return;
    }
    if (chatId === null || ctx.from === undefined) {
      await ctx.answerCallbackQuery({ text: 'Contexte de conversation introuvable.' });
      return;
    }
    const [, rawId, token = ''] = data.slice(2).split(':');
    const id = Number.parseInt(rawId ?? '', 10);
    if (!Number.isSafeInteger(id) || id <= 0) {
      await ctx.answerCallbackQuery({ text: 'Demande illisible.' });
      return;
    }
    await ctx.answerCallbackQuery({ text: approved ? 'Approuvé' : 'Annulé' });

    await enqueue(queues, chatId, async () => {
      const outcome = await resolveApproval(agent, { chatId, userId: ctx.from.id, id, token, approved });
      await bot.api.sendMessage(chatId, toTelegramHtml(outcome.message), { parse_mode: 'HTML' }).catch((err: unknown) => {
        log.error('résultat d’approbation non envoyé', { error: String(err) });
      });
    });
  });

  // --- Médias : refus explicite (et non un silence trompeur) ----------
  for (const kind of [
    'message:video_note',
    'message:video',
    'message:photo',
    'message:sticker',
    'message:document',
    'message:contact',
    'message:location',
    'message:poll',
  ] as const) {
    bot.on(kind, async (ctx) => {
      await ctx.reply(
        'Ce format n’est pas traité : je lis les vocaux et les notes audio, et le texte. Pour les documents, sers-toi de /start.',
      );
    });
  }

  /** Envoie la réponse vocale si la politique le décide. Ne lève jamais : un
   * échec de synthèse ne doit pas faire perdre la réponse texte déjà partie. */
  async function maybeSpeak(ctx: Context, chatId: number, replyText: string, hadVoice: boolean, userText: string, hasPending: boolean): Promise<void> {
    const synth = voice.synthesizer;
    if (synth === null) return;
    const mode = voiceOverride.get(chatId) ?? voice.mode;
    const decision = shouldSpeak(mode, {
      hadVoice,
      userText,
      hasPendingApproval: hasPending,
      emptyText: stripForSpeech(replyText).length === 0,
    });
    if (!decision.speak) {
      if (config.debug) log.info('vocal non envoyé', { chatId, raison: decision.reason });
      return;
    }
    try {
      void ctx.api.sendChatAction(chatId, 'upload_voice').catch(() => {});
      // Voix de cette conversation si elle en a choisi une, sinon le defaut du .env.
      const speech = await synth.synthesize(replyText, voice.preference?.get(chatId) ?? undefined);
      await bot.api.sendVoice(chatId, new InputFile(Buffer.from(speech.bytes), speech.fileName), {
        ...(speech.truncated
          ? { caption: toTelegramHtml(`extrait parlé (${speech.chars} caractères) — la réponse complète est juste au-dessus`) }
          : {}),
      });
      log.info('vocal envoyé', { chatId, fournisseur: synth.name, caractères: speech.chars, octets: speech.bytes.byteLength, tronque: speech.truncated });
    } catch (error) {
      // Le détail reste ici : le message de l'exception peut contenir l'URL, donc
      // l'identifiant de voix. L'utilisateur, lui, garde sa réponse texte.
      log.warn('vocal non envoyé (synthèse en échec)', {
        chatId,
        type: error instanceof Error ? error.name : 'erreur inconnue',
      });
    }
  }

  /** Corps partagé des tours : texte brut ou transcription, même pipeline. */
  async function turnBody(ctx: Context, chatId: number, input: { text: string; hadVoice: boolean }): Promise<void> {
    const text = input.text;
    // Ressaisi local : les handlers appellants vérifient déjà `ctx.from`, mais un
    // closure async ne conserve pas le narrowing — et deviner ici serait un plantage.
    const from = ctx.from;
    if (from === undefined) return;
    const isGroup = ctx.chat !== undefined && ctx.chat.type !== 'private';
      const keepTyping = setInterval(() => {
        void ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
      }, 4000);
      void ctx.api.sendChatAction(chatId, 'typing').catch(() => {});
      try {
        const result = await runAgent(agent, {
          chatId,
          userId: from.id,
          text,
          title: 'title' in ctx.chat! ? (ctx.chat!.title ?? null) : null,
          isGroup,
        });

        await sendChunks(bot, chatId, result.text);
        await maybeSpeak(ctx, chatId, result.text, input.hadVoice, text, result.pending.length > 0);

        // Les avis operatifs partent dans leur propre message : melange a la reponse, ils
        // seraient lus a voix haute pendant un appel — et une ligne de commande prononcee n'est
        // pas une information, c'est un bruit.
        for (const notice of result.notices ?? []) {
          await bot.api.sendMessage(chatId, notice).catch((err: unknown) => {
            log.warn('avis d’outil non envoyé', { chatId, erreur: String(err).slice(0, 140) });
          });
        }

        for (const item of result.pending) {
          await bot.api
            .sendMessage(chatId, approvalPrompt(item.toolName, item.reason), {
              parse_mode: 'HTML',
              reply_markup: approvalKeyboard(item.id, item.token, false),
            })
            .catch((err: unknown) => log.error('demande d’approbation non envoyée', { error: String(err) }));
        }

        log.info('tour traité', {
          chatId,
          iterations: result.iterations,
          toolCalls: result.toolCalls,
          provider: result.provider,
          model: result.model,
          entree: preview(text),
          origine: input.hadVoice ? 'vocal' : 'texte',
        });
      } catch (error) {
        log.error('échec inattendu du tour d’agent', { chatId, error: error instanceof Error ? error.message : String(error) });
        await bot.api
          .sendMessage(chatId, '💥 Erreur interne. Le détail est dans les journaux de la machine — rien n’a été exposé ici.')
          .catch(() => {});
      } finally {
        clearInterval(keepTyping);
      }
  }

  // --- Tour d'agent sur message texte ----------------------------------
  bot.on('message:text', async (ctx) => {
    const chatId = chatIdOf(ctx);
    if (chatId === null || ctx.from === undefined) return;
    await enqueue(queues, chatId, () => turnBody(ctx, chatId, { text: ctx.message.text, hadVoice: false }));
  });

  // --- Vocaux et notes audio : transcription, puis le même tour --------
  // Le texte reconnu est traité exactement comme un message texte de l'utilisateur :
  // il passe par la boucle d'agent, donc par l'encadrement « donnée non fiable ».
  // Il ne gagne AUCUN droit supplémentaire du fait qu'il vient d'un audio.
  const audioHandler = async (ctx: Context): Promise<void> => {
    const chatId = chatIdOf(ctx);
    const from = ctx.from;
    const msg = ctx.message;
    if (chatId === null || from === undefined || msg === undefined) return;

    const attachment =
      'voice' in msg && msg.voice !== undefined
        ? msg.voice
        : 'audio' in msg && msg.audio !== undefined
          ? msg.audio
          : undefined;
    if (attachment === undefined) return;

    if (voice.transcriber === null) {
      await ctx.reply('🎙 La transcription est désactivée (aucune clé Groq ni ElevenLabs). Écris-moi en texte.').catch(() => {});
      return;
    }
    const declared = typeof attachment.file_size === 'number' ? attachment.file_size : 0;
    if (declared > voice.mediaMaxBytes) {
      await ctx
        .reply(`📏 Fichier trop volumineux (${(declared / 1048576).toFixed(1)} Mo) — le plafond est à ${(voice.mediaMaxBytes / 1048576).toFixed(1)} Mo.`)
        .catch(() => {});
      return;
    }

    await enqueue(queues, chatId, async () => {
      void ctx.api.sendChatAction(chatId, 'typing').catch(() => {});

      // `file_path` n'est PAS sur la pièce jointe : il vient de getFile, et c'est une
      // valeur renvoyée par le serveur — donc non fiable, d'où la validation en aval.
      let filePath = '';
      try {
        const info = await bot.api.getFile(attachment.file_id);
        filePath = info.file_path ?? '';
      } catch (error) {
        log.warn('getFile refusé par Telegram', {
          chatId,
          raison: error instanceof Error ? error.message.slice(0, 80) : 'erreur inconnue',
        });
        await ctx.reply('🎙 Telegram n’a pas voulu me donner ce fichier.').catch(() => {});
        return;
      }

      let audio;
      try {
        audio = await downloadTelegramFile({
          apiRoot: config.telegramApiRoot,
          botToken: config.telegramBotToken,
          filePath,
          maxBytes: voice.mediaMaxBytes,
          timeoutMs: config.llmTimeoutMs,
          // Ce que Telegram déclare sur la pièce jointe passe avant ce que le nom du
          // fichier laisserait deviner — `files/voice_file_1` n'a pas d'extension.
          declaredMime:
            typeof attachment.mime_type === 'string' && attachment.mime_type !== ''
              ? attachment.mime_type
              : // Un message vocal Telegram EST un OGG/Opus 48 kb/s par spécification : en
                // l'absence de déclaration, ce n'est pas une supposition mais une garantie du
                // protocole — et sans extension au fournisseur, le fichier est refusé.
                (`voice` in msg ? 'audio/ogg' : undefined),  // `msg` : la copie déjà réduite du handler
        });
      } catch (error) {
        log.warn('média refusé ou indisponible', {
          chatId,
          raison: error instanceof Error ? error.message : 'erreur inconnue',
        });
        await ctx
          .reply('🎙 Je n’ai pas pu récupérer ce fichier (trop volumineux, forme refusée, ou Telegram indisponible).')
          .catch(() => {});
        return;
      }

      let transcript;
      try {
        transcript = await voice.transcriber!.transcribe({
          bytes: audio.bytes,
          mime: audio.mime,
          fileName: audio.fileName,
          languageHint: typeof from.language_code === 'string' ? from.language_code : undefined,
        });
      } catch (error) {
        // Le motif est journalisé : « AudioError » seul n'aide personne à corriger. On
        // ne remonte que nos propres messages (statut, nom de champ), jamais le corps du
        // fournisseur — il peut contenir un nom de fichier ou un solde de compte.
        // `AudioError.status` est `number | null` : null = nous n'avons rien envoyé. Comparer
        // à `undefined` rendait la branche muette et le message moins précis (attrapé par un
        // test, pas par la relecture — la règle habituelle).
        const statut = error instanceof AudioError ? error.status : null;
        log.warn('transcription en échec', {
          chatId,
          raison: error instanceof Error ? error.message.slice(0, 140) : 'erreur inconnue',
          statut: statut === null ? 'aucun appel émis' : statut,
        });
        const message = error instanceof Error ? error.message : '';
        await ctx
          .reply(
            statut === null
              ? `🎙 ${message || 'Format audio non reconnu'}. Un vocal Telegram (.ogg) passe normalement — réessaie, ou écris-moi.`
              : '🎙 La transcription n’a pas abouti (fournisseur indisponible). Ta réponse texte, elle, fonctionne toujours.',
          )
          .catch(() => {});
        return;
      }

      if (transcript.text === '') {
        await ctx.reply('🎙 Je n’ai rien entendu d’exploitable dans ce vocal.').catch(() => {});
        return;
      }

      log.info('vocal transcrit', {
        chatId,
        fournisseur: transcript.provider,
        modele: transcript.model,
        caracteres: transcript.text.length,
        duree: transcript.durationSec,
      });
      await turnBody(ctx, chatId, { text: transcript.text, hadVoice: true });
    });
  };

  bot.on('message:voice', audioHandler);
  bot.on('message:audio', audioHandler);

  bot.catch((err) => {
    log.error('grammy', { error: err.error instanceof Error ? err.error.message : err.message });
  });

  return bot;
}

// ----------------------------------------------------------------- helpers ---

/**
 * Toutes les commandes ouvertes par le canal, avec leur mode d'emploi.
 *
 * /help l'affiche telle quelle, `menuCommands()` en tire le menu Telegram : une commande
 * ajoutée ici est donc décrite ET dans l'aide ET dans le menu. Le menu ne peut contenir
 * que des noms sans paramètre, d'où l'absence de `forget_memory` (et de `<mots-clés>`) —
 * ce sont les arguments, pas la commande, qui décident.
 */
export const CHANNEL_COMMANDS: ReadonlyArray<{
  command: string;
  args: string;
  help: string;
  menu: string;
}> = [
  { command: 'start', args: '', help: 'présentation', menu: 'Présentation' },
  { command: 'help', args: '', help: 'cette aide', menu: 'Aide et commandes' },
  { command: 'id', args: '', help: 'ton chat id', menu: 'Mon chat id' },
  { command: 'tools', args: '', help: 'outils réellement disponibles', menu: 'Outils disponibles' },
  { command: 'memory', args: '<mots-clés>', help: 'lire la mémoire (sans argument : les plus récents)', menu: 'Mes souvenirs' },
  { command: 'forget', args: '', help: 'effacer l’historique de cette conversation', menu: 'Oublier cette conversation' },
  { command: 'forget_memory', args: '<id>', help: 'supprimer un souvenir précis', menu: 'Supprimer un souvenir (id)' },
  { command: 'stats', args: '', help: 'compteurs et derniers appels d’outils', menu: 'État et audit' },
  { command: 'pending', args: '', help: 'redemander les approbations en attente', menu: 'Approbations en attente' },
  { command: 'voice', args: '', help: 'toucher une voix du compte pour la changer · on/off/mode', menu: 'Choisir ma voix' },
  // args vide : le menu doit porter la commande (c'est le trajet principal), les variantes
  // (stop, etat) vivent dans l'aide — sinon le menu afficherait /call <démarrer> que le
  // client ne peut pas envoyer d'une tape.
  { command: 'call', args: '', help: 'appel vocal en direct · stop pour raccrocher · etat', menu: 'Appel vocal en direct' },
  { command: 'google', args: '', help: 'compte Google connecté, services, écritures', menu: 'Compte Google' },
];

/**
 * Le menu que Telegram affiche (bout « / », autocomplétion). Dérivé de CHANNEL_COMMANDS :
 * le recopier à la main dans le bootstrap est exactement ce qui a fait disparaître /voice
 * du menu, alors que le handler, lui, répondait très bien.
 */
export function menuCommands(): Array<{ command: string; description: string }> {
  return CHANNEL_COMMANDS.filter((c) => c.args === '').map((c) => ({ command: c.command, description: c.menu }));
}

/** `ctx.chat` est optionnel en typage (canal/inline) : on centralise la garde. */
function chatIdOf(ctx: Context): number | null {
  const direct = ctx.chat?.id;
  if (typeof direct === 'number') return direct;
  const fromCallback = ctx.callbackQuery && 'message' in ctx.callbackQuery ? ctx.callbackQuery.message?.chat.id : undefined;
  return typeof fromCallback === 'number' ? fromCallback : null;
}

function enqueue(queues: Map<number, Promise<void>>, chatId: number, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(chatId) ?? Promise.resolve();
  const next = previous.then(task, task).then(() => {
    if (queues.get(chatId) === next) queues.delete(chatId);
  });
  queues.set(chatId, next);
  return next;
}

async function sendChunks(bot: Bot, chatId: number, text: string): Promise<void> {
  const html = toTelegramHtml(text);
  for (const chunk of splitForTelegram(html)) {
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
    } catch {
      // Balisage refusé (imbrication invalide) : repli texte neutre.
      await bot.api.sendMessage(chatId, fallbackPlain(chunk)).catch(() => {});
    }
  }
}

function approvalPrompt(toolName: string, reason: string): string {
  return toTelegramHtml(
    `⚠️ **Approbation requise**\n\nOutil : \`${toolName}\`\nDétail : ${reason}\n\n` +
      'Rien n’a encore été exécuté. Cette demande expire au bout de 15 minutes.',
  );
}

function approvalKeyboard(id: number, token: string | null, disabled: boolean): TelegramKeyboard {
  if (disabled) {
    return { inline_keyboard: [[{ text: '🔒 redémarre la demande (jeton perdu)', callback_data: `${DENY_PREFIX}${id}:` }]] };
  }
  const secret = token ?? '';
  return {
    inline_keyboard: [
      [
        { text: '✅ Approuver', callback_data: `${APPROVE_PREFIX}${id}:${secret}` },
        { text: '🚫 Annuler', callback_data: `${DENY_PREFIX}${id}:${secret}` },
      ],
    ],
  };
}

/** Deux touches, pas davantage : le lien arrive dans le message, le reste est du texte. */
export function callKeyboard(): TelegramKeyboard {
  return {
    inline_keyboard: [
      [
        { text: '📞 Nouvel lien', callback_data: `${CALL_PREFIX}new` },
        { text: '📴 Raccrocher', callback_data: `${CALL_PREFIX}stop` },
      ],
    ],
  };
}

/** Bilan d'appel : ce que l'utilisateur a entendu, et ce que ça a coûté en voix. */
export function formatCallSummary(summary: {
  turns: number;
  seconds: number;
  speechChars: number;
  interruptedTurns: number;
  endReason: string;
  ear: string;
  spokenTurns: number;
}): string {
  const minutes = Math.floor(summary.seconds / 60);
  const seconds = summary.seconds % 60;
  const parts = [
    `⏱ ${minutes} min ${String(seconds).padStart(2, '0')}`,
    `${summary.turns} échange(s)`,
    `${summary.spokenTurns} réponse(s) parlée(s)`,
  ];
  if (summary.interruptedTurns > 0) parts.push(`${summary.interruptedTurns} interruption(s)`);
  if (summary.speechChars > 0) parts.push(`${summary.speechChars} caractères de voix`);
  return `📴 Appel terminé — ${parts.join(' · ')}\nMotif : ${summary.endReason}.\nOreille : ${summary.ear}.` +
    (summary.turns === 0 ? ' Aucun échange transcrit : rien n’a été facturé côté cerveau.' : ' La conversation est dans ma mémoire.');
}

function shorten(text: string, max = 90): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}
