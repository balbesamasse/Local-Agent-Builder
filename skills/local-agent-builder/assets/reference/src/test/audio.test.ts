import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildTranscriber, GroqWhisper, ElevenLabsScribe, TranscriberChain, resolveAudioPart } from '../audio/transcribe.js';
import { AudioError } from '../audio/types.js';
import { makeTestConfig } from '../testing/fixtures.js';
import { checkVoiceAvailability, extractItems } from '../audio/eleven-check.js';
import {
  isSafeTelegramPath,
  mimeFromFileName,
  downloadTelegramFile,
  TelegramFileError,
  describeTelegramPathIssue,
  telegramPathIssue,
} from '../channels/telegram/files.js';
import { shouldSpeak, parseVoiceMode, asksForVoice, refusesVoice } from '../audio/policy.js';

/** Faux fournisseur : renvoie la transcription, ou un statut d'erreur. */
async function fakeAudioEndpoint(handler: (req: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: Buffer }) => { status: number; json?: unknown; raw?: Buffer; contentType?: string }): Promise<{ url: string; calls: unknown[]; close: () => void }> {
  const calls: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({ method: req.method, url: req.url, headers: req.headers, bytes: body.length });
      const out = handler({ method: req.method ?? '', url: req.url ?? '', headers: req.headers as Record<string, string | string[] | undefined>, body });
      res.writeHead(out.status, { 'content-type': out.contentType ?? 'application/json' });
      res.end(out.raw ?? JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls, close: () => server.close() };
}

const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]); // en-tête OGG faux

test('Groq Whisper : multipart, clé en en-tête, texte extrait', async () => {
  const fake = await fakeAudioEndpoint(() => ({ status: 200, json: { text: '  rappelle-moi l’heure  ', language: 'fr' } }));
  try {
    const t = new GroqWhisper({ baseUrl: fake.url, apiKey: 'gsk_fake', model: 'whisper-large-v3', timeoutMs: 5000 });
    const r = await t.transcribe({ bytes: AUDIO, mime: 'audio/ogg', fileName: 'v.ogg', languageHint: 'fr' });
    assert.equal(r.text, 'rappelle-moi l’heure', 'la transcription est bornée-trimée');
    assert.equal(r.provider, 'groq-whisper');
    assert.equal(r.language, 'fr');
    const call = fake.calls[0] as { headers: Record<string, unknown>; bytes: number; url: string };
    assert.equal((call.headers as Record<string, string>).authorization, 'Bearer gsk_fake');
    assert.ok(call.bytes > AUDIO.byteLength, 'le corps contient le multipart (fichier + champs)');
    assert.equal(call.url, '/v1/audio/transcriptions');
  } finally {
    fake.close();
  }
});

test('ElevenLabs Scribe : en-tête xi-api-key et model_id', async () => {
  const fake = await fakeAudioEndpoint(() => ({ status: 200, json: { text: 'bonjour', language_code: 'fra', audio_duration_secs: 3 } }));
  try {
    const t = new ElevenLabsScribe({ baseUrl: fake.url, apiKey: 'sk_fake', model: 'scribe_v1', timeoutMs: 5000 });
    const r = await t.transcribe({ bytes: AUDIO, mime: 'audio/ogg', fileName: 'v.ogg' });
    assert.equal(r.text, 'bonjour');
    assert.equal(r.durationSec, 3);
    const call = fake.calls[0] as { headers: Record<string, string> };
    assert.equal(call.headers['xi-api-key'], 'sk_fake', 'ElevenLabs ne prend pas un Bearer');
  } finally {
    fake.close();
  }
});

test('chaîne : bascule sur erreur transitoire seulement', async () => {
  let groqStatus = 429;
  const groq = await fakeAudioEndpoint(() => ({ status: groqStatus, json: { text: 'devrait être ignoré' } }));
  const el = await fakeAudioEndpoint(() => ({ status: 200, json: { text: 'secours' } }));
  try {
    const chain = new TranscriberChain([
      new GroqWhisper({ baseUrl: groq.url, apiKey: 'k', model: 'w', timeoutMs: 5000 }),
      new ElevenLabsScribe({ baseUrl: el.url, apiKey: 'k', model: 's', timeoutMs: 5000 }),
    ]);
    const r = await chain.transcribe({ bytes: AUDIO, mime: 'audio/ogg', fileName: 'v.ogg' });
    assert.equal(r.text, 'secours', 'un 429 fait passer au fournisseur suivant');
    assert.deepEqual(chain.tried, ['groq-whisper', 'elevenlabs-scribe']);

    groqStatus = 401; // clé refusée : ce n'est pas transitoire, changer de fournisseur le cacherait
    await assert.rejects(
      () => chain.transcribe({ bytes: AUDIO, mime: 'audio/ogg', fileName: 'v.ogg' }),
      (error: unknown) => error instanceof AudioError && !error.retryable && error.status === 401,
    );
  } finally {
    groq.close();
    el.close();
  }
});

