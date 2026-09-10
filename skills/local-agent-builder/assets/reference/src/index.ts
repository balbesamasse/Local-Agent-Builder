/**
 * Point d'entrée : câble les modules et démarre le long polling.
 *
 * Aucun serveur HTTP n'est créé — la machine n'écoute sur aucun port.
 * L'ordre d'initialisation est volontaire : config validée → secrets masqués →
 * SQLite → LLM → outils → canal. Une config invalide fait sortir le processus
 * avec un message actionnable, sans jamais tenter de démarrage partiel.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, describeConfig, ConfigError } from './config.js';
import { log, registerSecrets, setDebug, setLogFile } from './core/logger.js';
import { exitCodeFor, installCrashGuards, EX_TEMPFAIL } from './core/guard.js';
import { Store } from './memory/store.js';
import { buildProviders, LlmChain } from './llm/providers.js';
import { checkConfiguredModels } from './llm/model-check.js';
import { buildTranscriber } from './audio/transcribe.js';
import { buildSynthesizer } from './audio/synthesize.js';
import { checkVoiceAvailability } from './audio/eleven-check.js';
import { buildVoiceCatalog } from './audio/voices.js';
import { parseVoiceMode } from './audio/policy.js';
import { buildRegistry } from './tools/index.js';
import { createGoogleRuntime, googleUnavailableStatus } from './google/index.js';
import { ApprovalGate } from './security/approvals.js';
import type { AgentDeps } from './core/agent.js';
import { createTelegramBot, menuCommands, formatCallSummary } from './channels/telegram/bot.js';
import type { RealtimeChannelDeps } from './realtime/channel.js';

/** Échec d'écoute du hub : temporaire par nature (port pris, interface qui nabane pas encore). */
class RealtimeUnavailableError extends Error {
  override readonly name = 'RealtimeUnavailableError';
}
import { buildRealtimeBundle } from './realtime/wire.js';
import { log as realtimeLog } from './core/logger.js';

/**
 * La version vient de `package.json`, pas d'une chaîne recopiée ici : le bandeau affichait
 * encore `v0.1.0` après le passage en 0.2.0, et un journal qui raconte une version fausse
 * fait chercher un bug dans le mauvais binaire. Le chemin est relatif au module, donc il
 * marche depuis `src/` (tsx) comme depuis `dist/` (node).
 */
function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'inconnue';
  } catch {
    return 'inconnue'; // le bandeau ne vaut pas un arrêt de service
  }
}

/** Hook de fermeture propre, branché dès que la base existe (voir installCrashGuards). */
let crashClose: (() => void) | undefined;

