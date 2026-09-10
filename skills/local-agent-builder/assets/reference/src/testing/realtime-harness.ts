/**
 * Pièces fausses pour tester la couche temps réel SANS fournisseur.
 *
 * Deux principes, parce qu'un test de temps réel menteur est pire que pas de test :
 *  - le faux écouteur fait le VRAI travail de découpage (il instancie `UtteranceVad`) : on
 *    n'injecte pas un `turn-end` clé en main, on pousse des cadres et on regarde la session
 *    réagir à ce que le VAD décide réellement ;
 *  - la fausse voix rend du PCM réel (un bloc d'octets par segment écrit) : le sink, la file
 *    de lecture du client et le budget se testent sur des octets, pas sur des promesses vides.
 */
import { Store } from '../memory/store.js';
import { ApprovalGate } from '../security/approvals.js';
import { buildRegistry } from '../tools/index.js';
import { FakeLlm, makeTestConfig } from '../testing/fixtures.js';
import type { AgentDeps } from '../core/agent.js';
import { UtteranceVad } from '../realtime/vad.js';
import { RealtimeSession } from '../realtime/session.js';
import type { CallClient, RealtimeSessionDeps } from '../realtime/session.js';
import {
  INPUT_SAMPLE_RATE,
  type ClientState,
  type ListenerEvent,
  type LiveListener,
  type LiveSpeaker,
  type SpeakResult,
  type SpeechChunk,
  type SpeechSink,
} from '../realtime/protocol.js';

export const SAMPLE_RATE = INPUT_SAMPLE_RATE;
export const FRAME_SAMPLES = 640; // 40 ms à 16 kHz

/** Un cadre PCM16 à niveau constant (0.08 = voix, 0 = silence) pour le seuil du VAD. */
export function frame(level: number, samples = FRAME_SAMPLES): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i += 1) {
    view.setInt16(i * 2, Math.round(Math.sin(i / 5) * level * 32767), true);
  }
  return out;
}

/** Une « phrase » : assez de cadres volets pour ouvrir le tour, assez de silence pour le clôturer. */
export function utteranceFrames(spoken = 8, trailingSilence = 12): Uint8Array[] {
  return [...Array.from({ length: spoken }, () => frame(0.08)), ...Array.from({ length: trailingSilence }, () => frame(0))];
}

export const FAKE_TRANSCRIPT = 'il est quelle heure exactement';

export interface RecordedSink {
  sink: SpeechSink;
  client: CallClient;
  audio: SpeechChunk[];
  captions: Array<{ role: 'in' | 'out'; text: string; final: boolean }>;
  states: ClientState[];
  notes: string[];
  closed: string[];
  textPayloads: unknown[];
  binaryPayloads: Uint8Array[];
}

/** Sink + client de test : tout est enregistré dans des listes, rien n'est envoyé sur un réseau. */
export function makeSink(): RecordedSink {
  const audio: SpeechChunk[] = [];
  const captions: RecordedSink['captions'] = [];
  const states: ClientState[] = [];
  const notes: string[] = [];
  const closed: string[] = [];
  const textPayloads: unknown[] = [];
  const binaryPayloads: Uint8Array[] = [];
  let gone = false;
  const sink: SpeechSink = {
    audio: (chunk) => audio.push(chunk),
    speechStart: () => notes.push('speech-start'),
    speechEnd: () => notes.push('speech-end'),
    caption: (role, text, final) => captions.push({ role, text, final }),
    state: (state) => states.push(state),
    note: (text) => notes.push(text),
    close: (reason) => {
      gone = true;
      closed.push(reason);
    },
    get closed() {
      return gone;
    },
  };
  const client: CallClient = {
    text: (payload) => textPayloads.push(payload),
    binary: (bytes) => binaryPayloads.push(bytes),
    close: (reason) => closed.push(`client:${reason}`),
    get closed() {
      return gone;
    },
  };
  return { sink, client, audio, captions, states, notes, closed, textPayloads, binaryPayloads };
}

