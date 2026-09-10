/**
 * Récupération d'un fichier reçu par Telegram — et refus de tout ce qui ne l'est pas.
 *
 * Ce module vit dans la couche CANAL, pas dans `audio/` : c'est lui qui connaît
 * `getFile`, `file_path` et la racine de l'API Bot. `audio/` reçoit des octets et
 * n'a pas à savoir qu'ils viennent de Telegram — c'est ce qui permet à un canal
 * WhatsApp ou Slack de réutiliser la transcription sans la réécrire.
 *
 * Deux attaques réelles sont bloquées ici, pas par élégance :
 *   1. `file_path` vient de la réponse de l'API Telegram. Un relais compromis, ou un
 *      `TELEGRAM_API_ROOT` pointé ailleurs, peut renvoyer `../../../../etc/passwd`.
 *      Cet identifiant est ensuite collé dans une URL : on n'accepte que la forme
 *      `files/<nom>.<ext>` sans séparateur, sans `..`, sans antislash, sans schéma.
 *   2. La taille. Telegram autorise jusqu'à 20 Mo par fichier ; un vocal de 3 Ko
 *      suffit à notre usage. Sans plafond, un expéditeur de la liste blanche — ou
 *      quelqu'un qui a volé le token — peut faire allouer des centaines de méga-octets
 *      par tour, et le processus meurt d'épuisement mémoire. Le plafond est vérifié
 *      sur `content-length` PUIS pendant la lecture : l'en-tête seul est un mensonge
 *      possible.
 *
 * Le jeton du bot est dans l'URL de téléchargement. Il ne doit donc JAMAIS se
 * retrouver dans un message d'erreur : on ne remonte que le statut HTTP.
 */

/**
 * Forme acceptable d'un `file_path` renvoyé par le serveur de fichiers de Telegram.
 *
 * La première version de cette garde était une liste blanche calquée sur la forme
 * observée ce jour-là — `files/<nom>.<ext>`, sans sous-dossier. Elle a refusé les
 * vocaux réels d'un utilisateur : Telegram renvoie aussi `files/AgentAudioFile/…` et
 * des noms horodatés contenant des deux-points. Leçon : une garde qui dépend de la
 * forme du jour se retourne contre l'utilisateur, et le vrai risque n'est pas une
 * surprise de nomenclature mais une SORTIE de la racine. On refuse donc ce qui sort
 * (traversée, absolu, schéma, hôte, octets de contrôle) et on n'exige rien d'autre.
 */
const PATH_CHARS_RE = /^[A-Za-z0-9._/:-]{1,180}$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  webm: 'audio/webm',
  mp4: 'video/mp4',
};

