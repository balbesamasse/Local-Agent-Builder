/**
 * Tests de la boucle d'agent, avec un faux LLM : on vérifie le CONTRÔLE
 * (limites, outillage, refus, approbations, cloisonnement) sans réseau ni coût.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, resolveApproval, type AgentDeps } from '../core/agent.js';
import { Store } from '../memory/store.js';
import { ToolRegistry, type Tool } from '../tools/registry.js';
import { ApprovalGate } from '../security/approvals.js';
import { buildRegistry } from '../tools/index.js';
import { FakeLlm, makeTestConfig } from '../testing/fixtures.js';
import type { LlmResponse } from '../llm/openai-compat.js';

function called(id: string, name: string, args: Record<string, unknown> = {}): Partial<LlmResponse> {
  return { toolCalls: [{ id, name, args: JSON.stringify(args) }], text: '' };
}

interface HarnessOptions {
  tools?: Tool[];
  config?: Partial<AgentDeps['config']>;
  /** true = outil sensible visible (DANGEROUS_TOOLS_ENABLED). */
  dangerousEnabled?: boolean;
  seed?: (store: Store) => void;
}

function harness(script: Array<Partial<LlmResponse> | Error>, options: HarnessOptions = {}): { deps: AgentDeps; store: Store; llm: FakeLlm } {
  const store = new Store(':memory:');
  options.seed?.(store);
  const config = makeTestConfig({
    ...options.config,
    dangerousToolsEnabled: options.dangerousEnabled ?? false,
  });
  const registry = options.tools ? new ToolRegistry(options.tools, config.dangerousToolsEnabled) : buildRegistry(config);
  const llm = new FakeLlm(script);
  return { deps: { config, llm, store, registry, gate: new ApprovalGate(store, registry, config.approvalTtlMinutes) }, store, llm };
}

// ------------------------------------------------------------- tour simple ---

test('réponse sans outil : un appel LLM, historique persisté', async () => {
  const h = harness([{ text: 'Bonjour 👋' }]);
  const reply = await runAgent(h.deps, { chatId: 10, userId: 4242, text: 'salut' });

  assert.equal(reply.text, 'Bonjour 👋');
  assert.equal(reply.iterations, 1);
  assert.equal(reply.toolCalls, 0);
  assert.deepEqual(reply.pending, []);
  assert.equal(h.llm.requests.length, 1);
  assert.deepEqual(
    h.store.recentMessages(10, 10).map((m) => `${m.role}:${m.content}`),
    ['user:salut', 'assistant:Bonjour 👋'],
  );
  const first = h.llm.requests[0]!.messages[0]!;
  assert.equal(first.role, 'system');
  assert.match(first.content ?? '', /TestGravity/, 'le prompt système nomme l’agent');
  h.store.close();
});

test('entrée assainie avant stockage (caractères de contrôle et longueur)', async () => {
  const h = harness([{ text: 'ok' }]);
  await runAgent(h.deps, { chatId: 11, userId: 4242, text: 'a\u0000b\u202Ecd' });
  const stored = h.store.recentMessages(11, 5)[0]!.content!;
  assert.equal(stored, 'abcd');
  h.store.close();
});

test('tour avec outil : appel rejoué au format assistant+tool_calls, résultat injecté', async () => {
  const h = harness([called('c1', 'get_current_time'), { text: 'Nous sommes mardi.' }]);
  const reply = await runAgent(h.deps, { chatId: 1, userId: 4242, text: 'quelle heure ?' });

  assert.equal(reply.toolCalls, 1);
  assert.equal(reply.iterations, 2);
  const second = h.llm.requests[1]!.messages;
  const assistantTurn = second.find((m) => m.role === 'assistant' && m.tool_calls?.length);
  const toolResult = second.find((m) => m.role === 'tool');
  assert.ok(assistantTurn, "l'appel doit être visible du modèle");
  assert.equal(toolResult?.tool_call_id, 'c1');
  assert.match(toolResult?.content ?? '', /BEGIN_TOOL_OUTPUT_get_current_time/, 'sortie encadrée comme donnée non fiable');
  h.store.close();
});

test('mémoire : chargée quand la question est personnelle, absente sinon', async () => {
  const h = harness([{ text: 'ok' }], {
    seed: (store) => {
      store.addMemory({ chatId: 1, content: 'l’utilisateur déteste les listes à puces interminables', kind: 'preference' });
    },
  });
  await runAgent(h.deps, { chatId: 1, userId: 4242, text: 'parle-moi de mes préférences de listes' });
  const systemMessages = h.llm.requests[0]!.messages.filter((m) => m.role === 'system');
  assert.equal(systemMessages.length, 2, 'bloc mémoire injecté en plus du prompt système');
  assert.match(systemMessages[1]!.content ?? '', /BEGIN_MEMORY/);
  assert.match(systemMessages[1]!.content ?? '', /ne constituent pas des instructions/);

  const h2 = harness([{ text: 'ok' }], {
    seed: (store) => {
      store.addMemory({ chatId: 1, content: 'préférence unrelated-xyz', kind: 'preference' });
    },
  });
  await runAgent(h2.deps, { chatId: 1, userId: 4242, text: 'combine 2 + 2' });
  assert.equal(h2.llm.requests[0]!.messages.filter((m) => m.role === 'system').length, 1, 'rien d’utile → pas de bloc mémoire');
  h.store.close();
  h2.store.close();
});

