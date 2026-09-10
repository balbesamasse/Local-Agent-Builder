import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkConfiguredModels, readIds } from '../llm/model-check.js';
import { makeTestConfig } from '../testing/fixtures.js';

/** Faux inventaire de modèles : répond {ok:[…]} sur /models, ou un code d'erreur. */
async function fakeInventory(ids: string[], status = 200): Promise<{ url: string; close: () => void }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) } : { error: 'nope' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}

test('sonde : un modèle présent dans l’inventaire est validé', async () => {
  const fake = await fakeInventory(['test-model', 'autre-modele']);
  try {
    const result = await checkConfiguredModels(makeTestConfig({ groqBaseUrl: fake.url }), 3000);
    assert.equal(result.fatal, null, 'aucun motif bloquant');
    assert.deepEqual(result.verified, ['Groq/test-model']);
    assert.deepEqual(result.warnings, []);
  } finally {
    fake.close();
  }
});

test('sonde : un modèle absent est refusé, avec des suggestions et sans fuite de clé', async () => {
  const fake = await fakeInventory(['gpt-x', 'test-model-plus', 'sans-rapport']);
  try {
    const config = makeTestConfig({ groqBaseUrl: fake.url, groqModel: 'test-model' });
    const result = await checkConfiguredModels(config, 3000);
    assert.ok(result.fatal, 'le modèle introuvable doit être bloquant');
    assert.match(result.fatal!, /ne propose pas le modèle « test-model »/);
    assert.match(result.fatal!, /test-model-plus/, 'la suggestion la plus proche doit être citée');
    assert.ok(
      !result.fatal!.includes(config.groqApiKey),
      'une clé API ne doit jamais se retrouver dans un message de diagnostic',
    );
  } finally {
    fake.close();
  }
});

test('sonde : une clé refusée (401) est bloquante', async () => {
  const fake = await fakeInventory([], 401);
  try {
    const result = await checkConfiguredModels(makeTestConfig({ groqBaseUrl: fake.url }), 3000);
    assert.match(result.fatal ?? '', /refuse la clé API \(HTTP 401\)/);
  } finally {
    fake.close();
  }
});

test('sonde : fournisseur injoignable ⇒ avertissement, jamais un échec de démarrage', async () => {
  // Port fermé : connexion refusée immédiate. Un agent doit pouvoir démarrer hors ligne.
  const result = await checkConfiguredModels(makeTestConfig({ groqBaseUrl: 'http://127.0.0.1:1/v1' }), 2000);
  assert.equal(result.fatal, null, 'le réseau absent ne doit pas empêcher le démarrage');
  assert.equal(result.warnings.length, 1, 'mais doit être signalé');
  assert.match(result.warnings[0]!, /Groq/);
});

test('sonde : un alias de routage absent de l’inventaire reste accepté', async () => {
  const fake = await fakeInventory(['dots-studio/dots-3-note-preview:free']);
  try {
    const config = makeTestConfig({
      groqApiKey: '', // on isole OpenRouter
      openRouterApiKey: 'or_test',
      openRouterBaseUrl: fake.url,
      openRouterModel: 'openrouter/alpha', // alias réel, mais absent de /models
    });
    const result = await checkConfiguredModels(config, 3000);
    assert.equal(result.fatal, null, 'une sonde naïe refuserait une configuration valide');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /alias de routage/);
  } finally {
    fake.close();
  }
});

test('lecture d’inventaire : les trois formes de réponse sont tolérées', () => {
  assert.deepEqual(readIds({ data: [{ id: 'a' }, { id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(readIds({ models: [{ id: 'c' }] }), ['c']);
  assert.deepEqual(readIds(['d', 'e']), ['d', 'e']);
  assert.deepEqual(readIds(undefined), []);
  assert.deepEqual(readIds({ data: 'surprenant' }), []);
});
