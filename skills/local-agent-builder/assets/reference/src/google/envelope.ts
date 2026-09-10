/**
 * Interprétation de la sortie de `gws`.
 *
 * Deux faits relevés sur le binaire 0.22.5, et c'est ce qui a déterminé ce fichier :
 *
 * 1. le code de sortie est documenté et fiable — 0 succès, 1 erreur d'API, 2 erreur
 *    d'authentification, 3 validation, 4 découverte (schéma d'API injoignable), 5 interne.
 *    Il prime donc sur le texte ;
 * 2. MAIS l'enveloppe d'erreur n'a pas la même forme selon qu'elle vient d'une méthode REST
 *    ou d'un helper. Une méthode (`gmail users messages list`) rend
 *    `{"error":{"code":401,"reason":"authError"}}` ; un helper (`calendar +agenda`) rend
 *    `{"error":{"code":0,"reason":"calendarList_failed","message":"<JSON chappé>"}}` — code 0,
 *    donc, avec la vraie réponse Google enfouie dans une chaîne. Mapper une erreur sur
 *    `error.code` seul classerait ce 401 en succès avec un message d'erreur dedans.
 *
 * D'où un classifieur qui regarde le code de sortie, puis l'enveloppe, puis le texte — et qui
 * ne considère jamais `exit 0` comme la preuve d'une réponse saine.
 */
import { redact } from './redact.js';

export type GoogleFailureKind =
  | 'auth'
  | 'rate_limit'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'discovery'
  | 'timeout'
  | 'api'
  | 'internal'
  /** Le transport lui-même a échoué : binaire absent, sortie illisible, processus tué. */
  | 'transport';

export interface GoogleFailure {
  kind: GoogleFailureKind;
  /** Phrase courte, sans secret, destinée au modèle comme au journal. */
  message: string;
  exitCode: number;
  /** true → la réponse utile est « reconnecte ton compte », pas « réessaie ». */
  needsReauth: boolean;
  /** true → un nouvel essai a un sens (transitoire), et seulement pour une lecture. */
  retryable: boolean;
}

export interface GoogleRawResult {
  /** Code de sortie du processus. */
  exitCode: number;
  stdout: string;
  stderr: string;
  killed: boolean;
  timedOut: boolean;
  /** Le binaire n'a pas pu être lancé, ou a rendu n'importe quoi. */
  spawnError?: string;
}

export interface GoogleCallOutcome {
  ok: boolean;
  /** Réponse décodée (objet, tableau, ou null pour une écriture sans corps). */
  value?: unknown;
  failure?: GoogleFailure;
  /** stdout tronqué et expurgé, utile au journal et au modèle en cas d'échec. */
  excerpt: string;
}

/** Codes de sortie du CLI, vérifiés sur `gws --help` (v0.22.5). */
const EXIT_MEANING: Record<number, GoogleFailureKind> = {
  1: 'api',
  2: 'auth',
  3: 'validation',
  4: 'discovery',
  5: 'internal',
};

/**
 * Un texte qui sent l'authentification refusée. Nécessaire parce que les helpers noient la
 * réponse Google dans une chaîne échappée, sans code d'erreur exploitable.
 */
const AUTH_TEXT = /(invalid_grant|invalid authentication credentials|unauthenticated|autherror|error\\[auth\\]|token refresh|invalid credentials|credentials missing or invalid|token has been expired or revoked|reauth)/i;
const RATE_TEXT = /(rateLimit|rate limit|quota|RESOURCE_EXHAUSTED|too many requests|429)/i;
const FORBIDDEN_TEXT = /(PERMISSION_DENIED|forbidden|access not config|insufficient|has not been used|require a larger project quota)/i;
const NOT_FOUND_TEXT = /(NOT_FOUND|notFound|404|no such)/i;

