/**
 * Bouche temps réel : websocket `stream-input` d'ElevenLabs, avec repli HTTP.
 *
 * PROTOCOLE (relevé sur la doc officielle, `GET /v1/text-to-speech/{voice_id}/stream-input`) :
 *   - le PREMIER message doit porter `text: " "` (une espace), et c'est là — seulement là —
 *     que `voice_settings` et `generation_config` sont acceptés ; la clé voyage dans ce
 *     premier message, jamais dans l'URL (une query string se retrouve dans les journaux
 *     du proxy et de la plateforme) ;
 *   - ensuite `{text, flush?}`. `flush: true` force la génération du reste du tampon en fin
 *     d'énoncé : sans ça, une phrase courte reste coincée dans le `chunk_length_schedule`
 *     et l'utilisateur entend un silence infini ;
 *   - `{text: ""}` termine la génération du tour ;
 *   - descendante : `{audio: <base64>}` puis `{isFinal: true}`.
 *
 * `output_format=pcm_24000` : la page lit du PCM brut, donc aucun décodeur n'est embarqué,
 * et c'est le navigateur qui horodate la lecture — ce qui rend l'interruption possible.
 *
 * SI LE WEBSOCKET EST REFUSÉ (compte sans droit, proxy, panne) : on bascule une fois, on le
 * dit, et l'appel continue en mode « réponse écrite dans le chat » plutôt que de mourir.
 * Un appel haché vaut mieux qu'un appel coupé.
 */
import { AudioError, type Synthesizer } from '../audio/types.js';
import { OUTPUT_SAMPLE_RATE, type RealtimeSocket, type LiveSpeaker, type SpeakResult, type SpeechChunk } from './protocol.js';

/** Ce que la bouche sait faire du vivant : envoyer des cadres et prévenir. */
export interface LiveSink {
  audio(chunk: SpeechChunk): void;
  note(text: string): void;
}

export interface RealtimeTtsOptions {
  apiKey: string;
  /** Base HTTP du fournisseur (celle de la config) : servie au diagnostic et aux tests. */
  httpBaseUrl: string;
  /** Base WEBSOCKET (`wss://…/v1`) ; dérivée de `httpBaseUrl` si absente. */
  wsBaseUrl?: string;
  voiceId: string;
  modelId: string;
  stability: number;
  similarityBoost: number;
  chunkLengthScheduleMs?: number[];
  inactivityTimeoutSecs?: number;
  timeoutMs: number;
  /** Jamais appelée par ce module : la session s'en sert pour rendre le texte en vocal *après* l'appel. */
  postCallSynthesizer?: Synthesizer;
  socketFactory: (url: string, headers: Record<string, string>) => RealtimeSocket;
}

const VOICE_ID_RE = /^[A-Za-z0-9]{10,64}$/;
/** Un cadre de 40 ms à 24 kHz en PCM16 = 3840 octets. Le même débit que la montante. */
const CHUNK_BYTES = 3840;
/** Le `open` d'un websocket ne prouve pas que le fournisseur accepte la session : on attend
 * ce premier signal (audio ou `isFinal`), borné dans le temps. */
const FIRST_SIGNAL_MS = 15_000;

export class ElevenLabsSpeechStream implements LiveSpeaker {
  readonly name = 'elevenlabs-stream';
  private socket: RealtimeSocket | null = null;
  private connected = false;
  private opening: Promise<void> | null = null;
  private degraded: string | null = null;

  private sink: LiveSink | null = null;
  private turnText = '';
  private sentText = '';
  private firstByteAt = 0;
  private turnStartedAt = 0;
  private waitingFinal: (() => void) | null = null;
  private aborted = false;

  constructor(private readonly opts: RealtimeTtsOptions) {
    if (!VOICE_ID_RE.test(opts.voiceId)) {
      throw new AudioError('la voix demandée n’a pas la forme d’un identifiant ElevenLabs', false);
    }
    if (opts.apiKey === '') throw new AudioError('aucune clé ElevenLabs : voix temps réel indisponible', false);
  }

  get mode(): 'websocket' | 'dégradé' {
    return this.degraded === null ? 'websocket' : 'dégradé';
  }

  /** Motif du repli, s'il y en a un — la session le journalise, le client l'affiche. */
  get degradedBecause(): string | null {
    return this.degraded;
  }

  begin(sink: LiveSink | ((chunk: SpeechChunk) => void)): Promise<void> {
    this.sink = typeof sink === 'function' ? { audio: sink, note: () => undefined } : sink;
    this.turnText = '';
    this.sentText = '';
    this.firstByteAt = 0;
    this.aborted = false;
    this.turnStartedAt = Date.now();
    return this.ensure();
  }

  async write(text: string): Promise<void> {
    if (this.aborted || this.degraded !== null) return;
    this.turnText += text;
    await this.ensure();
    if (this.aborted || !this.connected) return;
    const rest = this.turnText.slice(this.sentText.length);
    if (rest === '') return;
    this.sentText = this.turnText;
    this.socket?.send(JSON.stringify({ text: rest.endsWith(' ') ? rest : `${rest} ` }));
  }

  async end(): Promise<SpeakResult> {
    const chars = this.turnText.length;
    if (this.degraded !== null || this.aborted || !this.connected) {
      return this.result(this.aborted || this.degraded !== null, chars, this.degraded ?? 'hors ligne');
    }
    this.socket?.send(JSON.stringify({ text: '', flush: true }));
    await this.waitForFinal();
    return this.result(this.aborted, chars, 'websocket');
  }

