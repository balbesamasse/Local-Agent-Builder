/**
 * État de l'authentification Google.
 *
 * Règle fondatrice, mesurée ici : `gws auth status` rend un code de sortie **0** alors qu'il
 * annonce `"auth_method": "none"`. Un contrôle qui ne regarde que le code déclare un bot sain
 * alors qu'aucun compte n'est connecté — et l'agent passe son temps à répondre « Google a
 * refusé » à un utilisateur qui croit avoir tout configuré. Le diagnostic se lit donc dans le
 * corps de la réponse ; le code de sortie ne sert qu'à signaler que la question n'a pas pu être
 * posée.
 *
 * Ordre de priorité des credentials, relevé dans la documentation du CLI (et vérifié par les
 * champs renvoyés) : jeton dans l'environnement, puis fichier de credentials, puis magasin
 * chiffré alimenté par `gws auth login`.
 */
import { redact } from './redact.js';
import type { GoogleTransport } from './transport.js';

export interface GoogleAuthState {
  /** Le binaire répond-il (installé) — distinct de « authentifié ». */
  installed: boolean;
  version: string;
  /** Un compte est connecté et ses credentials sont lisibles par le CLI. */
  authenticated: boolean;
  /** `none` | `encrypted` | `plain` | `credentials_file` | `token` selon les champs rendus. */
  method: string;
  storage: string;
  keyringBackend: string;
  paths: { clientConfig: string; clientConfigExists: boolean; encrypted: string; encryptedExists: boolean; plain: string; plainExists: boolean; tokenCache: boolean };
  /** Ce que le CLI a répondu mot pour mot, expurgé — utile au journal, jamais au modèle. */
  raw: string;
  /** Phrases d'action, dans l'ordre où les suivre. */
  diagnosis: string[];
}

export interface GoogleAuthProbeOptions {
  /** Le projet exige que le compte ait été connecté avec ces services (scopes) pour les outils activés. */
  services: readonly string[];
  writesEnabled: boolean;
  /** true si une clé ADC morte traîne dans l'environnement (source de refus obscurs). */
  adcWarning?: string;
  /** Le magasin de l'utilisateur est joignable sur cette machine (pas de trousseau systeme). */
  keyringAvailable?: boolean;
}

/** `gws auth status` ne liste pas les scopes : on les déduit des services demandes au login. */
export function expectedScopes(services: readonly string[], writesEnabled: boolean): string[] {
  const readonlyScope = (service: string): string | undefined => {
    switch (service) {
      case 'gmail':
        return 'https://www.googleapis.com/auth/gmail.readonly';
      case 'drive':
        return 'https://www.googleapis.com/auth/drive.readonly';
      case 'docs':
        return 'https://www.googleapis.com/auth/documents.readonly';
      case 'sheets':
        return 'https://www.googleapis.com/auth/spreadsheets.readonly';
      case 'calendar':
        return 'https://www.googleapis.com/auth/calendar.readonly';
      case 'tasks':
        return 'https://www.googleapis.com/auth/tasks.readonly';
      default:
        return undefined;
    }
  };
  const writeScope = (service: string): string | undefined => {
    switch (service) {
      case 'gmail':
        return 'https://www.googleapis.com/auth/gmail.send';
      case 'drive':
        return 'https://www.googleapis.com/auth/drive.file';
      case 'docs':
        return 'https://www.googleapis.com/auth/documents';
      case 'sheets':
        return 'https://www.googleapis.com/auth/spreadsheets';
      case 'calendar':
        return 'https://www.googleapis.com/auth/calendar.events';
      case 'tasks':
        return 'https://www.googleapis.com/auth/tasks';
      default:
        return undefined;
    }
  };
  const scopes: string[] = [];
  for (const service of services) {
    const read = readonlyScope(service);
    if (read !== undefined) scopes.push(read);
    if (writesEnabled) {
      const write = writeScope(service);
      if (write !== undefined && !scopes.includes(write)) scopes.push(write);
    }
  }
  return scopes;
}

