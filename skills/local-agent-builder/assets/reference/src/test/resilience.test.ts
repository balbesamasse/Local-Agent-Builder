/**
 * Tests de résilience : ce qui fait qu'un bot s'arrête, et ce qui le fait repartir.
 *
 * Écrits après un arrêt réel du bot dont personne n'a pu donner la cause : le stdout
 * était mort avec le processus. Chaque test porte donc une faute précise, pas une
 * abstraction — lire les titres dans l'ordre raconte l'incident.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { ConfigError, hardenEnvFile } from '../config.js';
import { EX_CONFIG, EX_OK, EX_TEMPFAIL, exitCodeFor, isConfigError } from '../core/guard.js';
import { log, logFilePath, mirrorToSink, registerSecrets, setLogFile } from '../core/logger.js';
import {
  DEFAULT_POLICY,
  delayFor,
  ensureEnvironment,
  parseArgs,
  readLock,
  runUnderSupervision,
  shouldRestart,
} from '../supervise.js';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `og-${prefix}-`));
}

// ------------------------------------------------------------------ codes ---

test('une erreur de configuration ne vaut pas une panne temporaire', () => {
  const isCfg = (e: unknown): boolean => e instanceof ConfigError;
  assert.equal(exitCodeFor(new ConfigError('TELEGRAM_BOT_TOKEN manquant'), isCfg), EX_CONFIG);
  assert.equal(exitCodeFor(new Error('réseau interrompu'), isCfg), EX_TEMPFAIL);
  assert.equal(EX_CONFIG, 78);
  assert.equal(EX_TEMPFAIL, 75);
});

test('un ConfigError venu d’ailleurs reste reconnu par son nom', () => {
  // La garde reconnaît le nom plutôt que l'identité de classe : sinon il faudrait importer
  // toute la configuration dans chaque point d'entrée pour savoir quoi faire d'une erreur.
  const lookalike = new Error('x');
  lookalike.name = 'ConfigError';
  assert.equal(isConfigError(lookalike), true);
  assert.equal(isConfigError(new Error('x')), false);
});

test('relancer : oui pour 75 et pour un enfant tué par SIGKILL, non pour 0, 78 ou un arrêt demandé', () => {
  const p = DEFAULT_POLICY;
  assert.equal(shouldRestart(EX_TEMPFAIL, false, p), true, 'panne temporaire');
  // Un 0 n'est un arrêt propre que S'IL A DURÉ : la durée distingue « l'agent a décidé de
  // s'arrêter » de « l'enfant n'a jamais démarré ». Le premier ne se relance pas, le second si.
  assert.equal(shouldRestart(EX_OK, false, p, 600_000), false, 'un 0 après 10 min = arrêt voulu');
  assert.equal(shouldRestart(EX_OK, false, p, 18), true, 'un 0 au bout de 18 ms = enfant jamais lancé');
  assert.equal(shouldRestart(EX_OK, true, p, 18), false, 'un arrêt demandé ne se relance jamais');
  assert.equal(shouldRestart(EX_CONFIG, false, p), false, 'configuration invalide');
  // Le cœur de la règle, appris en tuant l'enfant à la main : `kill -9` et l'OOM-killer du
  // noyau ne laissent aucun code de sortie. Refuser de relancer là laissait le bot mort.
  assert.equal(shouldRestart(null, false, p), true, 'code null = signal reçu par l’enfant : on retente');
  assert.equal(shouldRestart(null, true, p), false, 'mais pas si c’est nous qui avons demandé l’arrêt');
  assert.equal(shouldRestart(EX_TEMPFAIL, true, p), false, 'l’arrêt demandé prime sur le code');
});

test('le délai de relance croît, se plafonne, puis allonge beaucoup', () => {
  const p = { ...DEFAULT_POLICY, baseDelayMs: 100, maxDelayMs: 3_000, maxConsecutive: 4, giveUpDelayMs: 60_000 };
  assert.equal(delayFor(0, p), 0, 'aucune panne consécutive = aucune attente');
  assert.equal(delayFor(1, p), 100);
  assert.equal(delayFor(2, p), 200);
  assert.equal(delayFor(3, p), 400);
  assert.equal(delayFor(4, p), 800);
  assert.equal(delayFor(9, p), 60_000, 'au-delà du seuil : on laisse respirer le fournisseur');
  assert.equal(delayFor(4, { ...p, maxDelayMs: 500 }), 500, 'jamais au-dessus du plafond');
});

// ------------------------------------------------------------------ verrou ---

test('deux superviseurs sur le même token refusent de cohabiter', () => {
  const dir = tmp('lock');
  const pidFile = join(dir, 'supervisor.pid');
  const alive = (pid: number): boolean => pid === 4242;

  assert.deepEqual(readLock(pidFile, alive), { acquired: false }, 'aucun verrou : on démarre');

  writeFileSync(pidFile, '4242\n', { mode: 0o600 });
  assert.deepEqual(readLock(pidFile, alive), { acquired: true, holder: 4242 }, 'détenteur vivant : on refuse');

  writeFileSync(pidFile, '9999\n');
  assert.deepEqual(readLock(pidFile, alive), { acquired: false, stale: true, holder: 9999 }, 'pid mort : verrou repris');

  writeFileSync(pidFile, 'pas-un-entier');
  const broken = readLock(pidFile, alive);
  assert.equal(broken.acquired, false);
  assert.equal(broken.stale, true, 'verrou illisible = verrou qui ne protège plus rien');

  writeFileSync(pidFile, '0\n');
  assert.equal(readLock(pidFile, alive).stale, true, 'pid 0 = pas un détenteur crédible');
  rmSync(dir, { recursive: true, force: true });
});

test('un verrou périmé ne condamne pas le bot pour l’éternité', () => {
  // Sans cette reprise, un crash laisse un fichier qui empêche tout redémarrage : le bot
  // devient injoignable pour une raison purement domestique.
  assert.equal(readLock(join(tmpdir(), 'og-inexistant-supervisor.pid'), () => false).acquired, false);
});

// ------------------------------------------------------------------ environnement ---

test('node_modules absent se répare ; présent, on ne touche à rien', async () => {
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]): Promise<number> => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return 0;
  };
  const done = await ensureEnvironment({ cwd: process.cwd(), needsBuild: false, run });
  const wantsInstall = !existsSync(join(process.cwd(), 'node_modules', 'better-sqlite3'));
  assert.equal(calls.includes('npm ci'), wantsInstall, `npm ci appelé à tort ou manquant : ${calls.join('|')}`);
  assert.equal(done.length, wantsInstall ? 1 : 0);
});

test('un npm ci qui échoue est dit, pas transformé en boucle de relances', async () => {
  await assert.rejects(
    ensureEnvironment({ cwd: '/tmp/og-inexistant-npmci', needsBuild: false, run: async () => 1 }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('npm ci') &&
      error.message.includes('code 1'),
  );
});

test('dist manquant déclenche le build, présent il ne le déclenche pas', async () => {
  const calls: string[] = [];
  const run = async (_c: string, args: string[]): Promise<number> => {
    calls.push(args.join(' '));
    return 0;
  };
  await ensureEnvironment({ cwd: process.cwd(), needsBuild: true, run });
  const wantsBuild = !existsSync(join(process.cwd(), 'dist', 'index.js'));
  assert.equal(calls.includes('run build'), wantsBuild, `build appelé à tort ou manquant : ${calls.join('|')}`);
});

test('les arguments du superviseur sont lus dans l’ordre réel', () => {
  const a = parseArgs(['--command', 'node', 'dist/index.js', '--max-restarts', '3', '--once', '--no-ensure']);
  assert.deepEqual(a.command, ['node', 'dist/index.js'], '--command s’arrête au prochain --');
  assert.equal(a.maxRestarts, 3);
  assert.equal(a.once, true);
  assert.equal(a.noEnsure, true);
  assert.deepEqual(parseArgs([]).command, [], 'aucun --command = commande par défaut du superviseur');
});

// ------------------------------------------------------------------ boucle ---

/** Faux enfant : même forme observable (pid + `exit`) sans lancer de processus. */
function fakeChild(code: number | null, signal: NodeJS.Signals | null = null): ChildProcess {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, { pid: 4242, stdout: null, stderr: null, kill: () => true });
  queueMicrotask(() => {
    emitter.emit('exit', code, signal);
  });
  return child as unknown as ChildProcess;
}

