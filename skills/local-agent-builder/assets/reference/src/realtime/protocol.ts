/**
 * Protocole du mode Live Voice (`src/realtime/`).
 *
 * CE QUE TELEGRAM NE PERMET PAS (vérifié sur la doc officielle, changelog lu jusqu'au
 * 24 août 2026) : un bot ne peut ni passer ni recevoir d'appel VoIP. L'API Bot est un
 * HTTP de messagerie : aucune méthode de média temps réel, et les types d'appel vocal
 * (VoiceChatStarted, MessageVoiceChat…) ont été retirés en 2022 au profit des visio de
 * groupe, que le bot ne peut que *annoncer* textuellement. Pour entendre un bot en
 * appel réel il faut un compte UTILISATEUR (MTProto/tdlib + lib tgcalls) : hors de
 * question ici, ça voudrait dire confier au projet les credentials du compte humain.
 *
 * D'OÙ CETTE ARCHITECTURE : le son ne passe pas par Telegram. Le bot ouvre une page
 * (WebApp / lien HTTPS) qui tient une session temps réel avec l'agent. Le plan exact,
 * ses compromis et ses limitations sont écrits dans `docs/REALTIME.md`.
 *
 * LE POINT DE DESIGN : `LiveListener` (oreille) et `LiveSpeaker` (bouche) sont des
 * interfaces, pas des appels ElevenLabs éparpillés. Changer de fournisseur de STT ou de
 * TTS = écrire un adaptateur, sans toucher au tour de parole ni au cerveau. C'est ce qui
 * rend la partie payante et fragiles remplaçable, et ce qui la rend testable : les tests
 * injectent des faux adaptateurs et ne paient rien.
 */
import type { Transcript } from '../audio/types.js';

/** Cadence d'échantillonnage de la montée (micro → agent) : celle qu'aiment les Whisper. */
export const INPUT_SAMPLE_RATE = 16_000;
/** Descente (agent → haut-parleur) : 24 kHz = `pcm_24000` d'ElevenLabs, aucun rééchantillonnage. */
export const OUTPUT_SAMPLE_RATE = 24_000;
/** Un cadre de 40 ms en PCM16 mono à 16 kHz = 1280 octets. Assez petit pour le temps réel,
 * assez gros pour ne pas noyer la boucle d'événements sous les paquets. */
export const FRAME_MS = 40;
export const FRAME_SAMPLES = (INPUT_SAMPLE_RATE * FRAME_MS) / 1000;
export const FRAME_BYTES = FRAME_SAMPLES * 2;
/** Garde-fou : un cadre plus gros que ça est un client qui déconne (ou attaque), rejeté. */
export const MAX_FRAME_BYTES = 64 * 1024;

/** En-tête binaire `[B1][t:u32LE][pcm]` — `t` = horodatage client en ms, utile au diagnostic. */
const BINARY_MAGIC = 0x42;
const HEADER_BYTES = 5;

/** Ce que l'oreille (n'importe laquelle) fait remonter à la session. */
export type ListenerEvent =
  | { type: 'partial'; text: string }
  /** Détection locale de début de parole (indépendante du fournisseur). */
  | { type: 'speech-start' }
  /** L'utilisateur a repris la parole pendant que l'agent parlait. */
  | { type: 'interrupt' }
  /** Fin de tour : le texte vient soit du fournisseur temps réel, soit de la transcription du bloc. */
  | { type: 'turn-end'; text: string; transcript: Transcript | null; seconds: number; tooShort: boolean }
  | { type: 'error'; message: string; retryable: boolean }
  /** Information de service (bascule de mode, raison d'un repli) : sous-titre, jamais facture. */
  | { type: 'note'; text: string };

export type LivenessEvents = ListenerEvent[];

