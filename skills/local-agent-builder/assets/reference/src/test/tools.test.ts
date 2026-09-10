import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../memory/store.js';
import { buildRegistry } from '../tools/index.js';
import { ToolRegistry, executeToolCall } from '../tools/registry.js';
import { getCurrentTimeTool } from '../tools/builtin/get-current-time.js';
import { calculatorTool } from '../tools/builtin/index.js';
import { evaluateExpression } from '../tools/calculator.js';
import { parseToolArguments, toJsonSchema, validateArgs } from '../tools/args.js';
import { makeTestConfig, makeToolContext } from '../testing/fixtures.js';
import type { Tool } from '../tools/registry.js';
import type { ToolContext } from '../core/types.js';

function contextFor(store: Store, overrides: Partial<ToolContext> = {}): ToolContext {
  return makeToolContext({ config: makeTestConfig(), store, ...overrides });
}

// ----------------------------------------------------------- get_current_time ---

test('get_current_time : renvoie l’heure réelle et valide le fuseau', async () => {
  const store = new Store(':memory:');
  const registry = buildRegistry(makeTestConfig());
  const ctx = contextFor(store);

  const res = await executeToolCall(registry, { name: 'get_current_time', args: '{}' }, ctx);
  assert.equal(res.kind, 'executed');
  if (res.kind !== 'executed') return;
  const epoch = Number(/epoch (\d+)/.exec(res.executed.result.content)?.[1]);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Number.isFinite(epoch), `epoch absent de : ${res.executed.result.content}`);
  assert.ok(Math.abs(epoch - now) <= 5, `horloge décalée : ${epoch} vs ${now}`);

  const bad = await executeToolCall(registry, { name: 'get_current_time', args: '{"fuseau":"Mars/Olympus"}' }, ctx);
  assert.equal(bad.kind, 'executed');
  if (bad.kind === 'executed') assert.equal(bad.executed.result.status, 'invalid_args');

  const iso = await executeToolCall(registry, { name: 'get_current_time', args: '{"format":"iso","fuseau":"UTC"}' }, ctx);
  assert.equal(iso.kind, 'executed');
  if (iso.kind === 'executed') assert.match(iso.executed.result.content, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  store.close();
});

// ---------------------------------------------------------------------- garde ---

test('outil hors liste : refusé, aucune exécution, tracé dans l’audit', async () => {
  const store = new Store(':memory:');
  const registry = buildRegistry(makeTestConfig());
  let ran = false;
  const honeypot: Tool = { ...getCurrentTimeTool, name: 'read_file', run: () => ((ran = true), { status: 'ok', content: '!' }) };
  const withTrap = new ToolRegistry([...registry.visible(), honeypot], false);

  const res = await executeToolCall(registry, { name: 'read_file', args: '{}' }, contextFor(store));
  assert.equal(res.kind, 'rejected');
  assert.match((res as { reason: string }).reason, /inconnu/);
  assert.equal(ran, false, 'le même nom sur un registre différent ne doit pas être appelé');
  assert.equal(withTrap.has('read_file'), true, 'le registre piégé, lui, le connaît');

  const traversal = await executeToolCall(registry, { name: '../../etc/passwd', args: '{}' }, contextFor(store));
  assert.equal(traversal.kind, 'rejected', 'un nom non conforme est rejeté sans même chercher');
  assert.equal(store.recentAudit(1, 5).some((a) => a.status === 'denied'), true, 'refus doit être journalisé');
  store.close();
});

test('arguments invalides : message pédagogique, aucune exécution', async () => {
  const store = new Store(':memory:');
  const registry = buildRegistry(makeTestConfig());

  const brokenJson = await executeToolCall(registry, { name: 'calculator', args: '{"expression": ' }, contextFor(store));
  assert.equal(brokenJson.kind, 'rejected');
  assert.match((brokenJson as { reason: string }).reason, /JSON invalide/);

  const unknownKey = await executeToolCall(registry, { name: 'calculator', args: '{"xpression":"1+1"}' }, contextFor(store));
  assert.match((unknownKey as { reason: string }).reason, /paramètre inconnu/);

  const missing = await executeToolCall(registry, { name: 'calculator', args: '{}' }, contextFor(store));
  assert.equal(missing.kind, 'rejected');
  assert.match((missing as { reason: string }).reason, /manquant/);
  store.close();
});

// ------------------------------------------------------------------ args.ts ---

test('parseToolArguments : exige un objet JSON, borné en taille', () => {
  assert.deepEqual(parseToolArguments(''), { ok: true, value: {} });
  assert.deepEqual(parseToolArguments(undefined), { ok: true, value: {} });
  assert.equal(parseToolArguments('[1,2]').ok, false);
  assert.equal(parseToolArguments('"texte"').ok, false);
  assert.equal(parseToolArguments(`{"a":"${'x'.repeat(5000)}"}`).ok, false);
});

