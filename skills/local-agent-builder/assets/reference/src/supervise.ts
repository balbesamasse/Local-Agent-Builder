/**
 * Superviseur : relance l'agent quand il meurt, et le laisse tranquille quand c'est voulu.
 *
 * Pourquoi ce fichier existe : le bot *peut* mourir pour des raisons qu'aucun `catch` ne
 * couvre — un `409 Conflict` parce qu'une seconde instance poll le même token, un OOM, une
 * exception dans du code tiers, ou (dans un bac à sable) la disparition de `node_modules`.
 * La bonne réponse n'est pas « ne jamais planter », c'est « repartir, en expliquant ».
 *
 * Trois décisions valent d'être écrites :
 *   - les codes de sortie sont un contrat (`78` = config, on ne relance pas ; `0` = arrêt
 *     demandé ; le reste = on relance) ;
 *   - le délai de relance croît, pour ne pas marteler un fournisseur pendant une panne ;
 *   - un verrou d'instance empêche deux superviseurs de se battre sur le même token
 *     Telegram — qui est précisément l'un des cas où le bot se tue lui-même.
 */
import { spawn, type ChildProcess } from 'node:child_process';
// DISK-WRITE-OK: journal du superviseur et fichier de verrou d'instance. Aucun media ne
// transite ici. La mention est exigee par l'invariant `media-no-residue`.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { log, mirrorToSink, registerSecrets, setDebug, setLogFile } from './core/logger.js';
import { EX_CONFIG, EX_OK } from './core/guard.js';

export interface SupervisorPolicy {
  /** Premier délai avant relance. */
  baseDelayMs: number;
  /** Plafond du délai (une panne durable ne doit pas produire une relance par seconde). */
  maxDelayMs: number;
  /** En dessous de cette durée de vie, l'échec compte comme consécutif. */
  unhealthyRunMs: number;
  /** Au-delà de ce nombre d'échecs consécutifs, on allonge beaucoup (et on le dit). */
  maxConsecutive: number;
  /** Le délai appliqué alors. */
  giveUpDelayMs: number;
  /** Codes de sortie pour lesquels relancer est inutile. */
  noRestartCodes: number[];
}

export const DEFAULT_POLICY: SupervisorPolicy = {
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
  unhealthyRunMs: 120_000,
  maxConsecutive: 6,
  giveUpDelayMs: 300_000,
  noRestartCodes: [EX_CONFIG],
};

/** Le délai avant la nième panne consécutive : exponentiel, plafonné, jamais nul. */
export function delayFor(consecutiveFailures: number, policy: SupervisorPolicy): number {
  if (consecutiveFailures <= 0) return 0;
  if (consecutiveFailures > policy.maxConsecutive) return policy.giveUpDelayMs;
  return Math.min(policy.maxDelayMs, Math.round(policy.baseDelayMs * 2 ** (consecutiveFailures - 1)));
}

/**
 * Faut-il relancer ?
 *
 * Le piège, découvert en réel : le signal qui a tué l'enfant ne dit **rien** de l'intention
 * de l'opérateur. `kill -9` comme l'OOM-killer du noyau se constatent par `code = null,
 * signal = 'SIGKILL'` — et c'est précisément le cas à relancer. Ce qui compte, c'est si
 * *nous* avons été invités à nous arrêter (`stoppedByRequest`, posé par le gestionnaire de
 * SIGINT/SIGTERM du superviseur). Un signal reçu par l'enfant sans que nous le lui ayons
 * transmis est une panne, pas une consigne.
 */
export function shouldRestart(
  code: number | null,
  stoppedByRequest: boolean,
  policy: SupervisorPolicy,
  /** Durée de vie réelle de l'enfant, en ms. `Infinity` = « il a clairement tourné ». */
  ranMs = Number.POSITIVE_INFINITY,
): boolean {
  if (stoppedByRequest) return false;
  if (code === null) return true; // SIGKILL, OOM, … : on retente
  if (code === EX_OK) {
    // Un code 0 n'est un arrêt voulu QUE s'il a duré. Un enfant qui rend 0 en quelques
    // millisecondes n'a rien arrêté : il n'a jamais démarré (un `node` sans script, un
    // wrapper qui a avalé ses arguments, un exec raté). Le tenir pour un arrêt propre
    // laissait le bot mort, en silence, avec un journal poli — le 2026-09-02, le superviseur
    // lancé avec `--command node --env-file=.env dist/index.js` n'a reçu que `node` (la
    // collecte des arguments s'arrête au premier `--`) : node a lu un stdin fermé, est sorti
    // en 0, et le bot n'a jamais existé.
    return ranMs < policy.unhealthyRunMs;
  }
  return !policy.noRestartCodes.includes(code);
}

/**
 * Verrou d'instance : un fichier, pas de daemonisation — c'est un outil local, et un
 * `kill -0` suffit à savoir si le détenteur vit encore. Un verrou laissé par un processus
 * mort est repris, sinon un crash rendrait le bot inutilisable jusqu'à suppression manuelle
 * du fichier.
 */
