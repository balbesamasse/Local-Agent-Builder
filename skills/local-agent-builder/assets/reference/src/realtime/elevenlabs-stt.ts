/**
 * Oreille temps réel : client WebSocket du `scribe_v2_realtime` d'ElevenLabs.
 *
 * PROTOCOLE (relevé sur la doc officielle, `GET /v1/speech-to-text/realtime`) :
 *   - connexion `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=…&audio_format=pcm_16000&…`,
 *     clé dans l'en-tête `xi-api-key` (JAMAIS dans l'URL : une query string se retrouve
 *     dans les journaux du proxy, de la plateforme, du navigateur) ;
 *   - montante : `{message_type:'input_audio_chunk', audio_base_64, commit, sample_rate}` ;
 *   - descendante : `session_started`, `partial_transcript`, `committed_transcript`,
 *     et une douzaine de types `*_error` (dont `auth_error`, `quota_exceeded_error`).
 *
 * DEUX CHOIX QUI COMPTENT :
 *   1. `commit_strategy=manual` : c'est NOUS qui décidons la fin de tour (voir `vad.ts`),
 *      pas le fournisseur. La session garde ainsi le même arbitrage du tour de parole
 *      que le mode « blocs » de repli, et le texte envoyé au cerveau est exactement ce
 *      que le VAD a entendu — sinon deux horloges se disputent la fin de phrase.
 *   2. Zéro journalisation du contenu : les partiels traversent la session pour les
 *      sous-titres, jamais pour le journal (même doctrine que le reste du projet).
 *
 * Le constructeur accepte un fabrique de websocket : les tests injectent un serveur
 * local et n'appellent jamais le vrai fournisseur.
 */
import { AudioError } from '../audio/types.js';
import { INPUT_SAMPLE_RATE, type RealtimeSocket, type SocketFactory } from './protocol.js';

/** Options du client. `socketFactory` est obligatoire : sans lui, aucun test honnête. */
export interface RealtimeSttOptions {
  apiKey: string;
  /** Base WEBSOCKET, ex. `wss://api.elevenlabs.io/v1` (ou `ws://127.0.0.1:port/v1` en test). */
  wsBaseUrl: string;
  modelId: string;
  /** Seuil/longueurs passés au VAD côté fournisseur — on ne s'en sert pas pour clôturer, mais il lit les partiels. */
  vadThreshold?: number;
  vadSilenceThresholdSecs?: number;
  languageCode?: string;
  keyterms?: string[];
  timeoutMs: number;
  keepaliveMs?: number;
  /** Tentatives de reconnexion avant de rendre la main (défaut 1 : un appel ne doit pas mourir d'un reset réseau). */
  reconnectAttempts?: number;
  socketFactory: SocketFactory;
}

export interface RealtimeSttHandlers {
  onPartial(text: string): void;
  onCommitted(text: string): void;
  onReady?(): void;
  onError?(error: AudioError): void;
  onClose?(info: { code: number; reason: string; willReconnect: boolean }): void;
}

/** Le fournisseur répond `pcm_16000` : 16 kHz mono 16 bits, la cadence de notre montante. */
const AUDIO_FORMAT = 'pcm_16000';

/** Les erreurs qui valent une reconnexion (ou un basculement de mode) plutôt qu'un plantage. */
const RETRYABLE_ERRORS = new Set([
  'quota_exceeded_error',
  'throttled_error',
  'rate_limited_error',
  'queue_overflow_error',
  'resource_exhausted_error',
  'session_time_limit_exceeded_error',
  'transcriber_error',
]);

export class RealtimeSttClient {
  private socket: RealtimeSocket | null = null;
  private ready = false;
  private closed = false;
  private lastActivity = 0;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private attempts = 0;
  private committedChars = 0;

  constructor(
    private readonly opts: RealtimeSttOptions,
    private readonly handlers: RealtimeSttHandlers,
  ) {}

  get open(): boolean {
    return this.ready;
  }

  /** Caractères engagés depuis l'ouverture — sert de trace de ce qui a été consommé. */
  get transcribedChars(): number {
    return this.committedChars;
  }

  start(): Promise<void> {
    if (this.opts.apiKey === '') throw new AudioError('aucune clé ElevenLabs : transcription temps réel indisponible', false);
    return this.connect();
  }

  private connect(): Promise<void> {
    const url = this.buildUrl();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: AudioError) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      let socket: RealtimeSocket;
      try {
        socket = this.opts.socketFactory(url, { 'xi-api-key': this.opts.apiKey });
      } catch (error) {
        fail(toAudioError(error, true));
        return;
      }
      this.socket = socket;

      const timer = setTimeout(() => fail(new AudioError('ouverture de la session temps réel : délai dépassé', true)), this.opts.timeoutMs);
      const clear = () => clearTimeout(timer);

      socket.on('open', () => {
        // Rien n'est encore « prêt » : on attend `session_started`, sinon les premiers
        // cadres partent dans le vide et la première syllabe de l'utilisateur est perdue.
      });