test('buildTranscriber : une clé absente retire le fournisseur, sans inventer de chaîne vide', () => {
  const base = {
    groqApiKey: '',
    groqBaseUrl: 'http://127.0.0.1:1/v1',
    whisperModel: 'whisper-large-v3',
    elevenLabsApiKey: '',
    elevenLabsBaseUrl: 'http://127.0.0.1:1/v1',
    elevenLabsSttModel: 'scribe_v1',
    transcriptionOrder: 'groq,elevenlabs',
    llmTimeoutMs: 5000,
  };
  assert.equal(buildTranscriber(base), null, 'aucune clé → pas de transcription, et pas d’objet cassé');
  const only = buildTranscriber({ ...base, elevenLabsApiKey: 'sk' });
  assert.ok(only !== null && only.tried.length === 0);
  const ordered = buildTranscriber({ ...base, groqApiKey: 'g', elevenLabsApiKey: 's', transcriptionOrder: 'elevenlabs' });
  assert.ok(ordered !== null, 'l’ordre demandé est respecté');
});

test('chemin de fichier Telegram : les sorties de racine sont refusées, les formes réelles acceptées', () => {
  // Formes réellement renvoyées par le serveur de fichiers — la garde ne doit pas
  // dépendre de l'une d'elles (c'est exactement ce qui a cassé un vocal utilisateur).
  for (const real of [
    'files/file_123.ogg',
    'files/document_1.pdf',
    'files/voice_file_1',
    'files/AgentAudioFile/audio_record_2026-09-02_19-32-00_1.ogg',
    'files/voice_file_2026-09-02_19:32:00_1.ogg',
    // Formes vues sur le réseau uniquement. Une liste blanche *de formes* est ce qui a
    // cassé le premier vocal réel : ce que la garde promet ici, c'est que toute SORTIE
    // de racine est refusée, pas que tout ce qui existe est accepté. Si un nom jamais
    // vu était refusé, le journal nommerait le caractère fautif et l'humain déciderait.
  ]) {
    assert.ok(isSafeTelegramPath(real), `forme réelle refusée à tort : ${real}`);
  }
  for (const evil of [
    '../../../../etc/passwd',
    '/etc/passwd',
    'files/../../secret',
    'files\\..\\windows\\system32',
    'https://evil.example/files/a.ogg',
    'files/../../x\n/../y',
    '',
    'files/'.concat('a'.repeat(200)),
  ]) {
    assert.equal(isSafeTelegramPath(evil), false, `refus attendu : ${JSON.stringify(evil.slice(0, 30))}`);
  }
});

test('téléchargement : plafond appliqué même si content-length ment', async () => {
  const fake = await fakeAudioEndpoint(() => ({
    status: 200,
    raw: Buffer.alloc(4096, 0x41),
    contentType: 'audio/ogg',
  }));
  // Le serveur ne déclare pas de content-length : le plafond doit tenir à la lecture.
  try {
    const url = new URL(fake.url);
    const ok = await downloadTelegramFile({
      apiRoot: `${url.protocol}//${url.host}`,
      botToken: '1:toto',
      filePath: 'files/file_1.ogg',
      maxBytes: 8192,
      timeoutMs: 5000,
    });
    assert.equal(ok.size, 4096);
    assert.equal(ok.mime, 'audio/ogg');
    assert.equal(ok.fileName, 'file_1.ogg');

    await assert.rejects(
      () =>
        downloadTelegramFile({
          apiRoot: `${url.protocol}//${url.host}`,
          botToken: '1:toto',
          filePath: 'files/file_1.ogg',
          maxBytes: 1024,
          timeoutMs: 5000,
        }),
      (error: unknown) => error instanceof TelegramFileError && /plafond/.test(error.message),
    );
  } finally {
    fake.close();
  }
});