/** L'oreille : reçoit les cadres micro, rend des tours de parole. */
export interface LiveListener {
  readonly name: string;
  /** Branchement des événements (une seule fois, avant `start`). */
  on(handler: (event: ListenerEvent) => void): void;
  /** Ouvre le flux fournisseur ; un échec doit conduire à un repli, jamais à une exception. */
  start(): Promise<void> | void;
  /** Un cadre PCM16 mono à `INPUT_SAMPLE_RATE`. */
  feed(pcm: Uint8Array): void;
  /** Le micro est coupé (bouton muet du client) : l'oreille doit cesser de juger. */
  setMuted(muted: boolean): void;
  /**
   * Drapeau « l'agent parle » : change le seuil du VAD, pour que le haut-parleur ne se coupe
   * pas lui-même. Obligatoire (et non `?`) : un adaptateur qui ne sait pas faire le dit avec
   * une méthode vide — optionnel, le call-site devient `?.()` et l'oubli est invisible.
   */
  setAgentSpeaking(speaking: boolean): void;
  /** L'appel s'arrête avec une phrase en cours : on la rend plutôt que de la jeter. */
  flush?(): void;
  /** Ferme l'oreille proprement (fin d'appel, échec, interruption). */
  close(): void;
}

/**
 * Miroir minimal de `WebSocket` côté client : ce que nos adaptateurs utilisent, rien de plus.
 * Déclaré ici (et pas dans chaque adaptateur) pour qu'un faux serveur de test et le vrai
 * `ws` de Node aient exactement la même forme — sinon le test prouve le test, pas l'adaptateur.
 */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'message' | 'error' | 'close', handler: (arg?: unknown) => void): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => RealtimeSocket;

/** Fabrique un adaptateur `RealtimeSocket` autour du client `ws` de Node. */
export function wrapNodeWebSocket(ws: {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  on(event: string, handler: (...args: never[]) => void): unknown;
}): RealtimeSocket {
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    on: (event, handler) => {
      ws.on(event, ((arg?: unknown) => handler(arg)) as never);
    },
  };
}

/** Morceau de voix descendante : PCM16 à `OUTPUT_SAMPLE_RATE` par défaut. */
export interface SpeechChunk {
  bytes: Uint8Array;
  sampleRate: number;
}

export interface SpeakResult {
  /** L'octet de voix a-t-il été coupé en cours (barge-in, plafond, arrêt d'appel) ? */
  interrupted: boolean;
  chars: number;
  provider: string;
  /** Temps jusqu'au premier octet de voix, en ms — la métrique que l'utilisateur entend. */
  firstByteMs: number;
}

/**
 * La voix descendante en continu. Les méthodes sont TOUTES obligatoires et retournent
 * toutes une Promise : un contrat avec des `| void` optionnels oblige chaque appelant à
 * gérer les deux formes, et c'est exactement là que se cachent les `possibly undefined`.
 */
export interface LiveSpeaker {
  readonly name: string;
  /** Démarre un énoncé ; les `SpeechChunk` partent dans le `sink` au fil de l'eau. */
  begin(sink: (chunk: SpeechChunk) => void): Promise<void>;
  write(text: string): Promise<void>;
  /** Fin de l'énoncé en cours : renvoie la facture réelle (caractères, premier octet). */
  end(): Promise<SpeakResult>;
  /** Coupe immédiatement (barge-in). Aucun octet ne part plus après ça ; annule la facture en cours. */
  abort(): void;
  close(): void;
}

/** Ce que la session peut envoyer au client. Implémenté par le hub (websocket) et par les tests. */
export interface SpeechSink {
  audio(chunk: SpeechChunk): void;
  /** Début/fin d'énoncé : le client s'en sert pour la file de lecture et l'interruption. */
  speechStart(): void;
  speechEnd(): void;
  /** Sous-titres (partiels de l'entrée, texte de la réponse) : accessibilité et debug. */
  caption(role: 'in' | 'out', text: string, final: boolean): void;
  state(state: ClientState, detail?: string): void;
  /** Le message court, non facturé, qu'on peut rendre en texte si le client n'a pas de voix. */
  note(text: string): void;
  close(reason: string): void;
  readonly closed: boolean;
}

export type ClientState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'ended';

/** Message client → serveur (JSON, borné en taille par le hub). */
export type ClientControl =
  | { t: 'ready'; caps?: { tts?: boolean } }
  | { t: 'mute'; muted: boolean }
  | { t: 'stop' }
  | { t: 'flush' }
  | { t: 'text'; text: string };

export const MAX_CONTROL_CHARS = 4000;

/** Encode un cadre PCM pour la montante. */
export function encodeAudioFrame(pcm: Uint8Array, clientTimeMs: number): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + pcm.byteLength);
  out[0] = BINARY_MAGIC;
  new DataView(out.buffer).setUint32(1, clientTimeMs >>> 0, true);
  out.set(pcm, HEADER_BYTES);
  return out;
}