test('la boucle relance sur 75 et coupe au budget de relances', async () => {
  const waits: number[] = [];
  let n = 0;
  const outcome = await runUnderSupervision({
    command: ['faux'],
    cwd: process.cwd(),
    maxRestarts: 2,
    policy: { ...DEFAULT_POLICY, baseDelayMs: 1, maxDelayMs: 2 },
    sleep: async (ms) => {
      waits.push(ms);
    },
    spawnChild: () => {
      n += 1;
      return fakeChild(EX_TEMPFAIL);
    },
  });
  assert.equal(n, 3, 'trois lancements : initial + deux relances');
  assert.equal(outcome.restarts, 2);
  assert.equal(outcome.reason, 'budget de relances épuisé');
  assert.equal(waits.length, 2, 'une attente entre chaque tentative');
});

test('un enfant tué de l’extérieur est relancé (le cas qui a cassé en réel)', async () => {
  // Le 20:17, `kill -9` sur le processus enfant a produit `code=null, signal='SIGKILL'` :
  // le superviseur a écrit « pas de relance » et s'est éteint. Ce test est cette ligne de log.
  const kills: string[] = [];
  let n = 0;
  const outcome = await runUnderSupervision({
    command: ['faux'],
    cwd: process.cwd(),
    maxRestarts: 1,
    // `unhealthyRunMs: 0` : le second tournant, qui sort en 0, doit être lu comme un arrêt
    // voulu (il a « tourné »). Sans ce réglage, un 0 à l'horloge du test est une sortie
    // d'enfant jamais démarré — et c'est justement l'autre règle, testée à côté.
    policy: { ...DEFAULT_POLICY, unhealthyRunMs: 0 },
    sleep: async () => undefined,
    spawnChild: () => {
      n += 1;
      if (n === 1) return fakeChild(null, 'SIGKILL');
      return fakeChild(EX_OK); // le second tournant s'arrête proprement
    },
  });
  assert.equal(n, 2, 'un SIGKILL doit être suivi d’une nouvelle tentative');
  assert.equal(outcome.restarts, 1);
  assert.match(outcome.reason, /code 0/);
  void kills;
});

