/**
 * Tests du détecteur de parole. Le VAD est la SEULE autorité qui décide qu'un tour est fini
 * (le fournisseur de transcription tourne en `commit_strategy=manual`) : s'il se trompe,
 * l'agent coupe la phrase de l'utilisateur ou met trois secondes à répondre. Ces seuils sont
 * donc testés comme du code de production, pas comme un réglage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceVad } from '../realtime/vad.js';
import { FRAME_BYTES } from '../realtime/protocol.js';

/** Un cadre de 40 ms, au niveau RMS demandé (0 = silence, 1 = saturation). */
const frame = (level: number, samples = FRAME_BYTES / 2): Uint8Array => {
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i += 1) {
    // Sinus à amplitude `level` : RMS = level/√2, ce qui place 0.02 au seuil par défaut.
    view.setInt16(i * 2, Math.round(Math.sin(i / 5) * level * 32767), true);
  }
  return out;
};

// Sous 0.05 : le seuil de parole (0.014) l'accepte, celui du barge-in (0.05) le refuse.
const ECHO = 0.03;
const VOICED = 0.08; // RMS ≈ 0.056 : passe aussi la porte « l'agent parle »
const QUIET = 0.0;

/** Pousse `n` cadres et renvoie la liste des événements, dans l'ordre. */
function feed(vad: UtteranceVad, n: number, level: number, agentSpeaking = false): string[] {
  const events: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const event = vad.push(frame(level), agentSpeaking);
    if (event !== null) events.push(event.type);
  }
  return events;
}

test('la parole continue ouvre un énoncé, le silence le clôture', () => {
  const vad = new UtteranceVad({});
  const opening = feed(vad, 6, VOICED);
  assert.deepEqual(opening, ['speech-start'], 'speechMinMs=160 → 4 cadres');
  const events = feed(vad, 14, QUIET);
  assert.deepEqual(events, ['speech-end']);
});

test('un bruit de deux cadres ne déclenche rien (seuil de montée de 160 ms)', () => {
  const vad = new UtteranceVad({});
  assert.equal(vad.push(frame(VOICED), false), null);
  assert.equal(vad.push(frame(VOICED), false), null);
  assert.equal(vad.push(frame(VOICED), false), null);
  assert.equal(vad.push(frame(QUIET), false), null);
});

test('une phrase hachée par un silence court n’est pas clôturée', () => {
  const vad = new UtteranceVad({});
  feed(vad, 8, VOICED);
  // 6 cadres de silence = 240 ms < silenceMs (450 ms).
  assert.deepEqual(feed(vad, 6, QUIET), []);
  const after = feed(vad, 12, VOICED);
  assert.deepEqual(after, [], "l'agent ne doit pas répondre deux fois sur la même phrase");
});

test('l’interruption de l’agent passe par le seuil haut, pas par le seuil de parole', () => {
  const vad = new UtteranceVad({});
  // Pendant que l'agent parle, un écho de la table ne doit PAS couper.
  assert.deepEqual(feed(vad, 10, ECHO, true), [], 'lécho du haut-parleur nest pas une interruption');
  // Une vraie voix dessus coupe.
  assert.deepEqual(feed(vad, 4, VOICED, true), ['interrupt']);
});

test('après l’interruption, le VAD ne rouvre pas de tour tant que l’agent n’a pas été coupé', () => {
  const vad = new UtteranceVad({});
  assert.deepEqual(feed(vad, 3, VOICED, true), []);
  assert.deepEqual(feed(vad, 1, VOICED, true), ['interrupt']);
  // Les cadres suivants restent dans le tampon (la phrase continue) et ne redéclenchent rien :
  // sinon l'agent se couperait deux fois et perdrait le début de la nouvelle question.
  assert.deepEqual(feed(vad, 10, VOICED, true), []);
});

