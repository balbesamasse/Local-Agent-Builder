import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { clampForSpeech, stripForSpeech, buildSynthesizer, ElevenLabsTts, TELEGRAM_VOICE_FORMAT } from '../audio/synthesize.js';
import { AudioError } from '../audio/types.js';
import { makeTestConfig } from '../testing/fixtures.js';

test('stripForSpeech : le balisage et les pictogrammes ne se dictent pas', () => {
  assert.equal(stripForSpeech('Tu as <b>deux</b> rendez-vous 🎯'), 'Tu as deux rendez-vous');
  assert.equal(stripForSpeech('<i>demain</i> à <code>17:00</code>'), 'demain à 17:00');
  assert.equal(
    stripForSpeech('<a href="https://x.example">le lien</a>'),
    'le lien',
    'une URL ne se lit pas : on garde l’intitulé',
  );
  assert.equal(stripForSpeech('1 &lt; 2 &amp;&quot;3&quot;'), '1 < 2 &"3"');
  assert.equal(stripForSpeech('```js\nconst a = 1;\n```'), '(bloc de code omis)', 'un bloc de code n’est pas parlable');
  assert.equal(stripForSpeech('   '), '', 'rien → chaîne vide, et le politique refuse de parler');
});

test('clampForSpeech : on coupe sur une fin de phrase, jamais au milieu d’un mot', () => {
  const text = 'Première phrase utile. Deuxième phrase utile. Troisième phrase beaucoup plus longue qui ne passera pas.';
  const clamped = clampForSpeech(text, 60);
  assert.ok(clamped.truncated);
  // La fenêtre de 60 caractères contient deux fins de phrase : on rend les deux
  // phrases complètes, et on ne rend PAS la troisième à moitié.
  assert.equal(clamped.text, 'Première phrase utile. Deuxième phrase utile.', `coupure attendue sur un point : ${clamped.text}`);
  assert.ok(clamped.text.length <= 60);
  assert.ok(!clamped.text.includes('Troisième'), 'une phrase entamée ne doit pas être à moitié prononcée');

  const short = clampForSpeech('Bonjour.', 45);
  assert.deepEqual(short, { text: 'Bonjour.', truncated: false });

  // Sans ponctuation dans la fenêtre, on coupe net avec une ellipse plutôt que de
  // renvoyer un texte plus long que le budget.
  const noSentences = clampForSpeech('a'.repeat(300), 40);
  assert.ok(noSentences.truncated);
  assert.equal(noSentences.text.length, 40, 'la fenêtre complète, ellipse déduite');
  assert.ok(noSentences.text.length <= 40, 'le budget ne se discute pas : il est dur');
});

test('ElevenLabsTts : requête, format Telegram, et budget appliqué', async () => {
  const seen: Array<{ headers: Record<string, string | string[] | undefined>; body: string; url: string }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
        url: req.url ?? '',
      });
      res.writeHead(200, { 'content-type': 'audio/ogg' });
      res.end(Buffer.from('opus-bytes'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  try {
    const tts = new ElevenLabsTts({
      apiKey: 'sk_test',
      baseUrl: base,
      voiceId: 'voiceid0123456789abcd',
      modelId: 'eleven_flash_v2_5',
      stability: 0.5,
      similarityBoost: 0.75,
      maxChars: 60,
      timeoutMs: 5000,
    });
    const speech = await tts.synthesize('<b>Bonjour</b> le monde, ceci est une réponse volontairement longue pour vérifier la coupure.');

    assert.equal(speech.bytes.byteLength, 'opus-bytes'.length);
    assert.equal(speech.mime, 'audio/ogg');
    assert.equal(speech.fileName, 'reponse.ogg');
    assert.equal(speech.truncated, true, 'le drapeau doit dire qu’on n’a pas tout dit');

    const call = seen[0]!;
    assert.ok(call.url.startsWith('/v1/text-to-speech/voiceid0123456789abcd'), call.url);
    assert.ok(call.url.includes(`output_format=${TELEGRAM_VOICE_FORMAT}`), 'Telegram exige de l’Opus pour un vocal');
    assert.equal(call.headers['xi-api-key'], 'sk_test');
    assert.ok(call.headers.authorization === undefined, 'ElevenLabs n’utilise pas un Bearer');
    const body = JSON.parse(call.body) as { text: string; model_id: string; voice_settings: Record<string, number> };
    assert.equal(body.model_id, 'eleven_flash_v2_5');
    assert.ok(!/<b>/.test(body.text), 'rien de balisé ne part au synthétiseur');
    assert.ok(body.text.length <= 60, `budget dépassé : ${body.text.length}`);
    assert.deepEqual(body.voice_settings, { stability: 0.5, similarity_boost: 0.75 });
  } finally {
    server.close();
  }
});

