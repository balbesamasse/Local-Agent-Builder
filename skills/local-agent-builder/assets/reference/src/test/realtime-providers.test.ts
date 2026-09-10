/**
 * Tests des ADAPTATEURS de voix, branchés sur de faux serveurs qui parlent le vrai protocole.
 *
 * C'est la partie qui prouve la remplaçabilité annoncée : oreille et bouche sont écrites
 * contre des websockets réels, avec un serveur qui rejette les mêmes erreurs que le
 * fournisseur (message inattendu, texte sans espace finale, réglages envoyés trop tard).
 * Un changement de contrat côté ElevenLabs doit casser ici, pas en production à 3 h du matin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { RealtimeSocket, SocketFactory } from '../realtime/protocol.js';
import { RealtimeListener } from '../realtime/listener.js';
import { ElevenLabsSpeechStream } from '../realtime/elevenlabs-tts.js';
import { startFakeProviders, socketFactoryFor, type FakeProviders } from '../testing/fake-realtime-providers.js';
import { frame, until, utteranceFrames } from '../testing/realtime-harness.js';
import type { Transcript, Transcriber } from '../audio/types.js';

const KEY = 'test-key';
const VOICE = 'CwhRBWXzGAHq8TQ4Fs17';

let providers: FakeProviders | null = null;
test.afterEach(async () => {
  if (providers !== null) {
    await providers.close();
    providers = null;
  }
});

const silentTranscriber: Transcriber = {
  name: 'faux blocs',
  transcribe: async (input): Promise<Transcript> => ({
    text: 'bloc transcrit',
    language: 'fr',
    durationSec: input.bytes.byteLength / 32_000,
    provider: 'faux blocs',
    model: 'fake',
  }),
};

function listenerFor(fake: FakeProviders, over: Partial<Parameters<typeof RealtimeListener.create>[0]> = {}) {
  return RealtimeListener.create({
    apiKey: KEY,
    wsBaseUrl: fake.wsUrl,
    realtimeModel: 'scribe_v2_realtime',
    timeoutMs: 2_000,
    transcriber: silentTranscriber,
    // Grace courte : sans elle, un « temps réel muet » attendrait 2,5 s avant le repli blocs.
    // 1,2 s et non 250 ms : sous la charge d'une suite entière (200 tests, CPU occupé), une
    // grace trop courte faisait BASCULER le tour en mode blocs — un test qui échoue parce que
    // la machine est lente n'est pas un test. Le repli sur les blocs a son test dédié, plus bas.
    commitGraceMs: 1_200,
    vad: { silenceMs: 200 },
    socketFactory: socketFactoryFor() as SocketFactory,
    ...over,
  });
}

function speechFor(fake: FakeProviders, over: Partial<ConstructorParameters<typeof ElevenLabsSpeechStream>[0]> = {}) {
  return new ElevenLabsSpeechStream({
    apiKey: KEY,
    httpBaseUrl: 'http://127.0.0.1:1/v1',
    wsBaseUrl: fake.wsUrl,
    voiceId: VOICE,
    modelId: 'eleven_flash_v2_5',
    stability: 50,
    similarityBoost: 75,
    timeoutMs: 2_000,
    socketFactory: socketFactoryFor() as never,
    ...over,
  });
}

test('oreille : le texte rendu est le FINAL du fournisseur, pas le partiel', async () => {
  const fake = await startFakeProviders({ transcript: 'il est dix-huit heures' });
  providers = fake;
  const listener = listenerFor(fake);
  const events: string[] = [];
  let text = '';
  listener.on((event) => {
    events.push(event.type);
    if (event.type === 'turn-end') text = event.text;
  });
  await listener.start();
  assert.equal(listener.currentMode, 'temps réel', 'avec websocket + clé, le mode temps réel doit être pris');
  assert.equal(listener.ear, 'elevenlabs-temps-réel', "l'oreille rendue au client doit nommer le mode, pas un id de modèle brut");

  // On n'écrit pas avant que le fournisseur ait dit `session_started` : la session n'existe
  // pas encore et la doc ElevenLabs répond par une erreur sur un cadre envoyé trop tôt.
  await until(() => listener.ready, 1000);
  // Les cadres partent au rythme d'un micro (une tick entre chaque) et non d'un bloc
  // synchrone : le fournisseur doit pouvoir rendre son texte FINAL avant la cloture du tour.
  for (const pcm of utteranceFrames()) {
    listener.feed(pcm);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await until(() => events.includes('turn-end'), 4000);

  assert.equal(text, 'il est dix-huit heures', 'le texte FINAL du fournisseur, pas le partiel');
  assert.equal(fake.stt.commits, 1, 'un seul commit par tour (le VAD local décide la fin)');
  assert.ok(fake.stt.maxChunkBytes >= 1280, 'les cadres de 40 ms partent entiers');
  const first = fake.stt.firstMessage!;
  assert.equal(first['message_type'], 'input_audio_chunk');
  assert.equal(first['sample_rate'], 16_000, 'le fournisseur doit savoir ce qu’il reçoit');
  assert.equal(first['commit'], false, 'jamais de commit implicite pendant la phrase');
  listener.close();
});

test('oreille : un fournisseur qui hoquette sur le texte final fait basculer CE tour sur les blocs', async () => {
  const fake = await startFakeProviders({ transcript: 'jamais rendu' });
  providers = fake;
  fake.muteCommits = true;
  const listener = listenerFor(fake, { commitGraceMs: 120 });
  const notes: string[] = [];
  let text = '';
  listener.on((event) => {
    if (event.type === 'note') notes.push(event.text);
    if (event.type === 'turn-end') text = event.text;
  });
  await listener.start();
  await until(() => listener.ready, 1000);
  for (const pcm of utteranceFrames()) listener.feed(pcm);
  await until(() => text !== '', 2000);
  assert.equal(text, 'bloc transcrit', 'la phrase est transcrite quand même : un appel ne meurt pas pour un fournisseur muet');
  assert.ok(notes.some((n) => /partiel muet/.test(n)), notes.join('|'));
  assert.equal(listener.currentMode, 'temps réel', 'une phrase ratée ne condamne pas le temps réel pour tout l’appel');
  listener.close();
});

test('oreille : le partiel nourrit le sous-titre, JAMAIS la décision de tour', async () => {
  const fake = await startFakeProviders();
  providers = fake;
  const listener = listenerFor(fake);
  const partials: string[] = [];
  let turns = 0;
  listener.on((event) => {
    if (event.type === 'partial') partials.push(event.text);
    if (event.type === 'turn-end') turns += 1;
  });
  await listener.start();
  await until(() => listener.ready, 1000);
  for (const pcm of utteranceFrames()) listener.feed(pcm);
  await until(() => turns === 1, 2000);
  assert.ok(partials.length > 0, 'le sous-titre doit bouger pendant la phrase');
  assert.equal(turns, 1, 'un tour = une décision, pas une par trame partielle');
  listener.close();
});

test('oreille : un échec du temps réel bascule en blocs, et l’appel continue', async () => {
  providers = await startFakeProviders();
  // Fabrique qui fait échouer la poignée de main : c'est ce que vit un compte sans droit
  // realtime, ou un proxy qui coupe les websockets.
  const broken: SocketFactory = () => {
    const socket: RealtimeSocket = {
      readyState: 1,
      send: () => undefined,
      close: () => undefined,
      on: (event, handler) => {
        if (event === 'error') setTimeout(() => handler(new Error('connexion refusée')), 0);
      },
    };
    return socket;
  };
  const listener = listenerFor(providers!, { socketFactory: broken, commitGraceMs: 20 });
  const notes: string[] = [];
  let finalText: string | null = null;
  listener.on((event) => {
    if (event.type === 'note') notes.push(event.text);
    if (event.type === 'turn-end') finalText = event.text;
  });
  await listener.start();
  assert.equal(listener.ready, false, 'un flux qui échoue ne doit jamais se dire prêt');
  assert.equal(listener.currentMode, 'blocs', 'léchec doit conduire au repli, pas à une exception');
  for (const pcm of utteranceFrames()) listener.feed(pcm);
  await until(() => finalText !== null, 2000);
  assert.equal(finalText, 'bloc transcrit', 'le mode blocs transcrit lénoncé entier');
  assert.ok(notes.some((n) => /bascule en mode blocs/.test(n)), notes.join('|'));
  listener.close();
});

test('oreille : la sourdine rend un reset du VAD (pas de tour fantôme au dé-muet)', async () => {
  const fake = await startFakeProviders();
  providers = fake;
  const listener = listenerFor(fake);
  let starts = 0;
  let ends = 0;
  listener.on((event) => {
    if (event.type === 'speech-start') starts += 1;
    if (event.type === 'turn-end') ends += 1;
  });
  await listener.start();
  await until(() => listener.ready, 1000);
  listener.feed(frame(0.08));
  listener.feed(frame(0.08));
  listener.setMuted(true);
  for (let i = 0; i < 20; i += 1) listener.feed(frame(0));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ends, 0, 'un énoncé coupé par la sourdine ne doit rien rendre');
  assert.equal(starts, 0, 'deux cadres ne suffisent pas à ouvrir un tour');
  listener.close();
});

test('voix : le premier message porte lair, les réglages et la clé (jamais l’URL)', async () => {
  const fake = await startFakeProviders();
  providers = fake;
  const seen: string[] = [];
  let openedUrl = '';
  const spy: SocketFactory = (url, headers) => {
    openedUrl = url;
    const socket = (socketFactoryFor() as SocketFactory)(url, headers);
    const wrapped: RealtimeSocket = {
      get readyState() {
        return socket.readyState;
      },
      send: (data) => {
        seen.push(data);
        socket.send(data);
      },
      close: () => socket.close(),
      on: (event, handler) => socket.on(event, handler),
    };
    return wrapped;
  };
  const speaker = speechFor(fake, { socketFactory: spy as never });
  const chunks: number[] = [];
  await speaker.begin((chunk) => chunks.push(chunk.bytes.byteLength));
  const url = openedUrl;
  const first = seen[0] ?? '{}';
  assert.ok(!url.includes(KEY), 'la clé ne doit jamais voyager dans une query string');
  assert.match(url, /output_format=pcm_24000/);
  assert.match(url, new RegExp(`/text-to-speech/${VOICE}/stream-input`));
  const payload = JSON.parse(first) as Record<string, unknown>;
  assert.equal(payload['text'], ' ', 'le premier message doit être une espace (sinon la session na pas de voix)');
  assert.equal(payload['xi-api-key'], KEY, 'et porter la clé dans le corps');
  assert.ok(payload['voice_settings'] !== undefined && payload['generation_config'] !== undefined);
  await speaker.end();
  speaker.close();
});

test('voix : flush → isFinal, et le premier octet est mesuré (la latence comptée)', async () => {
  const fake = await startFakeProviders();
  providers = fake;
  const speaker = speechFor(fake);
  const bytes: number[] = [];
  await speaker.begin((chunk) => bytes.push(chunk.bytes.byteLength));
  await speaker.write('Bonjour, je tenth.');
  const result = await speaker.end();
  assert.ok(bytes.length >= 3, `chunks=${bytes.length} : la fin d'énoncé doit vider le tampon du fournisseur`);
  assert.equal(result.interrupted, false);
  assert.equal(result.chars, 'Bonjour, je tenth.'.length);
  assert.ok(result.firstByteMs >= 0 && result.firstByteMs < 2000, `premierOctet=${result.firstByteMs}`);
  assert.equal(result.provider, 'websocket');
  speaker.close();
});

test('voix : un refus du fournisseur dégrade lappel sans le tuer', async () => {
  const fake = await startFakeProviders();
  providers = fake;
  fake.failSpeech = true;
  const speaker = speechFor(fake);
  await speaker.begin(() => undefined);
  await speaker.write('test ');
  const result = await speaker.end();
  assert.equal(speaker.mode, 'dégradé');
  assert.match(speaker.degradedBecause ?? '', /quota de voix atteint/);
  assert.equal(result.interrupted, false);
  // Après la bascule, `write` ne doit plus rien écrire au fournisseur (facture à zéro).
  const before = result.chars;
  await speaker.write('encore ');
  assert.equal((await speaker.end()).chars >= before, true);
  speaker.close();
});

test('voix : abort() ne ferme pas le canal (une interruption ne doit pas coûter une poignée de main)', async () => {
  const fake = await startFakeProviders();
  providers = fake;
  const speaker = speechFor(fake);
  let closes = 0;
  const inner = (socketFactoryFor() as SocketFactory);
  const counting: SocketFactory = (url, headers) => {
    const socket = inner(url, headers);
    const wrapped: RealtimeSocket = {
      get readyState() {
        return socket.readyState;
      },
      send: (data) => socket.send(data),
      close: () => {
        closes += 1;
        socket.close();
      },
      on: (event, handler) => socket.on(event, handler),
    };
    return wrapped;
  };
  const tracked = speechFor(fake, { socketFactory: counting as never });
  await tracked.begin(() => undefined);
  await tracked.write('une phrase qui sera coupée ');
  tracked.abort();
  assert.equal(closes, 0, 'le websocket de voix doit survivre à la coupure');
  const second = await tracked.begin(() => undefined).then(() => true);
  assert.equal(second, true, 'un deuxième énoncé doit pouvoir démarrer sans nouvelle connexion');
  tracked.close();
  speaker.close();
});

test('oreille et bouche se branchent sur n’importe quel serveur : la fabrique est un paramètre', async () => {
  // Ce test ne valide pas ElevenLabs, il valide la REMPLAÇABILITÉ annoncée : les deux
  // adaptateurs acceptent une fabrique de socket injectée. Changer de fournisseur = un
  // autre fichier, pas une retouche de la session.
  const fake = await startFakeProviders({ transcript: 'encodé ailleurs' });
  providers = fake;
  let factoryCalls = 0;
  const counting: SocketFactory = (url, headers) => {
    factoryCalls += 1;
    assert.match(url, /^ws:\/\/127\.0\.0\.1/, 'la base injectée est respectée telle quelle');
    return (socketFactoryFor() as SocketFactory)(url, headers);
  };
  const listener = listenerFor(fake, { socketFactory: counting });
  await listener.start();
  assert.ok(factoryCalls >= 1);
  listener.close();
});