  abort(): void {
    this.aborted = true;
    this.releaseFinal();
    // Pas de fermeture du websocket : une interruption ne doit pas coûter une poignée de
    // main de plus, donc un blanc, au prochain énoncé.
  }

  close(): void {
    this.releaseFinal();
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.sink = null;
    if (socket === null) return;
    try {
      socket.send(JSON.stringify({ text: '' }));
    } catch {
      /* déjà parti */
    }
    try {
      socket.close();
    } catch {
      /* déjà parti */
    }
  }

  private result(interrupted: boolean, chars: number, provider: string): SpeakResult {
    const started = this.turnStartedAt === 0 ? Date.now() : this.turnStartedAt;
    return {
      interrupted,
      chars,
      provider,
      firstByteMs: this.firstByteAt === 0 ? 0 : this.firstByteAt - started,
    };
  }

  private async ensure(): Promise<void> {
    if (this.degraded !== null) return;
    if (this.connected) return;
    if (this.opening !== null) return await this.opening;
    this.opening = this.open().finally(() => {
      this.opening = null;
    });
    try {
      await this.opening;
    } catch (error) {
      this.degrade(error instanceof AudioError ? error.message : 'flux de voix indisponible');
    }
  }

  private degrade(reason: string): void {
    this.degraded = reason.slice(0, 160);
    this.socket?.close();
    this.socket = null;
    this.connected = false;
    this.sink?.note(`Voix temps réel indisponible (${this.degraded}). Je continue en écrivant dans la conversation.`);
    this.releaseFinal();
  }

  private open(): Promise<void> {
    const base = this.opts.wsBaseUrl ?? wsFromHttp(this.opts.httpBaseUrl);
    const url = new URL(`${base.replace(/\/$/, '')}/text-to-speech/${encodeURIComponent(this.opts.voiceId)}/stream-input`);
    url.searchParams.set('model_id', this.opts.modelId);
    url.searchParams.set('output_format', 'pcm_24000');
    url.searchParams.set('inactivity_timeout', String(this.opts.inactivityTimeoutSecs ?? 120));

    return new Promise<void>((resolve, reject) => {
      let socket: RealtimeSocket;
      try {
        socket = this.opts.socketFactory(url.toString(), {});
      } catch (error) {
        reject(new AudioError(`connexion websocket refusée : ${error instanceof Error ? error.message : 'erreur'}`, true));
        return;
      }
      this.socket = socket;
      let settled = false;
      const fail = (error: AudioError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => fail(new AudioError('délai dépassé à l’ouverture du flux de voix', true)), this.opts.timeoutMs);

      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            text: ' ',
            voice_settings: { stability: this.opts.stability, similarity_boost: this.opts.similarityBoost },
            generation_config: { chunk_length_schedule: this.opts.chunkLengthScheduleMs ?? [120, 250, 400, 800] },
            'xi-api-key': this.opts.apiKey,
          }),
        );
        this.connected = true;
        // L'ouverture du canal suffit à pouvoir écrire : le fournisseur bufferise de toute
        // façon jusqu'au premier déclencheur. Attendre un premier octet de voix imposerait
        // d'écrire une phrase avant de pouvoir parler, ce qui est exactement l'inverse.
        succeed();
      });

      socket.on('message', (arg?: unknown) => {
        const raw = typeof arg === 'string' ? arg : Buffer.isBuffer(arg) ? arg.toString('utf8') : null;
        if (raw === null) return;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return;
        }
        if (typeof payload['audio'] === 'string') {
          const bytes = Uint8Array.from(Buffer.from(payload['audio'], 'base64'));
          if (bytes.byteLength > 0) {
            if (this.firstByteAt === 0) this.firstByteAt = Date.now();
            this.emit(bytes);
          }
          return;
        }
        if (payload['isFinal'] === true) {
          this.releaseFinal();
          return;
        }
        const detail = typeof payload['detail'] === 'string' ? (payload['detail'] as string) : null;
        if (detail !== null) this.degrade(`fournisseur : ${detail}`);
      });

      socket.on('error', (arg?: unknown) => {
        fail(new AudioError(`voix temps réel : ${arg instanceof Error ? arg.message : 'erreur réseau'}`, true));
      });

      socket.on('close', () => {
        if (this.socket !== socket) return; // remplacé par une réouverture
        this.connected = false;
        this.releaseFinal();
        fail(new AudioError(`flux de voix fermé (délai d'inactivité de ${FIRST_SIGNAL_MS / 1000} s dépassé ?)`, true));
      });
    });
  }

  private emit(bytes: Uint8Array): void {
    if (this.aborted || this.sink === null) return;
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      this.sink.audio({
        bytes: Uint8Array.prototype.slice.call(bytes.subarray(offset, offset + CHUNK_BYTES)),
        sampleRate: OUTPUT_SAMPLE_RATE,
      });
    }
  }

  private waitForFinal(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.connected) return resolve();
      const finish = () => {
        clearTimeout(timer);
        this.waitingFinal = null;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(FIRST_SIGNAL_MS, this.opts.timeoutMs));
      this.waitingFinal = finish;
    });
  }

  private releaseFinal(): void {
    const wait = this.waitingFinal;
    this.waitingFinal = null;
    if (wait !== null) wait();
  }
}

function wsFromHttp(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.toString().replace(/\/$/, '');
}
