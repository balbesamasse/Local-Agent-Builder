import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../memory/store.js';

function freshStore(): Store {
  return new Store(':memory:');
}

test('messages : fenêtre glissante chronologique, uniquement user/assistant', () => {
  const store = freshStore();
  for (let i = 1; i <= 6; i += 1) {
    store.addMessage({ chatId: 7, role: i % 2 === 0 ? 'assistant' : 'user', content: `msg-${i}` });
  }
  store.addMessage({ chatId: 7, role: 'tool', content: 'sortie-outil', toolName: 'get_current_time' });
  store.addMessage({ chatId: 999, role: 'user', content: 'autre-conversation' });

  const window = store.recentMessages(7, 3);
  assert.deepEqual(
    window.map((m) => m.content),
    ['msg-4', 'msg-5', 'msg-6'],
    'la fenêtre doit prendre les N derniers dans l’ordre chronologique',
  );
  assert.ok(
    window.every((m) => m.role === 'user' || m.role === 'assistant'),
    'les messages d’outil ne doivent pas être rejoués au modèle',
  );
  store.close();
});

test('mémoire : recherche par mots-clés pondérée par la récence', () => {
  const store = freshStore();
  store.addMemory({ chatId: 1, content: "L'utilisateur préfère les réponses courtes", kind: 'preference' });
  store.addMemory({ chatId: 1, content: "Le projet s'appelle OpenGravity", kind: 'projet' });
  store.addMemory({ chatId: 2, content: 'OpenGravity dans un autre chat, non visible ici', kind: 'fait' });

  const hits = store.searchMemories(1, 'opengravity projet', 5);
  assert.equal(hits.length, 1, 'un seul souvenir correspond');
  assert.match(hits[0]!.content, /OpenGravity/);

  assert.equal(store.searchMemories(1, 'zzzz_introuvable', 5).length, 0);
  assert.equal(store.countMemories(1), 2);
  assert.equal(store.countMemories(2), 1, 'cloisonnement par chat respecté');
  store.close();
});

test('mémoire : la pertinence prime sur la récence (garde-foul contre un score NULL)', () => {
  const store = freshStore();
  // « café noir sans sucre » est ANCIEN mais répond aux deux termes ;
  // « café au lait » est récent mais n'en répond qu'un. Si le score tombe à NULL
  // (bug julianday sur epoch-ms), c'est le plus récent qui gagne et le test échoue.
  store.addMemory({ chatId: 1, content: 'café noir sans sucre', kind: 'preference' });
  store.addMemory({ chatId: 1, content: 'café au lait', kind: 'preference' });
  store.touchMemory(1, Date.now() - 400 * 86400000);
  store.touchMemory(2, Date.now());

  const hits = store.searchMemories(1, 'café noir', 5);
  assert.equal(hits.length, 2, 'les deux souvenirs correspondent au moins à un terme');
  assert.match(hits[0]!.content, /café noir/, 'le plus pertinent doit passer en tête malgré sa vieillesse');

  // Et le score doit être un nombre, jamais NULL : on le vérifie par l’ordre relatif.
  const uneSeule = store.searchMemories(1, 'sucre', 5);
  assert.deepEqual(uneSeule.map((m) => m.content), ['café noir sans sucre']);
  store.close();
});

test('mémoire : le plafond purge les plus anciens et laisse les plus récents', () => {
  const store = freshStore();
  for (let i = 1; i <= 5; i += 1) {
    store.addMemory({ chatId: 1, content: `souvenir ${i}` });
    // updatedAt identique sinon : on force un écart temporel observable.
    store.touchMemory(i, Date.now() + i * 1000);
  }
  const removed = store.enforceMemoryCap(1, 3);
  assert.equal(removed, 2);
  const kept = store.listMemories(1, 10).map((m) => m.id);
  assert.deepEqual(kept, [5, 4, 3], 'on garde les plus récemment touchés');
  store.close();
});

test('approbations : expiration marquée, et un ticket consommé ne rejoue pas', () => {
  const store = freshStore();
  const approval = store.createApproval({
    chatId: 1,
    userId: 4242,
    toolName: 'dangerous_tool',
    args: { cible: '/etc/passwd' },
    reason: 'test',
    ttlMinutes: 15,
    tokenFingerprint: 'abc123',
  });
  assert.equal(store.pendingApprovalsForChat(1).length, 1);
  assert.equal(store.getApprovalTokenFingerprint(approval.id), 'abc123');

  store.consumeApprovalToken(approval.id);
  assert.equal(store.getApprovalTokenFingerprint(approval.id), null, 'le jeton doit être détruit à l’usage');

  store.decideApproval(approval.id, 'approved');
  assert.equal(store.pendingApprovalsForChat(1).length, 0);

  const stale = store.createApproval({
    chatId: 1,
    userId: 4242,
    toolName: 'x',
    args: {},
    reason: 'r',
    ttlMinutes: -1, // déjà expirée
    tokenFingerprint: 'zzz',
  });
  assert.equal(store.pendingApprovalsForChat(1).length, 0, 'une demande expirée sort de la file');
  assert.equal(store.getApproval(stale.id)?.status, 'expired');
  store.close();
});

test('audit : les appels d’outils sont journalisés, sorties tronquées', () => {
  const store = freshStore();
  store.logToolCall({ chatId: 1, userId: 4242, toolName: 'calculator', args: { expression: '1+1' }, status: 'ok', output: 'x'.repeat(5000) });
  const rows = store.recentAudit(1, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.toolName, 'calculator');
  assert.equal(rows[0]!.status, 'ok');
  store.close();
});

test('clearHistory ne touche pas la mémoire longue durée', () => {
  const store = freshStore();
  store.addMessage({ chatId: 1, role: 'user', content: 'a' });
  const memory = store.addMemory({ chatId: 1, content: 'à conserver' });
  assert.equal(store.clearHistory(1), 1);
  assert.equal(store.recentMessages(1, 10).length, 0);
  assert.equal(store.getMemory(memory.id)?.content, 'à conserver');
  store.close();
});
