/**
 * Configuration centralisée et validée.
 *
 * Règle : toute variable d'environnement est lue ICI et uniquement ici (y compris
 * DEBUG). Aucune clé n'est donc manipulée sans avoir été validée et bornée.
 * Le reste du code reçoit un objet `AppConfig` typé et déjà validé, ce qui
 * évite les `process.env.X!` éparpillés (source classique de bugs et de fuites).
 */
import { chmodSync, statSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';

/**
 * Rechargé ici pour que `node dist/index.js` marche sans option (npm run dev, lui,
 * passe déjà --env-file). Le CHEMIN est surchargeable par ENV_FILE : sans ça, un simple
 * `.env` du dépôt injecte les clés réelles dans tout processus fils — y compris les
 * tests d'intégration, qui héritent de l'environnement du lanceur. C'est arrivé : un
 * test bout-en-bout est parti sonder l'API ElevenLabs réelle et est mort au démarrage
 * le jour où une clé y a été ajoutée. Un test ne doit jamais pouvoir appeler un
 * fournisseur payant, ni dépendre de ce que la machine du développeur a collé là.
 */
// (l'appel est dans loadConfig : il doit connaître ENV_FILE avant de choisir son fichier)

export interface AppConfig {
  /** Nom affiché de l'agent (prompt système, /start, logs). */
  agentName: string;

  // --- Telegram ---
  telegramBotToken: string;
  /** Liste blanche stricte : tout ID absent est refusé. */
  allowedUserIds: ReadonlySet<number>;

  // --- Fournisseurs de LLM ---
  groqApiKey: string;
  groqModel: string;
  /** Second modèle Groq essayé si le premier est plafonné (429/503). */
  groqFallbackModel: string;
  /** Laisser vide désactive complètement OpenRouter (aucun appel réseau). */
  openRouterApiKey: string;
  openRouterModel: string;

  // --- Voix : écouter (transcription) et parler (synthèse) ---
  /** Laisser vide désactive ElevenLabs entièrement : aucun appel réseau de ce côté. */
  elevenLabsApiKey: string;
  /** Identifiant de voix, à lire sur le compte via GET /v1/voices — jamais recopié d'un blog. */
  elevenLabsVoiceId: string;
  elevenLabsTtsModel: string;
  elevenLabsSttModel: string;
  /** Base WEBSOCKET du fournisseur de voix (temps réel). Testable sans toucher au code. */
  elevenLabsWsUrl: string;
  /** Modèle de voix utilisé PENDANT un appel (distinct de celui des vocaux : latence d'abord). */
  realtimeTtsModel: string;
  /** 0-100 : 100 = très stable, 0 = très expressif. */
  elevenLabsStability: number;
  elevenLabsSimilarity: number;
  /** Modèle de transcription côté Groq (même clé que le texte). */
  whisperModel: string;
  /** Ordre de bascule de la transcription, séparé par des virgules. */
  transcriptionOrder: string;
  /** off | mirror | always | on_request — qui décide qu'une réponse a droit à un vocal. */
  voiceMode: string;
  /** Budget de synthèse par réponse, en caractères. */
  ttsMaxChars: number;
  /** Plafond absolu d'un fichier reçu, en octets. */
  mediaMaxBytes: number;

  // --- Live Voice (appel temps réel : page servie par le bot, flux PCM sur websocket) ---
  /**
   * Le hub est le SEUL morceau du projet qui ouvre un port : il n'existe que si l'utilisateur
   * l'a décidé (`REALTIME_ENABLED=true`), et l'invariant `listening-is-a-decision` du skill
   * échoue si quelqu'un l'allume sans le documenter (mention `LISTEN-EXCEPTION:`, bascule,
   * liste blanche confrontée à la poignée de main).
   */
  realtimeEnabled: boolean;
  /** Port d'écoute du hub (le 0 est réservé aux tests : port libre attribué par l'OS). */
  realtimePort: number;
  /** 127.0.0.1 par défaut : un micro ouvert sur 0.0.0.0 est une porte, pas une fonctionnalité. */
  realtimeBind: string;
  /** URL publique donnée à l'utilisateur ; vide = `http://127.0.0.1:<port>` (usage local). */
  realtimePublicUrl: string;
  /** Durée maximale d'un appel : au-delà on raccroche en le disant (deux factures par tour). */
  realtimeMaxMinutes: number;
  realtimeMaxTurns: number;
  /** Modèle de transcription temps réel (distinct du modèle par lots des vocaux). */
  realtimeSttModel: string;
  /** TTL d'un billet de connexion : court, à usage unique, et jamais revendu. */
  realtimeTicketTtlSeconds: number;
  /** Silence qui clôt un tour. 450 ms = réactif sans hacher la parole. */
  realtimeVadSilenceMs: number;
  realtimeMaxFrameKbps: number;

  // --- Google Workspace (via le CLI `gws`) ---
  /**
   * Acces a la boite mail, aux fichiers et au calendrier reels d'un humain : eteint par
   * defaut, et l'activation est une DECISION (un outil qui lit mes mails est une porte), pas
   * un reglage de confort. Cf. `docs/GOOGLE.md`.
   */
  googleEnabled: boolean;
  /** Nom ou chemin du binaire. `node_modules/.bin` est cherche avant le PATH. */
  googleBin: string;
  /** Liste blanche de services : hors d'ici, aucun outil n'est cree et l'appel est refuse. */
  googleServices: ReadonlySet<string>;
  /** Second verrou des ecritures, avec DANGEROUS_TOOLS_ENABLED : les deux doivent etre vrais. */
  googleAllowWrites: boolean;
  /** Un appel Google qui pend au-dela est coupe : l'agent doit repondre, pas rester poli. */
  googleTimeoutMs: number;
  /** Plafond d'octes lus sur stdout du CLI : un alt=media sur un fichier de 200 Mo ne doit pas entrer en memoire. */
  googleMaxOutputBytes: number;
  /** Les quotas Google sont par utilisateur : au-dela de 2 appels simultanés, on fait la queue. */
  googleMaxInFlight: number;
  /** Tentatives pour une LECTURE (1 = aucun rejeu). Une ecriture n'est jamais rejouee. */
  googleReadAttempts: number;
  /** Vide = magasin du CLI (~/.config/gws). Sinon transmis comme GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE. */
  googleCredentialsFile: string;
  /** `keyring` = trousseau de l'OS ; `file` = serveur sans trousseau, cle 0600 dans ~/.config/gws. */
  googleKeyringBackend: 'keyring' | 'file';
  /** Projet GCP pour le quota et la facturation ; vide = celui du client OAuth. */
  googleProjectId: string;

  // --- Persistance ---
  /**
   * Journal applicatif en plus de stdout. Vide = stdout uniquement, et c'est le défaut :
   * un test qui écrirait dans `logs/agent.log` pollue le dépôt, et un test polluant finit
   * par être supprimé. Le fichier n'est activé que parce que `.env` le demande.
   */
  logFile: string;

  dbPath: string;

  // --- Boucle d'agent ---
  maxIterations: number;
  /** À partir de cette itération, les outils sont désactivés pour forcer une réponse. */
  forceFinalIteration: number;
  systemTimezone: string;
  historyLimit: number;
  maxMessageChars: number;
  maxMemoryItems: number;
  /** Vérifier au démarrage que les modèles existent chez le fournisseur. */
  validateModelsAtBoot: boolean;
  llmTimeoutMs: number;
  llmMaxRetries: number;

  // --- Sécurité ---
  rateLimitBurst: number;
  rateLimitPerMinute: number;
  approvalTtlMinutes: number;
  /** Racine autorisée pour les outils qui touchent au système de fichiers. */
  workspaceRoot: string;
  /** Portail global : laisser à false pour interdire tout outil marqué « sensible ». */
  dangerousToolsEnabled: boolean;
  /** /id est la seule commande répondant hors liste blanche (utile à l'installation). */
  idCommandEnabled: boolean;
  /** DEBUG=1 : journalise les détails non sensibles (tour, itérations, outils). */
  debug: boolean;

  // --- Points de terminaison (à ne toucher que pour un relais ou un test) ---
  /** Vide = api.telegram.org. Permet un serveur Bot API auto-hébergé ou un proxy. */
  telegramApiRoot: string;
  groqBaseUrl: string;
  openRouterBaseUrl: string;
  elevenLabsBaseUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Valeur qui distingue « absent » de « présent mais vide ».
 *
 * Necessary parce que `.env.example` promet « Vide = désactivé » pour le modèle de
 * secours : avec `readString`, une clé laissée à "" retombait sur le DÉFAUT — donc
 * l'utilisateur qui croyait couper le secours l'activait. Le cas est appiqué par la
 * sonde d'inventaire au démarrage (le modèle par défaut n'existait pas chez le
 * fournisseur de test) : un comportement documenté et un comportement du code qui
 * divergent finissent toujours par se voir, autant que ce soit ici.
 */
function readStringDisableEmpty(name: string, fallback: string): string {
  if (process.env[name] === undefined) return fallback;
  return raw(name);
}

/** Valeur brute, «  » et guillemets accidentels nettoyés. */
function raw(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^["']|["']$/g, '').trim();
}

function readString(name: string, fallback: string): string {
  const value = raw(name);
  return value.length > 0 ? value : fallback;
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const value = raw(name);
  if (value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ConfigError(`${name} doit être un entier (reçu : « ${quote(value)} »).`);
  }
  if (parsed < min || parsed > max) {
    throw new ConfigError(`${name} doit être compris entre ${min} et ${max} (reçu : ${parsed}).`);
  }
  return parsed;
}

function readIds(name: string): Set<number> {
  const value = raw(name);
  const ids = new Set<number>();
  for (const part of value.split(/[\s,]+/)) {
    if (part === '') continue;
    if (!/^\d{1,20}$/.test(part)) {
      throw new ConfigError(
        `${name} contient une valeur invalide : « ${quote(part)} ». Attendu : des IDs numériques séparés par des virgules.`,
      );
    }
    const id = Number(part);
    if (!Number.isSafeInteger(id)) {
      throw new ConfigError(`${name} contient un ID trop grand pour être traité sans perte : ${part}`);
    }
    ids.add(id);
  }
  return ids;
}

/** Base websocket (`ws:`/`wss:`) : le fournisseur temps réel ne se configure pas avec un http. */
/**
 * Services Google autorises. Un nom inconnu est une faute de frappe qui DESACTIVERAIT un
 * service en silence — le refuser est plus honnete que le laisser passer.
 */
const GOOGLE_SERVICE_NAMES = ['gmail', 'drive', 'docs', 'sheets', 'calendar', 'tasks'];

function readGoogleServices(name: string): Set<string> {
  const raw = readString(name, 'gmail,drive,docs,sheets,calendar');
  const parts = raw.split(',').map((value) => value.trim().toLowerCase()).filter((value) => value !== '');
  if (parts.length === 0) {
    throw new ConfigError(`${name} : liste vide — aucun outil Google n'aurait de sens. Laisse la valeur par defaut ou eteins GOOGLE_ENABLED.`);
  }
  const out = new Set<string>();
  for (const part of parts) {
    if (!GOOGLE_SERVICE_NAMES.includes(part)) {
      throw new ConfigError(`${name} : service inconnu « ${part} ». Autorises : ${GOOGLE_SERVICE_NAMES.join(', ')}.`);
    }
    out.add(part);
  }
  // `auth` n'est pas un service de donnees : c'est l'appel de diagnostic, toujours permis.
  out.add('auth');
  return out;
}

/** Le magasin de `gws` n'a que deux modes ; un troisieme serait un mot mal tape. */
function readKeyringBackend(name: string): 'keyring' | 'file' {
  const value = readString(name, 'keyring').trim().toLowerCase();
  if (value !== 'keyring' && value !== 'file') {
    throw new ConfigError(`${name} doit valoir keyring (trousseau de l'OS) ou file (cle 0600 dans ~/.config/gws).`);
  }
  return value;
}

function readWsUrl(name: string, fallback: string): string {
  const value = raw(name) || fallback;
  if (value === '') return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} n’est pas une URL absolue valide : « ${quote(value)} ».`);
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new ConfigError(`${name} doit utiliser ws:// ou wss:// (reçu : ${url.protocol}).`);
  }
  return value;
}

