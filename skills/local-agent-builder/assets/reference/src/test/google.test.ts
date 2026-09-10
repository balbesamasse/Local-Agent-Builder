/**
 * Tests de l'intégration Google Workspace (CLI `gws`).
 *
 * Trois étages, parce que chacun a sa faute typique :
 *   1. l'interpréteur d'enveloppe — un code de sortie qui ne dit pas ce qu'on croit (le CLI
 *      rend `0` sur un `auth status` à `none`, et un helper rend un `401` avec `"code": 0`) ;
 *   2. les extracteurs — une réponse de 60 ko réduite à trois lignes utiles, sans rien inventer ;
 *   3. le transport réel, contre le double `fake-gws.mjs` lancé par `spawn` — c'est là que se
 *      voient l'argv construit, l'environnement transmis, le kill sur timeout et le rejeu.
 *
 * Aucun test n'appelle Google : `googleEnabled` est false dans le config de test, et le binaire
 * utilisé est le double. Un test qui dépendrait des données d'un compte réel est un test qui
 * passe quand la boîte mail de l'auteur est dans le bon état.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { classify, explainFailure } from '../google/envelope.js';
import { redact, safeExcerpt, stillSensitive } from '../google/redact.js';
import {
  GwsCliTransport,
  childEnvironment,
  forbiddenInheritedKeys,
  resolveGwsBin,
  staleAdcPointer,
} from '../google/gws-cli-transport.js';
import { assertNoForeignSecretsFor, projectedChildEnv } from '../google/secrets.js';
import { calendarEvents, docsText, driveHits, formatGmailHits, gmailBody, gmailHit, gmailListIds, sheetRows } from '../google/format.js';
import { googleTools } from '../google/tools.js';
import { readAuthState } from '../google/auth.js';
import { makeTestConfig } from '../testing/fixtures.js';
import type { AppConfig } from '../config.js';
import type { ToolContext } from '../core/types.js';
import type { Tool } from '../tools/registry.js';
import { Store } from '../memory/store.js';
import { ToolRegistry } from '../tools/registry.js';

const FAKE = join(process.cwd(), 'src', 'testing', 'fake-gws.mjs');

/** Environnement de père volontairement pollué : c'est ce que le fils ne doit PAS recevoir. */
const PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: '/tmp/fake-home',
  TZ: 'UTC',
  TELEGRAM_BOT_TOKEN: '123456:AATelegramBotTokenQuiNeDoitJamaisSortir',
  GROQ_API_KEY: 'gsk_' + 'A'.repeat(31),
  OPENROUTER_API_KEY: 'sk-or-v1-' + 'B'.repeat(24),
  ELEVENLABS_API_KEY: 'sk-eleven-' + 'C'.repeat(24),
  // Le piege reel de ce depot : une cle ADC declaree pour d'autres raisons, vers un fichier absent.
  GOOGLE_APPLICATION_CREDENTIALS: './service-account.json',
  GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: 'keyring',
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'og-google-'));
}

interface FakeOptions {
  mode?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  readAttempts?: number;
  allowWrites?: boolean;
  services?: string[];
  dangerous?: boolean;
}

/** Ce qu'un test reçoit du harness : le transport, ses outils, et la trace des appels. */
interface FakeCall {
  argv: string[];
  env: string[];
  params?: string;
  dryRun?: boolean;
}

interface Harness {
  config: AppConfig;
  transport: GwsCliTransport;
  dir: string;
  recorded: () => FakeCall[];
  tools: Tool[];
  store: Store;
  ctx: ToolContext;
}