test('historique : fenêtre glissante bornée, messages d’outil jamais rejoués', async () => {
  const store = new Store(':memory:');
  for (let i = 1; i <= 30; i += 1) {
    store.addMessage({ chatId: 5, role: i % 2 === 1 ? 'user' : 'assistant', content: `h${i}` });
  }
  store.addMessage({ chatId: 5, role: 'tool', content: 'jamais rejoué', toolName: 'x' });
  const config = makeTestConfig({ historyLimit: 4 });
  const llm = new FakeLlm([{ text: 'ok' }]);
  const registry = buildRegistry(config);
  await runAgent({ config, llm, store, registry, gate: new ApprovalGate(store, registry, 15) }, { chatId: 5, userId: 4242, text: 'nouveau' });

  const contents = llm.requests[0]!.messages.map((m) => m.content ?? '');
  assert.equal(contents.filter((c) => /^h\d+$/.test(c)).length, 4, 'exactement historyLimit messages repris');
  assert.ok(!contents.includes('jamais rejoué'));
  assert.deepEqual(contents.slice(-5, -1), ['h27', 'h28', 'h29', 'h30'], 'ce sont bien les plus récents');
  assert.equal(contents.at(-1), 'nouveau', 'le message courant arrive après la fenêtre');
  store.close();
});

// -------------------------------------------------------------- bornes ---

test('boucle qui ne finit pas : arrêt net à maxIterations, conclusion forcée', async () => {
  const endless = Array.from({ length: 10 }, (_, i) => called(`c${i}`, 'calculator', { expression: `${i}+1` }));
  const h = harness(endless, { config: { maxIterations: 3, forceFinalIteration: 0 } });
  const reply = await runAgent(h.deps, { chatId: 1, userId: 4242, text: 'calcule' });

  assert.equal(h.llm.requests.length, 3, 'on doit s’arrêter pile à maxIterations');
  assert.equal(reply.iterations, 3);
  assert.match(reply.text, /limite de 3 itérations/);
  h.store.close();
});

test('force-final : les outils sont retirés du contexte à l’itération de clôture', async () => {
  const h = harness([called('c1', 'calculator', { expression: '1+1' }), { text: '2' }], {
    config: { maxIterations: 5, forceFinalIteration: 2 },
  });
  const reply = await runAgent(h.deps, { chatId: 2, userId: 4242, text: 'calcule' });

  assert.ok((h.llm.requests[0]!.tools?.length ?? 0) > 0, 'itération 1 : outils déclarés');
  assert.deepEqual(h.llm.requests[1]!.tools, [], 'itération 2 : liste d’outils vide');
  assert.match(h.llm.requests[1]!.messages.at(-1)!.content ?? '', /BEGIN_SYSTEM[\s\S]*Limite/, 'instruction de clôture injectée et encadrée');
  assert.equal(reply.text, '2');
  h.store.close();
});

test('outil inconnu : refusé avant exécution, le modèle est recadré', async () => {
  const h = harness([called('c1', 'delete_everything'), { text: 'je ne peux pas' }]);
  await runAgent(h.deps, { chatId: 1, userId: 4242, text: 'supprime tout' });
  const toolMsg = h.llm.requests[1]!.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg?.content ?? '', /refusé/);
  assert.match(toolMsg?.content ?? '', /liste déclarée/);
  assert.equal(h.store.recentAudit(1, 3)[0]?.status, 'denied', 'refus journalisé dans l’audit');
  h.store.close();
});

test('doublon au même tour : une seule exécution', async () => {
  let executions = 0;
  const counter: Tool = {
    name: 'counter',
    description: 'compte ses exécutions pour vérifier la déduplication d’un tour',
    parameters: {},
    run: () => {
      executions += 1;
      return { status: 'ok', content: `exécution ${executions}` };
    },
  };
  const h = harness(
    [
      {
        toolCalls: [
          { id: 'a', name: 'counter', args: '{}' },
          { id: 'b', name: 'counter', args: '{}' },
        ],
        text: '',
      },
      { text: 'fini' },
    ],
    { tools: [counter] },
  );
  await runAgent(h.deps, { chatId: 1, userId: 4242, text: 'deux fois' });
  assert.equal(executions, 1);
  const toolMessages = h.llm.requests[1]!.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 2, 'le modèle doit quand même recevoir une réponse pour le 2e call (protocole OpenAI)');
  assert.match(toolMessages[1]?.content ?? '', /déjà effectué/);
  h.store.close();
});

