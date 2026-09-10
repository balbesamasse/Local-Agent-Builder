/**
 * L'oreille de l'appel : deux modes, une seule interface.
 *
 *   1. `temps réel` — un websocket ElevenLabs (`RealtimeSttClient`) reçoit les cadres au
 *      fil de l'eau et rend des transcriptions *partielles* ; c'est ce qui permet
 *      d'afficher la phrase pendant que l'utilisateur la prononce, et de raccourcir le
 *      temps avant que le cerveau se mette au travail.
 *   2. `blocs` — repli autonome : VAD local, puis une transcription du bloc sur le même
 *      `Transcriber` que les messages vocaux Telegram (Groq Whisper d'abord, Scribe en
 *      secours). Aucun nouveau compte, aucun nouveau secret : si le websocket tombe en
 *      plein appel, l'appel continue, juste un peu moins vif.
 *
 * Le basculement est déclenché par une erreur du fournisseur temps réel, et n'est JAMAIS
 * un échec pour l'utilisateur : la raison est journalisée (sans contenu), le mode est
 * annoncé dans les sous-titres. C'est là que le contrat `LiveListener` prouve son
 * utilité : la session, elle, ne sait pas lequel des deux elle utilise.
 */
import { AudioError, type Transcriber } from '../audio/types.js';
import { INPUT_SAMPLE_RATE, muxWav, type LiveListener, type ListenerEvent } from './protocol.js';
import { UtteranceVad, type VadEvent } from './vad.js';
import { RealtimeSttClient } from './elevenlabs-stt.js';
import type { SocketFactory } from './protocol.js';

export interface ListenerOptions {
  /** Clé + modèle du mode temps réel ; absents = mode blocs d'office. */
  apiKey: string;
  wsBaseUrl: string;
  realtimeModel: string;
  languageCode?: string;
  timeoutMs: number;
  /** Délai d'attente d'un `committed_transcript` avant de juger le temps réel muet. */
  commitGraceMs?: number;
  vad?: ConstructorParameters<typeof UtteranceVad>[0];
  transcriber: Transcriber | null;
  socketFactory?: SocketFactory;
}

export class RealtimeListener implements LiveListener {
  readonly name = 'oreille temps réel';
  private readonly vad: UtteranceVad;
  private handler: ((event: ListenerEvent) => void) | null = null;
  private stt: RealtimeSttClient | null = null;
  private committed = '';
  private waitCommitted: (() => void) | null = null;
  private mode: 'temps réel' | 'blocs';
  private muted = false;
  private closed = false;
  private agentSpeaking = false;
  /** Un tour ouvert côté VAD, pour ne jamais clôturer deux fois la même phrase. */
  private turnOpen = false;

  private constructor(private readonly opts: ListenerOptions) {
    this.vad = new UtteranceVad(opts.vad ?? {});
    this.mode = opts.apiKey === '' || opts.socketFactory === undefined ? 'blocs' : 'temps réel';
  }

  /** fabrique temps réel (websocket + VAD + repli blocs). */
  static create(opts: ListenerOptions): RealtimeListener {
    return new RealtimeListener(opts);
  }

  /** Branchement unique, avant `start`. */
  on(handler: (event: ListenerEvent) => void): void {
    this.handler = handler;
  }

  /**
   * Emporter un événement après `close()` ne doit pas casser le hub (le socket est déjà
   * rendu) ni réveiller une session terminée : la garde est ici, une seule fois, pas à
   * chaque émetteur du fichier.
   */
  private emit(event: ListenerEvent): void {
    if (this.closed) return;
    this.handler?.(event);
  }

  /** Le nom rendu à l'utilisateur et au journal dit la VÉRITÉ sur le mode en cours. */
  /**
   * Le flux du fournisseur est-il ouvert AU POINT d'accepter de l'audio ? La session s'en sert
   * pour ne pas annoncer « je t'écoute » avant que l'oreille soit réellement branchée.
   */
  get ready(): boolean {
    return this.stt !== null && this.stt.isOpen();
  }

  get ear(): string {
    return this.mode === 'temps réel' ? 'elevenlabs-temps-réel' : 'vad+blocs';
  }

  get currentMode(): 'temps réel' | 'blocs' {
    return this.mode;
  }

  /** L'agent est-il en train de parler ? Change le seuil du VAD (barge-in). */
  setAgentSpeaking(value: boolean): void {
    this.agentSpeaking = value;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.vad.reset(false);
  }

