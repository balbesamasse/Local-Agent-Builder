/**
 * Câblage du mode Live Voice : la config + les fournisseurs → un hub et des sessions.
 *
 * Pourquoi un fichier séparé : `index.ts` assemble déjà LLM, mémoire et canal, et ce module
 * est surtout ce que les TESTS importent pour monter un vrai appel contre de faux
 * fournisseurs, sans démarrer le bot ni parler à un service payant.
 *
 * Ce qui est réutilisé tel quel (c'est le sens de la fonctionnalité) :
 *   - `runAgent` : mêmes outils, même mémoire SQLite, mêmes plafonds d'itérations, même audit ;
 *   - `TranscriberChain` (Groq Whisper → Scribe) : le repli « mode blocs » de l'oreille ;
 *   - `getChatVoice` : LA voix choisie dans la conversation (`/voice`) est aussi celle qui
 *     parle dans l'appel — un appel qui changerait de voix tout seul serait une régression
 *     invisible dans le code et immédiate à l'oreille.
 */
import WebSocket from 'ws';
import type { AppConfig } from '../config.js';
import type { AgentDeps } from '../core/agent.js';
import type { Transcriber } from '../audio/types.js';
import { ElevenLabsSpeechStream } from './elevenlabs-tts.js';
import { RealtimeListener } from './listener.js';
import { buildRealtimeHub, type HubSessionInput, type RealtimeHub } from './hub.js';
import { wrapNodeWebSocket, type RealtimeSocket, type SocketFactory } from './protocol.js';
import type { RealtimeSessionDeps } from './session.js';

/**
 * Un seul client websocket sortant pour les deux flux ( transcription 16 kHz, voix 24 kHz ).
 * `perMessageDeflate: false` : la compression des trames audio coûte du CPU et de la
 * latence pour 0 octet gagné — un flux temps réel n'a rien à compresser rétroactivement.
 */
export const nodeSocketFactory: SocketFactory = (url, headers) => {
  const ws = new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 10_000 });
  return wrapNodeWebSocket(ws as unknown as Parameters<typeof wrapNodeWebSocket>[0]) as RealtimeSocket;
};

export interface RealtimeBundle {
  hub: RealtimeHub;
  /** Écoute et renvoie l'URL réelle (`REALTIME_PORT=0` → port attribué par l'OS). */
  listen(): Promise<{ port: number; url: string }>;
  /** Avertissements de démarrage : ce que l'utilisateur doit savoir avant le premier appel. */
  warnings: string[];
  describe(): { ear: string; mouth: string; budget: string; listen: string };
}

export interface WireOptions {
  config: AppConfig;
  agent: AgentDeps;
  /** Transcription par blocs : le repli de l'oreille (et le seul mode sans websocket fourni). */
  transcriber: Transcriber | null;
  /** Voix de l'appel par conversation : `getChatVoice(chatId) ?? ELEVENLABS_VOICE_ID`. */
  voiceFor: (chatId: number) => string | null;
  /** Salutation de début d'appel, courte et non facturée au-delà du budget d'un tour. */
  greeting?: string;
  /** Écrit dans le chat (bilan d'appel, réponse quand la voix a lâché). Fourni par le canal. */
  sendChatText?: (chatId: number, text: string) => Promise<void> | void;
  /** Injection de test : faux hub, faux fournisseur de voix. */
  socketFactory?: SocketFactory;
}