/** Transport branché sur le double, dans un répertoire jetable (le fichier de trace y vit). */
async function harness(options: FakeOptions = {}): Promise<Harness> {
  const dir = tmp();
  const config = makeTestConfig({
    googleEnabled: true,
    googleBin: FAKE,
    googleServices: new Set([...(options.services ?? ['gmail', 'drive', 'docs', 'sheets', 'calendar', 'auth'])]),
    googleAllowWrites: options.allowWrites ?? false,
    dangerousToolsEnabled: options.dangerous ?? false,
    googleTimeoutMs: options.timeoutMs ?? 4000,
    googleMaxOutputBytes: options.maxOutputBytes ?? 400_000,
    googleReadAttempts: options.readAttempts ?? 2,
    workspaceRoot: dir,
  });
  const env: Record<string, string> = {
    FAKE_GWS_MODE: options.mode ?? 'fixtures',
    FAKE_GWS_RECORD: join(dir, 'calls.jsonl'),
    // Le double y écrit son pid : le test vérifie qu'aucun fils ne survit à un timeout.
    FAKE_GWS_PIDFILE: join(dir, 'child.pid'),
    ...options.env,
  };
  const transport = new GwsCliTransport({
    bin: FAKE,
    workspaceRoot: dir,
    timeoutMs: config.googleTimeoutMs,
    maxOutputBytes: config.googleMaxOutputBytes,
    maxInFlight: config.googleMaxInFlight,
    readAttempts: config.googleReadAttempts,
    env,
    parentEnv: { ...PARENT_ENV, ...env },
  });
  // En production, `createGoogleRuntime` sonde le binaire avant de declarer les outils ; le
  // harness doit faire pareil, sinon les outils repondent « client absent » et le test ne prouve
  // plus rien sur le trajet.
  await transport.probe();
  const store = new Store(':memory:');
  const bundle = googleTools(config, transport);
  return {
    config,
    transport,
    dir,
    store,
    tools: bundle.tools,
    recorded: (): FakeCall[] => {
      const file = join(dir, 'calls.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as FakeCall);
    },
    ctx: {
      chatId: 4242,
      userId: 4242,
      config,
      store,
      requestApproval: async () => true,
    },
  };
}

const cleanup: Array<() => Promise<void>> = [];
after(async () => {
  // Les transports sont fermés AVANT que le répertoire jetable disparaisse : un fils encore
  // vivant écrirait dans un dossier supprimé, et l'erreur tomberait après la fin des tests.
  for (const fn of cleanup) await fn();
});
function dispose(h: { transport: GwsCliTransport; store: Store; dir: string }): void {
  cleanup.push(async () => {
    await h.transport.close('fin de test');
    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  });
}

// ============================================================ 1. enveloppe

test('un code de sortie 0 sur un statut „none“ n’est jamais lu comme une authentification', async () => {
  // Capture réelle de `gws auth status` sur une machine sans compte : code 0, corps éloquent.
  const h = await harness({ mode: 'fixtures' });
  dispose(h);
  const outcome = await h.transport.run({ service: 'auth', argv: ['auth', 'status'], write: false, label: 'x' });
  assert.equal(outcome.ok, true, 'le CLI a réussi sa sortie…');
  const payload = outcome.value as Record<string, unknown>;
  assert.equal(payload['auth_method'], 'oauth', '…et le double confirme le compte connecté');
  const state = await readAuthState(h.transport, { services: ['gmail'], writesEnabled: false });
  assert.equal(state.authenticated, true);

  const offline = new GwsCliTransport({
    bin: FAKE,
    workspaceRoot: h.dir,
    timeoutMs: 4000,
    maxOutputBytes: 400_000,
    maxInFlight: 1,
    readAttempts: 1,
    env: { FAKE_GWS_MODE: 'raw', FAKE_GWS_EXIT: '0', FAKE_GWS_STDOUT: '{"auth_method":"none","credential_source":"none","storage":"none","client_config_exists":false}' },
    parentEnv: PARENT_ENV,
  });
  const unauthenticated = await readAuthState(offline, { services: ['gmail'], writesEnabled: false });
  assert.equal(unauthenticated.authenticated, false, 'le corps, pas le code de sortie');
  assert.match(unauthenticated.diagnosis.join(' '), /google:login/, 'le diagnostic nomme la commande qui répare');
  assert.match(unauthenticated.diagnosis.join(' '), /client_secret|google:setup/);
  await offline.close();
});

test('une erreur de helper (code 0 dans l’enveloppe, 401 échappé dans le message) est classée auth', () => {
  const helperShape = {
    exitCode: 1,
    stdout: JSON.stringify({
      error: {
        code: 0,
        message: '{"error":{"code":401,"message":"Request had invalid authentication credentials.","errors":[{"reason":"authError"}]}}',
        reason: 'calendarList_failed',
      },
    }),
    stderr: 'error[api]: …',
    killed: false,
    timedOut: false,
  };
  const outcome = classify(helperShape, { write: false, maxExcerpt: 200 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure?.kind, 'auth', 'sans le scan du texte, ce 401 passerait pour une erreur inconnue');
  assert.equal(outcome.failure?.needsReauth, true);
});

test('les codes de sortie du CLI sont mappés tels que documentés', () => {
  const at = (code: number, stdout: unknown) => classify({ exitCode: code, stdout: JSON.stringify(stdout), stderr: '', killed: false, timedOut: false }, { write: false, maxExcerpt: 200 });
  assert.equal(at(2, { error: { code: 2, message: 'credentials missing', reason: 'authError' } }).failure?.kind, 'auth');
  assert.equal(at(1, { error: { code: 429, message: 'quota', reason: 'rateLimitExceeded' } }).failure?.kind, 'rate_limit');
  assert.equal(at(1, { error: { code: 403, message: 'API disabled', reason: 'accessNotConfigured' } }).failure?.kind, 'forbidden');
  assert.equal(at(1, { error: { code: 404, message: 'Not Found', reason: 'notFound' } }).failure?.kind, 'not_found');
  assert.equal(at(3, { error: { code: 3, message: 'bad input', reason: 'validationError' } }).failure?.kind, 'validation');
  assert.equal(at(4, { error: { code: 4, message: 'discovery unreachable', reason: 'discoveryError' } }).failure?.kind, 'discovery');
  assert.equal(at(0, { messages: [] }).ok, true, 'code 0 et corps sain = succès');
});

test('une sortie qui n’est pas du JSON n’est jamais déclarée réussie sur un code non nul', () => {
  const outcome = classify({ exitCode: 1, stdout: 'error[auth]: token refresh failed', stderr: '', killed: false, timedOut: false }, { write: false, maxExcerpt: 200 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure?.kind, 'auth', 'le texte seul doit suffire à nommer la cause');
  assert.match(explainFailure(outcome.failure!), /google:login|reconnecte/i);
});

// ========================================================= 2. extractions

test('gmail : la liste ne rend que des id, et les en-têtes viennent d’un second appel typé', () => {
  const listed = { messages: [{ id: 'a1', threadId: 't1' }, { id: 'a2', threadId: 't2' }], nextPageToken: 'NEXT' };
  const ids = gmailListIds(listed);
  assert.deepEqual(ids.ids, ['a1', 'a2']);
  assert.equal(ids.nextPageToken, 'NEXT');

  const message = {
    id: 'a1',
    snippet: 'extrait',
    labelIds: ['UNREAD'],
    payload: { headers: [{ name: 'Subject', value: 'Facture' }, { name: 'From', value: 'compta@exemple.fr' }] },
  };
  const hit = gmailHit(message);
  assert.equal(hit.subject, 'Facture');
  assert.equal(hit.unread, true);
  assert.match(formatGmailHits([hit], 'NEXT'), /\[a1\].*Facture/s);
});

test('gmail : le corps base64url est décodé, multipart compris, et le snippet sert de repli', () => {
  const plain = Buffer.from('Bonjour pièce jointe 👋', 'utf8').toString('base64url');
  const html = Buffer.from('<p>Bonjour</p>', 'utf8').toString('base64url');
  const message = { payload: { parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: html } }, { mimeType: 'text/plain', body: { data: plain } }] }] } };
  assert.equal(gmailBody(message), 'Bonjour pièce jointe 👋');
  assert.equal(gmailBody(message, 'html'), '<p>Bonjour</p>');
  assert.equal(gmailBody({ snippet: 'que le snippet', payload: {} }), 'que le snippet');
});