  /** Ouvre le flux temps réel. En cas d'échec, bascule sur les blocs — et dit pourquoi. */
  async start(): Promise<void> {
    if (this.mode !== 'temps réel' || this.opts.socketFactory === undefined) return;
    const client = new RealtimeSttClient(
      {
        apiKey: this.opts.apiKey,
        wsBaseUrl: this.opts.wsBaseUrl,
        modelId: this.opts.realtimeModel,
        languageCode: this.opts.languageCode,
        timeoutMs: this.opts.timeoutMs,
        socketFactory: this.opts.socketFactory,
      },
      {
        onPartial: (text) => {
          // Le partiel ne sert qu'au sous-titre : la décision de clôture reste au VAD local.
          if (!this.agentSpeaking) this.emit({ type: 'partial', text });
        },
        onCommitted: (text) => {
          this.committed += `${this.committed === '' ? '' : ' '}${text}`;
          this.releaseWaiter();
        },
        onError: (error) => this.degrade(error),
        onClose: ({ willReconnect }) => {
          if (!willReconnect) this.degrade(new AudioError('flux de transcription fermé', true));
        },
      },
    );
    try {
      await client.start();
      this.stt = client;
      this.emit({ type: 'note', text: `oreille : ${this.ear}` });
    } catch (error) {
      client.close();
      this.degrade(error instanceof AudioError ? error : new AudioError('transcription temps réel indisponible', true));
    }
  }

  /** Un cadre de la montante. Tout le découpage du tour de parole se décide ici. */
  feed(pcm: Uint8Array): void {
    if (this.closed || this.muted || pcm.byteLength === 0) return;
    this.stt?.sendPcm(pcm, false);
    const event = this.vad.push(pcm, this.agentSpeaking);
    if (event === null) return;
    this.handleVad(event);
  }

  /** Le client signale qu'il coupe son micro : on rend l'état cohérent. */
  private handleVad(event: VadEvent): void {
    if (event.type === 'speech-start') {
      this.turnOpen = true;
      this.committed = '';
      this.emit({ type: 'speech-start' });
      return;
    }
    if (event.type === 'interrupt') {
      this.emit({ type: 'interrupt' });
      return;
    }
    // speech-end
    if (!this.turnOpen) return;
    this.turnOpen = false;
    const seconds = event.seconds;
    void this.closeTurn(event.pcm, seconds, event.tooShort);
  }

  /** Clôture du tour : partiel/committed du fournisseur en temps réel, sinon transcription du bloc. */
  private async closeTurn(pcm: Uint8Array, seconds: number, tooShort: boolean): Promise<void> {
    if (this.closed) return;
    const durationSec = seconds;
    if (tooShort) {
      this.emit({ type: 'turn-end', text: '', transcript: null, seconds: durationSec, tooShort: true });
      return;
    }

    if (this.mode === 'temps réel' && this.stt !== null) {
      this.stt.sendPcm(new Uint8Array(0), true); // commit : le fournisseur doit rendre sa version finale
      const got = await this.waitForCommitted(this.opts.commitGraceMs ?? 2_500);
      if (got && this.committed !== '') {
        const text = this.committed.trim();
        this.emit({
          type: 'turn-end',
          text,
          seconds: durationSec,
          tooShort: false,
          transcript: { text, provider: this.ear, model: this.opts.realtimeModel, language: this.opts.languageCode ?? null, durationSec },
        });
        return;
      }
      // Temps réel muet sur ce tour : on transmet le bloc au même titre que le mode repli,
      // et on garde le temps réel pour la suite (une phrase ratée ne condamne pas l'appel).
      this.emit({ type: 'note', text: 'partiel muet sur ce tour, transcription du bloc' });
    }

    if (this.opts.transcriber === null) {
      this.emit({ type: 'error', message: 'aucun fournisseur de transcription disponible', retryable: false });
      return;
    }
    try {
      const wav = muxWav(pcm, INPUT_SAMPLE_RATE);
      const transcript = await this.opts.transcriber.transcribe({ bytes: wav, mime: 'audio/wav', fileName: `appel-${Date.now()}.wav` });
      const text = transcript.text.trim();
      this.emit({ type: 'turn-end', text, transcript, seconds: durationSec, tooShort: text === '' });
    } catch (error) {
      this.emit({
        type: 'error',
        message: error instanceof AudioError ? error.message : 'transcription impossible',
        retryable: !(error instanceof AudioError) ? true : error.retryable,
      });
    }
  }

  /** Passage forcé en mode blocs (erreur du fournisseur temps réel). */
  private degrade(error: AudioError): void {
    if (this.mode === 'blocs' || this.closed) return;
    this.mode = 'blocs';
    this.stt?.close();
    this.stt = null;
    this.releaseWaiter();
    // Le motif est court et sans contenu : « quota atteint », « clé refusée », « réseau ».
    this.emit({ type: 'note', text: `oreille : bascule en mode blocs (${error.message.slice(0, 90)})` });
  }

  private waitForCommitted(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.committed !== '') return resolve(true);
      const timer = setTimeout(() => {
        this.waitCommitted = null;
        resolve(false);
      }, ms);
      this.waitCommitted = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
  }

  private releaseWaiter(): void {
    const waiter = this.waitCommitted;
    this.waitCommitted = null;
    if (waiter !== null) waiter();
  }

  /** L'appel se termine pendant que l'utilisateur parlait : on rend le morceau, pas de perte silencieuse. */
  flush(): void {
    const rest = this.vad.flush();
    if (rest === null || rest.pcm.byteLength === 0) return;
    this.turnOpen = false;
    void this.closeTurn(rest.pcm, rest.seconds, rest.tooShort);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseWaiter();
    this.stt?.close();
    this.stt = null;
    this.vad.reset(false);
  }

}

