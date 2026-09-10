/**
 * Transport `gws` : un processus fils par appel, sans shell.
 *
 * Trois décisions de sécurité viennent de contraintes vérifiées, pas de principes :
 *
 * - **argv, jamais une ligne de commande** : `spawn(bin, argv, { shell: false })`. Les valeurs
 *   viennent du modèle ; avec un shell, une seule citation cassée deviendrait de l'exécution.
 * - **environnement minimal** : l'agent charge `.env` dans `process.env`, donc un fils hériterait
 *   du token Telegram et des clés de fournisseurs. Le fils ne reçoit que PATH, HOME, le fuseau,
 *   et les variables `GOOGLE_*` / `GWS_*` que CE projet lui destine.
 * - **plafond d'octes** : `drive files get --params '{"alt":"media"}'` sur un fichier de 200 Mo
 *   remplirait la mémoire. On compte à la lecture et on tue au-delà.
 *
 * Une écriture n'est jamais rejouée : sur une déconnexion, on ne sait pas si Google a appliqué
 * la modification, et réessayer un `+send` enverrait deux mails.
 *
 * invariant: exec-transport — ce module lance un binaire métier installé (`gws`), jamais une ligne
 * de commande et jamais du texte du modèle : argv est un tableau, `shell` est à false, et l'env du
 * fils passe par `childEnvironment`. Ces trois faits SONT la contrepartie de la levée de la règle
 * « no-code-execution » : le vérificateur les contrôle dans le fichier, il ne croit pas ce
 * commentaire sur parole — le retirer ne changerait donc rien, le retirer EN LEURRE un non plus.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { classify, type GoogleCallOutcome, type GoogleRawResult } from './envelope.js';
import { log } from '../core/logger.js';
import { redact } from './redact.js';
import { assertNoForeignSecretsFor } from './secrets.js';
import type { GoogleCall, GoogleTransport, GoogleTransportInfo } from './transport.js';

export interface GwsTransportOptions {
  /** Nom ou chemin du binaire, tel que configuré. */
  bin: string;
  /** Racine du projet : `node_modules/.bin` est cherché avant le PATH. */
  workspaceRoot: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Appels simultanés autorisés (les quotas Google sont par utilisateur). */
  maxInFlight: number;
  /** Tentatives totales pour une LECTURE faillible (1 = aucun rejeu). */
  readAttempts: number;
  /** Variables GOOGLE_* / GWS_* destinées au fils. */
  env: Record<string, string>;
  /**
   * Environnement du père — injecté pour que les tests prouvent l'isolation sans tricher.
   * Absent, c'est celui du processus : le lire ici est la SEULE entorse a « process.env confine a
   * config.ts », et elle est voulee a filtrer, pas a choisir un reglage (un transport dote de son
   * propre environnement ne peut pas passer par AppConfig sans que les secrets y entrent).
   */
  parentEnv?: NodeJS.ProcessEnv;
  /** Injecté par les tests : faux lanceur, pour observer l'argv et l'env réellement reçus. */
  spawnImpl?: (bin: string, argv: string[], options: ChildSpawnOptions) => ChildHandle;
}

export interface ChildSpawnOptions {
  env: Record<string, string>;
  cwd: string;
  shell: false;
  detached: boolean;
  stdio: ['ignore', 'pipe', 'pipe'];
  windowsHide: boolean;
}

/** Vue étroite d'un ChildProcess, suffisante ici et remplaçable dans les tests. */
export interface ChildHandle {
  pid?: number;
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Ce que le noyau autorise toujours — le reste de l'environnement du père reste au père. */
export const ENV_CORE = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const;
/**
 * Ce qui est transmis au fils, et rien d'autre. `GOOGLE_WORKSPACE_` et non `GOOGLE_` : sous le
 * préfixe large, `GOOGLE_APPLICATION_CREDENTIALS` passerait — et c'est exactement ce qui a fait
 * échouer le CLI dans ce dépôt (une clé déclarée pour d'autres raisons, pointant vers un fichier
 * absent : `gws` refuse toute la chaîne d'authentification là-dessus, avant même de regarder
 * `~/.config/gws`). Un préfixe d'environnement est une autorisation, pas un filtre de confort.
 */
export const ENV_PREFIXES = ['GOOGLE_WORKSPACE_', 'GWS_'] as const;

export function childEnvironment(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ENV_CORE) {
    const value = base[name];
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  for (const [name, value] of Object.entries(base)) {
    if (ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) && typeof value === 'string' && value !== '') {
      out[name] = value;
    }
  }
  // L'heritage d'abord, la volonte du projet ensuite : sans cet ordre, un
  // GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND pose dans le shell de l'utilisateur ecrasait la valeur
  // decidee par la configuration — et la configuration annonce ce qu'elle croit imposer.
  for (const [name, value] of Object.entries(extra)) {
    if (value !== '') out[name] = value;
  }
  return out;
}

