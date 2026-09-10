/**
 * Tests du hub : le SEUL point d'entrée réseau du projet. C'est là que se jouent le ticket,
 * l'isolation par conversation, le débit et ce que la page a le droit de charger — donc tout
 * est vérifié depuis un vrai client websocket et de vraies réponses HTTP, pas en appelant
 * des fonctions internes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRealtimeHub, openCallSocket, testSilence, testSpeech, type RealtimeHub } from '../realtime/hub.js';
import { CALL_PAGE_HTML } from '../realtime/page.js';
import { makeSessionHarness, until } from '../testing/realtime-harness.js';
import type { HubSessionInput, RealtimeHubDeps } from '../realtime/hub.js';
import type { RealtimeSessionDeps } from '../realtime/session.js';

const CHAT = 10;
const USER = 4242;

interface HubFixture {
  hub: RealtimeHub;
  port: number;
  base: string;
  url(path: string): string;
  calls: Array<{ chatId: number; event: string }>;
  close(): Promise<void>;
}

async function hubFixture(
  overrides: Partial<RealtimeHubDeps> = {},
  options: { allowed?: number[]; ttl?: number; maxKbps?: number } = {},
): Promise<HubFixture> {
  const calls: Array<{ chatId: number; event: string }> = [];
  const buildSession = (input: HubSessionInput): Omit<RealtimeSessionDeps, 'chatId' | 'userId' | 'sink' | 'client'> => {
    const h = makeSessionHarness({ reply: 'Voici la réponse.' });
    // Le harnais branche son propre listener/sink : on lui injecte ceux du hub, sinon la
    // session écrirait dans le vide et le test ne prouverait rien sur le transport.
    h.deps.sink = input.sink;
    h.deps.client = input.client;
    h.deps.sendChatText = input.sendChatText;
    calls.push({ chatId: input.chatId, event: 'construite' });
    return h.deps;
  };
  const deps: RealtimeHubDeps = {
    allowedUserIds: new Set(options.allowed ?? [USER]),
    ticketTtlSeconds: options.ttl ?? 120,
    maxFrameBytesPerSecond: options.maxKbps ?? 1_000_000,
    buildSession,
    onCallStarted: (info) => calls.push({ chatId: info.chatId, event: 'ouvert' }),
    onCallEnded: (info) => calls.push({ chatId: info.chatId, event: `fermé:${info.summary.turns}` }),
    ...overrides,
  };
  const hub = buildRealtimeHub(deps, '127.0.0.1', 0);
  const { port } = await hub.listen();
  return {
    hub,
    port,
    base: `http://127.0.0.1:${port}`,
    url: (path) => `ws://127.0.0.1:${port}${path}`,
    calls,
    async close() {
      await hub.close();
    },
  };
}

/** Lit le fil de contrôle jusqu'à trouver `t` demandé (le hub empile plusieurs messages). */
async function nextOf(socket: { nextControl(ms?: number): Promise<Record<string, unknown> | null> }, wanted: (m: Record<string, unknown>) => boolean, max = 12): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < max; i += 1) {
    const message = await socket.nextControl(600);
    if (message === null) return null;
    if (wanted(message)) return message;
  }
  return null;
}

// ------------------------------------------------------------------ HTTP ---

test('le hub ne sert que la page d’appel : tout le reste est un 404 muet', async () => {
  const f = await hubFixture();
  try {
    const page = await fetch(`${f.base}/`);
    assert.equal(page.status, 200);
    const other = await fetch(`${f.base}/favicon.ico`);
    assert.equal(other.status, 404);
    assert.equal(await other.text(), '', 'un 404 bavard renseigne un attaquant sur ce qui existe');
    for (const path of ['/memory', '/.env', '/../../etc/passwd', '/api', '/healthz']) {
      assert.equal((await fetch(`${f.base}${path}`)).status, 404, path);
    }
    const post = await fetch(`${f.base}/`, { method: 'POST', body: 'x' });
    assert.equal(post.status, 405);
  } finally {
    await f.close();
  }
});