export async function readAuthState(transport: GoogleTransport, options: GoogleAuthProbeOptions): Promise<GoogleAuthState> {
  const outcome = await transport.run({ service: 'auth', argv: ['auth', 'status'], write: false, label: 'google auth status' });
  const raw = redact(outcome.excerpt).slice(0, 1200);
  const payload = (outcome.value ?? {}) as Record<string, unknown>;
  const flag = (key: string): boolean => payload[key] === true;
  const str = (key: string): string => (typeof payload[key] === 'string' ? (payload[key] as string) : '');

  const authMethod = str('auth_method');
  const credentialSource = str('credential_source');
  // Le corps, pas le code : `auth_method: none` avec exit 0 est l'état normal d'un non-connecté.
  const authenticated = authMethod !== '' && authMethod !== 'none';

  const diagnosis: string[] = [];
  if (!transport.info.reachable) {
    diagnosis.push("Installe le client : « npm install » dans le dépôt (le paquet @googleworkspace/cli fournit le binaire gws).");
  }
  if (!flag('client_config_exists')) {
    diagnosis.push(`Crée le client OAuth : « npm run google:setup » (ou dépose un client_secret.json dans ${str('client_config') || '~/.config/gws/'}).`);
  }
  if (!authenticated) {
    diagnosis.push(`Connecte le compte : « npm run google:login » — le navigateur s'ouvre, choisis les services ${options.services.join(', ')}.`);
    if (flag('client_config_exists')) diagnosis.push('Un compte connecté mais inutilisable vient souvent d\'un scope refusé : reloginer en ciblant les services, pas le préréglage complet.');
  }
  if (options.writesEnabled && authenticated) {
    diagnosis.push(`Écritures activées (GWS_ALLOW_WRITES=true) : chaque envoi passera par un clic de confirmation, et les scopes d'écriture doivent avoir été accordés (${expectedScopes(options.services, true).length} scopes au total).`);
  }
  if (options.keyringAvailable === false && str('keyring_backend') === 'keyring') {
    diagnosis.push("Pas de trousseau système sur cette machine : passe GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file (la clé d' chiffrement atterrit dans ~/.config/gws/.encryption_key, à protéger en 600).");
  }
  if (options.adcWarning !== undefined) diagnosis.push(options.adcWarning);
  // Un jeton d'environnement court-circuite le magasin : la panne la plus difficile à voir.
  if (credentialSource === 'env' || credentialSource === 'token') {
    diagnosis.push('Un GOOGLE_WORKSPACE_CLI_TOKEN de l\'environnement prime sur le magasin chiffré : si le compte attendu n\'est pas celui-là, c\'est ici que ça se joue.');
  }

  return {
    installed: transport.info.reachable,
    version: transport.info.version,
    authenticated,
    method: authenticated ? `${authMethod}${credentialSource === '' ? '' : ` (${credentialSource})`}` : 'aucun',
    storage: str('storage') === '' ? 'aucun' : str('storage'),
    keyringBackend: str('keyring_backend') === '' ? 'inconnu' : str('keyring_backend'),
    paths: {
      clientConfig: str('client_config'),
      clientConfigExists: flag('client_config_exists'),
      encrypted: str('encrypted_credentials'),
      encryptedExists: flag('encrypted_credentials_exists'),
      plain: str('plain_credentials'),
      plainExists: flag('plain_credentials_exists'),
      tokenCache: flag('token_cache_exists'),
    },
    raw,
    diagnosis,
  };
}

/** Résumé pour Telegram : ce qui marche, ce qui manque, comment révoquer. Jamais de chemin de secret. */
export function formatAuthState(state: GoogleAuthState, enabled: boolean, services: readonly string[]): string {
  const head = enabled
    ? `🔑 Google Workspace — ${state.authenticated ? 'compte connecté' : 'aucun compte connecté'}`
    : '🔑 Google Workspace — désactivé (GOOGLE_ENABLED=false)';
  const lines = [
    head,
    `client : ${state.installed ? `gws ${state.version}` : 'absent'}`,
    `magasin : ${state.storage} · trousseau : ${state.keyringBackend}`,
    `services autorisés par la config : ${services.length === 0 ? 'aucun' : services.join(', ')}`,
  ];
  if (state.diagnosis.length > 0) {
    lines.push('', 'à faire :', ...state.diagnosis.map((d) => `• ${d}`));
  } else if (state.authenticated) {
    lines.push('', 'Rien à faire. Pour couper l’accès : « npm run google:revoke » (révoque aussi dans myaccount.google.com/permissions).');
  }
  return lines.join('\n');
}
