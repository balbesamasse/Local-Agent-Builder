/**
 * Catalogue des voix du compte ElevenLabs, pour la sélection par `/voice`.
 *
 * Pourquoi un module et pas un appel direct depuis le canal : le canal ne doit pas
 * connaître le fournisseur (il manipule des candidats, pas du JSON ElevenLabs), et un
 * `GET /v1/voices` à chaque appui de bouton est à la fois lent et inutile. Le cache a
 * donc une durée de vie, et l'erreur remontée est explicite : une liste vide lue comme
 * « aucun problème » est le faux négatif classique (voir `eleven-check.ts` pour le même
 * piège sur l'inventaire des modèles).
 *
 * Ce module n'émet **aucun appel payant** : lister des voix ne coûte rien, synthétiser
 * coûte. La sélection d'une voix ne déclenche donc jamais de synthèse (décision
 * utilisateur du 2026-09-02 : « juste le texte de confirmation »).
 */
import { extractItems, listEndpoint } from './eleven-check.js';
import { AudioError } from './types.js';

export interface VoiceCandidate {
  id: string;
  /** Nom tel que le compte le montre ; c'est ce que voit l'utilisateur. */
  name: string;
  /** Étiquette du bouton : nom borné, sans identifiant technique. */
  label: string;
  /** Catégorie déclarée par ElevenLabs (generated, professional, …) — informative. */
  category: string;
}

/** Au-delà, le clavier devient illisible ; `/voice <début de nom>` prend le relais. */
export const VOICE_PICK_LIMIT = 24;

/** Les libellés de boutons Telegram ne doivent pas déborder ; on tronque proprement. */
const LABEL_MAX = 26;

/** Clé de cache : `apiKey` n'y figure jamais volontairement (un log de clé = une fuite). */
interface CacheEntry {
  at: number;
  items: VoiceCandidate[];
}

function toCandidate(v: Record<string, unknown>): VoiceCandidate | null {
  const id = String(v['voice_id'] ?? '').trim();
  if (id === '') return null; // une voix sans identifiant n'est pas sélectionnable
  const rawName = String(v['name'] ?? '').trim();
  const name = rawName === '' ? '(sans nom)' : rawName;
  const category = typeof v['category'] === 'string' ? v['category'] : '';
  return { id, name, label: label(name), category };
}

function label(name: string): string {
  return name.length <= LABEL_MAX ? name : `${name.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

/** Comparaison sans accents ni casse : « Élodie » se trouve en tapant « elodie ». */
export function normalizeNeedle(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Voix actuelle en premier (on la reconnaît), puis par nom — un ordre stable vaut mieux
 * qu'un ordre d'inventaire qui change quand le compte ajoute une voix. */
export function sortVoices(items: VoiceCandidate[], currentId: string): VoiceCandidate[] {
  return [...items].sort((a, b) => {
    if (a.id === currentId && b.id !== currentId) return -1;
    if (b.id === currentId && a.id !== currentId) return 1;
    return a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' });
  });
}

/** Candidats pour un début de nom : au moins 2 caractères, sinon on refuse plutôt que
 * de proposer trois cents voix sur « a ». */
export function matchVoices(items: VoiceCandidate[], needle: string): VoiceCandidate[] {
  const clean = normalizeNeedle(needle);
  if (clean.length < 2) return [];
  return items.filter((v) => normalizeNeedle(v.name).includes(clean));
}

export interface VoiceCatalogOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** Durée de validité de l'inventaire (défaut 10 min) : un compte change rarement de voix. */
  ttlMs?: number;
  now?: () => number;
  /** Injection de test ; `fetch` par défaut. */
  fetcher?: typeof fetch;
}

export interface VoiceCatalog {
  /** Faux = pas de clé : le canal doit refuser la sélection, pas afficher une liste vide. */
  readonly enabled: boolean;
  list(options?: { refresh?: boolean }): Promise<VoiceCandidate[]>;
  /** Nom d'une voix à partir de son identifiant ; `null` si l'inventaire ne le connaît pas. */
  nameOf(id: string): Promise<string | null>;
}

export function buildVoiceCatalog(o: VoiceCatalogOptions): VoiceCatalog | null {
  if (o.apiKey === '') return null;
  const ttl = o.ttlMs ?? 600_000;
  const now = o.now ?? (() => Date.now());
  let cache: CacheEntry | null = null;
  let pending: Promise<VoiceCandidate[]> | null = null;

  async function fetchVoices(): Promise<VoiceCandidate[]> {
    // Une seule requête à la fois : dix appuis sur « 🔄 » ne doivent pas faire dix GET.
    if (pending !== null) return await pending;
    const run = (async (): Promise<VoiceCandidate[]> => {
      const url = `${o.baseUrl}/voices?with_settings=false&page_size=100`;
      const listed = await listEndpoint(url, o.apiKey, 'voices', o.timeoutMs, o.fetcher);
      const items = listed.items
        .map((v) => toCandidate(v))
        .filter((v): v is VoiceCandidate => v !== null);
      if (items.length === 0) {
        // Un inventaire vide n'est pas un succès : soit la réponse a changé de forme,
        // soit le compte n'a vraiment aucune voix. Le dire évite un « aucune voix dispo »
        // mensonger dans les deux cas.
        throw new AudioError(
          `ElevenLabs a répondu sans voix exploitable (${extractShape(listed.items)} élément(s) reçu(s))`,
          true,
        );
      }
      cache = { at: now(), items };
      return items;
    })();
    pending = run;
    try {
      return await run;
    } finally {
      pending = null;
    }
  }

  return {
    enabled: true,
    async list(options = {}) {
      const hit = cache;
      if (hit !== null && options.refresh !== true && now() - hit.at < ttl) return hit.items;
      try {
        return await fetchVoices();
      } catch (error) {
        const stale = cache;
        if (stale !== null) return stale.items; // un inventaire un peu vieux vaut mieux qu'une erreur
        throw error;
      }
    },
    async nameOf(id: string) {
      const items = await this.list();
      return items.find((v) => v.id === id)?.name ?? null;
    },
  };
}

function extractShape(items: unknown[]): string {
  const keys = items.length > 0 && typeof items[0] === 'object' && items[0] !== null
    ? Object.keys(items[0] as Record<string, unknown>).slice(0, 4).join('+')
    : 'aucune';
  return `${items.length}/${keys}`;
}

/**
 * Extrait la liste depuis n'importe quelle forme de réponse (tableau nu, `{voices}`,
 * `{items}`, `{data}`) — même fonction que la sonde de démarrage, donc même tolérance.
 */
export function parseVoiceList(payload: unknown): VoiceCandidate[] {
  return extractItems(payload, 'voices')
    .map((v) => toCandidate(v))
    .filter((v): v is VoiceCandidate => v !== null);
}