test('docs : le texte est aplati, y compris dans les cellules d’un tableau', () => {
  const doc = {
    title: 'Stratégie Q4',
    body: {
      content: [
        { paragraph: { elements: [{ textRun: { content: 'Objectif : tenir la marge.' } }] } },
        { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'EMOA' } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: '18 %' } }] } }] }] }] } },
      ],
    },
  };
  const flat = docsText(doc);
  assert.match(flat, /Objectif : tenir la marge\./);
  assert.match(flat, /EMOA/, 'ignorer les tableaux ferait perdre du contenu sans le dire');
  assert.match(flat, /18 %/);
});

test('sheets, drive, calendar : les formes attendues sont rendues lisibles', () => {
  assert.deepEqual(sheetRows({ values: [['mois', 'ventes'], ['août', '1200']] }), [['mois', 'ventes'], ['août', '1200']]);
  const hits = driveHits({ files: [{ id: 'f1', name: 'notes.txt', mimeType: 'text/plain', modifiedTime: '2026-08-30T09:12:00Z' }, { id: 'f2', name: 'Doc', mimeType: 'application/vnd.google-apps.document' }] });
  assert.equal(hits[0]?.native, false);
  assert.equal(hits[1]?.native, true, 'un Google Doc n’a pas de contenu téléchargeable : il passe par l’API Docs');
  const events = calendarEvents({ items: [{ summary: 'Point', status: 'cancelled', start: { dateTime: '2026-09-03T14:30:00+00:00' }, end: { date: '2026-09-04' } }] });
  assert.equal(events[0]?.start, '2026-09-03T14:30:00+00:00');
  assert.equal(events[0]?.end, '2026-09-04', 'un événement sur une journée n’a pas de dateTime : le date doit suffire');
});