export interface FakeListener extends LiveListener {
  events: ListenerEvent[];
  states: { agentSpeaking: boolean[]; muted: boolean[] };
  counts: { feeds: number; flushes: number; closes: number; starts: number };
  /** Pousse les cadres donnés ; le VAD décide, comme en production. */
  speak(frames?: Uint8Array[]): void;
  /** Change ce que le fournisseur aura « entendu » au prochain tour. */
  setTranscript(text: string): void;
  /**
   * Émet un événement directement. Sert aux tests qui doivent réagir à un état précis
   * (une interruption pendant un tour en cours) sans dépendre de la durée d'une réponse
   * — le chemin « le VAD décide l'interruption », lui, est testé dans realtime-vad.test.ts.
   */
  emit(event: ListenerEvent): void;
}

/**
 * Écouteur de test. Il reproduit le contrat de `RealtimeListener` (VAD local → événements,
 * texte convenu au moment de la clôture) sans websocket ni fournisseur.
 */
export function makeListener(options: { text?: string; silenceMs?: number } = {}): FakeListener {
  const vad = new UtteranceVad({ silenceMs: options.silenceMs ?? 200 });
  const events: ListenerEvent[] = [];
  let transcript = options.text ?? FAKE_TRANSCRIPT;
  let handler: ((event: ListenerEvent) => void) | null = null;
  let agentSpeaking = false;
  let muted = false;
  const listener: FakeListener = {
    name: 'écouteur de test',
    events,
    states: { agentSpeaking: [], muted: [] },
    counts: { feeds: 0, flushes: 0, closes: 0, starts: 0 },
    on: (next) => {
      handler = next;
    },
    start: () => {
      listener.counts.starts += 1;
      emit({ type: 'note', text: 'oreille : test' });
    },
    feed: (pcm) => {
      listener.counts.feeds += 1;
      if (muted) return;
      const event = vad.push(pcm, agentSpeaking);
      if (event === null) return;
      if (event.type === 'speech-start') emit({ type: 'speech-start' });
      if (event.type === 'interrupt') emit({ type: 'interrupt' });
      if (event.type !== 'speech-end') return;
      if (event.tooShort) {
        emit({ type: 'turn-end', text: '', transcript: null, seconds: event.seconds, tooShort: true });
        return;
      }
      emit({ type: 'partial', text: transcript.slice(0, 6) });
      emit({
        type: 'turn-end',
        text: transcript,
        seconds: event.seconds,
        tooShort: false,
        transcript: { text: transcript, provider: 'test', model: 'fake', language: 'fr', durationSec: event.seconds },
      });
    },
    setMuted: (value) => {
      muted = value;
      listener.states.muted.push(value);
      if (value) vad.reset(false);
    },
    setAgentSpeaking: (value) => {
      agentSpeaking = value;
      listener.states.agentSpeaking.push(value);
    },
    flush: () => {
      listener.counts.flushes += 1;
      const rest = vad.flush();
      if (rest === null || rest.pcm.byteLength === 0) return;
      emit({ type: 'turn-end', text: transcript, transcript: null, seconds: rest.seconds, tooShort: false });
    },
    close: () => {
      listener.counts.closes += 1;
    },
    speak: (frames = utteranceFrames()) => {
      for (const pcm of frames) listener.feed(pcm);
    },
    setTranscript: (text) => {
      transcript = text;
    },
    emit: (event) => emit(event),
  };
  const emit = (event: ListenerEvent): void => {
    events.push(event);
    handler?.(event);
  };
  return listener;
}

export interface FakeSpeaker extends LiveSpeaker {
  written: string[];
  counts: { begins: number; aborts: number; closes: number };
  /** true = `begin()` rejette : la voix est muette, la session doit écrire la réponse. */
  failOnBegin: boolean;
  /** true = `end()` rejette en cours d'énoncé : la réponse en cours bascule à l'écrit. */
  failOnEnd: boolean;
  /**
   * Blocke `end()` tant que `holdEnd` est vrai : c'est ce qui permet d'interrompre un tour
   * EN COURS au lieu d'arriver trop tard (une fausse voix qui rend son résultat en trois
   * microtâches ne laisse aucune fenêtre pour le barge-in).
   */
  holdEnd: boolean;
  releaseEnd: () => void;
  chunkBytes: number;
  firstByteMs: number;
}

