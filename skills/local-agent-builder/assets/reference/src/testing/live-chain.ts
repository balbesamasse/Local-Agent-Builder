/**
 * Vérification réelle de la chaîne complete (`npm run google:live`).
 *
 * `google:check` prouve les maillons un par un. Ce script prouve le trajet entier, avec les
 * modules de production dans le meme ordre qu'au demarrage : config validee → secrets masques →
 * runtime Google (binaire reel) → registre → boucle d'agent (LLM reel) → appel d'outil →
 * `gws` → Google → reponse → Telegram.
 *
 * Deux limites, dites a voix haute plutot que cachees :
 *   - la base de memoire utilisee est une base JETABLE : un test ne doit pas laisser un tour
 *     fictif dans l'historique reel de l'utilisateur ;
 *   - le message part bien dans la vraie conversation Telegram, precede d'une marque
 *     « verification » : une reponse d'agent sans contexte, dans un chat, se prend pour une
 *     hallucination ou pour une intrusion.
 *
 * Aucun contenu personnel n'est ecrit dans la sortie : ni objet de mail, ni nom de fichier.
 * Un diagnostic se partage, une boite mail non.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from 'grammy';
import { loadConfig, type AppConfig } from '../config.js';
import { log, registerSecrets } from '../core/logger.js';
import { Store } from '../memory/store.js';
import { buildProviders, LlmChain } from '../llm/providers.js';
import { buildRegistry } from '../tools/index.js';
import { ApprovalGate } from '../security/approvals.js';
import { runAgent, type AgentDeps } from '../core/agent.js';
import { createGoogleRuntime } from '../google/index.js';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? String(process.argv[index + 1]) : fallback;
}

async function main(): Promise<number> {
  const config: AppConfig = loadConfig();
  // Masquage avant toute sortie, comme dans `index.ts` : un test qui imprime un token n'est
  // pas plus prive qu'un journal qui le fait.
  registerSecrets([config.telegramBotToken, config.groqApiKey, config.openRouterApiKey, config.elevenLabsApiKey]);

  const message = arg(
    'message',
    'Cherche dans mes mails si j’ai reçu une facture de SUTEL ce mois-ci. Si tu ne peux pas, dis-moi exactement quoi faire.',
  );
  const chatId = Number(arg('chat', String([...config.allowedUserIds][0] ?? '')));
  if (!Number.isFinite(chatId)) {
    console.error('✗ aucun chat cible : TELEGRAM_ALLOWED_USER_IDS est vide et --chat n’a pas été passé');
    return 78;
  }
  if (!config.allowedUserIds.has(chatId)) {
    console.error(`✗ le chat ${chatId} n’est pas dans la liste blanche — refus (la liste blanche s’applique aussi aux tests)`);
    return 78;
  }

  const dir = mkdtempSync(join(tmpdir(), 'og-live-'));
  const store = new Store(join(dir, 'live.db'));
  const google = await createGoogleRuntime(config);
  for (const warning of google.warnings) log.warn(warning);

  const registry = buildRegistry(config, google.runtime?.tools ?? []);
  const gate = new ApprovalGate(store, registry, config.approvalTtlMinutes);
  const providers = buildProviders(config);
  const llm = new LlmChain(providers);
  const deps: AgentDeps = { config, llm, store, registry, gate };

  const googleToolsDeclared = registry.names().filter((name) => name.startsWith('gmail_') || name.startsWith('drive_') || name.startsWith('docs_') || name.startsWith('sheets_') || name.startsWith('calendar_'));
  console.log('— maillons visibles depuis ce test —');
  console.log(`  client Google   : ${google.runtime === undefined ? 'non câblé (voir les lignes ci-dessus)' : `gws ${google.runtime.transport.info.version} · ${google.runtime.auth.authenticated ? 'compte connecté' : 'aucun compte connecté'}`}`);
  console.log(`  outils Google  : ${googleToolsDeclared.length === 0 ? 'aucun déclaré' : googleToolsDeclared.join(', ')}`);
  console.log(`  fournisseurs    : ${providers.length} chaîné(s) · modèle ${config.groqModel}`);
  console.log(`  destination    : Telegram chat ${chatId}\n`);

  const started = Date.now();
  const reply = await runAgent(deps, { chatId, userId: chatId, text: message, channel: 'telegram' });
  const audit = store.recentAudit(chatId, 6);
  console.log('— résultat du tour —');
  console.log(`  itérations     : ${reply.iterations} · appels d’outils : ${reply.toolCalls} · ${reply.provider}/${reply.model} en ${Date.now() - started} ms`);
  for (const row of audit) console.log(`  audit          : ${row.toolName} → ${row.status}`);
  console.log(`  réponse        : ${reply.text.slice(0, 900).replace(/\n/g, '\n                 ')}`);
  for (const notice of reply.notices ?? []) console.log(`  avis operatif  : ${notice.slice(0, 300)}`);
  // Un avis sans consommateur est le defaut qui a fait ecrire ce script : le verifier ici vaut
  // mieux qu'un champ `userNotice` plein et jete.
  if ((reply.notices ?? []).length === 0) console.log('  avis operatif  : (aucun)');

  // Livraison reelle dans Telegram : c'est la moitie du trajet qu'aucun test unitaire ne peut
  // voir, et c'est exactement celle ou « rien ne se passe » a deja voulu dire « rien n'a ete envoye ».
  const bot = new Bot(config.telegramBotToken);
  const text = `🧪 vérification Google — ${reply.text}`;
  let delivered = true;
  try {
    await bot.api.sendMessage(chatId, text.slice(0, 4000));
    for (const notice of reply.notices ?? []) {
      // Message separe, comme dans le bot : mele a la reponse, l'avis serait prononce en appel.
      await bot.api.sendMessage(chatId, notice).catch((err: unknown) => {
        console.error(`  ✗ avis non délivré : ${err instanceof Error ? err.message.slice(0, 160) : 'erreur inconnue'}`);
      });
    }
  } catch (error) {
    delivered = false;
    console.error(`  ✗ réponse non délivrée dans Telegram : ${error instanceof Error ? error.message.slice(0, 200) : 'erreur inconnue'}`);
  } finally {
    await bot.stop();
  }

  await google.runtime?.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });

  const toolReached = reply.toolCalls > 0;
  console.log('');
  if (toolReached && delivered) {
    console.log('✓ trajet complet exécuté : question → modèle → outil Google → gws → Google → modèle → Telegram.');
    console.log('  Si la réponse dit « accès refusé », le maillon manquant est la connexion du compte : npm run google:login.');
    return 0;
  }
  if (!toolReached) {
    console.log('✗ le modèle n’a appelé aucun outil : la capacité Google n’était pas déclarée, ou la question ne l’a pas concerné.');
    return 1;
  }
  console.log('✗ le tour est bon mais la livraison Telegram a échoué.');
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`✗ vérification en échec : ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    process.exit(1);
  });