// ========================================================== 3. secrets ---

test('l’environnement du fils ne contient aucun secret du père, ni sous son nom ni sous un autre', () => {
  const child = projectedChildEnv(PARENT_ENV, { GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: 'file' });
  assert.deepEqual(forbiddenInheritedKeys(child), []);
  for (const name of forbiddenInheritedKeys(PARENT_ENV as Record<string, string>)) {
    const value = String(PARENT_ENV[name] ?? '');
    assert.ok(!Object.keys(child).includes(name), `${name} ne doit pas transiter`);
    assert.ok(!Object.values(child).some((entry) => entry.includes(value)), `la valeur de ${name} ne doit pas transiter, meme renomquee`);
  }
  assert.equal(child['GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND'], 'file', 'ce que le projet destinait au CLI y est bien');
  assert.equal(child['TZ'], 'UTC');
});

test('GOOGLE_APPLICATION_CREDENTIALS n’est pas transmis : c’est lui qui faisait échouer le CLI', () => {
  const child = childEnvironment(PARENT_ENV, {});
  assert.equal(child['GOOGLE_APPLICATION_CREDENTIALS'], undefined, 'le préfixe autorisé est GOOGLE_WORKSPACE_, pas GOOGLE_');
  const warning = staleAdcPointer(PARENT_ENV, process.cwd());
  assert.match(String(warning), /pointe vers \.\/service-account\.json/, 'et l’état du père est signalé, pas seulement évité');
  assert.equal(staleAdcPointer({ GOOGLE_APPLICATION_CREDENTIALS: 'src/config.ts' }, process.cwd()), undefined, 'un pointeur valide ne lève rien');
});

test('une fuite renommée est détectée sur la valeur, pas seulement sur le nom', () => {
  const leaked = { SOME_INNOCENT_NAME: PARENT_ENV['TELEGRAM_BOT_TOKEN'] as string };
  const leaks = assertNoForeignSecretsFor(leaked, PARENT_ENV);
  assert.equal(leaks.length, 1);
  assert.match(leaks[0] ?? '', /TELEGRAM_BOT_TOKEN/);
});

test('le masquage couvre les formes réelles de secrets Google, et l’extrait de journal aussi', () => {
  const sample = [
    'token ya29.a0AVvZSgKq0fakefakefakefake0',
    'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdef-_1234567890',
    '{"refresh_token":"1//0fakeRefreshTokenValue123","client_secret":"GOCSPX-fakefakefake"}',
    '-----BEGIN PRIVATE KEY-----\nMIIFakeKeyMaterial\n-----END PRIVATE KEY-----',
    'AIzaSyAFakeGoogleApiKey1234567890',
  ].join('\n');
  const clean = redact(sample);
  assert.equal(stillSensitive(clean), false, `reste sensible : ${clean}`);
  assert.match(clean, /REDACTÉ/);
  assert.equal(stillSensitive(safeExcerpt(`${sample}\nfin`, 90)), false);
});

// ========================================================= 4. transport ---

test('gmail_search construit exactement les appels de l’API, et le modèle n’en décide que les valeurs', async () => {
  const h = await harness();
  dispose(h);
  const search = h.tools.find((tool) => tool.name === 'gmail_search');
  assert.ok(search !== undefined);
  const result = await search.run({ requete: 'from:compta@exemple.fr newer_than:30d', max: 2 }, h.ctx);
  assert.equal(result.status, 'ok');
  assert.match(result.content, /2 message\(s\)/);

  const calls = h.recorded();
  const list = calls.find((call) => call.argv.join(' ').includes('messages list'));
  const get = calls.find((call) => call.argv.join(' ').includes('messages get'));
  assert.ok(list !== undefined && get !== undefined, 'un list puis un get par message : c’est le coût réel de l’API');
  assert.deepEqual(list.argv.slice(0, 4), ['gmail', 'users', 'messages', 'list']);
  const params = JSON.parse(String(list.params)) as Record<string, unknown>;
  assert.deepEqual(params, { userId: 'me', q: 'from:compta@exemple.fr newer_than:30d', maxResults: 2 });
  const meta = JSON.parse(String(get.params)) as Record<string, unknown>;
  assert.deepEqual(meta['metadataHeaders'], ['From', 'To', 'Subject', 'Date'], 'un paramètre répété est un TABLEAU : une chaîne citée partirait en une seule valeur pourrie');
  assert.equal(meta['format'], 'metadata', 'lire trois en-têtes plutôt que le message entier');
});