export function classify(raw: GoogleRawResult, opts: { write: boolean; maxExcerpt: number }): GoogleCallOutcome {
  const stdout = raw.stdout.trim();
  const envelope = parseEnvelope(stdout);

  if (raw.timedOut || raw.killed) {
    return fail('timeout', `Google n'a pas répondu dans le temps imparti — le compte est peut-être en train de demander une autorisation dans le navigateur.`, raw, opts);
  }
  if (raw.spawnError !== undefined) {
    return fail('transport', ` commande Google indisponible : ${raw.spawnError}`, raw, opts);
  }

  // Sortie vide et code 0 : un helper qui n'a rien à dire (ex. `+read` sur un id fantôme).
  if (raw.exitCode === 0 && stdout === '') {
    return { ok: true, value: null, excerpt: '' };
  }

  const parsed = envelope.json;
  const looksLikeError =
    raw.exitCode !== 0 ||
    (parsed !== undefined && parsed !== null && typeof parsed === 'object' && 'error' in parsed) ||
    envelope.topLevelError;

  if (!looksLikeError) {
    return { ok: true, value: parsed, excerpt: redact(stdout).slice(0, opts.maxExcerpt) };
  }

  const message = errorText(parsed, envelope.errorText || raw.stderr || stdout);
  const kind = pickKind(raw, message, parsed);
  return {
    ok: false,
    failure: {
      kind,
      message: redact(oneLine(message)).slice(0, 600),
      exitCode: raw.exitCode,
      needsReauth: kind === 'auth' || AUTH_TEXT.test(message),
      // Une écriture n'est jamais rejouée d'office : on ne sait pas si Google l'a appliquée.
      // Un timeout N'EST PAS rejoué : le budget déjà consommé est exactement celui qu'on
      // repayerait. Retenter, c'est faire attendre l'utilisateur deux fois pour une réponse qui
      // a déjà une chance sur deux d'échouer — un agent franc est plus utile qu'un agent insistant.
      retryable: !opts.write && (kind === 'rate_limit' || kind === 'discovery'),
    },
    excerpt: redact(stdout || raw.stderr).slice(0, opts.maxExcerpt),
  };
}

/** Le code de sortie prime ; l'enveloppe et le texte affinent (et sauvent le cas du helper). */
function pickKind(raw: GoogleRawResult, message: string, parsed: unknown): GoogleFailureKind {
  const declared = httpReason(parsed);
  if (declared === 'authError' || declared === 'unauthenticated' || declared === 'credentialsMissing') return 'auth';
  if (declared === 'rateLimitExceeded' || declared === 'userRateLimitExceeded' || declared === 'dailyLimitExceeded' || declared === 'quotaExceeded') return 'rate_limit';
  // `accessNotConfigured` est la reponse de Google quand l'API n'est pas activee dans le projet :
  // ce n'est pas une erreur de permission de l'utilisateur, et le conseil n'est pas le meme.
  if (declared === 'forbidden' || declared === 'permissionDenied' || declared === 'accessNotConfigured' || declared === 'projectNotLinked') return 'forbidden';
  if (declared === 'notFound') return 'not_found';

  const byCode = EXIT_MEANING[raw.exitCode];
  if (byCode === 'auth') return 'auth';
  if (byCode === 'validation') return 'validation';
  if (byCode === 'discovery') return 'discovery';

  if (AUTH_TEXT.test(message)) return 'auth';
  if (RATE_TEXT.test(message)) return 'rate_limit';
  if (FORBIDDEN_TEXT.test(message)) return 'forbidden';
  if (NOT_FOUND_TEXT.test(message)) return 'not_found';
  if (byCode !== undefined) return byCode;
  return 'api';
}

/** `error.errors[].reason` ou `error.reason`, y compris quand le tout est échappé dans une chaîne. */
function httpReason(parsed: unknown): string | undefined {
  const direct = dig(parsed);
  if (direct !== undefined) return direct;
  // Le message d'un helper contient le JSON de la réponse, chappé : on le reparse.
  const embedded = dig(parsed, true);
  if (typeof embedded === 'string' && embedded.includes('reason')) {
    const nested = parseEnvelope(embedded).json;
    return dig(nested);
  }
  return undefined;

  function dig(node: unknown, throughMessage = false): string | undefined {
    if (node === null || typeof node !== 'object') return undefined;
    const record = node as Record<string, unknown>;
    const error = record['error'];
    if (typeof error === 'string') return error;
    if (error !== null && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      if (typeof e['reason'] === 'string') return e['reason'];
      const errors = e['errors'];
      if (Array.isArray(errors)) {
        for (const item of errors) {
          if (item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>)['reason'] === 'string') {
            return (item as Record<string, string>)['reason'];
          }
        }
      }
      if (throughMessage && typeof e['message'] === 'string') return e['message'];
      if (!throughMessage && typeof e['message'] === 'string') return undefined;
    }
    return undefined;
  }
}