async function main(): Promise<void> {
  const config = loadConfig();
  // Journal sur disque dès que la config est lue : un agent dont la trace ne vit que sur
  // stdout ne laisse rien derrière lui quand son stdout meurt avec lui — c'est exactement
  // ce qui a rendu « il s'est arrêté tout seul » impossible à expliquer au réveil.
  setLogFile(config.logFile);
  setDebug(config.debug);

  // Pièges de dernière chance, posés une fois la config validée : en amont, une ConfigError
  // est une réponse saine, pas un plantage à journaliser deux fois.
  installCrashGuards({
    onFatal: () => {
      try {
        crashClose?.();
      } catch {
        /* la base est peut-être déjà fermée : on ne remplace pas la cause du crash */
      }
    },
  });

  // Masquage enregistré AVANT tout log ultérieur.
  registerSecrets([config.telegramBotToken, config.groqApiKey, config.openRouterApiKey, config.elevenLabsApiKey]);

  log.info(`— ${config.agentName} v${packageVersion()} —`);
  for (const line of describeConfig(config)) log.info(line);

  const store = new Store(config.dbPath);
  crashClose = () => store.close(); // WAL compacté même si on meurt d'une exception
  log.info('base SQLite prête', { path: config.dbPath });

  // On interroge le fournisseur AVANT d'ouvrir le canal : une clé mauvaise ou un
  // nom de modèle inventé doit être crié au démarrage, pas reprocher à l'utilisateur
  // au bout de dix secondes de silence.
  if (config.validateModelsAtBoot) {
    const check = await checkConfiguredModels(config);
    for (const warning of check.warnings) log.warn(warning);
    if (check.fatal) throw new ConfigError(check.fatal);
    if (check.verified.length > 0) log.info('modèles vérifiés chez le fournisseur', { modeles: check.verified.join(', ') });

    // Même doctrine pour la voix : on vérifie l'identifiant de voix et les modèles
    // sur LE compte, au démarrage, avant que quelqu'un parle pour rien.
    const voiceCheck = await checkVoiceAvailability(config);
    for (const warning of voiceCheck.warnings) log.warn(warning);
    if (voiceCheck.fatal) throw new ConfigError(voiceCheck.fatal);
    if (voiceCheck.verified.length > 0) log.info('voix vérifiée chez ElevenLabs', { verifie: voiceCheck.verified.join(', ') });
  }

  const llm = new LlmChain(buildProviders(config));

  // Google Workspace : le seul morceau de l'agent qui touche des donnees personnelles hors du
  // depot. Il ne leve jamais — un bot prive de Gmail vaut mieux qu'un bot qui ne demarre pas —
  // et il ecrit la raison exacte de son absence (binaire, compte, verrous).
  const google = await createGoogleRuntime(config);
  for (const warning of google.warnings) log.warn(warning);
  const registry = buildRegistry(config, google.runtime?.tools ?? []);
  const gate = new ApprovalGate(store, registry, config.approvalTtlMinutes);
  const agent: AgentDeps = { config, llm, store, registry, gate };

  log.info('capacités déclarées', { tools: registry.names().join(', ') });

  // Voix : la clé ElevenLabs active les deux côtés ; sans elle, le bot reste
  // textuel par configuration (et non par dégradation silencieuse).
  const transcriber = buildTranscriber({
    groqApiKey: config.groqApiKey,
    groqBaseUrl: config.groqBaseUrl,
    whisperModel: config.whisperModel,
    elevenLabsApiKey: config.elevenLabsApiKey,
    elevenLabsBaseUrl: config.elevenLabsBaseUrl,
    elevenLabsSttModel: config.elevenLabsSttModel,
    transcriptionOrder: config.transcriptionOrder,
    llmTimeoutMs: config.llmTimeoutMs,
  });
  const synthesizer = buildSynthesizer({
    elevenLabsApiKey: config.elevenLabsApiKey,
    elevenLabsBaseUrl: config.elevenLabsBaseUrl,
    elevenLabsVoiceId: config.elevenLabsVoiceId,
    elevenLabsTtsModel: config.elevenLabsTtsModel,
    elevenLabsStability: config.elevenLabsStability,
    elevenLabsSimilarity: config.elevenLabsSimilarity,
    ttsMaxChars: config.ttsMaxChars,
    llmTimeoutMs: config.llmTimeoutMs,
    voiceMode: config.voiceMode,
  });
  log.info('voix câblée', {
    mode: config.voiceMode,
    ecoute: transcriber === null ? 'désactivée' : 'activée',
    parole: synthesizer === null ? 'désactivée' : 'activée',
  });

  // Catalogue de voix : c'est lui qui alimente le selecteur de `/voice`, donc la liste
  // refletée a l'utilisateur est celle du compte, pas une liste recopiee dans un .env.
  const voiceCatalog = buildVoiceCatalog({
    apiKey: config.elevenLabsApiKey,
    baseUrl: config.elevenLabsBaseUrl,
    timeoutMs: config.llmTimeoutMs,
  });

  // Live Voice : le SEUL morceau du projet qui ouvre un port. Il n'existe que si la config le
  // demande, et le hub ne sert que la page d'appel + un websocket sur ticket à usage unique.
  // La fabrique est montée même si le hub est éteint : `/call` doit pouvoir EXPLIQUER pourquoi
  // il ne répond pas, au lieu de disparaître du menu ou de rendre un lien mort.
  // Le paquetage vu par le canal est hoisté et MUTABLE : `listening` ne devient `true`
  // qu'après l'écoute réelle du hub. Le figer à la construction du bot enverrait l'utilisateur
  // sur un port pas encore ouvert.
  let channelRealtime: RealtimeChannelDeps | null = null;
  const realtime = config.realtimeEnabled
    ? buildRealtimeBundle({
        config,
        agent,
        transcriber,
        voiceFor: (chatId) => store.getChatVoice(chatId),
        sendChatText: async (chatId, text) => {
          await bot.api.sendMessage(chatId, text).catch(() => {});
        },
        greeting: 'Appel ouvert. Je t’écoute — parle normalement, tu peux me couper la parole.',
      })
    : null;

  const bot = createTelegramBot({
    config,
    agent,
    realtime:
      config.realtimeEnabled && realtime !== null
        ? (channelRealtime = {
            listening: false,
            linkFor: (chatId, userId) => realtime.hub.linkFor(realtime.hub.issueTicket(chatId, userId)),
            status: (chatId) => {
              const session = realtime.hub.activeSession(chatId);
              return session === null ? null : { active: session.active, turns: session.turnCount };
            },
            end: (chatId, reason) => realtime.hub.endChat(chatId, reason),
            onEnded: (chatId, summary) => {
              void bot.api
                .sendMessage(chatId, formatCallSummary(summary))
                .catch(() => undefined);
            },
            writeChatText: async (chatId, text) => {
              await bot.api.sendMessage(chatId, text).catch(() => undefined);
            },
          })
        : null,
    google: {
      // `/google` repond aussi quand la capacite est fermee : c'est lui qui dit pourquoi.
      status: async () =>
        google.runtime !== undefined ? await google.runtime.statusMessage() : await googleUnavailableStatus(config, google.warnings),
    },
    voice: {
      transcriber,
      synthesizer,
      mode: parseVoiceMode(config.voiceMode),
      mediaMaxBytes: config.mediaMaxBytes,
      catalog: voiceCatalog,
      // La preference vit dans la base, pas dans .env : l'agent ne reecrit jamais son
      // propre fichier de secrets, et un choix par conversation ne regarde pas les autres.
      preference: {
        get: (chatId: number) => store.getChatVoice(chatId),
        set: (chatId: number, voiceId: string | null) => store.setChatVoice(chatId, voiceId),
      },
    },
  });

  try {
    const me = await bot.api.getMe();
    log.info('bot Telegram connecté', { username: `@${me.username}`, id: me.id });
    // /id reste derrière son drapeau : annoncé au menu puis refusé à l'usage, c'est
    // une promesse mensongère. Tout le reste vient du canal, donc rien ne s'oublie.
    await bot.api.setMyCommands(
      menuCommands().filter((entry) => entry.command !== 'id' || config.idCommandEnabled),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unauthorized|401/i.test(message)) {
      throw new Error('TELEGRAM_BOT_TOKEN refusé par Telegram (401 Unauthorized). Vérifie la valeur dans .env');
    }
    throw new Error(`impossible de joindre Telegram : ${message.slice(0, 200)}`);
  }

  if (realtime !== null && config.realtimeEnabled) {
    try {
      const bound = await realtime.listen();
      for (const warning of realtime.warnings) realtimeLog.warn(warning);
      const view = realtime.describe();
      log.info('appel live prêt', {
        lien: realtime.hub.publicBase,
        oreille: view.ear,
        bouche: view.mouth,
        plafond: view.budget,
      });
      if (bound.port !== config.realtimePort) log.info('hub sur port attribué par l’OS', { port: bound.port });
      if (channelRealtime !== null) channelRealtime.listening = true;
    } catch (error) {
      // Échec d'écoute = port probablement déjà pris. Ce n'est PAS une erreur de conception
      // (78, arrêt définitif) : c'est EX_TEMPFAIL, le superviseur retentera avec son backoff.
      // Rester vivant en promettant un `/call` mort serait le pire des deux.
      realtimeLog.error('hub temps réel indisponible', {
        erreur: error instanceof Error ? error.message.slice(0, 160) : 'erreur inconnue',
      });
      await realtime.hub.close().catch(() => undefined);
      if (channelRealtime !== null) channelRealtime.listening = false;
      throw new RealtimeUnavailableError(
        error instanceof Error ? error.message : 'le hub na pas pu sécouster',
      );
    }
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    void (async () => {
      if (stopping) return;
      stopping = true;
      log.info('arrêt demandé', { signal });
      try {
        // Fermeture dans l'ordre : les sessions d'abord (elles doivent rendre leur bilan et
        // solder la base), le hub ensuite, le polling en dernier.
        if (realtime !== null) await realtime.hub.close().catch(() => undefined);
        // Les appels Google en cours sont coupes AVANT le polling : un fils qui survivrait a
        // l'agent ecrirait dans la conversation apres l'arret annonce.
        if (google.runtime !== undefined) await google.runtime.close().catch(() => undefined);
        await bot.stop();
      } catch (error) {
        log.warn('arrêt du polling incomplet', { error: String(error) });
      }
      // Fermeture propre : WAL compacté, aucune écriture perdue.
      store.close();
      log.info('arrêté proprement');
      process.exit(0);
    })();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // (les rejections non gérées sont journalisées et comptées par la garde d'os)

  log.info('long polling démarré — Ctrl+C pour arrêter');
  await bot.start();
}

/**
 * Le code de sortie est un contrat avec le superviseur, pas un détail : `78` veut dire
 * « corrigez la configuration, relancer ne sert à rien », `75` veut dire « repars, c'est
 * passager ». Les deux valaient `1` : un superviseur n'avait aucun moyen de distinguer un
 * bot mal configuré — qu'il ferait tourner en boucle — d'un bot qui mérite une seconde chance.
 */
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Une configuration invalide porte un code distinct : la relancer produirait le même
  // échec, seconde après seconde. Tout le reste mérite une nouvelle tentative.
  // `RealtimeUnavailableError` n'est PAS une ConfigError : il doit tomber du bon côté du
  // contrat de supervision (relancer) alors qu'une config fausse doit rester fermée.
  const code = exitCodeFor(error, (e) => e instanceof ConfigError);
  // Un hub qui n'arrive pas à s'écouter est un échec passager (port occupé, interface pas
  // encore prête) : on force 75 pour que le superviseur retente, alors que le reste du
  // « sinon » garde déjà ce code — l'explicite ici évite qu'un futur `default: 1` le casse.
  const fatal = error instanceof RealtimeUnavailableError ? EX_TEMPFAIL : code;
  if (error instanceof ConfigError) {
    console.error(`\n❌ Configuration invalide — ${message}\n`);
  } else if (error instanceof RealtimeUnavailableError) {
    console.error(`\n⚠️  Mode appel indisponible (${message.slice(0, 120)}) — l’agent redémarre pour réessayer.\n`);
  } else {
    console.error(`\n❌ ${message}\n`);
  }
  log.fatal('arrêt de l’agent', { code: fatal, raison: message.slice(0, 200) });
  process.exit(fatal);
});