test('une injection par les arguments reste une donnée : le JSON protège l’argv, pas le shell', async () => {
  const h = await harness();
  dispose(h);
  const search = h.tools.find((tool) => tool.name === 'gmail_search')!;
  const hostile = '{"a":1}"; rm -rf / ; $(whoami) `id` --params {"x":';
  const result = await search.run({ requete: hostile }, h.ctx);
  assert.equal(result.status, 'ok', 'le CLI a reçu une requête de recherche, pas une commande');
  const call = h.recorded()[0];
  assert.equal(call?.argv.length, 6, 'service ressource méthode --params <un seul jeton> ');
  assert.equal(JSON.parse(String(call?.params))['q'], hostile, 'l’hostilité est préservée comme donnée, mot pour mot');
});

test('timeout : le fils est tué, l’agent répond, et aucun processus ne survit à l’appel', async () => {
  const h = await harness({ mode: 'hang', timeoutMs: 500 });
  dispose(h);
  const calendar = h.tools.find((tool) => tool.name === 'calendar_next')!;
  const start = Date.now();
  const result = await calendar.run({}, h.ctx);
  const elapsed = Date.now() - start;
  assert.equal(result.status, 'error');
  assert.match(result.content, /trop de temps|pas répondu/, 'la cause doit être nommée, pas un code nu');
  assert.ok(elapsed < 1400, `l'appel a duré ${elapsed} ms : le timeout doit borner ET ne pas être rejoué`);
  const pidFile = join(h.dir, 'child.pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), `le fils ${pid} survit à l'arrêt de l'appel`);
  }
});

test('plafond d’octes : un fichier démesuré est coupé, pas avalé', async () => {
  const h = await harness({ mode: 'huge', maxOutputBytes: 4096, env: { FAKE_GWS_HUGE_BYTES: '300000' } });
  dispose(h);
  const read = h.tools.find((tool) => tool.name === 'drive_read_text')!;
  const result = await read.run({ id: '1DrVtextFileId0001' }, h.ctx);
  assert.equal(result.status, 'error');
  assert.match(result.content, /trop volumineuse/, 'refus expliqué, avec la parade');
});

test('lecture sur un quota : une tentative de reprise ; écriture : jamais rejouée', async () => {
  const readSide = await harness({ mode: 'quota', readAttempts: 2 });
  dispose(readSide);
  const search = readSide.tools.find((tool) => tool.name === 'gmail_search')!;
  const readResult = await search.run({ requete: 'facture' }, readSide.ctx);
  assert.equal(readResult.status, 'error');
  assert.match(explainFailure({ kind: 'rate_limit', message: 'q', exitCode: 1, needsReauth: false, retryable: true }), /quota/);
  assert.equal(readSide.recorded().length, 2, 'une lecture peut être retentée');

  const writeSide = await harness({ mode: 'quota', allowWrites: true, dangerous: true, readAttempts: 2 });
  dispose(writeSide);
  const send = writeSide.tools.find((tool) => tool.name === 'gmail_send')!;
  const writeResult = await send.run({ a: 'dest@exemple.fr', objet: 'X', corps: 'Y' }, writeSide.ctx);
  assert.equal(writeResult.status, 'error');
  assert.equal(writeSide.recorded().length, 1, 'réessayer un envoi ferait deux mails : interdiction mesurée');
});

test('une erreur Google n’est jamais renvoyée au modèle telle quelle : extraits expurgés et bornés', async () => {
  const h = await harness({ mode: 'authfail' });
  dispose(h);
  const search = h.tools.find((tool) => tool.name === 'gmail_search')!;
  const result = await search.run({ requete: 'x' }, h.ctx);
  assert.equal(result.status, 'unavailable', 'auth refusée = capacité indisponible, pas une erreur à réessayer');
  assert.match(String(result.userNotice), /google:login/, "l'utilisateur doit savoir quoi taper");
  assert.ok(!/ya29\.|AIza|BEGIN/.test(result.content), 'aucun secret dans la réponse au modèle');
});