/**
 * Liste des clés de fournisseur qui n'ont rien à faire dans l'environnement d'un fils Google.
 * Vérifiée au démarrage ET dans les tests : la règle ne vaut que si elle est mesurée sur ce que
 * le projet contient réellement ce jour-là.
 */
export function forbiddenInheritedKeys(env: NodeJS.ProcessEnv): string[] {
  const forbidden = /(?:TELEGRAM|GROQ|OPENROUTER|ELEVENLABS|DB_PATH)/i;
  return Object.keys(env).filter((name) => forbidden.test(name));
}

/** Un ADC fantôme fait échouer `gws` AVANT qu'il ne regarde ses propres credentials : à refuser. */
export function staleAdcPointer(env: NodeJS.ProcessEnv, workspaceRoot: string): string | undefined {
  const target = env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (typeof target !== 'string' || target === '') return undefined;
  const candidate = target.startsWith('/') ? target : join(workspaceRoot, target);
  return existsSync(candidate) ? undefined : `GOOGLE_APPLICATION_CREDENTIALS pointe vers ${target}, qui n'existe pas — le CLI Google échoue là-dessus avant même de chercher ses propres credentials`;
}

export function resolveGwsBin(configured: string, workspaceRoot: string, pathValue: string): { bin: string; note?: string } {
  const looksLikePath = configured.includes('/') || configured.includes('\\');
  const candidates = looksLikePath
    ? [configured]
    : [join(workspaceRoot, 'node_modules', '.bin', configured), ...pathValue.split(delimiter).filter((dir) => dir !== '').map((dir) => join(dir, configured))];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return { bin: candidate };
  }
  return {
    bin: candidates[0] ?? configured,
    note: `binaire « ${configured} » introuvable : ni dans ${join(workspaceRoot, 'node_modules', '.bin')}, ni dans PATH`,
  };
}

