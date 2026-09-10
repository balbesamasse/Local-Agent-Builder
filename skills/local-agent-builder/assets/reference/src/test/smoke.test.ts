/** Vérifie que la pile de production s'importe sans effet de bord (hors réseau). */
import test from 'node:test';
import assert from 'node:assert/strict';

test('les modules du noyau s’importent', async () => {
  const core = await import('../core/agent.js');
  assert.equal(typeof core.runAgent, 'function');
  const prompts = await import('../core/prompts.js');
  const prompt = prompts.buildSystemPrompt({
    agentName: 'OpenGravity',
    timezone: 'Africa/Bamako',
    toolNames: ['get_current_time'],
    approvedByOwnerOnly: true,
  });
  assert.match(prompt, /OpenGravity/);
  assert.match(prompt, /get_current_time/);
  assert.match(prompt, /DONNÉE/u);
});
