/**
 * Catalogue de voix (sélecteur de `/voice`) et préférence persistée.
 *
 * Trois familles de fautes à empêcher ici :
 *   - une liste vide lue comme un succès (le faux négatif de forme) ;
 *   - un clic fabriquer une identité et partir la payer chez le fournisseur ;
 *   - une migration de base créer la colonne mais perdre les lignes d'avant.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_V1, SCHEMA_VERSION } from '../memory/schema.js';
import { Store } from '../memory/store.js';
import { AudioError } from '../audio/types.js';
import {
  VOICE_PICK_LIMIT,
  buildVoiceCatalog,
  matchVoices,
  normalizeNeedle,
  parseVoiceList,
  sortVoices,
  type VoiceCandidate,
} from '../audio/voices.js';
import { voiceKeyboard, voiceStatusText } from '../channels/telegram/bot.js';

const ID_A = 'voixaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'voixbbbbbbbbbbbbbbbbbbbb';
const ID_C = 'voixcccccccccccccccccccc';

function candidate(id: string, name: string, category = 'generated'): VoiceCandidate {
  return { id, name, label: name, category };
}

/** Serveur d'inventaire à la demande : le compteur de requêtes est la vraie assertion. */
async function fakeEleven(
  payload: unknown,
  opts: { status?: number } = {},
): Promise<{ baseUrl: string; hits: () => number; close: () => Promise<void> }> {
  let n = 0;
  const server = createServer((_req, res) => {
    n += 1;
    if (opts.status !== undefined && opts.status !== 200) {
      res.writeHead(opts.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'panne' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    hits: () => n,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ------------------------------------------------------------------ forme ---

test('les quatre formes de réponse ElevenLabs sont lues, les voix sans identifiant sautées', () => {
  const one = [{ voice_id: ID_A, name: 'Roger' }];
  const expected = [{ id: ID_A, name: 'Roger', label: 'Roger', category: '' }];
  for (const payload of [one, { voices: one }, { items: one }, { data: one }]) {
    assert.deepEqual(parseVoiceList(payload), expected, `forme non tolérée : ${JSON.stringify(payload)}`);
  }
  // Une entrée sans `voice_id` n'est pas sélectionnable : elle ne rentre pas dans la liste.
  assert.deepEqual(parseVoiceList({ voices: [{ name: 'Fantôme' }] }), []);
});

test('un nom trop long est tronqué, pas rejeté', () => {
  const items = parseVoiceList({ voices: [{ voice_id: ID_A, name: 'Élodie de la rive gauche du fleuve' }] });
  assert.equal(items.length, 1);
  assert.ok(items[0]!.label.length <= 26, `libellé trop long pour un bouton : ${items[0]!.label}`);
  assert.match(items[0]!.label, /…$/);
});

// ------------------------------------------------------------------ tri ---

test('la voix en cours vient en tête, le reste par nom, accents et casse non discriminants', () => {
  const items = [candidate(ID_B, 'Zézette'), candidate(ID_A, 'Roger'), candidate(ID_C, 'Élodie')];
  assert.deepEqual(sortVoices(items, ID_B).map((v) => v.name), ['Zézette', 'Élodie', 'Roger']);
  assert.deepEqual(sortVoices(items, '').map((v) => v.name), ['Élodie', 'Roger', 'Zézette']);
  // Un identifiant absent de la liste ne doit ni désordonner ni planter.
  assert.equal(sortVoices(items, 'inconnu').length, 3);
});

test('la recherche par nom est une sous-chaîne tolérante, et refuse les débuts trop courts', () => {
  // Les comptes ont des variantes du même nom (« Roger », « Roger (posée) ») : plusieurs
  // résultats est le cas normal, et le choix doit alors être demandé, pas deviné.
  const items = [candidate(ID_A, 'Roger'), candidate(ID_B, 'Élodie'), candidate(ID_C, 'Roger (posée)')];
  assert.equal(normalizeNeedle('  ÉLODIE  '), 'elodie');
  assert.deepEqual(matchVoices(items, 'elodie').map((v) => v.id), [ID_B], 'accents absents tolérés');
  assert.deepEqual(matchVoices(items, 'élo').map((v) => v.id), [ID_B], 'début de nom suffit');
  assert.deepEqual(
    matchVoices(items, 'roger').map((v) => v.id).sort(),
    [ID_A, ID_C].sort(),
    'sous-chaîne commune = plusieurs résultats, pas un choix arbitraire',
  );
  assert.deepEqual(matchVoices(items, 'rod'), [], 'une sous-chaîne absente ne doit rien inventer');
  assert.deepEqual(matchVoices(items, 'r'), [], 'une lettre ne doit pas proposer trente voix');
  assert.deepEqual(matchVoices(items, ''), []);
});

// ------------------------------------------------------------------ cache ---

test('le catalogue se met en cache : deux lectures, une requête', async () => {
  const fake = await fakeEleven({ voices: [{ voice_id: ID_A, name: 'Roger' }] });
  try {
    let t = 1_000;
    const catalog = buildVoiceCatalog({ apiKey: 'k', baseUrl: fake.baseUrl, timeoutMs: 4_000, now: () => t })!;
    const first = await catalog.list();
    const second = await catalog.list();
    assert.equal(fake.hits(), 1, `le cache n'a pas servi (${fake.hits()} requêtes)`);
    assert.deepEqual(first, second);
    // TTL dépassé → une nouvelle requête, sinon la liste ne suivrait jamais le compte.
    t += 600_001;
    await catalog.list();
    assert.equal(fake.hits(), 2);
  } finally {
    await fake.close();
  }
});

test('les appels concurrents ne font qu’une requête, et le rafraîchissement en force fait une', async () => {
  const fake = await fakeEleven({ voices: [{ voice_id: ID_A, name: 'Roger' }] });
  try {
    const catalog = buildVoiceCatalog({ apiKey: 'k', baseUrl: fake.baseUrl, timeoutMs: 4_000 })!;
    const [a, b] = await Promise.all([catalog.list(), catalog.list()]);
    assert.equal(fake.hits(), 1, 'deux clics simultanés ne doivent pas doubler le GET');
    assert.deepEqual(a, b);
    await catalog.list({ refresh: true });
    assert.equal(fake.hits(), 2);
  } finally {
    await fake.close();
  }
});

test('une panne d’inventaire est dite, et le dernier bon inventaire sert de repli', async () => {
  const ok = await fakeEleven({ voices: [{ voice_id: ID_A, name: 'Roger' }] });
  const catalog = buildVoiceCatalog({ apiKey: 'k', baseUrl: ok.baseUrl, timeoutMs: 4_000 })!;
  assert.equal((await catalog.list()).length, 1);
  await ok.close();

  // Fournisseur en panne ET cache périmé : on garde la dernière liste — choisir une voix
  // n'est pas une décision de vie ou de mort — mais on n'invente rien.
  const dead = await fakeEleven(null, { status: 500 });
  try {
    const items = await catalog.list({ refresh: true });
    assert.deepEqual(items.map((v) => v.name), ['Roger'], 'repli sur l’inventaire en cache');
  } finally {
    await dead.close();
  }

  // Sans aucun cache, l'erreur doit REMONTER : un `[]` muet vaut une liste mensongère.
  const dead2 = await fakeEleven(null, { status: 503 });
  try {
    const fresh = buildVoiceCatalog({ apiKey: 'k', baseUrl: dead2.baseUrl, timeoutMs: 4_000 })!;
    await assert.rejects(fresh.list(), (error: unknown) => error instanceof AudioError && error.retryable === true);
  } finally {
    await dead2.close();
  }
});

test('un inventaire sans aucune voix exploitable n’est pas un succès', async () => {
  const fake = await fakeEleven({ voices: [{ name: 'sans identifiant' }] });
  try {
    const catalog = buildVoiceCatalog({ apiKey: 'k', baseUrl: fake.baseUrl, timeoutMs: 4_000 })!;
    await assert.rejects(
      catalog.list(),
      (error: unknown) => error instanceof AudioError && /sans voix exploitable/.test(error.message),
    );
  } finally {
    await fake.close();
  }
});

test('sans clé, pas de catalogue — et surtout aucun appel réseau', async () => {
  const fake = await fakeEleven({ voices: [] });
  try {
    assert.equal(buildVoiceCatalog({ apiKey: '', baseUrl: fake.baseUrl, timeoutMs: 4_000 }), null);
    assert.equal(fake.hits(), 0, 'aucune requête ne doit partir sans clé');
  } finally {
    await fake.close();
  }
});

// ------------------------------------------------------------------ rendu ---

test('le clavier marque la voix courante et porte l’identifiant, jamais un index', () => {
  const items = [candidate(ID_A, 'Roger'), candidate(ID_B, 'Élodie')];
  const kb = voiceKeyboard(items, ID_B);
  const flat = kb.inline_keyboard.flat() as Array<{ text: string; callback_data: string }>;
  assert.equal(flat[0]!.text, '✓ Élodie', 'la voix active en tête et marquée');
  assert.ok(flat.some((b) => b.callback_data === `vo:${ID_A}`), 'un clic porte la voix, pas une position');
  assert.ok(flat.some((b) => b.callback_data === 'vo:clear'), 'retour au défaut accessible');
  assert.ok(flat.every((b) => b.callback_data.length <= 64), 'callback_data ≤ 64 octets (limite Telegram)');
});

test('au-delà de la limite affichée, le reliquat est annoncé et le moyen de l’atteindre aussi', () => {
  const many = Array.from({ length: VOICE_PICK_LIMIT + 6 }, (_, i) =>
    candidate(`voix${String(i).padStart(18, '0')}`, `Voix ${i}`),
  );
  const kb = voiceKeyboard(many.slice(0, VOICE_PICK_LIMIT), many[0]!.id);
  const buttons = kb.inline_keyboard.flat().length;
  assert.equal(buttons, VOICE_PICK_LIMIT + 2, `${VOICE_PICK_LIMIT} voix + 2 actions attendues, reçus ${buttons}`);
  const text = voiceStatusText({
    mode: 'mirror',
    modeSource: 'VOICE_MODE=mirror',
    listening: true,
    speaking: true,
    currentVoice: 'Voix 0',
    voiceSource: 'défaut du .env',
    shown: VOICE_PICK_LIMIT,
    total: many.length,
    selectable: true,
  });
  assert.match(text, new RegExp(`${VOICE_PICK_LIMIT} voix sur ${many.length} affichées`), 'le reliquat doit être annoncé');
  assert.match(text, /\/voice <début de nom>/, 'et le moyen de l’atteindre dit');
});

test('sans sélection possible, le texte l’explique au lieu de montrer un clavier vide', () => {
  const text = voiceStatusText({
    mode: 'off',
    modeSource: 'VOICE_MODE=off',
    listening: false,
    speaking: false,
    currentVoice: 'aucune',
    voiceSource: 'aucune voix configurée',
    shown: 0,
    total: 0,
    selectable: false,
  });
  assert.match(text, /Aucune sélection possible/);
  assert.match(text, /pas de clé ElevenLabs/);
  assert.ok(!text.includes('Touche pour choisir'), 'ne pas proposer ce qui est impossible');
});

// ------------------------------------------------------------------ persistance ---

test('la préférence de voix survit à une réouverture de la base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'og-voice-'));
  const store = new Store(join(dir, 'memory.db'));
  store.touchChat(7, null, false);
  assert.equal(store.getChatVoice(7), null, 'aucun choix avant le premier clic');
  store.setChatVoice(7, ID_B);
  assert.equal(store.getChatVoice(7), ID_B);
  store.close();

  const reopened = new Store(join(dir, 'memory.db'));
  assert.equal(reopened.getChatVoice(7), ID_B, 'un choix de voix doit survivre au redémarrage');
  reopened.setChatVoice(7, null);
  assert.equal(reopened.getChatVoice(7), null, 'effacer = revenir au défaut, non écrire le défaut dans la base');
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test('setChatVoice crée la ligne de conversation si elle manque', () => {
  const store = new Store(':memory:');
  store.setChatVoice(99, ID_A); // aucun touchChat préalable : le clic doit quand même être gardé
  assert.equal(store.getChatVoice(99), ID_A);
  store.close();
});

test('une base v1 migre en v2 sans perdre les lignes, et se déclare à jour', () => {
  const dir = mkdtempSync(join(tmpdir(), 'og-mig-'));
  const path = join(dir, 'memory.db');

  // On rejoue l'état d'avant : schéma v1 nu, `user_version` à 1, une conversation et un message.
  const old = new Database(path);
  old.exec(SCHEMA_V1);
  old.pragma('user_version = 1');
  old.prepare('INSERT INTO chats (chat_id, created_at, updated_at, title, is_group) VALUES (1,2,3,NULL,0)').run();
  old.prepare(`INSERT INTO messages (chat_id, role, content, created_at) VALUES (1,'user','souvenir a preserver',4)`).run();
  const before = old.prepare('PRAGMA table_info(chats)').all() as Array<{ name: string }>;
  assert.ok(!before.some((c) => c.name === 'voice_id'), 'v1 n’a pas la colonne');
  old.close();

  const store = new Store(path); // c'est la construction qui migre
  assert.equal(store.getChatVoice(1), null, 'la colonne existe, et est vide pour la ligne existante');
  store.setChatVoice(1, ID_C);
  assert.equal(store.getChatVoice(1), ID_C);
  store.close();

  const after = new Database(path, { readonly: true });
  assert.equal(
    (after.prepare('SELECT voice_id FROM chats WHERE chat_id = 1').get() as { voice_id: string }).voice_id,
    ID_C,
    'la préférence doit être écrite dans le fichier, pas seulement en mémoire',
  );
  assert.equal(
    (after.prepare('SELECT content FROM messages WHERE chat_id = 1').get() as { content: string }).content,
    'souvenir a preserver',
    'une migration additive ne touche pas aux lignes',
  );
  assert.equal(after.pragma('user_version', { simple: true }), SCHEMA_VERSION, 'la base doit se déclarer à jour');
  after.close();
  rmSync(dir, { recursive: true, force: true });
});