test('validateArgs : types, bornes, énumérations, valeurs par défaut', () => {
  const spec = {
    n: { type: 'integer' as const, min: 1, max: 3 },
    mode: { type: 'string' as const, enum: ['a', 'b'] as const },
    flag: { type: 'boolean' as const, default: false },
    txt: { type: 'string' as const, maxLength: 5 },
  };
  assert.deepEqual(validateArgs({ n: '2', mode: 'a' }, spec).args, { n: 2, mode: 'a', flag: false });
  assert.deepEqual(validateArgs({ txt: 'ok' }, spec).args, { txt: 'ok', flag: false });
  assert.match(validateArgs({ n: 9 }, spec).error ?? '', /≤ 3/);
  assert.match(validateArgs({ mode: 'c' }, spec).error ?? '', /a, b/);
  assert.match(validateArgs({ txt: 'trop long ici' }, spec).error ?? '', /dépasse 5/);
  assert.match(validateArgs({ n: 1.5 }, spec).error ?? '', /entier/);
  assert.match(validateArgs({ extra: 1 }, spec).error ?? '', /inconnu/);
});

test('toJsonSchema : le schéma vu par le modèle est dérivé du spec de validation', () => {
  const schema = toJsonSchema({
    n: { type: 'integer', min: 1, max: 3 },
    m: { type: 'string', enum: ['a', 'b'] as const, required: true },
  });
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false, 'les champs inconnus doivent être déclarés interdits');
  assert.deepEqual(schema.required, ['m']);
  assert.equal(schema.properties.n?.maximum, 3);
  assert.deepEqual(schema.properties.m?.enum, ['a', 'b']);
});

// ---------------------------------------------------------------- calculator ---

test('calculator : arithmétique juste, aucune exécution de code', () => {
  assert.equal(evaluateExpression('2 + 3 * 4').value, 14);
  assert.equal(evaluateExpression('(2 + 3) * 4').value, 20);
  assert.equal(evaluateExpression('2 ^ 3 ^ 2').value, 512, 'exponentiation right-associative');
  assert.equal(evaluateExpression('-5 + 2').value, -3);
  assert.equal(evaluateExpression('50 %').value, 0.5, '« 50 % » vaut 0,5');
  assert.ok(Math.abs((evaluateExpression('sqrt(16) + log(100)').value ?? 0) - 6) < 1e-9);
  assert.equal(evaluateExpression('1/0').ok, false, 'division par zéro refusée');

  for (const hostile of ['process.exit(1)', 'globalThis.x=1', '1;console.log(1)', '`${1+1}`', '(() => 1)()', 'sqrt(1))', '9^9^9', 'require("fs")']) {
    assert.equal(evaluateExpression(hostile).ok, false, `« ${hostile} » doit être refusé`);
  }
});

test('calculator : l’outil renvoie une ligne lisible', async () => {
  const store = new Store(':memory:');
  const res = await executeToolCall(buildRegistry(makeTestConfig()), { name: 'calculator', args: '{"expression":"1/3"}' }, contextFor(store));
  assert.equal(res.kind, 'executed');
  if (res.kind === 'executed') assert.equal(res.executed.result.content, '1/3 = 0.333333333333');
  store.close();
});

// -------------------------------------------------------------------- mémoire ---

test('remember : persiste, refuse un secret, applique le plafond', async () => {
  const store = new Store(':memory:');
  const config = makeTestConfig({ maxMemoryItems: 3 });
  const registry = buildRegistry(config);
  const ctx = contextFor(store, { config });

  const ok = await executeToolCall(registry, { name: 'remember', args: '{"fait":"Je cours le mardi soir","categorie":"projet"}' }, ctx);
  assert.equal(ok.kind, 'executed');
  if (ok.kind === 'executed') assert.match(ok.executed.result.content, /enregistré \(id 1\)/);
  assert.equal(store.countMemories(1), 1);
  assert.equal(store.getMemory(1)?.kind, 'projet');

  const secret = await executeToolCall(registry, { name: 'remember', args: '{"fait":"mon mot de passe est epee44"}' }, ctx);
  assert.equal(secret.kind, 'executed');
  if (secret.kind === 'executed') assert.equal(secret.executed.result.status, 'denied');
  assert.equal(store.countMemories(1), 1, 'le secret refusé ne doit rien écrire');

  for (let i = 0; i < 5; i += 1) {
    await executeToolCall(registry, { name: 'remember', args: JSON.stringify({ fait: `info ${i}` }) }, ctx);
  }
  assert.equal(store.countMemories(1), 3, 'maxMemoryItems est appliqué à l’écriture');
  store.close();
});

test('recall : résultats cloisonnés par conversation', async () => {
  const store = new Store(':memory:');
  const registry = buildRegistry(makeTestConfig());
  store.addMemory({ chatId: 1, content: 'préférence pour les réponses courtes' });
  store.addMemory({ chatId: 2, content: 'note confidentielle d’un autre chat' });

  const found = await executeToolCall(registry, { name: 'recall', args: '{"requete":"courtes"}' }, contextFor(store));
  assert.equal(found.kind, 'executed');
  if (found.kind === 'executed') {
    assert.match(found.executed.result.content, /réponses courtes/);
    assert.ok(!found.executed.result.content.includes('autre chat'), 'fuite inter-conversation');
  }

  const none = await executeToolCall(registry, { name: 'recall', args: '{"requete":"kwyjibo"}' }, contextFor(store));
  assert.equal(none.kind, 'executed');
  if (none.kind === 'executed') assert.match(none.executed.result.content, /aucun souvenir/);
  store.close();
});