export function makeSpeaker(options: { failOnBegin?: boolean; failOnEnd?: boolean; chunkBytes?: number } = {}): FakeSpeaker {
  const written: string[] = [];
  let into: ((chunk: SpeechChunk) => void) | null = null;
  const speaker: FakeSpeaker = {
    name: 'voix de test',
    written,
    counts: { begins: 0, aborts: 0, closes: 0 },
    failOnBegin: options.failOnBegin ?? false,
    failOnEnd: options.failOnEnd ?? false,
    chunkBytes: options.chunkBytes ?? 1920,
    firstByteMs: 3,
    holdEnd: false,
    releaseEnd: () => {},
    begin: async (sink) => {
      speaker.counts.begins += 1;
      if (speaker.failOnBegin) throw new Error('voix indisponible');
      into = sink;
    },
    write: async (text) => {
      if (text === '') return;
      written.push(text);
      into?.({ bytes: new Uint8Array(speaker.chunkBytes), sampleRate: 24_000 });
    },
    end: async (): Promise<SpeakResult> => {
      if (speaker.holdEnd) await new Promise<void>((resolve) => {
        speaker.releaseEnd = resolve;
      });
      if (speaker.failOnEnd) throw new Error('synthèse refusée');
      return { interrupted: false, chars: written.join('').length, provider: 'voix de test', firstByteMs: speaker.firstByteMs };
    },
    abort: () => {
      speaker.counts.aborts += 1;
      into = null;
    },
    close: () => {
      speaker.counts.closes += 1;
    },
  };
  return speaker;
}

export interface SessionHarnessOptions {
  reply?: string;
  /** `null` = aucun adaptateur de voix branché (config sans clé) : réponse écrite. */
  speaker?: FakeSpeaker | null;
  greeting?: string;
  limits?: Partial<RealtimeSessionDeps['limits']>;
  config?: Parameters<typeof makeTestConfig>[0];
}

export interface SessionHarness {
  deps: RealtimeSessionDeps;
  session: RealtimeSession;
  listener: FakeListener;
  speaker: FakeSpeaker;
  recorded: RecordedSink;
  store: Store;
  agent: AgentDeps;
  /** Le faux LLM, typé : les tests relisent les requêtesEffectives (prompts, nombre d'appels). */
  llm: FakeLlm;
  chatTexts: string[];
}

/** Une session complète sur un harnais d'agent déjà utilisé par les tests de la boucle. */
export function makeSessionHarness(options: SessionHarnessOptions = {}): SessionHarness {
  const store = new Store(':memory:');
  const config = makeTestConfig(options.config ?? {});
  const registry = buildRegistry(config);
  const agent: AgentDeps = {
    config,
    llm: new FakeLlm([{ text: options.reply ?? 'Il est dix-huit heures.' }]),
    store,
    registry,
    gate: new ApprovalGate(store, registry, config.approvalTtlMinutes),
  };
  const listener = makeListener();
  const speaker = options.speaker === undefined ? makeSpeaker() : options.speaker;
  const recorded = makeSink();
  const chatTexts: string[] = [];
  const deps: RealtimeSessionDeps = {
    chatId: 10,
    userId: 4242,
    agent,
    listener,
    speaker,
    sink: recorded.sink,
    client: recorded.client,
    greeting: options.greeting ?? '',
    sendChatText: (text) => {
      chatTexts.push(text);
    },
    limits: { maxMinutes: 10, maxTurns: 8, maxSpeechCharsPerTurn: 200, playbackGraceMs: 30, ...options.limits },
  };
  return {
    deps,
    session: new RealtimeSession(deps),
    listener,
    speaker: speaker ?? makeSpeaker(),
    recorded,
    store,
    agent,
    llm: agent.llm as FakeLlm,
    chatTexts,
  };
}

/** Attend que `predicate` devienne vrai en rendant la main à la boucle d'événements. */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition jamais atteinte');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Le nombre d'octets de voix effectivement descendus (le test du « ça a parlé »). */
export function audioBytes(recorded: RecordedSink): number {
  return recorded.audio.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
}