export interface LockState {
  acquired: boolean;
  holder?: number;
  stale?: boolean;
}

export function readLock(pidFile: string, alive: (pid: number) => boolean): LockState {
  if (!existsSync(pidFile)) return { acquired: false };
  const raw = readFileSync(pidFile, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid) || pid <= 0) return { acquired: false, stale: true };
  if (!alive(pid)) return { acquired: false, stale: true, holder: pid };
  return { acquired: true, holder: pid };
}

/** Un autre processus porte-t-il ce pid ? (le nôtre ne compte pas comme conflit) */
export function aliveElsewhere(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface EnsureOptions {
  cwd: string;
  /** Un point d'entrée dans `dist/` suppose un build ; `src/` (tsx) non. */
  needsBuild: boolean;
  run: (command: string, args: string[]) => Promise<number>;
}

/**
 * Répare l'environnement avant de lancer. Un `node_modules` absent (bac à sable restauré
 * depuis un instantané qui ne le contient pas) ou un `dist` manquant ne sont pas des
 * pannes de l'agent : les traiter comme telles ferait tourner le superviseur en boucle.
 */
export async function ensureEnvironment(o: EnsureOptions): Promise<string[]> {
  const done: string[] = [];
  if (!existsSync(join(o.cwd, 'node_modules', 'better-sqlite3'))) {
    const code = await o.run('npm', ['ci']);
    if (code !== 0) throw new Error(`npm ci a échoué (code ${code}) : dépendances non restaurées`);
    done.push('npm ci');
  }
  if (o.needsBuild && !existsSync(join(o.cwd, 'dist', 'index.js'))) {
    const code = await o.run('npm', ['run', 'build']);
    if (code !== 0) throw new Error(`npm run build a échoué (code ${code})`);
    done.push('npm run build');
  }
  return done;
}

export interface RunOptions {
  command: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  policy?: SupervisorPolicy;
  /** Nombre maximum de relances ; 0 ou absent = sans limite. */
  maxRestarts?: number;
  /** Injection de test : fabrique l'enfant. */
  spawnChild?: (command: string[], cwd: string, env: NodeJS.ProcessEnv, index: number) => ChildProcess;
  sleep?: (ms: number) => Promise<void>;
  /** Une seule itération, pour les tests et `--once`. */
  once?: boolean;
}

export interface RunOutcome {
  restarts: number;
  finalCode: number | null;
  reason: string;
}

/** Boucle de supervision. Résout dès qu'il n'y a plus lieu de relancer. */
export async function runUnderSupervision(o: RunOptions): Promise<RunOutcome> {
  const policy = o.policy ?? DEFAULT_POLICY;
  const sleep =
    o.sleep ?? ((ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let index = 0;
  const spawnChild =
    o.spawnChild ??
    ((command: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess =>
      spawn(command[0] as string, command.slice(1), {
        cwd,
        env,
        // pipe et non inherit : le superviseur recopie vers le terminal ET vers son fichier.
        stdio: ['ignore', 'pipe', 'pipe'],
      }));

  // Un enfant qui meurt avant d'avoir ouvert son journal ne laisse que son stdout : on le
  // recopie donc ici, sinon le seul témoin du décès disparaît avec le terminal.
  const tee = (stream: NodeJS.ReadableStream | null, level: 'out' | 'err'): void => {
    if (stream === null) return;
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        if (level === 'err') process.stderr.write(line + '\n');
        else process.stdout.write(line + '\n');
        mirrorToSink(line);
      }
    });
    stream.on('end', () => {
      if (rest.trim() !== '') (level === 'err' ? process.stderr : process.stdout).write(rest + '\n');
    });
  };

  let restarts = 0;
  let consecutive = 0;
  let current: ChildProcess | null = null;
  let stopping = false;
  const forward = (signal: NodeJS.Signals): void => {
    stopping = true;
    current?.kill(signal);
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);

  try {
    for (;;) {
      index += 1;
      const startedAt = Date.now();
      const child = spawnChild(o.command, o.cwd, { ...process.env, ...o.env }, index);
      current = child;
      log.info('superviseur : enfant démarré', { pid: child.pid, relances: restarts });
      if (o.spawnChild === undefined) {
        tee(child.stdout, 'out');
        tee(child.stderr, 'err');
      }

      const outcome = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => {
        child.once('exit', (code, sig) => resolve({ code, signal: sig }));
        child.once('error', (error) => {
          log.error('superviseur : impossible de lancer l’enfant', { raison: error.message.slice(0, 160) });
          resolve({ code: null, signal: 'spawn-error' });
        });
        },
      );
      current = null;

      const ranMs = Date.now() - startedAt;
      const why = outcome.signal === null ? `code ${outcome.code}` : `${outcome.signal}`;
      if (outcome.signal === 'spawn-error') {
        // Le binaire est introuvable : relancer répéterait l'échec à la même vitesse.
        return { restarts, finalCode: outcome.code, reason: 'commande impossible à exécuter' };
      }
      if (outcome.code === EX_OK && !stopping && ranMs < policy.unhealthyRunMs) {
        log.warn('superviseur : sortie 0 immédiate sans arrêt demandé — l’enfant n’a pas démarré', {
          vecu_ms: ranMs,
          commande: o.command.join(' ').slice(0, 120),
        });
      }
      if (!shouldRestart(outcome.code, stopping, policy, ranMs)) {
        log.info('superviseur : pas de relance', { raison: why, arret_demande: stopping });
        return { restarts, finalCode: outcome.code, reason: stopping ? 'arrêt demandé' : why };
      }
      if (outcome.signal !== null) {
        log.warn('superviseur : enfant tué par un signal', { signal: outcome.signal, vecu_ms: ranMs });
      }

      consecutive = ranMs < policy.unhealthyRunMs ? consecutive + 1 : 0;
      if (o.maxRestarts !== undefined && o.maxRestarts > 0 && restarts >= o.maxRestarts) {
        log.fatal('superviseur : budget de relances épuisé', { relances: restarts, raison: `code ${outcome.code}` });
        return { restarts, finalCode: outcome.code, reason: 'budget de relances épuisé' };
      }
      restarts += 1;
      const wait = delayFor(consecutive, policy);
      log.warn('superviseur : redémarrage programmé', {
        dans_ms: wait,
        raison: `code ${outcome.code}`,
        echecs_consecutifs: consecutive,
        vecu_ms: ranMs,
      });
      await sleep(wait);
      if (o.once === true) return { restarts, finalCode: outcome.code, reason: `code ${outcome.code} (once)` };
    }
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}

// ------------------------------------------------------------------ exécution ---

interface CliArgs {
  command: string[];
  maxRestarts: number;
  once: boolean;
  noEnsure: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { command: [], maxRestarts: 0, once: false, noEnsure: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (a === '--command') {
      i += 1;
      while (i < argv.length && !(argv[i] as string).startsWith('--')) {
        out.command.push(argv[i] as string);
        i += 1;
      }
      continue;
    }
    if (a === '--max-restarts') {
      out.maxRestarts = Number.parseInt(argv[i + 1] ?? '0', 10);
      i += 2;
      continue;
    }
    if (a === '--once') out.once = true;
    if (a === '--no-ensure') out.noEnsure = true;
    i += 1;
  }
  return out;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  // Le superviseur tient son propre fichier : c'est lui qui voit naître et mourir l'enfant,
  // y compris quand celui-ci n'a pas eu le temps d'ouvrir le sien.
  setLogFile(process.env.LOG_FILE_SUPERVISOR ?? join(root, 'logs', 'supervisor.log'));
  setDebug(process.env.DEBUG === '1' || process.env.DEBUG === 'true');
  // Le token arrive dans l'environnement : à masquer dès ici, pas seulement chez l'enfant.
  registerSecrets([process.env.TELEGRAM_BOT_TOKEN, process.env.GROQ_API_KEY, process.env.ELEVENLABS_API_KEY]);

  const pidFile = join(root, 'logs', 'supervisor.pid');
  const state = readLock(pidFile, aliveElsewhere);
  if (state.acquired) {
    log.error('superviseur déjà actif — deuxième instance refusée', { pid_detenteur: state.holder });
    log.error('deux superviseurs sur le même token Telegram se répondent par un 409 et se tuent');
    process.exitCode = EX_CONFIG;
    return;
  }
  if (state.stale) log.warn('verrou perime récupéré', { ancien_pid: state.holder });
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });

  try {
    if (!args.noEnsure) {
      const usesDist = args.command.join(' ').includes('dist/');
      const fixed = await ensureEnvironment({
        cwd: root,
        needsBuild: usesDist,
        run: async (cmd, cmdArgs) =>
          await new Promise<number>((resolve) => {
            const c = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
            c.once('exit', (code) => resolve(code ?? 1));
            c.once('error', () => resolve(1));
          }),
      });
      if (fixed.length > 0) log.info('environnement réparé avant lancement', { actions: fixed.join(', ') });
    }

    const command = args.command.length > 0 ? args.command : ['node', '--import', 'tsx', 'src/index.ts'];
    const outcome = await runUnderSupervision({
      command,
      cwd: root,
      maxRestarts: args.maxRestarts,
      once: args.once,
    });
    log.info('superviseur terminé', { relances: outcome.restarts, raison: outcome.reason });
    process.exitCode = EX_OK;
  } finally {
    try {
      unlinkSync(pidFile);
    } catch {
      /* déjà parti : tant mieux */
    }
  }
}

// Exécuté directement seulement (les tests importent les fonctions pures).
const entry = process.argv[1] ?? '';
if (entry.endsWith('supervise.ts') || entry.endsWith('supervise.js')) {
  main().catch((error: unknown) => {
    log.fatal('superviseur : erreur inattendue', {
      raison: error instanceof Error ? error.message.slice(0, 200) : 'inconnue',
    });
    process.exitCode = 75;
  });
}