test('un enfant qui a tourné puis sort en 0 n’est pas relancé', async () => {
  let n = 0;
  const outcome = await runUnderSupervision({
    command: ['faux'],
    cwd: process.cwd(),
    // `unhealthyRunMs: 0` = « cette exécution a forcément été vue comme longue » : un faux
    // enfant vit quelques millisecondes, le test ne doit rien à une horloge.
    policy: { ...DEFAULT_POLICY, unhealthyRunMs: 0 },
    sleep: async () => undefined,
    spawnChild: () => {
      n += 1;
      return fakeChild(EX_OK);
    },
  });
  assert.equal(n, 1, 'relance interdite sur un arrêt voulu');
  assert.equal(outcome.restarts, 0);
  assert.match(outcome.reason, /code 0/);
});

test('un enfant qui sort en 0 sans avoir démarré EST relancé', async () => {
  // Cas réel du 2026-09-02 : `--command node --env-file=.env dist/index.js` ne passait que
  // `node` au spawn. L'enfant lisait un stdin fermé et rendait 0 — un « arrêt propre » inventé
  // par le père, et un bot qui n'a jamais existé, sans un seul journal d'erreur.
  let n = 0;
  const outcome = await runUnderSupervision({
    command: ['faux'],
    cwd: process.cwd(),
    maxRestarts: 2,
    policy: { ...DEFAULT_POLICY, baseDelayMs: 1, maxDelayMs: 2 },
    sleep: async () => undefined,
    spawnChild: () => {
      n += 1;
      return fakeChild(EX_OK);
    },
  });
  assert.equal(n, 3, 'deux relances sur sorties 0 immédiates, avant le budget');
  assert.equal(outcome.restarts, 2);
  assert.match(outcome.reason, /budget/, 'et le budget de relances finit par dire stop');
});