test('un énoncé tronqué par le plafond de durée est signalé, rien n’est envoyé au cerveau', () => {
  // Ce qui est parti au cerveau se décide sur la DUREE TOTALE de l'enonce ouvert (parole +
  // silences internes), pas sur la seule voix : un « euh » au milieu ne hache pas la phrase.
  // maxUtteranceMs < minUtteranceMs est le seul chemin qui produit un `tooShort` — il existe
  // (un micro colle a une enceinte, un utilisateur monopolise) et il ne doit rien facturer.
  const vad = new UtteranceVad({ speechMinMs: 120, minUtteranceMs: 360, maxUtteranceMs: 120 });
  const events: string[] = [];
  let payload: Uint8Array | null = null;
  for (let i = 0; i < 8; i += 1) {
    const event = vad.push(frame(VOICED), false);
    if (event === null) continue;
    events.push(event.type);
    if (event.type === 'speech-end') {
      payload = event.pcm;
      assert.equal(event.tooShort, true);
    }
  }
  assert.deepEqual(events, ['speech-start', 'speech-end'], events.join(','));
  assert.equal(payload?.byteLength, 0, 'trop court = RIEN n’est transcrit, pas un tronçon');
});

test('un énoncé complet est rendu entier (le trop-court ne mange pas la parole normale)', () => {
  const vad = new UtteranceVad({ speechMinMs: 120, silenceMs: 240 });
  const events: string[] = [];
  let bytes = 0;
  for (let i = 0; i < 6; i += 1) {
    const event = vad.push(frame(VOICED), false);
    if (event !== null) events.push(event.type);
  }
  for (let i = 0; i < 8; i += 1) {
    const event = vad.push(frame(QUIET), false);
    if (event === null) continue;
    events.push(event.type);
    if (event.type === 'speech-end') {
      assert.equal(event.tooShort, false);
      bytes = event.pcm.byteLength;
    }
  }
  assert.deepEqual(events, ['speech-start', 'speech-end'], events.join(','));
  // 4 cadres d'amorce conservés + 6 de parole + le silence qui a déclenché la clôture :
  // tout est rendu, rien n'est rogné — c'est ce qui évite « y...ut » au lieu de « tout ».
  assert.equal(bytes, 12 * 1280, 'l’amorce est rendue avec l’énoncé, pas rognée');
});

test('une parole CONTINUE est quand même clôturée par maxUtteranceMs', () => {
  // Le défaut que ce test a trouvé : la garde de durée n'était évaluée QUE dans la branche
  // « silence ». Une salve de 30 secondes ne se clôturait donc jamais — le cas exact à protéger.
  const vad = new UtteranceVad({ maxUtteranceMs: 240, minUtteranceMs: 80 });
  const events: string[] = [];
  let bytes = -1;
  for (let i = 0; i < 12; i += 1) {
    const event = vad.push(frame(VOICED), false);
    if (event === null) continue;
    events.push(event.type);
    if (event.type === 'speech-end') {
      assert.equal(event.seconds, 0.24, 'la durée rendue est le plafond, pas une accumulation');
      bytes = event.pcm.byteLength;
    }
  }
  assert.deepEqual(events, ['speech-start', 'speech-end'], events.join(','));
  assert.equal(bytes, 10 * 1280, 'les 4 cadres d’amorce ne sont pas perdus par la clôture forcée');
});

test('après une interruption, reset(false) vide l’amorce : l’écho de l’agent ne devient pas une phrase', () => {
  const blip = (vad: UtteranceVad): void => {
    for (let i = 0; i < 2; i += 1) vad.push(frame(VOICED), false);
  };
  const run = (keep: boolean): number => {
    const vad = new UtteranceVad({ speechMinMs: 120, minUtteranceMs: 120 });
    blip(vad);
    vad.reset(keep);
    for (let i = 0; i < 6; i += 1) vad.push(frame(VOICED), false);
    const flushed = vad.flush();
    return flushed === null ? 0 : flushed.pcm.byteLength;
  };
  const kept = run(true);
  const dropped = run(false);
  assert.ok(kept > dropped, `kept=${kept} dropped=${dropped}`);
  assert.ok(dropped > 0, 'sans amorce, la phrase reste entière : on ne perd QUE lécho');
});

test('un reset ferme l’énoncé en cours : la sourdine ne doit pas rendre un tour périmé', () => {
  // `setMuted(true)` appelle reset(false). Si l'énoncé restait « ouvert », le flush de fin
  // d'appel transcrirait une phrase antérieure au mute — une réponse à une question retirée.
  const vad = new UtteranceVad({});
  for (let i = 0; i < 8; i += 1) vad.push(frame(VOICED), false);
  assert.equal(vad.speaking, true);
  vad.reset(false);
  assert.equal(vad.speaking, false);
  assert.equal(vad.flush(), null);
});
