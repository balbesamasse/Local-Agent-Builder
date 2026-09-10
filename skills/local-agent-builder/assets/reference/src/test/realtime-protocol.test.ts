/**
 * Tests du protocole temps réel : framing, anneaux, budget, WAV en mémoire.
 *
 * Ces primitives décident de ce que le hub accepte d'un navigateur et de ce que la session
 * envoie au fournisseur. Un cadre mal lu = audio silencieux ; un anneau qui déborde =
 * transcription qui déraille ; un WAV mal en-têtu = 400 chez le fournisseur. Aucun de ces
 * bugs ne se voit à l'œil, donc ils sont tous assertés ici.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeAudioFrame,
  parseClientFrame,
  rms16,
  muxWav,
  PcmRing,
  SpeechBudget,
  FRAME_BYTES,
  FRAME_MS,
  MAX_CONTROL_CHARS,
  MAX_FRAME_BYTES,
  INPUT_SAMPLE_RATE,
  wrapNodeWebSocket,
} from '../realtime/protocol.js';

const frame = (pcm: Uint8Array, timeMs: number): Uint8Array => {
  const out = new Uint8Array(5 + pcm.byteLength);
  out[0] = 0x42;
  new DataView(out.buffer).setUint32(1, timeMs >>> 0, true);
  out.set(pcm, 5);
  return out;
};

const tone = (samples: number, level = 0.5): Uint8Array => {
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i += 1) {
    view.setInt16(i * 2, Math.round(Math.sin(i / 6) * level * 32767), true);
  }
  return out;
};

test('un cadre audio se relit à l’identique (marqueur, horodatage, octets)', () => {
  const pcm = tone(320);
  const parsed = parseClientFrame(frame(pcm, 1234));
  assert.equal(parsed.kind, 'audio');
  if (parsed.kind !== 'audio') return;
  assert.equal(parsed.clientTimeMs, 1234);
  assert.deepEqual([...parsed.pcm], [...pcm]);
});

test('encodeAudioFrame produit le même octet de trame que parseClientFrame accepte', () => {
  const pcm = tone(160);
  const parsed = parseClientFrame(encodeAudioFrame(pcm, 40));
  assert.equal(parsed.kind, 'audio');
  if (parsed.kind !== 'audio') return;
  assert.equal(parsed.pcm.byteLength, 320);
  assert.equal(parsed.clientTimeMs, 40);
});

test('un texte JSON trop long est refusé sans être tronqué silencieusement', () => {
  const tooLong = JSON.stringify({ t: 'text', text: 'a'.repeat(MAX_CONTROL_CHARS + 10) });
  const parsed = parseClientFrame(tooLong);
  assert.equal(parsed.kind, 'invalid');
  if (parsed.kind !== 'invalid') return;
  assert.match(parsed.why, /long|taille/i);
});

test('une trame sans marqueur, trop courte ou au-dessus du plafond est invalidée', () => {
  assert.equal(parseClientFrame(new Uint8Array([0x00, 0x01, 0x02])).kind, 'invalid');
  assert.equal(parseClientFrame(new Uint8Array([0x42, 0x00])).kind, 'invalid');
  // Le plafond porte sur le PCM (le marqueur + l'horodatage sont ajoutés par le client).
  // Le plafond porte sur le PCM (marqueur + horodatage sont ajoutés par le client).
  assert.equal(parseClientFrame(new Uint8Array(5 + MAX_FRAME_BYTES + 2).fill(0x42)).kind, 'invalid');
  assert.equal(parseClientFrame(new Uint8Array(5 + MAX_FRAME_BYTES).fill(0x42)).kind, 'audio');
  // Un JSON malformé reste du TEXTE brut : c'est le hub qui décide qu'il n'est pas lisible,
  // et le protocole n'a pas à faire de parsing (un parse ici serait deux parsing).
  assert.equal(parseClientFrame('{"t":').kind, 'text');
});

test('une trame invalide dit POURQUOI (le hub doit pouvoir le dire sans lire le micro)', () => {
  const parsed = parseClientFrame(new Uint8Array([0x41, 0x00, 0x00]));
  assert.equal(parsed.kind, 'invalid');
  if (parsed.kind !== 'invalid') return;
  assert.ok(parsed.why.length > 3, parsed.why);
});

test('le PCM d’un cadre de 40 ms à 16 kHz fait exactement FRAME_BYTES', () => {
  assert.equal(FRAME_MS * INPUT_SAMPLE_RATE * 2, FRAME_BYTES * 1000);
  assert.equal(FRAME_BYTES, 1280);
});

test('rms16 distingue le silence d’une voix, sans exploser sur un plein échelle', () => {
  assert.equal(rms16(new Uint8Array(320)), 0);
  const loud = rms16(tone(1600, 0.9));
  assert.ok(loud > 0.2 && loud <= 1, `rms=${loud}`);
  const view = new DataView(new ArrayBuffer(2));
  view.setInt16(0, 32767, true);
  assert.ok(rms16(new Uint8Array(view.buffer)) <= 1);
});

test('PcmRing perd le plus vieux et non le plus récent (le pré-roll doit rester intact)', () => {
  const ring = new PcmRing(8);
  ring.push(new Uint8Array([1, 2, 3, 4]));
  ring.push(new Uint8Array([5, 6, 7, 8]));
  assert.deepEqual([...ring.bytes()], [1, 2, 3, 4, 5, 6, 7, 8]);
  ring.push(new Uint8Array([9, 10]));
  assert.deepEqual([...ring.bytes()], [3, 4, 5, 6, 7, 8, 9, 10]);
  // Repli sur la fin du tampon (écriture qui franchit la fin circulaire) :
  ring.push(new Uint8Array([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
  assert.equal(ring.size, 8);
  assert.deepEqual([...ring.bytes()], [13, 14, 15, 16, 17, 18, 19, 20]);
  ring.clear();
  assert.equal(ring.size, 0);
});

test('muxWav écrit un en-tête que le fournisseur lit (taille = 44 + PCM, riff/wave aux bonnes cases)', () => {
  const pcm = tone(160);
  const wav = muxWav(pcm, INPUT_SAMPLE_RATE);
  const text = Buffer.from(wav).toString('latin1');
  assert.equal(text.slice(0, 4), 'RIFF');
  assert.equal(text.slice(8, 12), 'WAVE');
  assert.equal(wav.byteLength, pcm.byteLength + 44);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(view.getUint32(4, true), wav.byteLength - 8);
  assert.equal(view.getUint32(40, true), pcm.byteLength);
  assert.equal(view.getUint32(24, true), INPUT_SAMPLE_RATE);
  assert.equal(view.getUint16(34, true), 16);
});

test('SpeechBudget refuse au-delà du plafond et ne dépasse jamais', () => {
  const budget = new SpeechBudget(10);
  assert.equal(budget.take(6), true);
  assert.equal(budget.remaining, 4);
  assert.equal(budget.take(5), false);
  assert.equal(budget.spent, 6);
  assert.equal(budget.take(4), true);
  assert.equal(budget.remaining, 0);
});

test('wrapNodeWebSocket ne garde que les quatre événements utilisés', () => {
  const seen: string[] = [];
  const fake = {
    readyState: 1,
    send: (data: string) => seen.push(`send:${data}`),
    close: () => seen.push('close'),
    on: (event: string, handler: (...args: never[]) => void) => {
      seen.push(`on:${event}`);
      if (event === 'message') handler('{"ok":true}' as never);
    },
  };
  const socket = wrapNodeWebSocket(fake as unknown as Parameters<typeof wrapNodeWebSocket>[0]);
  assert.equal(socket.readyState, 1);
  socket.on('message', (arg) => seen.push(`msg:${String(arg)}`));
  socket.send('x');
  socket.close();
  assert.deepEqual(seen, ['on:message', 'msg:{"ok":true}', 'send:x', 'close']);
});