test('une sortie sur 78 interrompt la boucle avec son motif, sans attente', async () => {
  let n = 0;
  const outcome = await runUnderSupervision({
    command: ['faux'],
    cwd: process.cwd(),
    sleep: async () => assert.fail('aucune attente : on ne relance pas une config invalide'),
    spawnChild: () => {
      n += 1;
      return fakeChild(EX_CONFIG);
    },
  });
  assert.equal(n, 1);
  assert.match(outcome.reason, /code 78/);
});

test('le backoff est exponentiel sur les pannes consécutives', async () => {
  const waits: number[] = [];
  await runUnderSupervision({
    command: ['faux'],
    cwd: process.cwd(),
    maxRestarts: 3,
    policy: { ...DEFAULT_POLICY, baseDelayMs: 10, maxDelayMs: 10_000 },
    sleep: async (ms) => {
      waits.push(ms);
    },
    spawnChild: () => fakeChild(EX_TEMPFAIL),
  });
  assert.deepEqual(waits, [10, 20, 40], `10, 20, 40 attendus ; reçu : ${waits.join(',')}`);
  // Les trois premiers délais sont la signature du backoff ; le budget coupé au 4e.
  assert.equal(waits.length, 3);
});

// ------------------------------------------------------------------ journal ---

test('le journal écrit sur disque, et le masquage s’applique aussi là', () => {
  const dir = tmp('log');
  const file = join(dir, 'agent.log');
  setLogFile(file);
  assert.equal(logFilePath(), file);
  registerSecrets(['1234560:SECRET-abc']);
  log.info('bot Telegram connecté', { url: 'https://api.telegram.org/file/bot1234560:SECRET-abc/f.oga' });
  mirrorToSink('ligne brute avec 1234560:SECRET-abc dedans');
  setLogFile(undefined);
  const content = readFileSync(file, 'utf8');
  assert.equal((statSync(file).mode & 0o777).toString(8), '600', 'un journal naît en 600');
  assert.match(content, /bot Telegram connecté/);
  assert.match(content, /ligne brute avec \[masqué\] dedans/, 'la ligne d’un enfant est masquée aussi');
  assert.ok(!content.includes('SECRET-abc'), 'un secret ne doit jamais toucher le disque');
  rmSync(dir, { recursive: true, force: true });
});