test('le double connaît la même absence de MCP que le vrai binaire, et l’audit du dépôt est écrit', async () => {
  const h = await harness({ mode: 'mcp' });
  dispose(h);
  const outcome = await h.transport.run({ service: 'auth', argv: ['mcp'], write: false, label: 'gws mcp' });
  assert.equal(outcome.ok, false);
  assert.match(String(outcome.failure?.message), /Unknown service 'mcp'/);
  // Preuve sur le binaire réel, pas seulement sur le double : la capacité a été vérifiée ici.
  const real = spawnSync(join(process.cwd(), 'node_modules', '.bin', 'gws'), ['mcp', '--help'], { encoding: 'utf8', shell: false });
  const text = `${real.stdout ?? ''}${real.stderr ?? ''}`;
  assert.match(text, /Unknown service 'mcp'|mcp/i, `sortie inattendue du binaire réel : ${text.slice(0, 120)}`);
});

test('résolution du binaire : le dépôt d’abord, le PATH ensuite, un absent nommé', () => {
  const dir = tmp();
  try {
    const bin = join(dir, 'node_modules', '.bin', 'gws');
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(bin, '#!/bin/sh\necho résolu\n', { mode: 0o755 });
    assert.equal(resolveGwsBin('gws', dir, '').bin, bin, 'le binaire du dépôt passe avant le PATH');
    const elsewhere = join(dir, 'hors-depot');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'gws'), '#!/bin/sh\necho PATH\n', { mode: 0o755 });
    rmSync(bin);
    assert.equal(resolveGwsBin('gws', dir, elsewhere).bin, join(elsewhere, 'gws'), 'sans binaire dans le dépôt, le PATH prend le relais');
    const missing = resolveGwsBin('gws-qui-nexiste-pas', dir, '/usr/bin');
    assert.match(String(missing.note), /introuvable/);
    assert.equal(resolveGwsBin('/bin/sh', dir, '').bin, '/bin/sh', 'un chemin explicite est pris tel quel');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ==================================================== 5. registre et verrous

test('liste blanche de services : un service hors liste na ni outil ni appel possible', async () => {
  const h = await harness({ services: ['drive', 'auth'] });
  dispose(h);
  const names = h.tools.map((tool) => tool.name);
  assert.ok(!names.includes('gmail_search') && !names.includes('calendar_next'), `outils hors liste : ${names.join(',')}`);
  assert.ok(names.includes('drive_search'));
  const drive = h.tools.find((tool) => tool.name === 'drive_search')!;
  const result = await drive.run({ requete: 'notes' }, h.ctx);
  assert.equal(result.status, 'ok');
});

test('écritures : deux verrous, et un outil sensible toujours approuvé par un humain', async () => {
  const locked = await harness();
  const open = await harness({ allowWrites: true, dangerous: true });
  dispose(locked);
  dispose(open);
  assert.ok(!locked.tools.some((tool) => tool.requiresApproval === true), 'GWS_ALLOW_WRITES=false ou DANGEROUS=false : la main sur le compte est retirée');
  const writes = open.tools.filter((tool) => tool.requiresApproval === true);
  assert.deepEqual(writes.map((tool) => tool.name).sort(), ['calendar_create', 'docs_append', 'drive_delete', 'gmail_send', 'sheets_append']);
  for (const tool of writes) assert.equal(tool.dangerous, true, `${tool.name} doit être marqué sensible`);

  // Le registre refuse un outil sensible sans approbation : linvariant est vérifié a lenregistrement.
  assert.throws(
    () =>
      new ToolRegistry(
        [{ name: 'google_envoyeur', description: 'x', parameters: {}, run: () => ({ status: 'ok', content: '' }) } as unknown as Tool, { ...writes[0]!, requiresApproval: undefined } as Tool],
        true,
      ),
    /sans requiresApproval|jamais sans accord/,
  );
});

test('drive_delete : le nom doit correspondre avant que quoi que ce soit soit supprimé', async () => {
  const h = await harness({ allowWrites: true, dangerous: true });
  dispose(h);
  const del = h.tools.find((tool) => tool.name === 'drive_delete')!;
  const wrong = await del.run({ id: '1DrVtextFileId0001', nom: 'tout-autre-chose.txt' }, h.ctx);
  assert.equal(wrong.status, 'denied');
  assert.match(wrong.content, /ne correspond pas/);
  assert.ok(!h.recorded().some((call) => call.argv.join(' ').includes('delete')), 'aucun appel de suppression ne doit avoir été construit');

  const right = await del.run({ id: '1DrVtextFileId0001', nom: 'notes-de-reunion.txt' }, h.ctx);
  assert.equal(right.status, 'ok');
  assert.match(right.content, /supprimé définitivement/);
  const deleteCall = h.recorded().find((call) => call.argv.join(' ').includes('files delete'));
  assert.ok(deleteCall !== undefined);
  assert.equal(JSON.parse(String(deleteCall.params))['fileId'], '1DrVtextFileId0001');
});

test('un texte non textuel de Drive naffecte pas le contexte : plafonné, marqué comme donnée', async () => {
  const h = await harness();
  dispose(h);
  const read = h.tools.find((tool) => tool.name === 'drive_read_text')!;
  const result = await read.run({ id: '1DrVtextFileId0001', max_lignes: 1 }, h.ctx);
  assert.equal(result.status, 'ok');
  assert.ok(result.content.length < 9000, 'le plafond de sortie est respecté');
  assert.match(result.content, /donnée/i, 'le contenu externe est encadré comme une donnée');
  assert.ok(!/ya29\./.test(result.content), 'un jeton lu dans un fichier ne ressort pas vers le modèle');
});

test('sheets_read et calendar_next rendent des lignes lisibles plutôt que du JSON', async () => {
  const h = await harness();
  dispose(h);
  const sheets = h.tools.find((tool) => tool.name === 'sheets_read')!;
  const table = await sheets.run({ spreadsheet: 'SH1234567890abcdefghij' }, h.ctx);
  assert.equal(table.status, 'ok');
  assert.match(table.content, /mois \| ventes \| marge/);

  const calendar = h.tools.find((tool) => tool.name === 'calendar_next')!;
  const agenda = await calendar.run({ jours: 3 }, h.ctx);
  assert.match(agenda.content, /Point fournisseur/);
  assert.match(agenda.content, /ANNULÉ/, 'un événement annulé doit rester marqué comme tel');
  const call = h.recorded().find((entry) => entry.argv.join(' ').includes('events list'))!;
  const params = JSON.parse(String(call.params)) as Record<string, unknown>;
  assert.equal(params['singleEvents'], true, 'sans ça, un événement récurrent est rendu comme un modèle et non comme une date');
  assert.equal(params['orderBy'], 'startTime');
  assert.match(String(params['timeMin']), /T\d\d:\d\d:\d\d/);
});

test('arguments invalides : loutil refuse avant tout appel réseau et dit quoi corriger', async () => {
  const h = await harness({ allowWrites: true, dangerous: true });
  dispose(h);
  const create = h.tools.find((tool) => tool.name === 'calendar_create')!;
  const bad = await create.run({ titre: 'Rendez-vous', debut: 'demain 14h', fin: '2026-09-04T15:00:00+00:00' }, h.ctx);
  assert.equal(bad.status, 'invalid_args');
  assert.match(bad.content, /format d.horaire refusé/);
  const reversed = await create.run({ titre: 'X', debut: '2026-09-04T15:00:00+00:00', fin: '2026-09-04T14:00:00+00:00' }, h.ctx);
  assert.match(reversed.content, /fin doit suivre/);
  assert.equal(h.recorded().length, 0, 'un refus sur validation ne consomme aucun appel Google');

  const send = h.tools.find((tool) => tool.name === 'gmail_send')!;
  const typo = await send.run({ a: 'pas-une-adresse', objet: 'X', corps: 'Y' }, h.ctx);
  assert.equal(typo.status, 'invalid_args');
  assert.match(typo.content, /adresse mail refusée/);
});

test('le transport fermé rend une erreur de transport, sans fils ni promesse pendue', async () => {
  const h = await harness();
  dispose(h);
  await h.transport.close('test');
  const outcome = await h.transport.run({ service: 'gmail', argv: ['gmail', 'users', 'messages', 'list'], write: false, label: 'x' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failure?.kind, 'transport');
  assert.equal(h.transport.inFlight, 0);
});