export function buildRealtimeBundle(opts: WireOptions): RealtimeBundle {
  const { config } = opts;
  const warnings: string[] = [];
  const sockets = opts.socketFactory ?? nodeSocketFactory;

  const buildSession = (input: HubSessionInput): Omit<RealtimeSessionDeps, 'chatId' | 'userId' | 'sink' | 'client'> => {
    const voiceId = opts.voiceFor(input.chatId) ?? config.elevenLabsVoiceId;
    // Le websocket d'écoute n'existe que si la clé ET une fabrique sont là. Sans fabrique,
    // on ne part pas d'un `undefined` : on configure le mode blocs, qui marche, lui, sans
    // fournisseur temps réel (c'est le cas d'un compte sans droit realtime).
    const canListen = config.elevenLabsApiKey !== '';

    const listener = RealtimeListener.create({
      apiKey: canListen ? config.elevenLabsApiKey : '',
      wsBaseUrl: config.elevenLabsWsUrl,
      realtimeModel: config.realtimeSttModel,
      timeoutMs: config.llmTimeoutMs,
      transcriber: opts.transcriber,
      vad: { silenceMs: config.realtimeVadSilenceMs },
      socketFactory: canListen ? sockets : undefined,
    });

    let speaker: ElevenLabsSpeechStream | null = null;
    if (config.elevenLabsApiKey !== '' && voiceId !== '') {
      try {
        speaker = new ElevenLabsSpeechStream({
          apiKey: config.elevenLabsApiKey,
          httpBaseUrl: config.elevenLabsBaseUrl,
          wsBaseUrl: config.elevenLabsWsUrl,
          voiceId,
          modelId: config.realtimeTtsModel,
          stability: config.elevenLabsStability,
          similarityBoost: config.elevenLabsSimilarity,
          timeoutMs: config.llmTimeoutMs,
          socketFactory: sockets,
        });
      } catch (error) {
        speaker = null;
        // La cause intéresse l'opérateur, pas l'appelant : on ne la remonte pas en conversation.
        warnings.push(`voix de l’appel indisponible : ${error instanceof Error ? error.message.slice(0, 90) : 'erreur'}`);
      }
    }

    return {
      agent: opts.agent,
      listener,
      speaker,
      greeting: opts.greeting ?? '',
      sendChatText: input.sendChatText,
      limits: {
        maxMinutes: config.realtimeMaxMinutes,
        maxTurns: config.realtimeMaxTurns,
        maxSpeechCharsPerTurn: config.ttsMaxChars,
        playbackGraceMs: 4_000,
      },
    };
  };

  const hub = buildRealtimeHub(
    {
      allowedUserIds: config.allowedUserIds,
      ticketTtlSeconds: config.realtimeTicketTtlSeconds,
      // Le débit entrant n'est pas facturé, mais il est transformé en octets à encoder pour
      // le fournisseur : un client déréglé ne doit pas pouvoir transformer l'appel en DDoS
      // sortant payé à notre place.
      maxFrameBytesPerSecond: Math.round((config.realtimeMaxFrameKbps * 1024) / 8),
      buildSession,
      ...(opts.sendChatText ? { sendChatText: opts.sendChatText } : {}),
      ...(config.realtimePublicUrl === '' ? {} : { publicBase: config.realtimePublicUrl }),
    },
    config.realtimeBind,
    config.realtimePort,
  );

  if (config.realtimeBind !== '127.0.0.1' && config.realtimeBind !== 'localhost') {
    warnings.push(
      config.realtimePublicUrl.startsWith('https://')
        ? 'hub à l’écoute sur une adresse publique — les liens restent à usage unique et 120 s'
        : 'hub public sans https:// : le navigateur refusera le micro (sauf en localhost)',
    );
  }
  if (opts.transcriber === null && config.elevenLabsApiKey === '') {
    warnings.push('appel live sans fournisseur d’écoute : configure GROQ_API_KEY ou ELEVENLABS_API_KEY');
  }

  return {
    hub,
    listen: () => hub.listen(),
    warnings,
    describe: () => ({
      ear: config.elevenLabsApiKey === '' ? 'vad+blocs' : `${config.realtimeSttModel} → repli vad+blocs`,
      mouth: config.elevenLabsApiKey === '' || config.elevenLabsVoiceId === '' ? 'aucune' : `${config.realtimeTtsModel} (pcm_24000)`,
      budget: `${config.realtimeMaxMinutes} min · ${config.realtimeMaxTurns} échanges · ${config.ttsMaxChars} car./tour`,
      listen: `${config.realtimeBind}:${config.realtimePort}`,
    }),
  };
}