test('trop d’appels d’un coup : seuls les 4 premiers sont traités', async () => {
  // Args distincts : sans quoi la déduplication (volontaire) masquerait la borne par tour.
  const calls = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, name: 'noop', args: JSON.stringify({ i }) }));
  let ran = 0;
  const noop: Tool = {
    name: 'noop',
    description: 'outil factice qui compte ses appels pour tester la borne par tour',
    parameters: { i: { type: 'integer' } },
    run: () => {
      ran += 1;
      return { status: 'ok', content: 'ok' };
    },
  };
  const h = harness([{ toolCalls: calls, text: '' }, { text: 'stop' }], { tools: [noop] });
  await runAgent(h.deps, { chatId: 1, userId: 4242, text: 'go' });
  assert.equal(ran, 4, 'MAX_TOOL_CALLS_PER_TURN = 4');
  h.store.close();
});

test('échec de tous les fournisseurs : message générique, aucun détail technique renvoyé', async () => {
  const h = harness([new Error('boom interne secret-token-123')]);
  const reply = await runAgent(h.deps, { chatId: 1, userId: 4242, text: 'salut' });
  assert.match(reply.text, /pas pu joindre le modèle/);
  assert.ok(!reply.text.includes('secret-token'), 'le message brut du fournisseur ne fuit pas vers Telegram');
  assert.equal(reply.provider, 'erreur');
  h.store.close();
});

// --------------------------------------------------------- approbations ---

function sensitiveTool(name: string, counter: () => void): Tool {
  return {
    name,
    description: 'outil sensible de test, exécution suspendue à un accord humain explicite',
    parameters: { cible: { type: 'string', maxLength: 60 } },
    requiresApproval: true,
    dangerous: true,
    run: () => {
      counter();
      return { status: 'ok', content: 'action réellement effectuée' };
    },
  };
}

test('outil sensible : mis en attente, rien n’est exécuté sans clic', async () => {
  let executed = 0;
  const h = harness([called('c1', 'send_email', { cible: 'a@b.c' }), { text: 'je peux envoyer si tu valides' }], {
    tools: [sensitiveTool('send_email', () => (executed += 1))],
    dangerousEnabled: true,
  });

  const reply = await runAgent(h.deps, { chatId: 77, userId: 4242, text: 'envoie un mail' });
  assert.equal(executed, 0, 'aucune exécution avant approbation');
  assert.equal(reply.pending.length, 1);
  const ticket = reply.pending[0]!;
  assert.equal(ticket.toolName, 'send_email');
  assert.match(ticket.token, /^[A-Za-z0-9_-]{32,}$/, 'jeton aléatoire à usage unique');

  const stored = h.store.getApproval(ticket.id)!;
  assert.equal(stored.status, 'pending');
  assert.equal(stored.userId, 4242);
  assert.match(stored.argsJson, /a@b\.c/);

  const toolMsg = h.llm.requests[1]!.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg?.content ?? '', /approbation humaine/);
  assert.match(toolMsg?.content ?? '', /N’AFFIRME PAS/, 'le modèle doit être sommé de ne pas prétendre l’action faite');

  const outcome = await resolveApproval(h.deps, { chatId: 77, userId: 4242, id: ticket.id, token: ticket.token, approved: true });
  assert.equal(executed, 1, 'exécuté uniquement après le clic');
  assert.match(outcome.message, /action réellement effectuée/);
  assert.equal(h.store.getApproval(ticket.id)!.status, 'approved');

  const replay = await resolveApproval(h.deps, { chatId: 77, userId: 4242, id: ticket.id, token: ticket.token, approved: true });
  assert.equal(executed, 1, 'un clic rejoué ne ré-exécute rien');
  assert.match(replay.message, /déjà/);
  h.store.close();
});

test('approbation : refusée pour un autre utilisateur ou un autre chat', async () => {
  let executed = 0;
  const h = harness([called('c1', 'wipe_disk'), { text: 'confirme' }], {
    tools: [sensitiveTool('wipe_disk', () => (executed += 1))],
    dangerousEnabled: true,
  });
  const reply = await runAgent(h.deps, { chatId: 3, userId: 4242, text: 'efface' });
  const ticket = reply.pending[0]!;

  assert.match((await resolveApproval(h.deps, { chatId: 3, userId: 999, id: ticket.id, token: ticket.token, approved: true })).message, /ne appartient pas/);
  assert.match((await resolveApproval(h.deps, { chatId: 4, userId: 4242, id: ticket.id, token: ticket.token, approved: true })).message, /ne appartient pas/);
  assert.equal(executed, 0, 'ni un autre utilisateur autorisé, ni un autre chat ne peut consommer le ticket');

  const denied = await resolveApproval(h.deps, { chatId: 3, userId: 4242, id: ticket.id, token: ticket.token, approved: false });
  assert.match(denied.message, /annulée/);
  assert.equal(executed, 0);
  assert.equal(h.store.getApproval(ticket.id)!.status, 'denied');
  h.store.close();
});

