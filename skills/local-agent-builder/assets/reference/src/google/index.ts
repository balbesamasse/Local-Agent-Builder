/**
 * Côté Google de l'agent : construction du transport, choix de ce qui est déclaré au modèle.
 *
 * Regle appliquee ici, dans le sens de la voix : **une capacite dont le MOYEN d'acces existe est
 * declaree**, meme quand l'etat du compte empeche de repondre. Un binaire absent retire les outils
 * (rien a appeler) ; un compte non connecte les laisse la, avec la raison ecrite au demarrage, une
 * reponse d'outil qui nomme `npm run google:login` et un `/google` qui explique. Retirer les outils
 * faute de connexion rendrait la reparation invisible a l'usage et imposerait un redemarrage apres
 * chaque login : un refus explique vaut mieux qu'une absence silencieuse.
 *
 * Le contrat `gws` n'existe pas dans les versions antérieures à 0.8.0 et son sous-ordre MCP a
 * été retiré depuis : ce module parle donc au CLI, par processus fils, sans port ni démon.
 */
import { GwsCliTransport } from './gws-cli-transport.js';
import { readAuthState, formatAuthState, type GoogleAuthState } from './auth.js';
import { googleTools } from './tools.js';
import type { Tool } from '../tools/registry.js';
import type { AppConfig } from '../config.js';
import { log } from '../core/logger.js';

export interface GoogleRuntime {
  transport: GwsCliTransport;
  tools: Tool[];
  services: string[];
  writesExposed: boolean;
  /** Dernier état d'authentification connu (relu à chaque `/google`). */
  auth: GoogleAuthState;
  refresh(): Promise<GoogleAuthState>;
  statusMessage(): Promise<string>;
  close(): Promise<void>;
}

/** Ce que le fils reçoit comme environnement — une liste close, construite depuis la config. */
export function googleChildEnv(config: AppConfig): Record<string, string> {
  const env: Record<string, string> = {
    GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: config.googleKeyringBackend,
    // Le CLI appelle les API avec son propre user-agent ; coller le nôtre ne sert rien et
    // brouillerait un diagnostic côté Google.
  };
  if (config.googleCredentialsFile !== '') env['GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE'] = config.googleCredentialsFile;
  if (config.googleProjectId !== '') env['GOOGLE_WORKSPACE_PROJECT_ID'] = config.googleProjectId;
  return env;
}

export interface GoogleRuntimeOutcome {
  runtime: GoogleRuntime | undefined;
  warnings: string[];
}

/**
 * Renvoie `undefined` (et jamais une exception) quand Google ne peut pas être servi : un bot
 * muet sur Gmail vaut mieux qu'un bot qui ne démarre pas. La raison est dans `warnings`, écrite
 * par l'appelant dans le journal de démarrage.
 */
