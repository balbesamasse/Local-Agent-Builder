/**
 * Journalisation minimale, sans dépendance, avec masquage des secrets.
 * Aucune clé API, aucun token et aucun contenu de message privé ne transite ici.
 *
 * Deux destinations, toujours actives en parallèle : la sortie standard (l'humain qui
 * regarde) et, si `LOG_FILE` est posé, un fichier (la cause du décès, quand le
 * processus — et donc son stdout — a disparu). Un journal qui ne vit que sur stdout
 * n'est pas un journal : c'est exactement ce qui a rendu un arrêt du bot impossible à
 * expliquer au réveil.
 */
// DISK-WRITE-OK: journal applicatif uniquement — jamais un octet recu ou synthetise.
// Cette mention est exigee par l'invariant `media-no-residue` : l'autorisation d'ecrire
// est declaree dans le fichier qui l'use, pas dans la tete du verificateur.
import { appendFileSync, chmodSync, mkdirSync, openSync, closeSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

let debugEnabled = false;
const secrets = new Set<string>();

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Rotation bornée : un journal qui remplit le disque est une nouvelle panne. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
let fileSink: { path: string; bytes: number } | null = null;

/**
 * Active l'écriture dans un fichier (`undefined` ou '' = désactivé). Ne lève jamais :
 * le journal ne doit en aucun cas devenir la cause d'un arrêt.
 */
export function setLogFile(path: string | undefined): void {
  if (path === undefined || path.trim() === '') {
    fileSink = null;
    return;
  }
  const target = path.trim();
  try {
    mkdirSync(dirname(target), { recursive: true });
    let bytes = 0;
    try {
      bytes = statSync(target).size;
      // Un journal porte des chatId et des motifs d'erreur : pas une audience publique.
      // Comme pour `.env`, on ne le décrète pas à la création, on le répare à l'ouverture —
      // une restauration d'instantané ou un `cp` le laisse volontiers en 644.
      if ((statSync(target).mode & 0o077) !== 0) chmodSync(target, 0o600);
    } catch {
      closeSync(openSync(target, 'a', 0o600)); // premier trait : né en 600
    }
    fileSink = { path: target, bytes };
  } catch (error) {
    console.warn(`${new Date().toISOString()} WARN  journal fichier désactivé`, {
      raison: error instanceof Error ? error.name : 'erreur inconnue',
    });
    fileSink = null;
  }
}

/** Chemin du fichier de journal, ou null — exposé pour les tests et le superviseur. */
export function logFilePath(): string | null {
  return fileSink?.path ?? null;
}

function appendToSink(line: string): void {
  if (fileSink === null) return;
  try {
    if (fileSink.bytes > MAX_LOG_BYTES) {
      renameSync(fileSink.path, `${fileSink.path}.1`); // un seul rang, disque borné
      fileSink.bytes = 0;
    }
    appendFileSync(fileSink.path, `${line}\n`);
    fileSink.bytes += line.length + 1;
  } catch {
    fileSink = null; // plus d'espace, plus de droit : on continue en stdout
  }
}

/**
 * Fait entrer une ligne extérieure — le stdout/stderr d'un processus enfant — dans le
 * journal, sans l'afficher : le terminal la reçoit déjà. Elle passe par le même masquage
 * que les nôtres, parce qu'une trame de plantage de bibliothèque peut contenir l'URL d'appel
 * Telegram, token compris.
 */
export function mirrorToSink(line: string): void {
  appendToSink(String(scrub(line)));
}

/** Enregistre les valeurs à ne jamais écrire dans un log (clé API, token bot…). */
export function registerSecrets(values: Array<string | undefined>): void {
  for (const v of values) {
    if (typeof v === 'string' && v.length >= 6) secrets.add(v);
  }
}

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[…]';
  if (typeof value === 'string') {
    let out = value;
    for (const secret of secrets) out = out.split(secret).join('[masqué]');
    // Filets de sécurité : motifs type clé API même non enregistrés.
    out = out.replace(/\b(gsk_|sk-or-[A-Za-z0-9_-]{10,}|\d{8,}:[A-Za-z0-9_-]{20,})\b/g, '[masqué]');
    return out.length > 500 ? `${out.slice(0, 500)}…` : out;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /token|api_?key|secret|password|authorization/i.test(k) ? '[masqué]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (level === 'debug' && !debugEnabled) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const detail = meta ? ` ${JSON.stringify(scrub(meta))}` : '';
  const text = line + detail;
  if (level === 'error' || level === 'fatal') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
  appendToSink(text); // `appendFileSync` : rien à-flusher, le trait est déjà parti
}

export const log = {
  debug: (m: string, meta?: Record<string, unknown>) => emit('debug', m, meta),
  info: (m: string, meta?: Record<string, unknown>) => emit('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => emit('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => emit('error', m, meta),
  /** Ce qui a tué le processus. Niveau distinct pour qu'on le retrouve dans un gros fichier. */
  fatal: (m: string, meta?: Record<string, unknown>) => emit('fatal', m, meta),
};
