/**
 * Le tour de parole d'un appel : la pièce qui relie l'oreille, le cerveau et la bouche.
 *
 * POURQUOI UNE MACHINE À ÉTATS EXPLICITE : trois événements arrivent en désordre —
 * la fin de phrase détectée localement, le `committed_transcript` du fournisseur, et la
 * reprise de parole de l'utilisateur pendant que l'agent parle. Sans arbitre, on a soit
 * deux tours pour une même phrase (double facture LLM + réponse qui se marche dessus),
 * soit une interruption qui ne coupe rien. Ici : une seule file, un seul tour à la fois,
 * et un `AbortController` par tour qui annule vraiment l'appel LLM (le budget de
 * l'utilisateur est en jeu, pas seulement sa patience).
 *
 * CE QUE LA SESSION NE FAIT PAS : elle n'a pas de second cerveau. Elle appelle
 * `runAgent` avec le `chatId` de la conversation Telegram, donc la mémoire, les outils,
 * l'audit et les plafonds d'itérations sont exactement ceux du mode texte — l'appel est
 * une *autre bouche sur la même tête*, pas un agent parallèle.
 *
 * LE PLAFOND EST ICI, PAS « PLUS TARD » : une conversation vocale consomme deux factures
 * par tour (transcription + synthèse) plus le LLM. Sans plafond de durée et de tours, un
 * appel laissé ouvert est un compteur qui tourne. Dépassement = on le dit à voix haute,
 * on clôture, on persiste.
 */
import type { AgentDeps } from '../core/agent.js';
import { runAgent } from '../core/agent.js';
import { log } from '../core/logger.js';
import { clampForSpeech, stripForSpeech } from '../audio/synthesize.js';
import type { LiveListener, LiveSpeaker, SpeakResult, SpeechSink } from './protocol.js';
import { SpeechBudget, type ListenerEvent } from './protocol.js';

export interface CallClient {
  text(payload: unknown): void;
  binary(bytes: Uint8Array): void;
  close(reason: string): void;
  readonly closed: boolean;
}

export interface RealtimeSessionDeps {
  chatId: number;
  userId: number;
  agent: AgentDeps;
  sink: SpeechSink;
  listener: LiveListener;
  speaker: LiveSpeaker | null;
  client: CallClient;
  /** Ce qui est annoncé dans l'appel quand il s'ouvre (zéro facture : un mot, pas un paragraphe). */
  greeting?: string;
  /** Reply trop long pour la voix, ou voix dégradée : on écrit dans le chat. */
  sendChatText?: (text: string) => Promise<void> | void;
  limits: {
    maxMinutes: number;
    maxTurns: number;
    maxSpeechCharsPerTurn: number;
    /** Attendre la fin de lecture annoncée par le client, sans qu'il gèle l'appel. */
    playbackGraceMs: number;
  };
}

export interface CallSummary {
  turns: number;
  seconds: number;
  speechChars: number;
  interruptedTurns: number;
  endReason: string;
  ear: string;
  spokenTurns: number;
}

type State = 'idle' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'ended';

export class RealtimeSession {
  private state: State = 'idle';
  private turns = 0;
  private interrupted = 0;
  private startedAt = Date.now();
  private budget: SpeechBudget;
  private controller: AbortController | null = null;
  private queue: Promise<void> = Promise.resolve();
  private playbackWaiter: (() => void) | null = null;
  private closedFlag = false;
  private lastPartialSent = '';

  constructor(private readonly deps: RealtimeSessionDeps) {
    this.budget = new SpeechBudget(deps.limits.maxSpeechCharsPerTurn * Math.max(1, deps.limits.maxTurns));
    deps.listener.on((event) => this.onListenerEvent(event));
  }

  get active(): boolean {
    return !this.closedFlag;
  }

  get turnCount(): number {
    return this.turns;
  }

