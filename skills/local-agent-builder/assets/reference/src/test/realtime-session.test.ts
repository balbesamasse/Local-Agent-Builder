/**
 * Tests de la session temps réel : la machine à états qui tient l'appel.
 *
 * Le harnais (src/testing/realtime-harness.ts) remplace FOURNISSEURS et websocket, pas la
 * session : le VAD, la file de tours, le budget, le barge-in et la clôture sont les vrais
 * objets de production. Ces tests sont donc ce qui prouve que l'appel « ne casse pas » —
 * ce qu'aucun test unitaire de protocole ne peut montrer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  audioBytes,
  frame,
  makeSessionHarness,
  makeSpeaker,
  until,
  utteranceFrames,
} from '../testing/realtime-harness.js';

test('un tour de parole : cerveau appelé UNE fois, réponse écrite en mémoire', async () => {
  const h = makeSessionHarness({ reply: 'Il est dix-huit heures.' });
  await h.session.start();
  h.listener.speak();
  await until(() => h.recorded.states.includes('listening') && h.recorded.captions.some((c) => c.role === 'out'));

  const agent = h.recorded.captions.find((c) => c.role === 'out');
  assert.equal(agent?.text, 'Il est dix-huit heures.');

  const history = h.store.recentMessages(10, 10);
  assert.deepEqual(
    history.map((m) => `${m.role}:${m.content}`),
    ['user:il est quelle heure exactement', 'assistant:Il est dix-huit heures.'],
    "le tour d'appel entre dans la mémoire, comme un message écrit",
  );
  await h.session.end('test');
});

test('la voix descend en PCM 24 kHz vers le client, et le tour est compté parlé', async () => {
  const h = makeSessionHarness({ reply: 'Bonjour.' });
  await h.session.start();
  h.listener.speak();
  await until(() => h.recorded.audio.length > 0);
  assert.ok(audioBytes(h.recorded) > 0, 'des octets de voix doivent partir au client');
  for (const chunk of h.recorded.audio) assert.equal(chunk.sampleRate, 24_000);

  const summary = h.session.summary();
  assert.equal(summary.turns, 1);
  assert.equal(summary.speechChars > 0, true);
  await h.session.end('test');
  assert.equal(h.session.summary().spokenTurns, 1);
});

test('le canal « appel » change la consigne de l’agent (phrases courtes, pas de markdown)', async () => {
  const h = makeSessionHarness({ reply: 'ok.' });
  await h.session.start();
  h.listener.speak();
  await until(() => h.recorded.captions.some((c) => c.role === 'out'));
  const system = String(h.llm.requests[0]?.messages[0]?.content ?? '');
  assert.match(system, /À L’ORAL|à l’oral/, 'le prompt système doit dire que la sortie sera parlée');
  assert.match(system, /Aucun titre, aucune liste|aucun markdown/i);
  await h.session.end('test');
});

test('barge-in : la voix est coupée, le client est prévenu, l’appel survit', async () => {
  const h = makeSessionHarness({ reply: 'Une réponse assez longue pour être interrompue en route.' });
  await h.session.start();
  // La voix reste OUVERTE dès que le tour est lancé : sans ça, le tour se termine en trois
  // microtâches et on mesurerait une interruption après la fin de la phrase.
  h.speaker.holdEnd = true;
  h.listener.speak();
  await until(() => h.listener.states.agentSpeaking.includes(true));

  // Le seuil de barge-in (et le fait que l'écho du haut-parleur ne le franchit pas) est testé
  // dans realtime-vad.test.ts. Ce qu'on vérifie ici, c'est la RÉACTION de la session à
  // l'événement — coupure de la voix, annonce au client, appel qui survit.
  h.listener.emit({ type: 'interrupt' });
  // La file de la session est SÉRIELLE : le tour en cours doit finir de se dépiler avant que
  // la coupure soit traitée. On libère donc la voix juste après avoir demandé la coupure.
  h.speaker.releaseEnd();
  h.speaker.holdEnd = false;
  await until(() => h.speaker.counts.aborts > 0);
  await until(() => h.recorded.states.filter((s) => s === 'listening').length >= 2);

  assert.ok(h.recorded.notes.includes('speech-end'), "la fin d'énoncé doit être annoncée au client");
  assert.ok(
    h.recorded.textPayloads.some((p) => (p as { t?: string }).t === 'interrupt'),
    'le client doit couper sa file de lecture, sinon l’agent parlerait dans le vide',
  );
  assert.equal(h.listener.states.agentSpeaking.at(-1), false, 'oreille rouverte : sinon plus personne n’écoute');
  assert.equal(h.session.summary().interruptedTurns, 1);
  assert.equal(h.session.active, true, 'une interruption ne clôt pas un appel');
  await h.session.end('test');
});

test('sourdine : le VAD ne juge plus, et l’état du client suit', async () => {
  const h = makeSessionHarness({ reply: 'ok.' });
  await h.session.start();
  h.session.onControl({ t: 'mute', muted: true });
  assert.deepEqual(h.listener.states.muted, [true]);
  assert.ok(h.recorded.states.includes('muted'));
  h.listener.speak();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.session.summary().turns, 0, 'muet = rien ne doit être transcrit ni facturé');
  h.session.onControl({ t: 'mute', muted: false });
  assert.ok(h.recorded.states.includes('listening'));
  await h.session.end('test');
});

test('sans adaptateur de voix, la réponse est ÉCRITE au chat (jamais perdue)', async () => {
  const h = makeSessionHarness({ reply: 'Réponse sans voix.', speaker: null });
  await h.session.start();
  h.listener.speak();
  await until(() => h.chatTexts.length > 0);
  assert.deepEqual(h.chatTexts, ['Réponse sans voix.']);
  assert.equal(audioBytes(h.recorded), 0);
  assert.match(h.recorded.notes.join('\n'), /Voix indisponible/);
  await h.session.end('test');
});

test('voix qui échoue en cours de route : la réponse part à l’écrit, l’appel continue', async () => {
  const h = makeSessionHarness({ reply: 'À écrire.', speaker: makeSpeaker({ failOnEnd: true }) });
  await h.session.start();
  h.listener.speak();
  await until(() => h.chatTexts.length > 0);
  assert.deepEqual(h.chatTexts, ['À écrire.']);
  assert.equal(h.session.active, true);
  await h.session.end('test');
});

test('plafond de tours : l’appel se clôt de lui-même, avec le motif', async () => {
  const h = makeSessionHarness({ reply: 'ok.', limits: { maxTurns: 2 } });
  await h.session.start();
  for (let i = 0; i < 4; i += 1) {
    h.listener.speak();
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  await until(() => !h.session.active, 3000);
  assert.match(h.session.summary().endReason, /échanges/);
  assert.equal(h.session.summary().turns, 2);
});

test('durée maximale : le premier tour qui déborde clôture l’appel', async () => {
  const h = makeSessionHarness({ reply: 'ok.', limits: { maxMinutes: 0 } });
  await h.session.start();
  h.listener.speak();
  await until(() => !h.session.active, 3000);
  assert.match(h.session.summary().endReason, /durée maximale/);
});

test('clôture propre : oreille et voix fermées UNE fois, état ended, client prévenu', async () => {
  const h = makeSessionHarness({ reply: 'ok.' });
  await h.session.start();
  h.listener.speak();
  await until(() => h.recorded.audio.length > 0);
  await h.session.end('raccroché depuis Telegram');
  await h.session.end('deuxième fois');

  assert.equal(h.listener.counts.closes, 1, 'une double fermeture serait un double facturage de session');
  assert.equal(h.speaker.counts.closes, 1);
  assert.ok(h.recorded.states.includes('ended'));
  assert.deepEqual(h.recorded.closed, ['raccroché depuis Telegram', 'client:raccroché depuis Telegram']);
  assert.equal(h.session.active, false);
});

test('un énoncé en cours est rendu à la clôture : rien ne se perd silencieusement', async () => {
  const h = makeSessionHarness({ reply: 'ok.' });
  await h.session.start();
  // Seulement 8 cadres : l'énoncé est ouvert, jamais clôturé par un silence.
  h.listener.speak(Array.from({ length: 8 }, () => frame(0.08)));
  assert.equal(h.session.summary().turns, 0);
  await h.session.end('fin');
  assert.equal(h.listener.counts.flushes, 1, 'la session doit demander le morceau en cours');
});

test('le texte tapé depuis la page vaut un tour de parole', async () => {
  const h = makeSessionHarness({ reply: 'Écrit depuis la page.' });
  await h.session.start();
  h.session.onControl({ t: 'text', text: 'une question écrite' });
  await until(() => h.recorded.captions.some((c) => c.role === 'out'));
  assert.equal(h.session.summary().turns, 1);
  const history = h.store.recentMessages(10, 4);
  assert.equal(history[0]?.content, 'une question écrite');
  assert.equal(history[0]?.channel, 'call', 'le canal doit rester attaché à la ligne');
  await h.session.end('test');
});

test('un contrôle invalide est ignoré, pas fatal', async () => {
  const h = makeSessionHarness({ reply: 'ok.' });
  await h.session.start();
  h.session.onControl({ t: 'inconnu' });
  h.session.onControl({ t: 'text', text: '   ' });
  h.session.onControl({ t: 'ready' });
  await new Promise((resolve) => setTimeout(resolve, 6));
  assert.equal(h.session.active, true);
  assert.equal(h.session.summary().turns, 0);
  await h.session.end('test');
});

test('le budget de voix par tour borne ce qui est SYNTHÉTISÉ (et le reste est écrit)', async () => {
  const long = `${'x'.repeat(500)}. Et une deuxième phrase, plus longue encore.`;
  const h = makeSessionHarness({ reply: long, limits: { maxSpeechCharsPerTurn: 40 } });
  await h.session.start();
  h.listener.speak();
  await until(() => h.speaker.written.length > 0);
  const spoken = h.speaker.written.join('');
  assert.ok(spoken.length <= 40, `parlé=${spoken.length} — la facture du fournisseur se calcule ici`);
  assert.match(spoken, /…$/, 'une coupure doit être marquée, pas laissée en pleine syllabe');
  await until(() => h.chatTexts.length > 0);
  assert.equal(h.chatTexts[0]?.length, long.length, 'ce qui n’a pas pu être dit est écrit, pas perdu');
  await h.session.end('test');
});

test('une réponse qui tient dans le budget ne part pas au chat', async () => {
  const h = makeSessionHarness({ reply: 'Court.', limits: { maxSpeechCharsPerTurn: 40 } });
  await h.session.start();
  h.listener.speak();
  await until(() => h.speaker.written.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(h.chatTexts, [], 'pas de doublon écrit quand tout a été dit');
  await h.session.end('test');
});

test('la salutation est parlée une fois, sans consommer un tour', async () => {
  const h = makeSessionHarness({ reply: 'ok.', greeting: 'Je t’écoute.' });
  await h.session.start();
  assert.equal(h.speaker.counts.begins, 1);
  assert.equal(h.session.summary().turns, 0);
  assert.deepEqual(h.speaker.written, ['Je t’écoute.']);
  await h.session.end('test');
});

test('deux énoncés rapprochés sont traités dans l’ordre, jamais en parallèle', async () => {
  const h = makeSessionHarness({ reply: 'ok.' });
  await h.session.start();
  const frames = utteranceFrames();
  h.listener.speak(frames);
  h.listener.speak(frames);
  await until(() => h.session.summary().turns >= 2, 3000);
  assert.equal(h.session.summary().turns, 2);
  const spoken = h.recorded.captions.filter((c) => c.role === 'out');
  assert.equal(spoken.length, 2);
  await h.session.end('test');
});
