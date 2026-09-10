/**
 * Cohérence des commandes du canal — trois listes qui doivent dire la meme chose.
 *
 * La faute qui a motive ce fichier : `/voice` etait implemente, decrit dans /help, et
 * absent du menu Telegram. Le bot repondait donc tres bien a la commande, mais personne
 * ne la voyait a cote des autres — un bug muet, sans erreur nulle part, qu'aucun test
 * de comportement ne pouvait attraper. Les trois verifications ci-dessous ferment les
 * trois directions de la derive :
 *
 *   1. tout handler enregistre est dans le menu (ou assume une entree hors menu) ;
 *   2. toute entree du menu a un handler ;
 *   3. /help couvre les memes commandes que le menu.
 *
 * Et un controle de forme, parce que Telegram refuse au-dela de 32 caracteres pour un
 * nom et de 256 pour une description : ce n'est pas un detail de style, c'est un
 * setMyCommands qui echoue au demarrage, en silence.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CHANNEL_COMMANDS, menuCommands } from '../channels/telegram/bot.js';

/** Racine du depot, trouvee depuis le module (marche depuis src/ comme depuis dist/). */
function repoRoot(): string {
  let here = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(here, 'package.json'))) return here;
    here = dirname(here);
  }
  throw new Error('racine de depot introuvable depuis le test');
}

/** Vrai code source du canal et du bootstrap — pas un copie-colle dans le test. */
function read(...parts: string[]): string {
  const p = resolve(repoRoot(), ...parts);
  if (!existsSync(p)) throw new Error(`fichier introuvable : ${p} — le test ne peut plus rien prouver`);
  return readFileSync(p, 'utf8');
}

/** Commandes volontairement hors menu : elles existent, mais les annoncer serait mentir
 * a moitie (`/id` n'est ouverte que si TELEGRAM_ID_COMMAND_ENABLED=true). */
const GATED: ReadonlySet<string> = new Set(['id']);

/** Les noms que le canal enregistre reellement (`bot.command('x', …)`). */
function registeredCommands(): Set<string> {
  const src = read('src', 'channels', 'telegram', 'bot.ts');
  return new Set([...src.matchAll(/bot\.command\(\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1] as string));
}

test('toute commande enregistree est annoncee au client (menu ou aide)', () => {
  // Le menu Telegram ne peut pas contenir de commande avec parametre : /memory et
  // /forget_memory vivent donc dans l'aide, pas dans le menu. Ce qui n'est tolere nulle
  // part, c'est une commande absente des deux — c'est exactement /voice.
  const declared = new Map(CHANNEL_COMMANDS.map((c) => [c.command, c]));
  const missing = [...registeredCommands()].filter((c) => !declared.has(c)).sort();
  assert.deepEqual(missing, [], `commandes invisibles dans le client : ${missing.map((c) => `/${c}`).join(', ')}`);
});

test('une commande avec parametre reste hors menu, et son usage est ecrit comme tel', () => {
  // Telegram refuse une entree de menu dont le nom contient un espace ou un `<` : ce
  // sont les arguments qui la renvoient vers /help, pas un choix de presentation.
  for (const c of CHANNEL_COMMANDS) {
    if (c.args === '') continue;
    assert.match(c.args, /^<[a-z0-9\u00e9\u00e8\u00ea\u00e0\u00e7 -]+>$/, `usage d'argument inattendu pour /${c.command} : ${c.args}`);
    assert.ok(!menuCommands().some((e) => e.command === c.command), `/${c.command} ne peut pas etre au menu avec un parametre`);
    assert.ok(c.help.length > 0, `/${c.command} n'est ni au menu ni expliquee dans /help`);
  }
});

test('une entree hors menu est filtree explicitement dans le bootstrap', () => {
  const entries = menuCommands();
  const src = read('src', 'index.ts');
  for (const c of GATED) {
    const inMenu = entries.some((e) => e.command === c);
    if (!inMenu) continue; // deja exclue a la source, rien a filtrer
    assert.ok(
      new RegExp(`command !== '${c}'|command === '${c}'`).test(src),
      `/${c} est au menu par defaut : le bootstrap doit la filtrer selon son drapeau, sinon le menu promet une commande refusee`,
    );
  }
});

test('le menu ne promet aucune commande morte', () => {
  const declared = new Set(CHANNEL_COMMANDS.map((c) => c.command));
  const registered = registeredCommands();
  const dead = [...declared].filter((c) => !registered.has(c)).sort();
  assert.deepEqual(dead, [], `le menu et /help annoncent des commandes sans handler : ${dead.map((c) => `/${c}`).join(', ')}`);
});

test('/help et le menu decrivent le meme jeu de commandes', () => {
  // /help est derive de CHANNEL_COMMANDS : le verifier dans le source sert a ce que
  // personne ne re-introduise une liste recopiee a la main dans le handler.
  const src = read('src', 'channels', 'telegram', 'bot.ts');
  const help = src.slice(src.indexOf("bot.command('help'"), src.indexOf("bot.command('tools'"));
  assert.match(help, /CHANNEL_COMMANDS/, '/help doit deriver de la liste partagee, pas dune liste recopiee');
  assert.ok(!/const lines: Array<\[string, string\]>/.test(help), 'une seconde liste de commandes dans le handler repartirait en derive');
});

test('le menu est construit a partir du deriveur, pas dune liste recopiee dans le bootstrap', () => {
  const src = read('src', 'index.ts');
  assert.match(src, /setMyCommands\([\s\S]{0,200}menuCommands\(\)/, 'le bootstrap doit appeler menuCommands()');
  assert.ok(
    !/\{\s*command:\s*['"]start['"]/.test(src),
    'des entrees de menu literals dans index.ts vont diverger du canal tot ou tard',
  );
});

test('les entrees de menu respectent les limites de lAPI Telegram', () => {
  const entries = menuCommands();
  assert.ok(entries.length >= 8, `un menu a moitie vide ne rend pas service : ${entries.length} entree(s)`);
  for (const e of entries) {
    assert.match(e.command, /^[a-z0-9_]{1,32}$/, `nom de commande refusé par Telegram : ${e.command}`);
    assert.ok(e.description.length > 0 && e.description.length <= 256, `description hors bornes pour /${e.command}`);
    assert.ok(!/[\n\t]/.test(e.description), `une description multiline casse le menu : /${e.command}`);
  }
});