function errorText(parsed: unknown, fallback: string): string {
  if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
    const error = (parsed as Record<string, unknown>)['error'];
    if (typeof error === 'string') return error;
    if (error !== null && typeof error === 'object') {
      const e = error as Record<string, unknown>;
      const message = typeof e['message'] === 'string' ? e['message'] : '';
      const status = typeof e['status'] === 'string' ? ` (${e['status']})` : '';
      if (message !== '') return message + status;
    }
  }
  return fallback === '' ? "Google a renvoyé une erreur sans message." : fallback;
}

interface Envelope {
  json: unknown;
  /** true si l'objet de premier niveau porte une clé `error`. */
  topLevelError: boolean;
  errorText: string;
}

/** Le CLI rend du JSON nu sur stdout ; mais un `--format text` ou un bruit parasite arrive aussi. */
export function parseEnvelope(text: string): Envelope {
  const trimmed = text.trim();
  if (trimmed === '') return { json: undefined, topLevelError: false, errorText: '' };
  try {
    const json = JSON.parse(trimmed) as unknown;
    const topLevelError = json !== null && typeof json === 'object' && 'error' in (json as Record<string, unknown>);
    return { json, topLevelError, errorText: '' };
  } catch {
    // NDJSON (--page-all) : un objet par ligne. On garde la première ligne exploitable.
    for (const line of trimmed.split('\n')) {
      const candidate = line.trim();
      if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
      try {
        const json = JSON.parse(candidate) as unknown;
        const topLevelError = json !== null && typeof json === 'object' && 'error' in (json as Record<string, unknown>);
        return { json, topLevelError, errorText: '' };
      } catch {
        /* ligne suivante */
      }
    }
  }
  // Pas de JSON du tout : on ne déclare pas ça réussi si ça ressemble à une erreur.
  const looksLikeError = /^(error|Error)\b/.test(trimmed) || /\berror\[/.test(trimmed);
  return { json: trimmed, topLevelError: looksLikeError, errorText: trimmed };
}

function fail(kind: GoogleFailureKind, message: string, raw: GoogleRawResult, opts: { write: boolean; maxExcerpt: number }): GoogleCallOutcome {
  return {
    ok: false,
    failure: {
      kind,
      message: redact(oneLine(message)).slice(0, 600),
      exitCode: raw.exitCode,
      needsReauth: kind === 'auth',
      retryable: !opts.write && kind === 'discovery',
    },
    excerpt: redact(raw.stdout || raw.stderr).slice(0, opts.maxExcerpt),
  };
}

/**
 * Le motif generique ne suffit pas quand la cause est locale et reparable par l'utilisateur :
 * « sortie trop volumineuse, precise ta recherche » ne doit pas etre ecrase par « le client est
 * injoignable ». Un causalite plus precisee qu'elle-meme est une causalite perdue.
 */
function specific(failure: GoogleFailure): string {
  const detail = failure.message.trim();
  return detail === '' ? '' : ` — ${detail.slice(0, 180)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Cause lisible à montrer dans Telegram quand un appel Google échoue. */
export function explainFailure(failure: GoogleFailure): string {
  switch (failure.kind) {
    case 'auth':
      return "compte Google non connecté ou autorisation expirée — « npm run google:login » sur la machine de l'agent";
    case 'rate_limit':
      return 'quota Google atteint (trop de demandes) — attends un peu';
    case 'forbidden':
      return "permission refusée par Google : l'API est peut-être désactivée dans le projet, ou le scope demandé n'a pas été accordé";
    case 'not_found':
      return 'le document demandé est introuvable (id invalide, ou il ne t’appartient pas)';
    case 'validation':
      return 'paramètres refusés par le CLI';
    case 'discovery':
      return "le schéma de l'API Google est injoignable (réseau, ou API désactivée dans le projet)";
    case 'timeout':
      return `Google a mis trop de temps à répondre${specific(failure)}`;
    case 'transport':
      return `le client Google n'est pas joignable sur cette machine${specific(failure)}`;
    default:
      return `Google a refusé (${failure.message})`;
  }
}