export type ParsedFrame = { kind: 'audio'; pcm: Uint8Array; clientTimeMs: number } | { kind: 'text'; text: string } | { kind: 'invalid'; why: string };

/**
 * Lecture d'un message entrant. `pcm` est une VUE sur le buffer du websocket : le hub
 * l'utilise immédiatement (VAD + tampon) et ne le garde pas au-delà du tour de boucle.
 */
export function parseClientFrame(data: Uint8Array | string): ParsedFrame {
  if (typeof data === 'string') {
    if (data.length > MAX_CONTROL_CHARS) return { kind: 'invalid', why: 'contrôle trop long' };
    return { kind: 'text', text: data };
  }
  if (data.byteLength < HEADER_BYTES) return { kind: 'invalid', why: 'trame trop courte' };
  if (data[0] !== BINARY_MAGIC) return { kind: 'invalid', why: 'en-tête inconnu' };
  const pcm = data.subarray(HEADER_BYTES);
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) return { kind: 'invalid', why: 'PCM16 de longueur impaire' };
  if (pcm.byteLength > MAX_FRAME_BYTES) return { kind: 'invalid', why: 'cadre audio trop volumineux' };
  return { kind: 'audio', pcm, clientTimeMs: new DataView(data.buffer, data.byteOffset, HEADER_BYTES).getUint32(1, true) };
}

/** RMS d'un cadre PCM16, normalisé sur [0,1]. Le VAD ne juge que ça. */
export function rms16(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

/** Enveloppe WAV (RIFF/PCM16 mono) : ce que les fournisseurs de transcription savent lire. */
export function muxWav(pcm16: Uint8Array, sampleRate: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const str = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + pcm16.byteLength, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, pcm16.byteLength, true);
  const out = new Uint8Array(header.byteLength + pcm16.byteLength);
  out.set(header, 0);
  out.set(pcm16, header.byteLength);
  return out;
}

/**
 * Tampon circulaire de PCM : la montante ne doit JAMAIS être écrite sur le disque, et ne
 * doit pas non plus grossir sans bornes si le fournisseur s'emballe. On garde le dernier
 * `maxBytes`, en perdant le plus vieux — un appel n'a pas besoin d'entendre 10 minutes en arrière.
 */
export class PcmRing {
  private readonly buffer: Uint8Array;
  private start = 0;
  private length = 0;

  constructor(readonly maxBytes: number) {
    this.buffer = new Uint8Array(maxBytes);
  }

  get size(): number {
    return this.length;
  }

  push(pcm: Uint8Array): void {
    if (pcm.byteLength >= this.maxBytes) {
      this.buffer.set(pcm.subarray(pcm.byteLength - this.maxBytes));
      this.start = 0;
      this.length = this.maxBytes;
      return;
    }
    if (this.length + pcm.byteLength > this.maxBytes) {
      const drop = this.length + pcm.byteLength - this.maxBytes;
      this.start = (this.start + drop) % this.maxBytes;
      this.length -= drop;
    }
    const end = (this.start + this.length) % this.maxBytes;
    if (end + pcm.byteLength <= this.maxBytes) {
      this.buffer.set(pcm, end);
    } else {
      const first = this.maxBytes - end;
      this.buffer.set(pcm.subarray(0, first), end);
      this.buffer.set(pcm.subarray(first), 0);
    }
    this.length += pcm.byteLength;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    const first = Math.min(this.length, this.maxBytes - this.start);
    out.set(this.buffer.subarray(this.start, this.start + first), 0);
    if (this.length > first) out.set(this.buffer.subarray(0, this.length - first), first);
    return out;
  }

  clear(): void {
    this.start = 0;
    this.length = 0;
  }
}

/** Budget de voix descendante : ce qui est effectivement envoyé au synthétiseur. */
export class SpeechBudget {
  private used = 0;
  constructor(private readonly maxChars: number) {}

  get remaining(): number {
    return Math.max(0, this.maxChars - this.used);
  }

  take(chars: number): boolean {
    if (this.used + chars > this.maxChars) return false;
    this.used += chars;
    return true;
  }

  get spent(): number {
    return this.used;
  }
}
