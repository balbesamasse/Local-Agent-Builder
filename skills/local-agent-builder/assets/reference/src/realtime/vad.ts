/**
 * Détection de fin de tour locale (VAD à énergie).
 *
 * POURQUOI ELLE EST À NOUS ET PAS SEULEMENT FOURNIE PAR LE FABRICANT : la session doit
 * pouvoir interrompre l'agent pendant qu'il parle, et ça ne dépend d'aucun fournisseur —
 * sinon l'interruption disparaît dès qu'on change d'API de transcription. Elle sert aussi
 * de repli quand le websocket temps réel tombe : l'appel continue en mode « je coupe sur
 * le silence, je transmets le bloc », moins réactif mais vivant.
 *
 * Le seuil est en RMS normalisé [0,1] sur un cadre de 40 ms. Trois durées le rendent
 * utilisable sans sursauter à chaque claquement de langue ni hacher la parole :
 * montée (il faut N cadres voiced pour déclarer la parole), attente de fin (silence
 * prolongé), et durée minimale d'un énoncé (un toussotement n'est pas une question).
 */
import { PcmRing, FRAME_MS, rms16 } from './protocol.js';

export interface VadOptions {
  /** RMS au-dessus duquel un cadre est considéré comme de la parole. */
  threshold?: number;
  /** Pendant que l'agent parle, le micro capte son propre haut-parleur : on exige plus fort. */
  interruptThreshold?: number;
  /** Durée (ms) de parole continue avant de déclarer un début d'énoncé. */
  speechMinMs?: number;
  /** Silence (ms) qui clôt le tour. 450 ms : assez court pour paraître vif, assez long pour respirer. */
  silenceMs?: number;
  /** En dessous, on jette (bruit, toux, écho résiduel). */
  minUtteranceMs?: number;
  /** Amorce conservée avant le début détecté, pour ne pas manger la première syllabe. */
  prerollMs?: number;
  /** Durée maximale d'un énoncé : au-delà on clôt, sinon une toux longue devient un puits à budget. */
  maxUtteranceMs?: number;
}

export type VadEvent =
  | { type: 'speech-start' }
  /** `pcm` vide = trop court pour mériter une transcription (mais à signaler à l'utilisateur). */
  | { type: 'speech-end'; pcm: Uint8Array; seconds: number; tooShort: boolean }
  | { type: 'interrupt' };

const DEFAULTS = {
  threshold: 0.014,
  interruptThreshold: 0.05,
  speechMinMs: 160,
  silenceMs: 450,
  minUtteranceMs: 220,
  prerollMs: 200,
  maxUtteranceMs: 20_000,
} as const;

const framesFor = (ms: number): number => Math.max(1, Math.round(ms / FRAME_MS));

export class UtteranceVad {
  private readonly threshold: number;
  private readonly interruptThreshold: number;
  private readonly speechFrames: number;
  private readonly silenceFrames: number;
  private readonly minUtteranceFrames: number;
  private readonly maxUtteranceFrames: number;

  /** Amorce : les derniers cadres avant la détection, rendus avec l'énoncé. */
  private readonly preroll: PcmRing;
  /** L'énoncé en cours. */
  private readonly current: PcmRing;

  private readonly prerollMs: number;

  private started = 0;
  private voiced = 0;
  private silent = 0;
  private open = false;

  constructor(opts: VadOptions = {}) {
    this.threshold = opts.threshold ?? DEFAULTS.threshold;
    this.interruptThreshold = opts.interruptThreshold ?? DEFAULTS.interruptThreshold;
    this.speechFrames = framesFor(opts.speechMinMs ?? DEFAULTS.speechMinMs);
    this.silenceFrames = framesFor(opts.silenceMs ?? DEFAULTS.silenceMs);
    this.minUtteranceFrames = framesFor(opts.minUtteranceMs ?? DEFAULTS.minUtteranceMs);
    this.maxUtteranceFrames = framesFor(opts.maxUtteranceMs ?? DEFAULTS.maxUtteranceMs);
    this.prerollMs = framesFor(opts.prerollMs ?? DEFAULTS.prerollMs);
    this.preroll = new PcmRing(this.prerollMs * 2 * 640);
    // L'enonce en cours contient l'amorce EN PLUS de la parole : la capacity doit suivre les
    // deux, sinon un enonce de duree maximale reglee perd sa tete avant la transcription.
    this.current = new PcmRing((this.maxUtteranceFrames + this.prerollMs) * 2 * 640 + 4096);
  }