test('un voice_id douteux est refusé avant de toucher l’URL', () => {
  const base = {
    apiKey: 'sk',
    baseUrl: 'http://127.0.0.1:1/v1',
    modelId: 'm',
    stability: 0.5,
    similarityBoost: 0.5,
    maxChars: 500,
    timeoutMs: 1000,
  };
  for (const bad of ['../../etc/passwd', 'voice id with spaces', 'short', 'x'.repeat(200), '']) {
    assert.throws(
      () => new ElevenLabsTts({ ...base, voiceId: bad }),
      (error: unknown) => error instanceof AudioError && /ELEVENLABS_VOICE_ID refusé/.test(error.message),
      `refus attendu pour ${JSON.stringify(bad.slice(0, 18))}`,
    );
  }
  assert.ok(new ElevenLabsTts({ ...base, voiceId: 'a'.repeat(10) }), 'la forme attendue est acceptée');
});

test('401 est définitif, 429 est transitoire — et le corps de la réponse reste hors du message', async () => {
  for (const [status, expectRetryable] of [[401, false], [429, true], [503, true]] as const) {
    const server: Server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: { status: 'Invalid API key sk_doit_rester_hors_du_message' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    try {
      const tts = new ElevenLabsTts({
        apiKey: 'sk',
        baseUrl: base,
        voiceId: 'voiceid0123456789abcd',
        modelId: 'm',
        stability: 0.5,
        similarityBoost: 0.5,
        maxChars: 500,
        timeoutMs: 3000,
      });
      await assert.rejects(
        () => tts.synthesize('bonjour'),
        (error: unknown) => {
          assert.ok(error instanceof AudioError);
          assert.equal(error.retryable, expectRetryable, `statut ${status}`);
          assert.ok(!error.message.includes('sk_doit_rester'), 'le corps de l’erreur ne se propage pas');
          assert.match(error.message, new RegExp(String(status)));
          return true;
        },
      );
    } finally {
      server.close();
    }
  }
});

test('buildSynthesizer : off, ou sans clé, ou sans voix ⇒ null, jamais un objet cassé', () => {
  const base = {
    elevenLabsApiKey: 'sk',
    elevenLabsBaseUrl: 'http://127.0.0.1:1/v1',
    elevenLabsVoiceId: 'voiceid0123456789abcd',
    elevenLabsTtsModel: 'm',
    elevenLabsStability: 0.5,
    elevenLabsSimilarity: 0.75,
    ttsMaxChars: 1200,
    llmTimeoutMs: 5000,
    voiceMode: 'mirror',
  };
  assert.ok(buildSynthesizer(base), 'clé + voix + mode actif ⇒ synthétiseur');
  assert.equal(buildSynthesizer({ ...base, voiceMode: 'off' }), null, 'mode off court-circuite tout');
  assert.equal(buildSynthesizer({ ...base, elevenLabsApiKey: '' }), null, 'sans clé, pas de voix');
  assert.equal(buildSynthesizer({ ...base, elevenLabsVoiceId: '' }), null, 'sans voix, pas de voix');
});

test('la config de test n’active aucune voix par accident', () => {
  const config = makeTestConfig();
  assert.equal(config.voiceMode, 'mirror');
  assert.equal(config.elevenLabsApiKey, '');
  assert.equal(config.mediaMaxBytes, 8388608);
});