test('le token du bot ne transite dans aucun message d’erreur', async () => {
  const fake = await fakeAudioEndpoint(() => ({ status: 404, json: { description: `nope for bot ${'1:SECRET_TOKEN_JAMAIS_DANS_LE_LOG'}` } }));
  try {
    const url = new URL(fake.url);
    await assert.rejects(
      () =>
        downloadTelegramFile({
          apiRoot: `${url.protocol}//${url.host}`,
          botToken: '1:SECRET_TOKEN_JAMAIS_DANS_LE_LOG',
          filePath: 'files/absent.ogg',
          maxBytes: 4096,
          timeoutMs: 5000,
        }),
      (error: unknown) => {
        assert.ok(error instanceof TelegramFileError);
        assert.ok(!error.message.includes('SECRET_TOKEN'), `message trop bavard : ${error.message}`);
        assert.match(error.message, /404/, 'le statut, lui, est utile');
        return true;
      },
    );
  } finally {
    fake.close();
  }
});

test('extension → type MIME (Telegram ne renvoie pas toujours mime_type)', () => {
  assert.equal(mimeFromFileName('v.ogg'), 'audio/ogg');
  assert.equal(mimeFromFileName('v.MP3'), 'audio/mpeg');
  assert.equal(mimeFromFileName('note.opus'), 'audio/ogg');
  assert.equal(mimeFromFileName('sans-extension'), 'application/octet-stream');
});

test('politique de voix : miroir, toujours, sur demande, refus explicite', () => {
  const ctx = (over: Partial<Parameters<typeof shouldSpeak>[1]> = {}) => ({
    hadVoice: false,
    userText: '',
    hasPendingApproval: false,
    emptyText: false,
    ...over,
  });

  assert.equal(shouldSpeak('off', ctx({ hadVoice: true })).speak, false, 'off coupe à la source');
  assert.equal(shouldSpeak('mirror', ctx({ hadVoice: true })).speak, true, 'un vocal reçu → un vocal rendu');
  assert.equal(shouldSpeak('mirror', ctx({ hadVoice: false })).speak, false, 'du texte reçu → du texte rendu');
  assert.equal(shouldSpeak('always', ctx()).speak, true);
  assert.equal(shouldSpeak('on_request', ctx({ userText: 'envoie-moi ça en vocal' })).speak, true);
  assert.equal(shouldSpeak('on_request', ctx({ userText: 'combien font 2+2' })).speak, false);
  assert.equal(shouldSpeak('always', ctx({ userText: 'pas de vocal, juste le texte' })).speak, false, 'le refus écrit gagne sur le mode');
  assert.equal(shouldSpeak('always', ctx({ hasPendingApproval: true })).speak, false, 'une approbation se lit, elle ne s’écoute pas');
  assert.equal(shouldSpeak('always', ctx({ emptyText: true })).speak, false);

  assert.ok(asksForVoice('réponds en vocal svp'));
  assert.ok(!asksForVoice('pas en vocal'));
  assert.ok(refusesVoice('sans audio'));
  assert.equal(parseVoiceMode('nimporte_quoi'), 'mirror', 'une valeur inconnome retombe sur le défaut, ne casse pas le démarrage');
  assert.equal(parseVoiceMode('ALWAYS'), 'always');
});

test('sonde ElevenLabs : la forme réelle de /v1/models est un TABLEAU NU', async () => {
  // Relevée sur un compte réel le 2026-09-02 : `GET /v1/models` ne renvoie PAS
  // { models: [...] }, contrairement à `GET /v1/voices`. Un parseur qui ne connaît que
  // la forme documentée lit un inventaire vide… et se félicite de ne rien trouver.
  const fake = await fakeAudioEndpoint((req) => {
    if (req.url.includes('/voices')) {
      return { status: 200, json: { voices: [{ voice_id: 'voiceid0123456789abcd', name: 'Roger' }] } };
    }
    if (req.url.includes('/models')) {
      return { status: 200, json: [{ model_id: 'eleven_flash_v2_5', can_do_text_to_speech: true }, { model_id: 'eleven_v3', can_do_text_to_speech: true }] };
    }
    return { status: 404, json: { detail: 'route inattendue dans ce test' } };
  });
  try {
    const check = await checkVoiceAvailability(
      makeTestConfig({
        elevenLabsApiKey: 'sk_test',
        elevenLabsBaseUrl: fake.url,
        elevenLabsVoiceId: 'voiceid0123456789abcd',
        elevenLabsTtsModel: 'eleven_flash_v2_5',
        elevenLabsSttModel: 'scribe_v1',
        voiceMode: 'mirror',
      }),
      4000,
    );
    assert.equal(check.fatal, null, check.fatal ?? undefined);
    assert.deepEqual(check.warnings, [], 'inventaire lu : aucune excuse de ne pas vérifier');
    assert.ok(check.verified.some((v) => v.includes('eleven_flash_v2_5')), check.verified.join(' · '));
    assert.ok(check.verified.some((v) => v.includes('voiceid0123456789abcd')), check.verified.join(' · '));
  } finally {
    fake.close();
  }
});