/** URL absolue http(s) uniquement : on refuse un `file://` ou un scheme inattendu. */
function readUrl(name: string, fallback: string): string {
  const value = raw(name) || fallback;
  if (value === '') return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} n’est pas une URL absolue valide : « ${quote(value)} ».`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${name} doit utiliser http(s):// (reçu : ${url.protocol}).`);
  }
  return value;
}

function readTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: value });
  } catch {
    throw new ConfigError(`SYSTEM_TIMEZONE invalide : « ${quote(value)} ». Utiliser un fuseau IANA (ex. « Africa/Bamako », « UTC »).`);
  }
  return value;
}

/** Valeur non sensible : juste bornée, pour rester lisible dans une erreur. */
function quote(value: string, max = 40): string {
  const oneLine = value.replace(/\s+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Masque un secret dans un message d'erreur ou un log. */
export function redact(value: string): string {
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}…${value.slice(-2)} (${value.length} car.)`;
}

/**
 * Un fichier de clés lisible par le groupe ou par le monde n'est qu'à moitié protégé :
 * `gitignore` empêche la diffusion volontaire, rien n'empêche la lecture locale. Le dépôt
 * d'exemple est livré en 600, mais un `cp`, une restauration d'instantané ou un éditeur
 * distrait le ramènent en 644 (c'est ce qui s'est produit ici après un reset du bac à
 * sable). Plutôt que de le signaler une fois puis de le laisser dériver, on remet les
 * droits ici : c'est le seul endroit qui connaisse à la fois le chemin et le fait qu'il
 * porte des secrets.
 */
export function hardenEnvFile(path: string): boolean {
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) === 0) return false;
    chmodSync(path, 0o600);
    process.stderr.write(
      `[warn] ${path}: droits ${mode.toString(8)} -> 600 (le fichier porte des clés)\n`,
    );
    return true;
  } catch {
    return false; // fichier absent ou système sans chmod : ce n'est pas à la config de mourir pour ça
  }
}

export function loadConfig(): AppConfig {
  // Lu à la CONSTRUCTION et non à l'import du module : `ENV_FILE` doit être lu avant de
  // servir à choisir le fichier. dotenv n'écrase aucune variable déjà exportée — le
  // shell reste prioritaire sur le disque, ce qui est ce qui rend les tests hermétiques.
  const envPath = process.env.ENV_FILE ?? '.env';
  loadDotenv({ path: envPath, quiet: true });
  hardenEnvFile(envPath);

  const token = raw('TELEGRAM_BOT_TOKEN');
  if (token === '' || token.startsWith('REMPLACEZ')) {
    throw new ConfigError('TELEGRAM_BOT_TOKEN manquant. Créez un bot avec @BotFather puis renseignez-le dans .env');
  }
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new ConfigError(
      `TELEGRAM_BOT_TOKEN n'a pas le format attendu (« 123456789:AA... ») : ${redact(token)}. Vérifiez copier/coller et l'absence de guillemets.`,
    );
  }

  const allowedUserIds = readIds('TELEGRAM_ALLOWED_USER_IDS');
  if (allowedUserIds.size === 0) {
    throw new ConfigError(
      'TELEGRAM_ALLOWED_USER_IDS est vide : par sécurité l\'agent refuse de démarrer sans liste blanche (sinon n\'importe qui pourrait le piloter).',
    );
  }

  const groqApiKey = raw('GROQ_API_KEY');
  const openRouterApiKey = raw('OPENROUTER_API_KEY');
  if (groqApiKey === '' && openRouterApiKey === '') {
    throw new ConfigError('Aucune clé LLM : renseignez au minimum GROQ_API_KEY (ou OPENROUTER_API_KEY) dans .env');
  }

  const systemTimezone = readTimezone(readString('SYSTEM_TIMEZONE', 'UTC'));
  const maxIterations = readInt('AGENT_MAX_ITERATIONS', 6, 1, 25);
  const forceFinalIteration = readInt('AGENT_FORCE_FINAL_ITERATION', 5, 0, maxIterations);
  const dangerous = readString('DANGEROUS_TOOLS_ENABLED', 'false').toLowerCase();
  if (!/^(true|false|1|0)$/.test(dangerous)) {
    throw new ConfigError('DANGEROUS_TOOLS_ENABLED doit valoir true ou false.');
  }

  const voiceMode = readString('VOICE_MODE', 'mirror').trim().toLowerCase();
  if (!['off', 'mirror', 'always', 'on_request'].includes(voiceMode)) {
    throw new ConfigError(
      `VOICE_MODE invalide (reçu : « ${redact(voiceMode)} »). Valeurs admises : off, mirror, always, on_request.`,
    );
  }

  return {
    agentName: readString('AGENT_NAME', 'OpenGravity'),
    telegramBotToken: token,
    allowedUserIds,
    groqApiKey,
    // Ces identifiants sont une hypothèse, pas une garantie : la liste des modèles est
    // propre à chaque compte. D’où la sonde de src/index.ts au démarrage, qui vérifie que
    // le modèle existe avant le premier message (sinon : 400 opaque chez le fournisseur).
    groqModel: readString('GROQ_MODEL', 'openai/gpt-oss-120b'),
    // Vide explicité = secours volontairement coupé (voir readStringDisableEmpty).
    groqFallbackModel: readStringDisableEmpty('GROQ_FALLBACK_MODEL', 'qwen/qwen3.8-27b'),
    openRouterApiKey,
    openRouterModel: readString('OPENROUTER_MODEL', 'openrouter/free'),
    elevenLabsApiKey: raw('ELEVENLABS_API_KEY'),
    elevenLabsVoiceId: readString('ELEVENLABS_VOICE_ID', ''),
    elevenLabsTtsModel: readString('ELEVENLABS_TTS_MODEL', 'eleven_flash_v2_5'),
    elevenLabsSttModel: readString('ELEVENLABS_STT_MODEL', 'scribe_v1'),
    elevenLabsWsUrl: readWsUrl('ELEVENLABS_WS_URL', 'wss://api.elevenlabs.io/v1'),
    realtimeTtsModel: readString('REALTIME_TTS_MODEL', 'eleven_flash_v2_5'),
    whisperModel: readString('GROQ_WHISPER_MODEL', 'whisper-large-v3'),
    transcriptionOrder: readString('TRANSCRIPTION_PROVIDERS', 'groq,elevenlabs'),
    elevenLabsStability: readInt('ELEVENLABS_STABILITY', 50, 0, 100) / 100,
    elevenLabsSimilarity: readInt('ELEVENLABS_SIMILARITY', 75, 0, 100) / 100,
    voiceMode,
    ttsMaxChars: readInt('TTS_MAX_CHARS', 1200, 100, 8000),
    realtimeEnabled: readBool('REALTIME_ENABLED', false),
    realtimePort: readInt('REALTIME_PORT', 8790, 0, 65535),
    realtimeBind: readBind('REALTIME_BIND', '127.0.0.1'),
    realtimePublicUrl: readUrl('REALTIME_PUBLIC_URL', ''),
    realtimeMaxMinutes: readInt('REALTIME_MAX_MINUTES', 10, 1, 120),
    realtimeMaxTurns: readInt('REALTIME_MAX_TURNS', 40, 1, 500),
    realtimeSttModel: readString('REALTIME_STT_MODEL', 'scribe_v2_realtime'),
    realtimeTicketTtlSeconds: readInt('REALTIME_TICKET_TTL_SECONDS', 120, 15, 3600),
    realtimeVadSilenceMs: readInt('REALTIME_VAD_SILENCE_MS', 450, 200, 2000),
    realtimeMaxFrameKbps: readInt('REALTIME_MAX_KBPS', 128, 16, 4096),
    googleEnabled: readBool('GOOGLE_ENABLED', false),
    googleBin: readString('GWS_BIN', 'gws'),
    googleServices: readGoogleServices('GWS_SERVICES'),
    googleAllowWrites: readBool('GWS_ALLOW_WRITES', false),
    googleTimeoutMs: readInt('GWS_TIMEOUT_MS', 20000, 2000, 120000),
    googleMaxOutputBytes: readInt('GWS_MAX_OUTPUT_BYTES', 400000, 4096, 4194304),
    googleMaxInFlight: readInt('GWS_MAX_IN_FLIGHT', 2, 1, 8),
    googleReadAttempts: readInt('GWS_READ_ATTEMPTS', 2, 1, 3),
    googleCredentialsFile: readString('GWS_CREDENTIALS_FILE', ''),
    googleKeyringBackend: readKeyringBackend('GWS_KEYRING_BACKEND'),
    googleProjectId: readString('GWS_PROJECT_ID', ''),
    mediaMaxBytes: readInt('MEDIA_MAX_BYTES', 8388608, 1024, 20971520),
    dbPath: readString('DB_PATH', './memory.db'),
    maxIterations,
    forceFinalIteration,
    systemTimezone,
    historyLimit: readInt('HISTORY_LIMIT', 40, 0, 500),
    maxMessageChars: readInt('MAX_MESSAGE_CHARS', 6000, 500, 20000),
    maxMemoryItems: readInt('MAX_MEMORY_ITEMS', 500, 10, 100000),
    validateModelsAtBoot: readBool('LLM_VALIDATE_MODELS', true),
    llmTimeoutMs: readInt('LLM_TIMEOUT_MS', 60000, 5000, 600000),
    llmMaxRetries: readInt('LLM_MAX_RETRIES', 2, 0, 8),
    rateLimitBurst: readInt('RATE_LIMIT_BURST', 20, 1, 1000),
    rateLimitPerMinute: readInt('RATE_LIMIT_PER_MIN', 12, 1, 1000),
    approvalTtlMinutes: readInt('APPROVAL_TTL_MINUTES', 15, 1, 240),
    workspaceRoot: readString('WORKSPACE_ROOT', '.'),
    dangerousToolsEnabled: dangerous === 'true' || dangerous === '1',
    idCommandEnabled: readBool('TELEGRAM_ID_COMMAND_ENABLED', true),
    debug: readBool('DEBUG', false),
    logFile: readString('LOG_FILE', ''),
    telegramApiRoot: readUrl('TELEGRAM_API_ROOT', ''),
    groqBaseUrl: readUrl('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
    openRouterBaseUrl: readUrl('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    elevenLabsBaseUrl: readUrl('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io/v1'),
  };
}

/**
 * Adresse d'écoute : localhost ou un IPv4 écrit explicitement. Refuser un nom d'hôte ici
 * serait un faux ami (`0.0.0.0` se dit en clair), mais refuser le vide et les espaces, oui.
 */
function readBind(name: string, fallback: string): string {
  const value = raw(name) || fallback;
  if (value === 'localhost' || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    if (value !== 'localhost' && value.split('.').some((part) => Number(part) > 255)) {
      throw new ConfigError(`${name} n'est pas une adresse IP valide : « ${quote(value)} ».`);
    }
    return value;
  }
  throw new ConfigError(`${name} doit être « 127.0.0.1 » (défaut), « localhost » ou une adresse IPv4 (reçu : « ${quote(value)} »).`);
}