  /** Lancement : l'oreille s'ouvre, l'agent dit un mot, et on passe à l'écoute. */
  async start(): Promise<void> {
    await Promise.resolve(this.deps.listener.start());
    this.setState('listening');
    if (this.deps.greeting !== undefined && this.deps.greeting !== '') {
      await this.announce(this.deps.greeting);
    }
  }

  /** Le hub branche les cadres binaires ici. */
  onAudio(pcm: Uint8Array): void {
    if (this.closedFlag) return;
    this.deps.listener.feed(pcm);
  }

  onControl(control: { t: string; muted?: boolean; text?: string }): void {
    if (this.closedFlag) return;
    switch (control.t) {
      case 'mute':
        this.deps.listener.setMuted(control.muted === true);
        this.setState(control.muted === true ? 'muted' : 'listening');
        return;
      case 'stop':
        void this.end('arrêt demandé par le client');
        return;
      case 'flush':
        // Le client a fini de lire ce qu'on lui a envoyé : on peut réécouter.
        this.releasePlayback();
        return;
      case 'text': {
        const text = typeof control.text === 'string' ? control.text.trim() : '';
        if (text === '') return;
        this.enqueue(async () => {
          await this.runTurn(text, null);
        });
        return;
      }
      default:
        return;
    }
  }

  /** Le client est parti (onglet fermé, réseau perdu) : on clôture proprement. */
  onClientGone(): void {
    void this.end('connexion client perdue');
  }

  async end(reason: string): Promise<void> {
    if (this.closedFlag) return;
    this.enqueue(() => this.finish(reason));
    await this.queue;
  }

  summary(): CallSummary {
    return {
      turns: this.turns,
      seconds: Math.round((Date.now() - this.startedAt) / 1000),
      speechChars: this.budget.spent,
      interruptedTurns: this.interrupted,
      endReason: this.endReason,
      ear: this.deps.listener.name,
      spokenTurns: this.spokenTurns,
    };
  }

  private endReason = 'en cours';
  private spokenTurns = 0;

  // ------------------------------------------------------------- file ---

