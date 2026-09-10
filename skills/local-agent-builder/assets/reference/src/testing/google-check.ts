/**
 * Diagnostic de bout en bout de l'intégration Google (`npm run google:check`).
 *
 * Écrit parce qu'une installation « les fichiers sont en place » ne vaut rien : ce qui compte est
 * de savoir si un appel part, où il coinche, et quoi taper pour que ça passe. Chaque étape rend
 * une ligne d'état et, en cas de blocage, la commande qui débloque.
 *
 * Le code de sortie est un contrat : 0 = la chaîne est utilisable, 1 = un maillon manque,
 * 78 = configuration refusée (le même code que l'agent, pour qu'un script de déploiement n'ait
 * pas deux logiques à tenir).
 *
 * Aucune donnée personnelle n'est imprimée : ni objet de mail, ni nom de fichier, ni titre
 * d'événement — uniquement des comptes et des formes. Le stdout d'un diagnostic finit dans un
 * journal, et un journal se partage plus souvent qu'une boîte mail.
 */
import { loadConfig, ConfigError, type AppConfig } from '../config.js';
import { GwsCliTransport, staleAdcPointer } from '../google/gws-cli-transport.js';
import { readAuthState, expectedScopes, formatAuthState } from '../google/auth.js';
import { googleTools } from '../google/tools.js';
import { buildRegistry } from '../tools/index.js';
import { googleChildEnv } from '../google/index.js';
import { calendarEvents, driveHits, gmailListIds, sheetRows } from '../google/format.js';
import { paramsFlag } from '../google/transport.js';

const OFFLINE = process.argv.includes('--offline');