function readBool(name: string, fallback: boolean): boolean {
  const value = raw(name).toLowerCase();
  if (value === '') return fallback;
  if (!/^(true|false|1|0)$/.test(value)) {
    throw new ConfigError(`${name} doit valoir true ou false (reçu : « ${redact(value)} »).`);
  }
  return value === 'true' || value === '1';
}

/** Journalise la config retenue, secrets masqués. */
export function describeConfig(config: AppConfig): string[] {
  return [
    `agent        : ${config.agentName} (max ${config.maxIterations} itérations, force-final @ ${config.forceFinalIteration || 'off'})`,
    `telegram     : ${config.allowedUserIds.size} utilisateur(s) autorisé(s) [${[...config.allowedUserIds].join(', ')}]`,
    `llm          : groq/${config.groqModel}${config.groqFallbackModel ? ` → fallback groq/${config.groqFallbackModel}` : ''}${config.openRouterApiKey ? ' → fallback openrouter' : ' (openrouter désactivé)'}`,
    `voix         : ${config.voiceMode} · écoute via ${config.transcriptionOrder} (${config.whisperModel}) · ${config.elevenLabsApiKey ? `parole elevenlabs/${config.elevenLabsTtsModel} voix=${config.elevenLabsVoiceId || '⚠ NON DÉFINIE'}` : 'parole désactivée (aucune clé ElevenLabs)'}`,
    // Le média et le journal sont deux choses distinctes : dire « aucun fichier écrit sur
    // disque » alors que le journal en est un rendrait la ligne suspecte a la premiere
    // lecture du `logs/` — et une ligne de log qu'on ne croit plus ne sert plus.
    `média        : plafond ${(config.mediaMaxBytes / 1048576).toFixed(1)} Mo par fichier, budget TTS ${config.ttsMaxChars} caractères, aucun média écrit sur disque`,
    `journal      : ${config.logFile === '' ? 'stdout seulement' : config.logFile} (4 Mio puis rotation)`,
    `sélection    : /voice liste les voix du compte · défaut = ${config.elevenLabsVoiceId === '' ? 'aucun (ELEVENLABS_VOICE_ID vide)' : 'ELEVENLABS_VOICE_ID'}`,
    `mémoire      : ${config.dbPath} (fenêtre ${config.historyLimit} msg, ${config.maxMemoryItems} souvenirs max)`,
    `sécurité     : rate-limit ${config.rateLimitPerMinute}/min (rafale ${config.rateLimitBurst}), approbations ${config.approvalTtlMinutes} min, outils sensibles ${config.dangerousToolsEnabled ? 'ACTIVÉS' : 'désactivés'}`,
    `fuseau       : ${config.systemTimezone}${config.debug ? ' · DEBUG actif' : ''}`,
    `commandes    : /id ${config.idCommandEnabled ? 'active (à couper après installation)' : 'désactivée'}${config.telegramApiRoot ? ` · API relais ${config.telegramApiRoot}` : ''}`,
    // L'appel temps réel ouvre le seul port du projet : il a sa ligne, parce qu'un port
    // qu'on a oublié d'éteindre se découvre en relisant le démarrage, pas en relisant le code.
    `google       : ${
      config.googleEnabled
        ? `${[...config.googleServices].filter((s) => s !== 'auth').join(',')} · binaire ${config.googleBin} · timeout ${config.googleTimeoutMs} ms · écritures ${
            config.googleAllowWrites && config.dangerousToolsEnabled ? 'activées (confirmation humaine obligatoire)' : 'verrouillées'
          }`
        : 'désactivé (GOOGLE_ENABLED=false)'
    }`,
    `appel live  : ${
      config.realtimeEnabled
        ? `hub ${config.realtimeBind}:${config.realtimePort}${config.realtimePublicUrl ? ` · lien ${config.realtimePublicUrl}` : ''} · ${config.realtimeMaxMinutes} min / ${config.realtimeMaxTurns} échanges max · oreille ${config.realtimeSttModel}`
        : 'désactivé (REALTIME_ENABLED=false)'
    }`,
  ];
}