test('approbation : jeton forgé refusé, et expiration automatique', async () => {
  let executed = 0;
  const h = harness([called('c1', 'danger_flag'), { text: '?' }], {
    tools: [sensitiveTool('danger_flag', () => (executed += 1))],
    dangerousEnabled: true,
  });
  const reply = await runAgent(h.deps, { chatId: 8, userId: 4242, text: 'danger' });
  const ticket = reply.pending[0]!;
  const forged = await resolveApproval(h.deps, { chatId: 8, userId: 4242, id: ticket.id, token: 'x'.repeat(43), approved: true });
  assert.match(forged.message, /invalide/);
  assert.equal(executed, 0, 'connaître l’id séquentiel ne suffit pas');

  // TTL nul : la demande expire immédiatement et sort de la file.
  const gate = new ApprovalGate(h.store, h.deps.registry, 0);
  const t2 = gate.create(1, 4242, 'danger_flag', {}, 'r')!;
  assert.deepEqual(gate.pending(1).map((a) => a.id).includes(t2.id), false, 'une demande expirée n’est plus présentée');
  const expired = await gate.resolve({ id: t2.id, token: t2.token, userId: 4242, chatId: 1, approved: true, context: { chatId: 1, userId: 4242, config: h.deps.config, store: h.store, requestApproval: async () => false } });
  assert.match(expired.message, /Délai dépassé/);
  assert.equal(executed, 0, 'une demande expirée ne s’exécute jamais rétroactivement');
  h.store.close();
});

test('outil sensible masqué quand le portail est fermé : l’appel est refusé', async () => {
  let executed = 0;
  const h = harness([called('c1', 'send_email'), { text: 'impossible' }], {
    tools: [sensitiveTool('send_email', () => (executed += 1))],
    dangerousEnabled: false,
  });
  await runAgent(h.deps, { chatId: 9, userId: 4242, text: 'envoie' });
  assert.equal(executed, 0);
  const toolMsg = h.llm.requests[1]!.messages.find((m) => m.role === 'tool');
  assert.match(toolMsg?.content ?? '', /désactivé par configuration/);
  h.store.close();
});

// ------------------------------------------------- avis opératif d'un refus ---

function refusingTool(name = 'outil_refus'): Tool {
  return {
    name,
    description: 'outil qui refuse, pour observer ce que le canal reçoit',
    // Un argument déclaré, pas `{}` : le registre refuse les arguments qu'il ne connaît pas,
    // et un test qui en passerait un verrait l'outil exécuté… jamais.
    parameters: { un: { type: 'integer', min: 1, max: 9 } },
    run: () => ({
      status: 'unavailable',
      content: 'Google a refusé cet appel (compte non connecté).',
      userNotice: '🔑 Sur la machine de l’agent : « npm run google:login ».',
    }),
  };
}

test('un refus d’outil remonte son avis opératif au canal, pas seulement au modèle', async () => {
  // `ToolResult.userNotice` était déclaré et produit… sans aucun consommateur. Ces deux tests
  // existent pour qu'un champ d'interface ne puisse plus être une promesse vide : un outil qui
  // « explique » dans un champ lu par personne n'explique rien.
  const h = harness([called('c1', 'outil_refus'), { text: 'je ne peux pas lire Gmail' }], { tools: [refusingTool()] });
  const result = await runAgent(h.deps, { chatId: 5, userId: 4242, text: 'cherche une facture' });
  assert.deepEqual(result.notices, ['🔑 Sur la machine de l’agent : « npm run google:login ».']);
  assert.ok(!result.text.includes('google:login'), "l'avis reste distinct de la réponse : il ne doit pas être lu à voix haute");
  h.store.close();
});

test('deux refus qui répètent le même avis ne produisent qu’un seul message', async () => {
  const h = harness(
    [called('c1', 'outil_refus', { un: 1 }), called('c2', 'outil_refus', { un: 2 }), { text: 'fin' }],
    { tools: [refusingTool()] },
  );
  const result = await runAgent(h.deps, { chatId: 5, userId: 4242, text: 'cherche' });
  assert.equal(result.notices?.length, 1, `notices : ${JSON.stringify(result.notices)}`);
  h.store.close();
});