interface Step {
  label: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const steps: Step[] = [];
function step(label: string, ok: boolean, detail: string, fix?: string): void {
  steps.push({ label, ok, detail, fix });
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${label.padEnd(34)} ${detail}`);
  if (!ok && fix !== undefined) console.log(`  → ${fix}`);
}

async function main(): Promise<number> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`✗ configuration refusée — ${error.message}`);
      return 78;
    }
    throw error;
  }

  console.log('— état de l’intégration Google Workspace —');
  step('capacité', config.googleEnabled, config.googleEnabled ? 'GOOGLE_ENABLED=true' : 'GOOGLE_ENABLED=false (les outils ne sont pas déclarés)', 'mettre GOOGLE_ENABLED="true" dans .env');

  const transport = new GwsCliTransport({
    bin: config.googleBin,
    workspaceRoot: config.workspaceRoot,
    timeoutMs: config.googleTimeoutMs,
    maxOutputBytes: config.googleMaxOutputBytes,
    maxInFlight: config.googleMaxInFlight,
    readAttempts: config.googleReadAttempts,
    env: googleChildEnv(config),
    parentEnv: process.env,
  });

  const probe = await transport.probe();
  step('client gws', transport.info.reachable, `${transport.info.bin.replace(/^.*\/node_modules\//, 'node_modules/')} · version ${transport.info.version}`, probe.note ?? 'npm install dans le dépôt de l’agent');

  const adc = staleAdcPointer(process.env, config.workspaceRoot);
  step('pointeur ADC', adc === undefined, adc === undefined ? 'aucun GOOGLE_APPLICATION_CREDENTIALS mort dans l’environnement' : adc, 'retirer la clé du .env, ou créer le fichier qu’elle nomme');

  const services = [...config.googleServices].filter((name) => name !== 'auth');
  const auth = await readAuthState(transport, { services, writesEnabled: config.googleAllowWrites && config.dangerousToolsEnabled, adcWarning: adc });
  step('compte connecté', auth.authenticated, auth.authenticated ? `méthode ${auth.method} · magasin ${auth.storage} · trousseau ${auth.keyringBackend}` : 'aucun (le CLI rend un code 0 là-dessus : c’est le corps qui parle)', 'npm run google:login');
  if (!auth.paths.clientConfigExists) {
    step('client OAuth', false, `${auth.paths.clientConfig || '~/.config/gws/client_secret.json'} absent`, 'npm run google:setup (une seule fois, sur la machine de l’agent)');
  } else {
    step('client OAuth', true, 'présent');
  }
  step('scopes attendus', true, `${expectedScopes(services, config.googleAllowWrites && config.dangerousToolsEnabled).length} scope(s) pour ${services.join(', ')} — un compte en mode test est limité à ~25 scopes, ne demande pas le préréglage complet`);

  const bundle = googleTools(config, transport);
  const registry = buildRegistry(config, bundle.tools);
  const googleNames = bundle.tools.map((tool) => tool.name);
  step(
    'outils déclarés au modèle',
    googleNames.length > 0 && config.googleEnabled,
    config.googleEnabled
      ? `${googleNames.length} sur ${registry.size} outils du registre : ${googleNames.join(', ') || 'aucun'}`
      : `${googleNames.length} outils prêts, mais la capacité est éteinte : au démarrage, aucun ne serait déclaré`,
    'GWS_SERVICES couvre-t-il un service ? puis GOOGLE_ENABLED=true',
  );
  step('écritures', bundle.writesExposed, bundle.writesExposed ? 'activées — chaque appel passera par un clic de confirmation' : 'verrouillées (GWS_ALLOW_WRITES et DANGEROUS_TOOLS_ENABLED)', 'les deux verrous, puis relogin si les scopes d’écriture manquent');

  // Construction de la requete, verifiee sur le binaire reel sans reseau ni compte : c'est la
  // moitie du trajet qui ne depend pas de l'utilisateur, et c'est la seule partie que l'on peut
  // prouver ici.
  const built = await transport.run({
    service: 'gmail',
    argv: ['gmail', 'users', 'messages', 'list', '--params', paramsFlag({ userId: 'me', q: 'newer_than:1d', maxResults: 1 })],
    write: false,
    label: 'check/dry-run',
    dryRun: true,
  });
  const dryUrl = built.ok ? String((built.value as Record<string, unknown> | undefined)?.['url'] ?? '') : '';
  step('construction de la requête', dryUrl.includes('gmail.googleapis.com'), dryUrl === '' ? `le CLI n'a pas rendu de requête (${built.failure?.message ?? 'sortie illisible'})` : `GET ${dryUrl}`, auth.authenticated ? undefined : 'npm run google:setup puis npm run google:login');

  if (auth.authenticated && !OFFLINE) {
    // Un appel reel, un seul, et seulement ce qui prouve le trajet : des comptes, pas du contenu.
    const calendar = await transport.run({
      service: 'calendar',
      argv: ['calendar', 'events', 'list', '--params', paramsFlag({ calendarId: 'primary', timeMin: new Date().toISOString(), timeMax: new Date(Date.now() + 86_400_000 * 7).toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 5 })],
      write: false,
      label: 'check/calendar',
    });
    if (calendar.ok) {
      const events = calendarEvents(calendar.value);
      step('lecture Google réelle', true, `calendrier : ${events.length} événement(s) dans les 7 prochains jours (contenu non affiché)`);
    } else {
      step('lecture Google réelle', false, `refus : ${calendar.failure?.message ?? 'erreur inconnue'}`, calendar.failure?.needsReauth === true ? 'npm run google:login' : 'voir la ligne « scopes attendus »');
    }

    const drive = await transport.run({ service: 'drive', argv: ['drive', 'files', 'list', '--params', paramsFlag({ pageSize: 3, fields: 'files(id,name,mimeType)' })], write: false, label: 'check/drive' });
    step('accès Drive', drive.ok, drive.ok ? `${driveHits(drive.value).length} fichier(s) lisibles sur 3 demandés` : `refus : ${drive.failure?.message ?? 'erreur inconnue'}`);
  } else if (!auth.authenticated) {
    step('lecture Google réelle', false, 'non tentée : aucun compte connecté', 'npm run google:login puis relancer cette commande');
  } else {
    step('lecture Google réelle', true, 'ignorée (--offline) : la construction de requête est vérifiée, le réseau non');
  }

  // Deux appels a la forme : ils sont censes echouer sans compte, et ce qu'on verifie ici n'est
  // pas la reponse de Google mais que nos extracteurs ne cassent pas sur une reponse d'erreur
  // (un `?? []` manquant transformerait un 401 en plantage de l'agent).
  const sheetsProbe = await transport.run({ service: 'sheets', argv: ['sheets', 'spreadsheets', 'values', 'get', '--params', paramsFlag({ spreadsheetId: 'FORME', range: 'A1:B2' })], write: false, label: 'check/sheets-forme' });
  step(
    'extraction sans plantage',
    true,
    `sur une réponse ${sheetsProbe.ok ? 'saine' : `refusée (${sheetsProbe.failure?.kind ?? 'inconnu'})`} : ${sheetRows(sheetsProbe.value).length} ligne(s), ${gmailListIds(sheetsProbe.value).ids.length} id — aucun extracteur n'a levé`,
  );

  const gmailShape = await transport.run({ service: 'gmail', argv: ['gmail', 'users', 'messages', 'list', '--params', paramsFlag({ userId: 'me', q: 'in:inbox', maxResults: 1 })], write: false, label: 'check/gmail-forme' });
  step('chemin gmail jusqu’au bout', gmailShape.ok, gmailShape.ok ? `réponse acceptée · ${gmailListIds(gmailShape.value).ids.length} id extrait(s)` : `refus Google nommé : ${gmailShape.failure?.kind ?? 'inconnu'} — ${gmailShape.failure?.message.slice(0, 90) ?? ''}`, 'npm run google:login');

  const blocking = steps.filter((entry) => !entry.ok);
  console.log('');
  console.log(formatAuthState(auth, config.googleEnabled, services).split('\n').map((line) => `  ${line}`).join('\n'));
  console.log('');
  if (blocking.length === 0) {
    console.log('✓ chaîne complète vérifiée : Telegram → agent → outils → gws → Google → agent → Telegram.');
    console.log('  Réponse attendue dans Telegram : « cherche un mail sur les factures ».');
    return 0;
  }
  console.log(`✗ ${blocking.length} maillon(s) à reprendre, listés ci-dessus avec la commande qui les répare.`);
  console.log('  Le compte se connecte sur la machine de l’agent : ni mot de passe, ni client_secret, ni token dans Telegram ni dans le dépôt.');
  return 1;
}

main().then((code) => process.exit(code)).catch((error: unknown) => {
  console.error(`✗ diagnostic en échec : ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
  process.exit(1);
});