function isExecutable(candidate: string): boolean {
  try {
    if (!existsSync(candidate)) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class GwsCliTransport implements GoogleTransport {
  public readonly info: GoogleTransportInfo;
  private readonly binNote: string | undefined;
  private readonly live = new Set<ChildHandle>();
  private running = 0;
  private closed = false;
  private readonly waiters: Array<() => void> = [];

  // invariant: env-enfant — process.env est lu ici pour etre FILTRE (voir childEnvironment), jamais pour lire un reglage du projet.
  private readonly parentEnv: NodeJS.ProcessEnv;

  constructor(private readonly options: GwsTransportOptions) {
    this.parentEnv = options.parentEnv ?? process.env;
    const resolved = resolveGwsBin(options.bin, options.workspaceRoot, this.parentEnv['PATH'] ?? '');
    this.binNote = resolved.note;
    this.info = { kind: 'gws-cli', bin: resolved.bin, version: 'inconnue', reachable: false };
  }

  /**
   * Interroge le binaire une fois, au démarrage. Séparé du constructeur parce qu'un constructeur
   * ne doit pas lancer de processus : le transport se construit aussi dans les tests.
   */
  async probe(): Promise<{ note?: string }> {
    if (this.closed) return { note: 'transport fermé' };
    // Le pointeur ADC mort se detecte ICI et nulle part ailleurs : c'est le transport qui
    // construit l'environnement du fils, donc c'est lui qui sait ce qui va vraiment etre herite.
    // Un deuxieme calcul dans index.ts finirait par diverger du premier (et a deja diverge).
    const adc = this.info.adcHint ??= staleAdcPointer(this.parentEnv, this.options.workspaceRoot);
    const child = await this.spawnOnce({ service: 'auth', argv: ['--version'], write: false, label: 'gws --version' });
    if (child.exitCode === 0 && child.stdout.trim() !== '') {
      const first = (redact(child.stdout).split('\n')[0] ?? '').replace(/^gws\s*/, '').trim();
      this.info.version = first.slice(0, 32);
      this.info.reachable = true;
      log.info('client Google disponible', { binaire: this.info.bin, version: this.info.version });
    }
    return {
      note: this.info.reachable ? (adc ?? this.binNote) : (this.binNote ?? `« ${this.info.bin} » ne répond pas`),
    };
  }

  /**
   * Ce que l'environnement du fils interdit. `leaks` est fatal : une cle de fournisseur laissee
   * passer la est une faute de cablage, et un fils qui la voit peut la renvoyer dans un message
   * d'erreur. `notes` se crie au demarrage sans empecher le service.
   */
  envDiagnostics(): { leaks: string[]; notes: string[] } {
    const childEnv = this.childEnv;
    const leaks = assertNoForeignSecretsFor(childEnv, this.parentEnv);
    const notes: string[] = [];
    const adc = staleAdcPointer(this.parentEnv, this.options.workspaceRoot);
    if (adc !== undefined) notes.push(adc);
    // Nommer ce qui a ete RETENU rend la liste blanche verifiable a l'oeil : « le fils n'a pas la
    // cle du bot » doit se lire au demarrage, pas se deviner quand un appel échoue.
    const withheld = forbiddenInheritedKeys(this.parentEnv).filter((name) => !(name in childEnv));
    if (withheld.length > 0) {
      notes.push(`clés du père retenues au client Google : ${withheld.slice(0, 6).join(', ')}${withheld.length > 6 ? `, +${withheld.length - 6}` : ''}`);
    }
    return { leaks, notes };
  }

  /** L'environnement REÇU par un fils. Un seul calcul : le diagnostic porte sur ce qui est réellement passé. */
  private get childEnv(): Record<string, string> {
    return childEnvironment(this.parentEnv, this.options.env);
  }

  async run(call: GoogleCall): Promise<GoogleCallOutcome> {
    const attempts = call.write ? 1 : Math.max(1, Math.min(3, this.options.readAttempts));
    if (this.closed) {
      return classify(closedRaw(), { write: call.write, maxExcerpt: 200 });
    }
    let last: GoogleCallOutcome | undefined;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const outcome = await this.withSlot(async () => {
        const child = await this.spawnOnce(call);
        if (child.overflow === true) {
          return tooBig(call, this.options.maxOutputBytes);
        }
        return classify(child, { write: call.write, maxExcerpt: 900 });
      });
      last = outcome;
      if (outcome.ok || outcome.failure === undefined || !outcome.failure.retryable) break;
      if (attempt < attempts) {
        log.warn('appel Google à reprendre', { outil: call.label, cause: outcome.failure.kind, prochaine: attempt + 1 });
        await sleep(Math.min(2000, 400 * 2 ** attempt));
      }
    }
    return last ?? classify(closedRaw(), { write: call.write, maxExcerpt: 200 });
  }

  async close(reason = 'arrêt'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const count = this.live.size;
    for (const child of [...this.live]) {
      try {
        killTree(child, 'SIGKILL');
      } catch {
        /* déjà mort */
      }
    }
    this.live.clear();
    if (count > 0) log.info('appels Google interrompus', { raison: reason, fils: count });
    let waiter = this.waiters.shift();
    while (waiter !== undefined) {
      waiter();
      waiter = this.waiters.shift();
    }
  }

  get inFlight(): number {
    return this.running;
  }

  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.options.maxInFlight) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }

  private spawnOnce(call: GoogleCall): Promise<ChildResult> {
    const argv = [...call.argv];
    if (call.dryRun === true) argv.push('--dry-run');
    const spawnOptions: ChildSpawnOptions = {
      env: this.childEnv,
      cwd: this.options.workspaceRoot,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    };
    const limit = call.maxOutputBytes ?? this.options.maxOutputBytes;
    const timeoutMs = call.timeoutMs ?? this.options.timeoutMs;

    return new Promise<ChildResult>((resolve) => {
      let child: ChildHandle;
      try {
        child = this.options.spawnImpl !== undefined
          ? this.options.spawnImpl(this.info.bin, argv, spawnOptions)
          : (spawn(this.info.bin, argv, spawnOptions) as unknown as ChildHandle);
      } catch (error) {
        resolve({ exitCode: -1, stdout: '', stderr: '', killed: false, timedOut: false, spawnError: String((error as Error).message ?? error) });
        return;
      }
      this.live.add(child);

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let overflow = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (exitCode: number, killed: boolean, spawnError?: string): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.live.delete(child);
        resolve({ exitCode, stdout, stderr, killed, timedOut, spawnError, overflow });
      };

      timer = setTimeout(() => {
        timedOut = true;
        killTree(child, 'SIGTERM');
        setTimeout(() => killTree(child, 'SIGKILL'), 1500).unref?.();
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > limit) {
          overflow = true;
          killTree(child, 'SIGKILL');
          finish(-1, true);
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString('utf8');
      });
      child.on('error', (error: Error) => finish(-1, false, error.message));
      child.on('close', (code, signal) => finish(code ?? (signal === null ? -1 : 1), signal !== null));
    });
  }
}

interface ChildResult extends GoogleRawResult {
  overflow?: boolean;
}

function closedRaw(): GoogleRawResult {
  return { exitCode: -1, stdout: '', stderr: '', killed: false, timedOut: false, spawnError: 'transport fermé — l’agent est en cours d’arrêt' };
}

function tooBig(call: GoogleCall, limit: number): GoogleCallOutcome {
  return {
    ok: false,
    failure: {
      kind: 'transport',
      message: `sortie Google trop volumineuse (plafond ${Math.round(limit / 1024)} Ko) : précise la recherche, ou demande un extrait`,
      exitCode: -1,
      needsReauth: false,
      retryable: false,
    },
    excerpt: `« ${call.label} » a rendu plus que le plafond`,
  };
}

function killTree(child: ChildHandle, signal: NodeJS.Signals): void {
  const pid = child.pid;
  try {
    if (typeof pid === 'number' && process.platform !== 'win32') process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* déjà mort */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