test('sonde ElevenLabs : modèle de synthèse absent = fatal, modèle STT absent = jamais', async () => {
  // L'inventaire /v1/models ne couvre QUE la synthèse (vérifié sur le compte réel :
  // aucune entrée « scribe »). En juger ELEVENLABS_STT_MODEL refuserait un démarrage
  // parfaitement valide — le pire genre de garde.
  const base = {
    elevenLabsApiKey: 'sk_test',
    elevenLabsVoiceId: 'voiceid0123456789abcd',
    elevenLabsTtsModel: 'eleven_flash_v2_5',
    elevenLabsSttModel: 'scribe_v1',
    voiceMode: 'mirror',
  };
  const fake = await fakeAudioEndpoint((req) => {
    if (req.url.includes('/voices')) {
      return { status: 200, json: { voices: [{ voice_id: 'voiceid0123456789abcd', name: 'Roger' }] } };
    }
    return { status: 200, json: [{ model_id: 'eleven_multilingual_v2', can_do_text_to_speech: true }, { model_id: 'eleven_turbo_v2_5', can_do_text_to_speech: true }] };
  });
  try {
    const bad = await checkVoiceAvailability({ ...makeTestConfig(base), elevenLabsBaseUrl: fake.url }, 4000);
    assert.ok(bad.fatal !== null && /ELEVENLABS_TTS_MODEL/.test(bad.fatal), String(bad.fatal));
    assert.ok(bad.fatal!.includes('eleven_multilingual_v2'), 'le message doit donner les choix possibles');
    assert.ok(!bad.fatal!.includes('scribe_v1'), 'le modèle de transcription ne se juge pas ici');

    const good = await checkVoiceAvailability(
      { ...makeTestConfig(base), elevenLabsTtsModel: 'eleven_multilingual_v2', elevenLabsBaseUrl: fake.url },
      4000,
    );
    assert.equal(good.fatal, null, good.fatal ?? undefined);

    // Clé présente mais voix non choisie : l'agent parlerait pour rien au premier tour.
    const noVoice = await checkVoiceAvailability({ ...makeTestConfig(base), elevenLabsVoiceId: '', elevenLabsBaseUrl: fake.url }, 4000);
    assert.ok(noVoice.fatal !== null && /ELEVENLABS_VOICE_ID/.test(noVoice.fatal), String(noVoice.fatal));

    // Voix inconnue du compte : fatal, avec les identifiants valides sous les yeux.
    const wrongVoice = await checkVoiceAvailability(
      { ...makeTestConfig(base), elevenLabsVoiceId: 'voixinventee12345678', elevenLabsBaseUrl: fake.url },
      4000,
    );
    assert.ok(wrongVoice.fatal !== null && /n'existe pas sur ce compte/.test(wrongVoice.fatal), String(wrongVoice.fatal));
    assert.ok(wrongVoice.fatal!.includes('voiceid0123456789abcd'), 'la liste des voix du compte doit suivre');

    // ElevenLabs injoignable : un avertissement, pas un refus — l'agent doit démarrer.
    const down = await checkVoiceAvailability({ ...makeTestConfig(base), elevenLabsBaseUrl: 'http://127.0.0.1:1/v1' }, 1500);
    assert.equal(down.fatal, null, down.fatal ?? undefined);
    assert.equal(down.warnings.length, 1, down.warnings.join(' · '));
  } finally {
    fake.close();
  }
});

test('extrait les inventaires sous les trois formes rencontrées chez les fournisseurs', () => {
  const items = [{ model_id: 'a' }, { model_id: 'b' }];
  assert.deepEqual(extractItems(items, 'models'), items, 'tableau nu (ElevenLabs /v1/models)');
  assert.deepEqual(extractItems({ models: items }, 'models'), items, 'objet enveloppant (ElevenLabs /v1/voices)');
  assert.deepEqual(extractItems({ data: items }, 'models'), items, 'enveloppe data (compatible OpenAI)');
  assert.deepEqual(extractItems(null, 'models'), [], 'corps illisible → inventaire vide, pas d’exception');
  assert.deepEqual(extractItems('texte', 'models'), [], 'pas du tout un objet');
  assert.deepEqual(extractItems({ autres: items }, 'models'), [], 'un champ inattendu ne remplace pas l’inventaire');
});

test('diagnostic de refus : jamais le nom de fichier complet, mais assez pour corriger', () => {
  // Un refus doit être compréhensible sans transformer le journal en déballage de
  // pièces jointes privées : l'utilisateur appelle ses fichiers ce qu'il veut.
  assert.equal(describeTelegramPathIssue('files/a.ogg'), 'aucun');
  const long = describeTelegramPathIssue('files/' + 'b'.repeat(400));
  assert.match(long, /trop long \(406 caractères\) · racine/);
  assert.ok(!long.includes('b'.repeat(20)), 'le contenu du nom ne se journalise pas : ' + long);
  assert.match(describeTelegramPathIssue('https://evil.example/a.ogg'), /schéma ou hôte en tête/);
  assert.match(describeTelegramPathIssue('a/../b'), /segment traversant/);
  assert.match(describeTelegramPathIssue('files//x'), /double slash/);
  assert.match(describeTelegramPathIssue('.hidden'), /segment inattendu/);
  assert.equal(telegramPathIssue('files/ok-1.ogg'), null);
});

test('nom présenté au fournisseur : l’extension est une donnée sémantique, pas du décor', () => {
  // Le nom que le serveur de fichiers de Telegram rend réellement pour un vocal n'a pas
  // d'extension — et Groq refuse le fichier sur ce seul critère (vérifié sur l'API :
  // « file must be one of the following types: [flac mp3 …] »).
  assert.deepEqual(resolveAudioPart({ bytes: AUDIO, mime: 'audio/ogg', fileName: 'files/voice_file_1' }), {
    fileName: 'voice_file_1.ogg',
    mime: 'audio/ogg',
  });
  // Un nom déjà conforme n'est pas touché, un paramètre de mime est nettoyé.
  assert.deepEqual(resolveAudioPart({ bytes: AUDIO, mime: 'audio/ogg; codecs=opus', fileName: 'a.webm' }), {
    fileName: 'a.webm',
    mime: 'audio/ogg',
  });
  assert.deepEqual(resolveAudioPart({ bytes: AUDIO, mime: '', fileName: 'x.mp3' }), { fileName: 'x.mp3', mime: 'audio/mp3' });
  // Irrécupérable : erreur non transitoire SANS statut HTTP — c'est ce qui permet au canal
  // de dire « on n'a rien envoyé » au lieu de « le fournisseur a refusé ».
  assert.throws(
    () => resolveAudioPart({ bytes: AUDIO, mime: 'application/octet-stream', fileName: 'files/blob' }),
    (error: unknown) =>
      error instanceof AudioError &&
      !error.retryable &&
      error.status === null &&
      /format audio non reconnu/.test(error.message),
  );
});

test('Groq Whisper : le nom corrigé part dans le multipart, et un refus interne ne coûte aucun appel', async () => {
  const seen: string[] = [];
  const fake = await fakeAudioEndpoint((req) => {
    seen.push(req.body.toString('latin1'));
    return { status: 200, json: { text: 'deux plus deux', language: 'fr' } };
  });
  try {
    const t = new GroqWhisper({ baseUrl: fake.url, apiKey: 'gsk_fake', model: 'whisper-large-v3', timeoutMs: 5000 });
    const r = await t.transcribe({ bytes: AUDIO, mime: 'audio/ogg', fileName: 'files/voice_file_1' });
    assert.equal(r.text, 'deux plus deux');
    assert.match(seen[0]!, /filename="voice_file_1\.ogg"/, 'extension garantie au fournisseur');
    assert.match(seen[0]!, /content-type:\s*audio\/ogg/i, 'le Content-Type suit la déclaration du canal');

    await assert.rejects(
      () => t.transcribe({ bytes: AUDIO, mime: 'application/octet-stream', fileName: 'files/blob' }),
      (error: unknown) => error instanceof AudioError && error.status === null,
    );
    assert.equal(seen.length, 1, 'aucun appel réseau pour un fichier qu’on sait déjà refusé');
  } finally {
    fake.close();
  }
});
