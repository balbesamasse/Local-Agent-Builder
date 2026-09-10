/**
 * Rendu Telegram : l'échappement est la barrière anti-injection de mise en
 * forme (et anti-HTML cassé) ; la découpe doit rester valide côté API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackPlain, splitForTelegram, tagsOpenedIn, TELEGRAM_HARD_LIMIT, toTelegramHtml } from '../channels/telegram/format.js';
import { preview } from '../channels/telegram/format.js';

test('toTelegramHtml : le HTML du modèle est neutralisé, nos balises autorisées passent', () => {
  assert.equal(toTelegramHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(toTelegramHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(toTelegramHtml('<div>texte</div>'), '&lt;div&gt;texte&lt;/div&gt;', 'balise non autorisée = texte brut');
  assert.equal(toTelegramHtml('<b>gras</b>'), '<b>gras</b>');
  assert.equal(toTelegramHtml('<code>x</code>'), '<code>x</code>');
  assert.equal(toTelegramHtml('<a href="javascript:alert(1)">cliq</a>'), '&lt;a href=&quot;javascript:alert(1)&quot;&gt;cliq&lt;/a&gt;', 'lien javascript: refusé');
  assert.equal(toTelegramHtml('<a href="https://exemple.fr">cliq</a>'), '<a href="https://exemple.fr">cliq</a>');
});

test('toTelegramHtml : Markdown courant traduit après échappement', () => {
  assert.equal(toTelegramHtml('**important**'), '<b>important</b>');
  assert.equal(toTelegramHtml('du `code` inline'), 'du <code>code</code> inline');
  assert.equal(toTelegramHtml('# Titre'), '<b>Titre</b>');
  assert.equal(toTelegramHtml('- un\n- deux'), '• un\n• deux');
  assert.equal(toTelegramHtml('[site](https://exemple.fr)'), '<a href="https://exemple.fr">site</a>');
  // Un <b> injecté par le Markdown ne doit pas refermer un balisage existant.
  assert.equal(toTelegramHtml('<b>**x**</b>'), '<b><b>x</b></b>');
});

test('toTelegramHtml : une injection de balise dans un lien Markdown est inerte', () => {
  const injected = '[x](https://e.fr)" onmouseover="alert(1)';
  const html = toTelegramHtml(injected);
  // Le lien autorisé est produit ; le reste (guillemet + attribut) reste échappé.
  assert.equal(html, '<a href="https://e.fr">x</a>&quot; onmouseover=&quot;alert(1)');
  assert.equal((html.match(/ onmouseover=/g) ?? []).length, 1, 'l’attribut injecté ne doit jamais être nu');
  assert.equal((html.match(/href="/g) ?? []).length, 1, 'un seul href, celui que nous fabriquons');
});

test('splitForTelegram : chaque morceau respecte la limite dure de 4096', () => {
  const long = Array.from({ length: 400 }, (_, i) => `ligne numéro ${i} avec du texte`).join('\n');
  const html = toTelegramHtml(long);
  const chunks = splitForTelegram(html);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= TELEGRAM_HARD_LIMIT, `chunk trop long : ${chunk.length}`);
  }
  assert.equal(chunks.join('').replace(/\n/g, '').length, html.replace(/\n/g, '').length, 'aucun contenu perdu');
});

test('splitForTelegram : balisage équilibré dans chaque morceau (sinon Telegram renvoie 400)', () => {
  const html = '<pre>' + 'a'.repeat(5000) + '</pre>';
  const chunks = splitForTelegram(html);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.deepEqual(tagsOpenedIn(chunk), [], `balise non refermée dans un morceau : ${chunk.slice(0, 40)}`);
  }
  // Un <b> ouvert avant la coupe doit être rouvert après.
  const bold = `<b>${'m'.repeat(3900)}</b>`;
  const parts = splitForTelegram(bold);
  assert.ok(parts.length >= 2);
  assert.match(parts[1] ?? '', /^<b>/);
});

test('splitForTelegram : texte court = un seul morceau, sans découpe inutile', () => {
  const chunks = splitForTelegram(toTelegramHtml('courts'));
  assert.deepEqual(chunks, ['courts']);
});

test('fallbackPlain : dernier recours, jamais de balise nuante', () => {
  assert.equal(fallbackPlain('<b>x</b> &amp; y'), 'x & y');
  assert.equal(fallbackPlain('<a href="https://e.fr">l</a>'), 'l');
});

test('preview : un seul ligne bornée pour les logs', () => {
  assert.equal(preview('a\nb\nc'), 'a b c');
  assert.equal(preview('x'.repeat(200), 10), `${'x'.repeat(10)}…`);
});