test('forget : supprime par id, uniquement dans le bon chat', async () => {
  const store = new Store(':memory:');
  const registry = buildRegistry(makeTestConfig());
  const mine = store.addMemory({ chatId: 1, content: 'à moi' });
  const theirs = store.addMemory({ chatId: 2, content: 'à l’autre' });

  const wrongChat = await executeToolCall(registry, { name: 'forget', args: `{"id":${theirs.id}}` }, contextFor(store));
  assert.equal(wrongChat.kind, 'executed');
  if (wrongChat.kind === 'executed') assert.match(wrongChat.executed.result.content, /aucun souvenir/);
  assert.equal(store.getMemory(theirs.id)?.content, 'à l’autre', 'un id d’un autre chat ne doit rien supprimer');

  const right = await executeToolCall(registry, { name: 'forget', args: `{"id":${mine.id}}` }, contextFor(store));
  assert.equal(right.kind, 'executed');
  if (right.kind === 'executed') assert.match(right.executed.result.content, /supprimé/);
  assert.equal(store.getMemory(mine.id), null);
  store.close();
});

// ------------------------------------------------------------------ registry ---

test('registry : noms uniques et conformes, description exploitable', () => {
  assert.throws(() => new ToolRegistry([getCurrentTimeTool, getCurrentTimeTool], false), /deux fois/);
  assert.throws(
    () => new ToolRegistry([{ ...calculatorTool, name: 'Mauvais Nom' }], false),
    /invalide/,
  );
  const defs = buildRegistry(makeTestConfig()).definitions();
  assert.deepEqual(defs.map((d) => d.function.name).sort(), ['calculator', 'forget', 'get_current_time', 'recall', 'remember']);
  for (const def of defs) {
    assert.ok(def.function.description.length > 30, `${def.function.name} : description trop courte pour guider le modèle`);
  }
});

test('registry : outil dangereux masqué si le portail est fermé, visible sinon', () => {
  const dangerous: Tool = { ...calculatorTool, name: 'shell', dangerous: true, requiresApproval: true };
  const registry = buildRegistry(makeTestConfig());
  assert.equal(new ToolRegistry([...registry.visible(), dangerous], false).has('shell'), true, 'enregistré…');
  assert.equal(
    new ToolRegistry([...registry.visible(), dangerous], false).definitions().some((d) => d.function.name === 'shell'),
    false,
    '…mais jamais déclaré au modèle tant que DANGEROUS_TOOLS_ENABLED=false',
  );
  assert.equal(
    new ToolRegistry([...registry.visible(), dangerous], true).definitions().some((d) => d.function.name === 'shell'),
    true,
  );
});

test('registry : un outil dangereux sans approbation est impossible à enregistrer', () => {
  assert.throws(
    () => new ToolRegistry([{ ...calculatorTool, name: 'run_command', dangerous: true, requiresApproval: false }], true),
    /requiresApproval/,
    'la validation est dans le constructeur : aucun chemin de contournement',
  );
});

test('registry : exécution d’un outil en erreur → l’agent continue, l’erreur est renvoyée au modèle', async () => {
  const store = new Store(':memory:');
  const boom: Tool = {
    name: 'boom',
    description: 'outil volontairement défaillant pour le test',
    parameters: {},
    run: () => {
      throw new Error('panne simulée');
    },
  };
  const registry = new ToolRegistry([boom], false);
  const res = await executeToolCall(registry, { name: 'boom', args: '{}' }, contextFor(store));
  assert.equal(res.kind, 'executed', 'une panne d’outil ne doit pas tuer le tour');
  if (res.kind === 'executed') {
    assert.equal(res.executed.result.status, 'error');
    assert.match(res.executed.result.content, /panne simulée/);
  }
  assert.equal(store.recentAudit(1, 5)[0]?.status, 'error', 'la panne est journalisée');
  store.close();
});

test('registry : sortie d’outil tronquée à maxOutputChars avant d’atteindre le modèle', async () => {
  const store = new Store(':memory:');
  const chatter: Tool = {
    name: 'chatter',
    description: 'outil de test renvoyant une sortie démesurée',
    parameters: {},
    maxOutputChars: 100,
    run: () => ({ status: 'ok', content: 'A'.repeat(5000) }),
  };
  const res = await executeToolCall(new ToolRegistry([chatter], false), { name: 'chatter', args: '{}' }, contextFor(store));
  assert.equal(res.kind, 'executed');
  if (res.kind === 'executed') {
    assert.equal(res.executed.result.content.length, 110, '100 caractères + suffixe de troncature');
    assert.match(res.executed.result.content, /\[tronqué\]$/);
  }
  store.close();
});