      socket.on('message', (arg?: unknown) => {
        const raw = readMessage(arg);
        if (raw === null) return;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return; // une trame qu'on ne sait pas lire n'est pas une raison de couper l'appel
        }
        const type = typeof payload['message_type'] === 'string' ? (payload['message_type'] as string) : '';
        this.lastActivity = Date.now();

        if (type === 'session_started') {
          this.ready = true;
          this.attempts = 0;
          this.startKeepalive();
          this.handlers.onReady?.();
          clear();
          done();
          return;
        }
        if (type === 'partial_transcript') {
          const text = typeof payload['text'] === 'string' ? payload['text'] : '';
          if (text !== '') this.handlers.onPartial(text);
          return;
        }
        if (type === 'committed_transcript' || type === 'final_transcript') {
          const text = typeof payload['text'] === 'string' ? payload['text'].trim() : '';
          if (text !== '') {
            this.committedChars += text.length;
            this.handlers.onCommitted(text);
          }
          return;
        }
        if (type.endsWith('_error')) {
          const message = typeof payload['error'] === 'string' ? (payload['error'] as string) : type;
          const error = new AudioError(
            `temps réel ElevenLabs : ${message.slice(0, 160)}`,
            RETRYABLE_ERRORS.has(type),
            type === 'auth_error' ? 401 : null,
          );
          // Une clé refusée est une réponse définitive : on ne se reconnecte pas, on bascule.
          if (type === 'auth_error' || type === 'invalid_request' || type === 'unaccepted_terms_error') this.closed = true;
          this.handlers.onError?.(error);
          return;
        }
      });

      socket.on('error', (arg?: unknown) => {
        const error = toAudioError(arg, true);
        if (!this.ready) {
          clear();
          fail(error);
          return;
        }
        this.handlers.onError?.(error);
      });

      socket.on('close', (arg?: unknown) => {
        this.ready = false;
        this.stopKeepalive();
        const code = typeof arg === 'number' ? arg : 1006;
        const canRetry = !this.closed && this.attempts < (this.opts.reconnectAttempts ?? 1);
        if (canRetry) {
          this.attempts += 1;
          this.connect().catch((error: unknown) => {
            this.handlers.onError?.(toAudioError(error, false));
            this.handlers.onClose?.({ code, reason: 'reconnexion impossible', willReconnect: false });
          });
          clear();
          if (!settled) {
            settled = true;
            resolve(); // l'appelant ne doit pas être puni d'une coupure survenue après l'ouverture
          }
          return;
        }
        clear();
        this.handlers.onClose?.({ code, reason: 'fermeture du fournisseur', willReconnect: false });
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  private buildUrl(): string {
    const url = new URL(`${this.opts.wsBaseUrl.replace(/\/$/, '')}/speech-to-text/realtime`);
    url.searchParams.set('model_id', this.opts.modelId);
    url.searchParams.set('audio_format', AUDIO_FORMAT);
    url.searchParams.set('commit_strategy', 'manual');
    if (this.opts.languageCode) url.searchParams.set('language_code', this.opts.languageCode);
    if (this.opts.keyterms && this.opts.keyterms.length > 0) url.searchParams.set('keyterms', this.opts.keyterms.join(','));
    // On laisse le fournisseur émettre ses partiels ; la clôture du tour reste notre décision.
    url.searchParams.set('vad_threshold', String(this.opts.vadThreshold ?? 0.4));
    url.searchParams.set('vad_silence_threshold_secs', String(this.opts.vadSilenceThresholdSecs ?? 1.5));
    url.searchParams.set('no_verbatim', 'true');
    return url.toString();
  }

  /** Un cadre PCM16 (16 kHz mono). `commit=true` clôt l'énoncé en cours chez le fournisseur. */
  sendPcm(pcm: Uint8Array, commit = false): void {
    if (this.socket === null || !this.isOpen()) return;
    const copy = Uint8Array.prototype.slice.call(pcm);
    const message: Record<string, unknown> = {
      message_type: 'input_audio_chunk',
      audio_base_64: Buffer.from(copy.buffer).toString('base64'),
      commit,
      sample_rate: INPUT_SAMPLE_RATE,
    };
    this.socket.send(JSON.stringify(message));
    this.lastActivity = Date.now();
  }

  /** Le canal est ouvert ET la session du fournisseur est démarrée : on peut écrire. */
  isOpen(): boolean {
    // 1 = OPEN (constante WebSocket) ; on ne dépend pas de l'import du module `ws` ici.
    return this.socket !== null && this.socket.readyState === 1 && this.ready;
  }

  private startKeepalive(): void {
    const ms = this.opts.keepaliveMs ?? 18_000;
    if (ms <= 0 || this.keepalive !== null) return;
    this.keepalive = setInterval(() => {
      if (this.closed || !this.isOpen()) return;
      if (Date.now() - this.lastActivity < ms) return;
      this.socket?.send(JSON.stringify({ message_type: 'keep_alive' }));
      this.lastActivity = Date.now();
    }, Math.max(1000, Math.floor(ms / 2)));
    // Une minuterie ne doit jamais, à elle seule, empêcher le processus de s'éteindre.
    this.keepalive.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepalive !== null) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    this.stopKeepalive();
    try {
      this.socket?.close();
    } catch {
      /* déjà fermé : rien à dire */
    }
    this.socket = null;
  }
}

function readMessage(arg: unknown): string | null {
  if (typeof arg === 'string') return arg;
  if (Buffer.isBuffer(arg)) return arg.toString('utf8');
  if (arg instanceof Uint8Array) return Buffer.from(arg).toString('utf8');
  if (typeof arg === 'object' && arg !== null && 'toString' in arg) {
    const text = String((arg as { toString(): string }).toString());
    return text === '[object Object]' ? null : text;
  }
  return null;
}

function toAudioError(error: unknown, retryable: boolean): AudioError {
  if (error instanceof AudioError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AudioError(`temps réel audio indisponible : ${message.slice(0, 160)}`, retryable);
}