  /** Un énoncé est en cours de stockage (sert au budget et à l'arbitrage du tour). */
  get speaking(): boolean {
    return this.open;
  }

  /** Les cadres déjà accumulés (pour le partiel du fournisseur temps réel). */
  get utteranceBytes(): number {
    return this.current.size;
  }

  /** Entre deux tours : `keepPreroll=false` après une interruption (on repart à zéro). */
  reset(keepPreroll = true): void {
    this.started = 0;
    this.voiced = 0;
    this.silent = 0;
    this.open = false;
    this.current.clear();
    if (!keepPreroll) this.preroll.clear();
  }

  /**
   * Un cadre de la montante. Renvoie l'événement, ou null si rien n'est décidable.
   * `agentSpeaking` = l'agent est en train de parler : la parole détectée devient une
   * interruption, pas un nouveau tour (le tour en cours est clos par la session).
   */
  push(pcm: Uint8Array, agentSpeaking: boolean): VadEvent | null {
    const level = rms16(pcm);
    const limit = agentSpeaking ? this.interruptThreshold : this.threshold;
    const voiced = level >= limit;

    if (!this.open) {
      this.preroll.push(pcm);
      if (voiced) {
        this.voiced += 1;
        this.silent = 0;
        if (this.voiced >= this.speechFrames) {
          this.open = true;
          this.started = 0;
          this.current.push(this.preroll.bytes());
          this.preroll.clear();
          if (agentSpeaking) return { type: 'interrupt' };
          return { type: 'speech-start' };
        }
      } else {
        this.voiced = Math.max(0, this.voiced - 1);
      }
      return null;
    }

    this.current.push(pcm);
    this.started += 1;

    // Garde-fou de duree, EVALUE A CHAQUE CADRE : pose ici a l'epreuve, il ne se declenchait
    // que dans la branche « silence » — donc jamais sur une parole continue, exactement le cas
    // qu'il doit proteger (un utilisateur qui monopolise, un micro colle a une enceinte).
    if (this.started >= this.maxUtteranceFrames) return this.close();

    if (agentSpeaking) {
      // L'interruption est déjà déclarée ; on ne rouvre pas de tour tant que la session
      // n'a pas coupé l'agent. Le cadre reste dans le tampon : ce que l'utilisateur a dit
      // pendant la coupure fait partie de sa phrase.
      return null;
    }

    if (voiced) {
      this.silent = 0;
    } else {
      this.silent += 1;
      if (this.silent >= this.silenceFrames) return this.close();
    }
    return null;
  }

  /** L'appel se termine avec un énoncé inachevé : on le rend quand même (mieux que rien). */
  flush(): { pcm: Uint8Array; seconds: number; tooShort: boolean } | null {
    if (!this.open) return null;
    const event = this.close();
    if (event.type !== 'speech-end') return null;
    return { pcm: event.pcm, seconds: event.seconds, tooShort: event.tooShort };
  }

  private close(): VadEvent {
    const pcm = this.current.bytes();
    const frames = this.started;
    this.open = false;
    this.voiced = 0;
    this.silent = 0;
    this.started = 0;
    this.current.clear();
    const seconds = (frames * FRAME_MS) / 1000;
    const tooShort = frames < this.minUtteranceFrames;
    // Trop court pour être une phrase : on ne facture pas une transcription pour ça,
    // mais on le signale, sinon l'utilisateur croit que l'agent l'a ignoré.
    return { type: 'speech-end', pcm: tooShort ? new Uint8Array(0) : pcm, seconds, tooShort };
  }

  /** Le seuil réellement appliqué — exporté pour que les tests disent la vérité. */
  get appliedThreshold(): number {
    return this.threshold;
  }

  static readonly defaults = DEFAULTS;
}