  /** Une seule file : deux tours ne peuvent pas se chevaucher, quel que soit l'ordre des events. */
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task, task).catch((error: unknown) => {
      log.warn('session temps réel : tour en échec', { chatId: this.deps.chatId, erreur: String(error).slice(0, 160) });
    });
  }

  private onListenerEvent(event: ListenerEvent): void {
    switch (event.type) {
      case 'partial':
        if (this.state !== 'listening' || event.text === this.lastPartialSent) return;
        this.lastPartialSent = event.text;
        this.deps.sink.caption('in', event.text, false);
        return;
      case 'speech-start':
        // Un début de phrase : on repart d'un sous-titre vide côté client.
        this.lastPartialSent = '';
        return;
      case 'interrupt':
        this.enqueue(() => this.handleInterrupt());
        return;
      case 'turn-end':
        this.enqueue(() => this.handleTurnEnd(event));
        return;
      case 'note':
        this.deps.sink.note(event.text);
        return;
      case 'error':
        log.warn('session temps réel : oreille en échec', {
          chatId: this.deps.chatId,
          raison: event.message.slice(0, 160),
          transitoire: event.retryable,
        });
        this.deps.sink.note(`oreille : ${event.message.slice(0, 120)}`);
        return;
    }
  }

  /** Coupure d'un énoncé en cours (parole détectée pendant que l'agent parle). */
  private async handleInterrupt(): Promise<void> {
    this.interrupted += 1;
    this.controller?.abort();
    this.deps.speaker?.abort();
    this.deps.sink.speechEnd();
    this.deps.client.text({ t: 'interrupt' });
    this.releasePlayback();
    this.setState('listening');
  }

  private async handleTurnEnd(event: Extract<ListenerEvent, { type: 'turn-end' }>): Promise<void> {
    if (event.tooShort || event.text === '') {
      if (event.tooShort && event.seconds > 0) {
        this.deps.sink.note('Trop court pour être une question — parle un peu plus longtemps.');
        this.setState('listening');
      }
      return;
    }
    this.deps.sink.caption('in', event.text, true);
    await this.runTurn(event.text, event.transcript);
  }

  /**
   * Un tour : cerveau → voix. `text` est déjà la transcription validée par l'oreille ;
   * `runAgent` fait le reste (mémoire, outils, audit, plafonds d'itérations).
   */
  private async runTurn(text: string, transcript: { provider: string; model: string } | null): Promise<void> {
    if (this.closedFlag) return;
    const now = Date.now();
    const minutes = (now - this.startedAt) / 60_000;
    if (minutes >= this.deps.limits.maxMinutes) {
      await this.finish(`durée maximale atteinte (${this.deps.limits.maxMinutes} min)`);
      return;
    }
    if (this.turns >= this.deps.limits.maxTurns) {
      await this.finish(`nombre maximal d'échanges atteint (${this.deps.limits.maxTurns})`);
      return;
    }

    this.turns += 1;
    this.setState('thinking');
    const controller = new AbortController();
    this.controller = controller;
    const started = Date.now();

    let reply: Awaited<ReturnType<typeof runAgent>>;
    try {
      reply = await runAgent(this.deps.agent, {
        chatId: this.deps.chatId,
        userId: this.deps.userId,
        text,
        channel: 'call',
        signal: controller.signal,
        onPartial: (partial) => {
          if (controller.signal.aborted) return;
          if (this.deps.speaker === null) return;
          // Le flux est coupe AU BUDGET, lui aussi : sinon la synthese partielle ecrirait les
          // 2 000 caracteres d'une reponse longue avant meme que le texte final soit connu.
          const said = stripForSpeech(partial);
          if (said.length <= this.deps.limits.maxSpeechCharsPerTurn) void this.deps.speaker.write(said);
        },
      });
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      log.warn('session temps réel : tour interrompu', { chatId: this.deps.chatId, tour: this.turns, annulé: aborted });
      this.setState('listening');
      return;
    } finally {
      this.controller = null;
    }

    if (controller.signal.aborted) {
      // L'utilisateur a coupé pendant la réflexion : rien à dire, et rien de facturé en plus.
      this.setState('listening');
      return;
    }

    // Sous-titres d'abord : ils coûtent zéro et ils font la différence perçue.
    this.deps.sink.caption('out', reply.text, true);

    // Le texte est BORNE avant d'etre envoye au synthetiseur : le budget par tour est la ligne
    // qui dit a l'utilisateur « tant de caracteres de voix par reponse », et la facture du
    // fournisseur se calcule sur ce qu'on lui ecrit, pas sur l'intention. Sans ce clamp, une
    // reponse longue etait dite en entier (et payee en entier) des le premier tour.
    const clamped = clampForSpeech(stripForSpeech(reply.text), this.deps.limits.maxSpeechCharsPerTurn);
    const speakable = clamped.text;
    const allowed = this.budget.take(speakable.length);
    // Référence locale : la nullité de `this.deps.speaker` doit être éliminée UNE fois, et
    // rester valable à l'intérieur des fermetures (TS ne propage pas le narrowing à travers `this`).
    const speaker = this.deps.speaker;
    if (speaker === null || !allowed || speakable.length === 0) {
      await this.deliverTextually(reply.text, speaker === null ? 'aucune voix temps réel' : 'budget de voix de l’appel atteint');
      this.setState('listening');
      return;
    }

    this.setState('speaking');
    this.deps.listener.setAgentSpeaking(true);
    this.deps.sink.speechStart();
    if (clamped.truncated) {
      // Ce qui n'a pas pu être dit est écrit, pas perdu : une reponse coupee en pleine phrase
      // est pire qu'une reponse lue. C'est la meme regle que le mode miroir du chat.
      await this.deliverTextually(reply.text, 'réponse plus longue que le budget de voix du tour');
    }
    let result: SpeakResult;
    try {
      await speaker.begin((chunk) => this.deps.sink.audio(chunk));
      // `onPartial` a déjà écrit au fil de la génération ; on ne remet QUE le reste, sinon la
      // fin de phrase serait synthétisée deux fois — deux fois le prix, et une redite à l'oreille.
      const tail = speakable.slice(this.spokenChars).trimStart();
      if (tail !== '') await speaker.write(tail);
      result = await speaker.end();
    } catch (error) {
      log.warn('session temps réel : voix en échec', { chatId: this.deps.chatId, erreur: error instanceof Error ? error.message.slice(0, 120) : 'inconnue' });
      await this.deliverTextually(reply.text, 'la voix a échoué sur ce tour');
      this.deps.sink.speechEnd();
      this.deps.listener.setAgentSpeaking(false);
      this.setState('listening');
      return;
    } finally {
      this.spokenChars = 0;
    }

    this.spokenTurns += 1;
    this.deps.sink.speechEnd();
    this.deps.listener.setAgentSpeaking(false);
    if (result.interrupted) {
      this.deps.client.text({ t: 'interrupt' });
      this.setState('listening');
      return;
    }
    // Le client est seul à savoir quand le dernier octet est sorti du haut-parleur.
    await this.waitForPlayback();
    this.setState('listening');

    log.info('session temps réel : tour parlé', {
      chatId: this.deps.chatId,
      tour: this.turns,
      latenceMs: Date.now() - started,
      premierOctetMs: result.firstByteMs,
      caractères: result.chars,
      fournisseur: result.provider,
      ecoute: transcript === null ? '—' : transcript.provider,
    });
  }

  private spokenChars = 0;

  /** Voix indisponible ou budget touché : la réponse n'est pas perdue, elle est écrite. */
  private async deliverTextually(text: string, reason: string): Promise<void> {
    this.deps.sink.note(`Voix indisponible (${reason}) : réponse écrite dans la conversation.`);
    const send = this.deps.sendChatText;
    if (send !== undefined) {
      try {
        await send(text);
      } catch {
        /* le canal peut être parti : l'appel ne meurt pas pour un envoi Telegram */
      }
    }
  }

  private async announce(text: string): Promise<void> {
    this.deps.sink.caption('out', text, true);
    const speaker = this.deps.speaker;
    if (speaker === null) return;
    if (!this.budget.take(text.length)) return;
    try {
      await speaker.begin((chunk) => this.deps.sink.audio(chunk));
      await speaker.write(text);
      this.spokenChars = text.length;
      await speaker.end();
    } catch {
      /* une salutation ratée ne vaut pas la fermeture de l'appel */
    } finally {
      this.spokenChars = 0;
    }
  }

  private waitForPlayback(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.playbackWaiter = null;
        resolve();
      }, this.deps.limits.playbackGraceMs);
      this.playbackWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private releasePlayback(): void {
    const waiter = this.playbackWaiter;
    this.playbackWaiter = null;
    if (waiter !== null) waiter();
  }

  private setState(state: 'listening' | 'thinking' | 'speaking' | 'muted'): void {
    this.state = state;
    this.deps.sink.state(state);
  }

  private async finish(reason: string): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.endReason = reason;
    this.controller?.abort();
    this.releasePlayback();
    try {
      this.deps.listener.flush?.();
    } catch {
      /* clôture déjà décidée */
    }
    try {
      this.deps.speaker?.close();
    } catch {
      /* flux déjà fermé */
    }
    this.deps.listener.close();

    const summary = this.summary();
    log.info('session temps réel : appel clôturé', {
      chatId: this.deps.chatId,
      tours: summary.turns,
      dureeSec: summary.seconds,
      voix: `${summary.spokenTurns}/${summary.turns}`,
      caractères: summary.speechChars,
      interrompus: summary.interruptedTurns,
      motif: reason,
    });
    this.deps.sink.state('ended', reason);
    this.deps.sink.close(reason);
    this.deps.client.close(reason);
  }
}