test('les en-têtes de la page verrouillent micro, cache et fuite de référent', async () => {
  const f = await hubFixture();
  try {
    const res = await fetch(`${f.base}/call`);
    assert.equal(res.status, 200);
    const headers = res.headers;
    const csp = headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/, 'rien ne doit pouvoir être chargé hors de la page');
    assert.match(csp, /script-src 'unsafe-inline' blob:/, 'le worklet audio est un blob : sans ce droit, pas de micro');
    assert.ok(!/https?:/.test(csp), 'aucune origine http autorisée dans la CSP');
    assert.equal(headers.get('permissions-policy'), 'microphone=(self)');
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
    assert.equal(headers.get('cache-control'), 'no-store', 'un lien de micro à usage unique ne se met pas en cache');
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------- tickets ---

test('le jeton voyage dans le fragment, jamais dans une query string', () => {
  const hub = buildRealtimeHub(
    { allowedUserIds: new Set([USER]), ticketTtlSeconds: 60, maxFrameBytesPerSecond: 1_000_000, buildSession: () => makeSessionHarness().deps },
    '127.0.0.1',
    0,
  );
  const ticket = hub.issueTicket(CHAT, USER);
  const link = hub.linkFor(ticket);
  assert.match(link, /#t=[A-Za-z0-9_-]+$/);
  assert.ok(!link.includes('?t='), 'une query string est recopiée dans les journaux du proxy');
  assert.equal(ticket.token.length >= 32, true, 'un jeton court se devine');
});

test('un lien ne marche qu’une fois, et un lien expiré ne marche pas du tout', async () => {
  const f = await hubFixture({}, { ttl: 120 });
  try {
    const ticket = f.hub.issueTicket(CHAT, USER);
    const first = await openCallSocket(f.url(`/ws?t=${ticket.token}`));
    const hello = await first.nextControl(800);
    assert.equal((hello as { t?: string }).t, 'hello');
    first.close();
    await assert.rejects(() => openCallSocket(f.url(`/ws?t=${ticket.token}`)), /Unexpected /, 'le jeton doit être mort après usage');

    const stale = f.hub.issueTicket(CHAT, USER);
    assert.equal(f.hub.revokeTicket(stale.token), true);
    assert.equal(f.hub.revokeTicket(stale.token), false, 'révoquer deux fois ne doit pas faire semblant');
    await assert.rejects(() => openCallSocket(f.url(`/ws?t=${stale.token}`)));
  } finally {
    await f.close();
  }
});

test('un inconnu avec un lien valide est refusé : la liste blanche est appliquée, pas rejouée', async () => {
  const f = await hubFixture({}, { allowed: [999] });
  try {
    const ticket = f.hub.issueTicket(CHAT, USER);
    await assert.rejects(() => openCallSocket(f.url(`/ws?t=${ticket.token}`)), /403|Unexpected/, "l'utilisateur du ticket n'est pas autorisé");
  } finally {
    await f.close();
  }
});

// ------------------------------------------------------------ flux audio ---

test('aller-retour : l’audio monte, la voix descend avec son en-tête, les sous-titres suivent', async () => {
  const f = await hubFixture();
  let seenAudio = 0;
  try {
    const ticket = f.hub.issueTicket(CHAT, USER);
    const socket = await openCallSocket(f.url(`/ws?t=${ticket.token}`));
    assert.equal((await socket.nextControl(800) as { t?: string }).t, 'hello');

    for (const pcm of [...Array.from({ length: 10 }, () => testSpeech(0.04)), ...Array.from({ length: 12 }, () => testSilence(0.04))]) {
      socket.sendAudio(pcm);
    }
    const firstAudio = await socket.nextAudio(1500);
    assert.notEqual(firstAudio, null, 'la voix doit redescendre vers le client');
    assert.equal(firstAudio!.sampleRate, 24_000);
    seenAudio += 1;
    await until(() => seenAudio > 0, 500);

    const captions: string[] = [];
    const states: string[] = [];
    let ended = false;
    // Le client lit ce qui descend et rend la main : on continue à puiser les contrôles.
    for (let i = 0; i < 12; i += 1) {
      const control = await socket.nextControl(500);
      if (control === null) break;
      if (control['t'] === 'caption') captions.push(String(control['text']));
      if (control['t'] === 'state') states.push(String(control['state']));
      if (control['t'] === 'speech' && control['state'] === 'end') socket.sendText({ t: 'flush' });
    }
    void ended;
    assert.ok(captions.length > 0, 'les sous-titres doivent être remontés');
    assert.ok(states.includes('thinking') || states.includes('speaking'), states.join(','));
    socket.close();
  } finally {
    await f.close();
  }
});

test('une trame audio déformée est écartée sans couper l’appel', async () => {
  const f = await hubFixture();
  try {
    const socket = await openCallSocket(f.url(`/ws?t=${f.hub.issueTicket(CHAT, USER).token}`));
    await socket.nextControl(500);
    socket.sendAudio(new Uint8Array(3));
    socket.sendAudio(new Uint8Array(1281)); // longueur impaire
    socket.sendText({ t: 42 });
    socket.sendText('ceci n est pas du json');
    socket.sendAudio(testSpeech(0.04));
    // L'appel vit toujours : le client peut toujours poser une question.
    socket.sendText({ t: 'text', text: 'toujours là ?' });
    const states: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const control = await socket.nextControl(500);
      if (control === null) break;
      if (control['t'] === 'state') states.push(String(control['state']));
      if (states.includes('thinking')) break;
    }
    assert.ok(states.length > 0, 'les trames invalides ne doivent pas geler la machine à états');
    socket.close();
  } finally {
    await f.close();
  }
});

test('débit déréglé : le hub lâche des cadres et le dit, au lieu de saturer le fournisseur', async () => {
  // 2 ko/s : un client qui enverrait du 48 kHz stereo est coupé, pas facturé.
  const f = await hubFixture({}, { maxKbps: 2048 });
  try {
    const socket = await openCallSocket(f.url(`/ws?t=${f.hub.issueTicket(CHAT, USER).token}`));
    await socket.nextControl(500);
    for (let i = 0; i < 400; i += 1) socket.sendAudio(new Uint8Array(1280).fill(0x42));
    // La première note est celle de l'oreille : on cherche CELLE du débit — c'est justement
    // l'objet du test, le hub ne doit pas noyer l'avis utile dans les messages de bord.
    const note = await nextOf(socket, (m) => m['t'] === 'note' && /Débit/.test(String(m['text'] ?? '')));
    assert.notEqual(note, null, 'le client doit savoir qu’il perd de l’audio');
    socket.close();
  } finally {
    await f.close();
  }
});

test('une seule source de micro par conversation : le deuxième onglet est refusé en le disant', async () => {
  const f = await hubFixture();
  try {
    const a = await openCallSocket(f.url(`/ws?t=${f.hub.issueTicket(CHAT, USER).token}`));
    assert.equal((await a.nextControl(800) as { t?: string }).t, 'hello');
    const b = await openCallSocket(f.url(`/ws?t=${f.hub.issueTicket(CHAT, USER).token}`));
    const msg = await b.nextControl(500);
    assert.equal((msg as { t?: string }).t, 'error');
    assert.match(String((msg as { text?: string }).text), /déjà ouvert/);
    a.close();
    b.close();
  } finally {
    await f.close();
  }
});

test('un seul appel par ticket : la session est construite une fois, pas à chaque message', async () => {
  const f = await hubFixture();
  try {
    const socket = await openCallSocket(f.url(`/ws?t=${f.hub.issueTicket(CHAT, USER).token}`));
    await socket.nextControl(500);
    for (let i = 0; i < 5; i += 1) socket.sendAudio(testSpeech(0.04));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.calls.filter((c) => c.event === 'construite').length, 1);
    socket.close();
  } finally {
    await f.close();
  }
});

// ------------------------------------------------------------- fermeture ---

test('le client qui part clôture l’appel, et le bilan est rendu UNE fois', async () => {
  const f = await hubFixture();
  try {
    const socket = await openCallSocket(f.url(`/ws?t=${f.hub.issueTicket(CHAT, USER).token}`));
    await socket.nextControl(500);
    socket.close();
    await until(() => f.calls.some((c) => c.event.startsWith('fermé')), 1500);
    assert.equal(f.calls.filter((c) => c.event.startsWith('fermé')).length, 1);
    assert.equal(f.hub.activeSession(CHAT), null, 'la session ne doit pas survivre à son micro');
  } finally {
    await f.close();
  }
});

test('/call stop : la session est fermée dans l’ordre, le socket aussi', async () => {
  const f = await hubFixture();
  try {
    const socket = await openCallSocket(f.url(`/ws?t=${f.hub.issueTicket(CHAT, USER).token}`));
    await socket.nextControl(500);
    assert.equal(f.hub.status(CHAT)?.active, true);
    assert.equal(await f.hub.endChat(CHAT, 'raccroché depuis Telegram'), true);
    assert.equal(await f.hub.endChat(CHAT, 'encore'), false, 'raccrocher deux fois ne doit pas réécrire un bilan');
    const closed = await nextOf(socket, (m) => m['t'] === 'closed');
    assert.notEqual(closed, null, 'le client doit être prévenu AVANT que le socket ne se coupe');
    assert.match(String((closed as { reason?: string }).reason ?? ''), /Telegram/);
    await until(() => f.calls.some((c) => c.event.startsWith('fermé')), 1500);
  } finally {
    await f.close();
  }
});

test('endAll : la fermeture du service ne laisse aucun micro ouvert', async () => {
  const f = await hubFixture();
  try {
    const a = await openCallSocket(f.url(`/ws?t=${f.hub.issueTicket(CHAT, USER).token}`));
    await a.nextControl(500);
    const b = await openCallSocket(f.url(`/ws?t=${f.hub.issueTicket(77, USER).token}`));
    await b.nextControl(500);
    await f.hub.endAll('arrêt du service');
    assert.equal(f.hub.activeSession(CHAT), null);
    assert.equal(f.hub.activeSession(77), null);
    a.close();
    b.close();
  } finally {
    await f.close();
  }
});

test('un port déjà pris ne fait pas semblant de tourner', async () => {
  const f = await hubFixture();
  try {
    const second = buildRealtimeHub(
      { allowedUserIds: new Set([USER]), ticketTtlSeconds: 60, maxFrameBytesPerSecond: 1_000_000, buildSession: () => makeSessionHarness().deps },
      '127.0.0.1',
      f.port,
    );
    await assert.rejects(() => second.listen(), /EADDRINUSE/);
    await second.close();
  } finally {
    await f.close();
  }
});

// ------------------------------------------------------------------ page ---

test('la page d’appel ne charge RIEN d’externe (ni CDN, ni police, ni script)', () => {
  // Ce n'est pas une question de goût : le bot tourne souvent derrière un VPN ou un pare-feu,
  // et une page qui tient le micro ne doit rien demander ailleurs que son propre serveur.
  assert.ok(!/src\s*=\s*["']https?:/i.test(CALL_PAGE_HTML), 'une ressource distante est référencée');
  assert.ok(!/href\s*=\s*["']https?:/i.test(CALL_PAGE_HTML), 'un lien de style distant est référencé');
  assert.ok(!/\bfetch\s*\(\s*["']https?:/i.test(CALL_PAGE_HTML), 'une requête sortante est codée en dur');
  assert.ok(!/\bimport\s*\(/.test(CALL_PAGE_HTML), 'un import dynamique chargerait ce qu’il veut');
  assert.ok(!/@(?:import|font-face)/i.test(CALL_PAGE_HTML), 'une police externe serait une dépendance réseau');
});

test('la page lit le jeton dans le fragment et se branche sur /ws du même hôte', () => {
  assert.match(CALL_PAGE_HTML, /location\.hash/, 'le jeton doit venir du fragment');
  assert.match(CALL_PAGE_HTML, /\/ws\?t=/, 'le websocket est pris sur le même origine que la page');
  assert.match(CALL_PAGE_HTML, /isSecureContext|getUserMedia/);
});

test('le client embarqué parle le protocole exact : cadres 0x42, 16 kHz, contrôle JSON', () => {
  assert.match(CALL_PAGE_HTML, /0x42/, 'la montante doit porter le marqueur attendu par parseClientFrame');
  assert.match(CALL_PAGE_HTML, /16000|16_000/, 'le micro doit être ré-échantillonné à 16 kHz');
  assert.match(CALL_PAGE_HTML, /\{\s*t:\s*'flush'\s*\}/, 'le client doit dire quand il a fini de lire');
  assert.match(CALL_PAGE_HTML, /registerProcessor/, 'le worklet audio est obligatoire : sans lui, pas de cadres réguliers');
});

test('les chaînes de la page ne contiennent pas d’entités HTML échappées', () => {
  // Un `&amp;` dans une chaîne JS s'affiche tel quel à l'utilisateur — le piège classique
  // d'une page régénérée depuis un template HTML.
  const script = CALL_PAGE_HTML.slice(CALL_PAGE_HTML.indexOf('<script>'), CALL_PAGE_HTML.indexOf('</script>'));
  assert.ok(!/&amp;|&quot;|&#39;|&lt;|&gt;/.test(script), 'des entités HTML se sont glissées dans le script');
});

test('la page annonce les limites de l’API Bot (le son ne passe pas par Telegram)', () => {
  assert.match(CALL_PAGE_HTML, /Telegram|flux direct/, "l'utilisateur doit savoir où va son audio");
});

test('la taille de la page reste sous le budget raisonnable dun appel', () => {
  // Une page de plus en plus grosse est un risque de coupure côté proxy local, et un signal
  // qu'on y empile des fonctionnalités qui devraient être dans le module.
  assert.ok(CALL_PAGE_HTML.length < 16_000, `page = ${CALL_PAGE_HTML.length} octets`);
});
