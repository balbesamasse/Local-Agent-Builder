/**
 * Contrat du transport Google.
 *
 * Le projet a déjà cette forme pour la voix temps réel (`socketFactory`, `Transcriber`) :
 * une interface étroite, une implémentation réelle, un double de test qui parle EXACTEMENT le
 * même langage. Ce n'est pas une coquetterie d'architecture — c'est ce qui permet de prouver
 * la chaîne complète sans le compte de l'utilisateur, et ce qui laisse un autre transport
 * (par exemple un vrai serveur MCP, si `gws` en rejette un jour un) se brancher sans retoucher
 * les outils.
 *
 * Choix assumé, vérifié sur le binaire et non supposé : `gws` n'expose PAS de serveur MCP
 * (`gws mcp` → « Unknown service 'mcp' » ; le sous-ordre a été ajouté puis retiré en v0.8.0,
 * voir le CHANGELOG du dépôt). Le transport disponible est donc le CLI, appelé par processus
 * fils. Il est plus simple à borner qu'un serveur : pas de port, pas de session, un appel = une
 * requête HTTP que l'on peut vérifier localement avec `--dry-run`.
 */
import type { GoogleCallOutcome } from './envelope.js';

/** Services que l'agent connaît. Un service absent d'ici n'est pas appelable. */
export const GOOGLE_SERVICES = ['gmail', 'drive', 'docs', 'sheets', 'calendar', 'tasks', 'auth'] as const;
export type GoogleService = (typeof GOOGLE_SERVICES)[number];

export interface GoogleCall {
  /** Sert à la liste blanche de configuration et au journal — jamais composé du texte du modèle. */
  service: GoogleService;
  /**
   * Arguments passés au binaire, sans son nom. Construits par les outils, jamais reçus du
   * modèle : le modèle ne fournit que des VALEURS, qui entrent dans un `--params` encodé en
   * JSON. C'est ce qui rend l'injection impossible par construction.
   */
  argv: string[];
  /** true → modification côté Google : jamais rejouée, jamais sans approbation humaine. */
  write: boolean;
  /** Nom d'outil, pour le journal et l'audit. */
  label: string;
  /** Plafond d'octes lus sur stdout ; au-delà le fils est tué (un fichier de 200 Mo ne doit pas entrer en mémoire). */
  maxOutputBytes?: number;
  /** Dépasse `googleTimeoutMs` — pour un export volumineux assumé. */
  timeoutMs?: number;
  /** true → `--dry-run` : construction vérifiée, aucun appel réseau, aucun secret requis. */
  dryRun?: boolean;
}

export interface GoogleTransportInfo {
  kind: 'gws-cli';
  /** Chemin réellement résolu (un `gws` du dépôt n'est pas celui d'une installation globale). */
  bin: string;
  /** Version annoncée par le binaire, ou inconnue si l'interrogation a échoué. */
  version: string;
  /** true si le binaire répond : distinguer « non installé » de « non authentifié ». */
  reachable: boolean;
  /** Pointeur ADC mort : suffisant, à lui seul, pour faire échouer tous les appels. */
  adcHint?: string;
}

export interface GoogleTransport {
  readonly info: GoogleTransportInfo;
  run(call: GoogleCall): Promise<GoogleCallOutcome>;
  /** Fermé = plus aucun fils ne vit, et `run` rend une erreur de transport. */
  close(reason?: string): Promise<void>;
}

/** Erreur de programmation : levée au démarrage, jamais pendant un tour de conversation. */
export class GoogleTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleTransportError';
  }
}

/** Un service n'est pas appelable parce que la configuration ne l'autorise pas. */
export function isServiceAllowed(allowed: ReadonlySet<string>, service: GoogleService): boolean {
  return allowed.has(service);
}

/**
 * Encodage d'un `--params` : les valeurs du modèle deviennent des données, jamais des arguments.
 * Un paramètre répété de l'API (`metadataHeaders`) se passe en TABLEAU : une chaîne citée
 * partirait en une seule valeur, et le `--dry-run` du CLI le montre mot pour mot.
 */
export function paramsFlag(params: Record<string, string | number | boolean | readonly string[]>): string {
  return JSON.stringify(params);
}