test('un journal déjà là en 644 est remis à l’heure à l’ouverture', () => {
  const dir = tmp('logmode');
  const file = join(dir, 'agent.log');
  writeFileSync(file, 'ligne existante\n', { mode: 0o644 });
  setLogFile(file);
  assert.equal((statSync(file).mode & 0o777).toString(8), '600');
  assert.match(readFileSync(file, 'utf8'), /ligne existante/, 'on ne tronque pas ce qui précède');
  setLogFile(undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('un chemin de journal inaccessible ne tue jamais l’agent', () => {
  // `/dev/null/impossible` ne peut pas exister : c'est exactement le cas cherché — le
  // journal ne doit jamais devenir la cause de l'arrêt.
  setLogFile('/dev/null/impossible/agent.log');
  assert.equal(logFilePath(), null, 'sink désactivé, aucune exception');
  assert.doesNotThrow(() => log.warn('journal hors service'));
});

// ------------------------------------------------------------------ droits .env ---

test('un .env lisible par tous est ramené en 600 au chargement', () => {
  const dir = tmp('env');
  const file = join(dir, '.env');
  writeFileSync(file, 'TELEGRAM_BOT_TOKEN="1:x"\n', { mode: 0o644 });
  assert.equal(statSync(file).mode & 0o777, 0o644, 'le test part bien d’un fichier mal gardé');
  assert.equal(hardenEnvFile(file), true, 'les droits devaient être modifiés');
  assert.equal((statSync(file).mode & 0o777).toString(8), '600');
  assert.equal(hardenEnvFile(file), false, 'déjà bon : pas de second avertissement');
  assert.equal(hardenEnvFile(join(dir, 'absent')), false, 'fichier absent : ce n’est pas une panne');
  chmodSync(file, 0o640);
  assert.equal(hardenEnvFile(file), true, 'groupe lecteur = encore à corriger');
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ bout-en-bout ---

// `.mts` et non `.ts` : posé dans un dossier temporaire, hors du package, un `.ts` serait
// compilé en CommonJS par tsx — et le `await` de premier niveau n'y est pas supporté.
const FIXTURE = `
const { installCrashGuards } = await import(process.env.GUARD_MODULE);
const { setLogFile } = await import(process.env.GUARD_LOGGER);

if (process.argv[2] === 'reject') {
  setLogFile(process.env.GUARD_LOG);
  installCrashGuards({});
  Promise.reject(new Error('rejet oublie dans un coin du code'));
  await new Promise((r) => setTimeout(r, 40));
  console.log('SURVIVET');
  process.exit(0);
}

if (process.argv[2] === 'boom') {
  setLogFile(process.env.GUARD_LOG);
  installCrashGuards({ onFatal: () => console.log('FATALDISPOSE') });
  setTimeout(() => {
    throw new Error('explosion synchrone en cours de service');
  }, 10);
}
`;

test('une promesse rejetée survit ; une exception synchrone meurt en 75 et l’écrit', () => {
  const dir = tmp('child');
  const file = join(dir, 'child.mts');
  writeFileSync(file, FIXTURE);
  const logFile = join(dir, 'child.log');
  const env = {
    ...process.env,
    GUARD_MODULE: join(process.cwd(), 'src/core/guard.ts'),
    GUARD_LOGGER: join(process.cwd(), 'src/core/logger.ts'),
    GUARD_LOG: logFile,
  };

  const survivor = spawnSync('node', ['--import', 'tsx', file, 'reject'], { encoding: 'utf8', env });
  assert.equal(survivor.status, 0, `un rejet ne doit pas être mortel — ${survivor.stderr.slice(0, 200)}`);
  assert.match(survivor.stdout, /SURVIVET/);
  assert.match(readFileSync(logFile, 'utf8'), /rejet oublie/);

  const dead = spawnSync('node', ['--import', 'tsx', file, 'boom'], { encoding: 'utf8', env });
  assert.equal(dead.status, EX_TEMPFAIL, `code 75 attendu, reçu ${dead.status} — ${dead.stderr.slice(0, 200)}`);
  assert.match(dead.stdout, /FATALDISPOSE/, 'la fermeture propre doit précéder la sortie');
  assert.ok(existsSync(logFile), 'le motif du décès doit survivre au terminal');
  const written = readFileSync(logFile, 'utf8');
  assert.match(written, /exception non attrapee|exception non attrapée/);
  assert.match(written, /explosion synchrone en cours de service/);
  rmSync(dir, { recursive: true, force: true });
});

test('Node 20 sans garde tue le processus sur un rejet (contrôle du présupposé)', () => {
  // Si un jour un rejet non géré cesse d'être mortel par défaut, la première règle de la
  // garde change de valeur : ce test le dit, au lieu de laisser le commentaire mentir.
  const dir = tmp('node-default');
  const file = join(dir, 'bare.cjs');
  writeFileSync(file, "Promise.reject(new Error('x'));\nsetTimeout(() => console.log('ENCORE_VIVANT'), 50);\n");
  const bare = spawnSync(process.execPath, [file], { encoding: 'utf8' });
  assert.notEqual(bare.status, 0, 'un rejet non géré est mortel par défaut dans cette version de Node');
  rmSync(dir, { recursive: true, force: true });
});