export function mimeFromFileName(fileName: string): string {
  const ext = fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * `null` si le chemin est exploitable, sinon pourquoi il ne l'est pas.
 * Séparé du téléchargement pour être testé seul, et du journal pour être réduit.
 */
export function telegramPathIssue(filePath: string): string | null {
  if (filePath === '') return 'vide';
  if (filePath.length > 180) return `trop long (${filePath.length} caractères)`;
  if (!PATH_CHARS_RE.test(filePath)) {
    const bad = [...filePath].find((c) => !/[A-Za-z0-9._/:-]/.test(c));
    return `caractère non autorisé ${JSON.stringify(bad ?? '?')}`;
  }
  if (filePath.startsWith('/')) return 'chemin absolu';
  if (filePath.endsWith('/')) return 'segment final vide';
  const segments = filePath.split('/');
  const first = segments[0] ?? '';
  // Un deux-points dans le PREMIER segment est un schéma (`https:`, `file:`) : c'est un
  // changement d'interprétation de l'URL, pas un nom de fichier. Ailleurs il est légal,
  // et Telegram s'en sert dans ses horodatages (`…_19:32:00_1.ogg`) — SEGMENT_RE doit
  // donc l'admettre, sinon on en revient au refus arbitraire qui a cassé un vocal.
  if (first.includes(':')) return `schéma ou hôte en tête (${JSON.stringify(first.slice(0, 12))})`;
  for (const segment of segments) {
    if (segment === '') return 'double slash';
    if (segment === '.' || segment === '..') return 'segment traversant';
    if (!SEGMENT_RE.test(segment)) return `segment inattendu (${JSON.stringify(segment.slice(0, 12))})`;
  }
  return null;
}

/** Vrai si `file_path` est exploitable. */
export function isSafeTelegramPath(filePath: string): boolean {
  return telegramPathIssue(filePath) === null;
}

/**
 * De quoi journaliser un refus sans exposer un nom de fichier : l'utilisateur appelle
 * ses documents `rapport-licenciement.pdf`, le chemin Telegram le contient tel quel.
 */
export function describeTelegramPathIssue(filePath: string): string {
  const issue = telegramPathIssue(filePath);
  if (issue === null) return 'aucun';
  const root = filePath.split('/')[0] ?? '';
  return `${issue} · racine ${JSON.stringify(root.slice(0, 16))} · ${filePath.length} caractères`;
}

export interface DownloadOptions {
  /** Racine de l'API Bot, sans slash final. Vide = api.telegram.org. */
  apiRoot: string;
  botToken: string;
  filePath: string;
  /** Plafond absolu en octets. */
  maxBytes: number;
  /**
   * `mime_type` déclaré par la pièce jointe Telegram, si elle en a un. Nécessaire parce
   * que le `file_path` est souvent SANS extension (`files/voice_file_1`) : le nom ne dit
   * alors rien du contenu, et un fournisseur qui juge sur l'extension rejetterait le
   * fichier avant de le regarder.
   */
  declaredMime?: string;
  timeoutMs: number;
}

export interface DownloadedFile {
  bytes: Uint8Array;
  mime: string;
  fileName: string;
  size: number;
}

export class TelegramFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramFileError';
  }
}

/**
 * Télécharge un fichier du serveur de fichiers de Telegram en mémoire.
 * Aucun fichier temporaire n'est créé : `retention` n'a pas à être configurée pour
 * que rien ne traîne, puisque rien n'est écrit.
 */
export async function downloadTelegramFile(opts: DownloadOptions): Promise<DownloadedFile> {
  if (!isSafeTelegramPath(opts.filePath)) {
    throw new TelegramFileError(`chemin de fichier Telegram refusé : ${describeTelegramPathIssue(opts.filePath)}`);
  }
  const root = opts.apiRoot.trim() === '' ? 'https://api.telegram.org' : opts.apiRoot.replace(/\/+$/, '');
  const url = `${root}/file/bot${opts.botToken}/${opts.filePath}`;
  const fileName = opts.filePath.slice(opts.filePath.lastIndexOf('/') + 1);
  const mime = (opts.declaredMime ?? '').trim() !== '' ? (opts.declaredMime ?? '').trim() : mimeFromFileName(fileName);

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs), redirect: 'manual' });
  } catch (error) {
    throw new TelegramFileError(`téléchargement impossible : ${error instanceof Error ? error.name : 'erreur inconnue'}`);
  }
  if (!response.ok) {
    // Volontairement muet sur l'URL : elle porte le token.
    throw new TelegramFileError(`le serveur de fichiers a répondu ${response.status}`);
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > opts.maxBytes) {
    throw new TelegramFileError(`fichier trop volumineux (${declared} octets annoncés, plafond ${opts.maxBytes})`);
  }

  // Lecture bornée : on refuse dès le premier octet qui dépasse, même si
  // content-length mentait. `arrayBuffer()` seul ne poserait aucun plafond.
  if (response.body === null) throw new TelegramFileError('réponse sans corps');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > opts.maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TelegramFileError(`fichier trop volumineux (plafond ${opts.maxBytes} octets dépassé)`);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, mime, fileName, size: total };
}