export async function createGoogleRuntime(config: AppConfig): Promise<GoogleRuntimeOutcome> {
  const warnings: string[] = [];
  if (!config.googleEnabled) return { runtime: undefined, warnings };

  const transport = new GwsCliTransport({
    bin: config.googleBin,
    workspaceRoot: config.workspaceRoot,
    timeoutMs: config.googleTimeoutMs,
    maxOutputBytes: config.googleMaxOutputBytes,
    maxInFlight: config.googleMaxInFlight,
    readAttempts: config.googleReadAttempts,
    env: googleChildEnv(config),
  });

  const probe = await transport.probe();
  if (probe.note !== undefined) warnings.push(probe.note);
  if (!transport.info.reachable) {
    warnings.push('outils Google non déclarés : le client `gws` ne répond pas. « npm install » dans le dépôt, puis relance.');
    return { runtime: undefined, warnings };
  }

  // Les outils sont declares des que le MOYEN D'ACCES existe. L'etat du compte, lui, est verifie
  // a l'usage et annonce : un outil retire faute de connexion est un outil que le modele ne peut
  // meme pas essayer, donc un utilisateur qui voit « ça marche pas » sans jamais voir la cause,
  // et un `npm run google:login` qui oblige a redemarrer l'agent pour rien.
  const auth = await readAuthState(transport, {
    services: [...config.googleServices].filter((s) => s !== 'auth'),
    writesEnabled: config.googleAllowWrites && config.dangerousToolsEnabled,
    adcWarning: transport.info.adcHint,
  });
  for (const line of auth.diagnosis) warnings.push(line);
  if (!auth.authenticated) {
    warnings.push("aucun compte connecté : les outils Google répondront « accès refusé » tant que « npm run google:login » n'aura pas été fait — inutile de redémarrer l'agent après.");
  }

  const bundle = googleTools(config, transport);
  // Contrôle de forme de l'environnement du fils : une clé de fournisseur qui se promènerait là
  // est une faute de câblage, pas un réglage. Le transport le fait, lui qui construit cet
  // environnement — deux calculateurs du même diagnostic finissent par diverger.
  const env = transport.envDiagnostics();
  for (const note of env.notes) if (!warnings.includes(note)) warnings.push(note);
  if (env.leaks.length > 0) {
    warnings.push(`environnement du client Google contient des clés étrangères (${env.leaks.join(', ')}) — appel refusé tant que ce n'est pas corrigé`);
    await transport.close('clés étrangères');
    return { runtime: undefined, warnings };
  }

  let latest = auth;
  const runtime: GoogleRuntime = {
    transport,
    tools: bundle.tools,
    services: bundle.services,
    writesExposed: bundle.writesExposed,
    auth: latest,
    async refresh() {
      latest = await readAuthState(transport, {
        services: [...config.googleServices].filter((s) => s !== 'auth'),
        writesEnabled: config.googleAllowWrites && config.dangerousToolsEnabled,
        adcWarning: transport.info.adcHint,
      });
      runtime.auth = latest;
      return latest;
    },
    async statusMessage() {
      const state = await runtime.refresh();
      return formatAuthState(state, config.googleEnabled, bundle.services);
    },
    async close() {
      await transport.close('arrêt de l’agent');
    },
  };

  log.info('google workspace câblé', {
    binaire: transport.info.bin,
    version: transport.info.version,
    services: bundle.services.join(',') || 'aucun',
    outils: bundle.tools.length,
    ecritures: bundle.writesExposed ? 'activées (confirmation humaine)' : 'verrouillées',
    magasin: `${latest.storage} · trousseau ${latest.keyringBackend}`,
  });
  return { runtime, warnings };
}

/**
 * Réponse de `/google` quand la capacité n'est pas câblée : l'état, les raisons relevées au
 * démarrage, et la commande qui répare. Un menu qui affiche une entrée muette est pire qu'une
 * entrée absente — c'est ce qui a été appris sur `/call`.
 */
export async function googleUnavailableStatus(config: AppConfig, warnings: readonly string[]): Promise<string> {
  const head = config.googleEnabled
    ? '🔑 Google Workspace — activé dans la configuration, mais non câblé à ce démarrage.'
    : '🔑 Google Workspace — désactivé (GOOGLE_ENABLED=false).';
  const reasons = warnings.length === 0 ? ["Aucune raison relevée : relance « npm run google:check » pour redemander l'état au client."] : warnings;
  const steps = [
    '1. « npm install » — le client `gws` est une dépendance du projet.',
    '2. « npm run google:setup » sur la machine de l’agent — une seule fois (projet Google Cloud, client OAuth, écran de consentement).',
    '3. « npm run google:login » — le navigateur s’ouvre, tu choisis les services. Rien ne passe par Telegram.',
    '4. « npm run google:check » puis redémarrer l’agent.',
  ];
  return [head, '', 'ce qui manque :', ...reasons.map((w) => `• ${w.slice(0, 300)}`), '', 'dans l’ordre :', ...steps].join('\n');
}

export { explainFailure } from './envelope.js';
export { redact, safeExcerpt } from './redact.js';
export { readAuthState, formatAuthState, expectedScopes } from './auth.js';
export type { GoogleAuthState } from './auth.js';
export type { GoogleTransport, GoogleCall } from './transport.js';
export { GOOGLE_SERVICES } from './transport.js';
export { childEnvironment, resolveGwsBin, staleAdcPointer, forbiddenInheritedKeys } from './gws-cli-transport.js';
