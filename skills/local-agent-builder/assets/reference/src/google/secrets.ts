/**
 * Contrôle de ce qui traverse la frontière du processus fils.
 *
 * L'agent connaît quatre secrets : le token Telegram, deux clés de fournisseurs de texte, une de
 * voix. `gws` n'en a besoin d'aucun. Comme le projet charge `.env` dans `process.env`, un
 * `spawn` avec l'environnement par défaut les donnerait tous les quatre au fils — et un binaire
 * tiers qui lit des variables d'environnement (c'est son métier) les voit.
 *
 * Le contrôle est fait sur les NOMS et sur les VALEURS : une clé renommée resterait une fuite.
 */
import { childEnvironment, forbiddenInheritedKeys } from './gws-cli-transport.js';

/** Noms de variables qui n'ont rien à faire chez un client Google. */
export function foreignSecretNames(parentEnv: NodeJS.ProcessEnv): string[] {
  return forbiddenInheritedKeys(parentEnv as Record<string, string>);
}

/**
 * Retourne la liste des fuites : un nom interdit présent dans l'environnement du fils, ou une
 * valeur secrète du père retrouvée telle quelle sous un autre nom. Vide = frontière propre.
 */
export function assertNoForeignSecretsFor(childEnv: Record<string, string>, parentEnv: NodeJS.ProcessEnv): string[] {
  const leaks: string[] = [];
  const forbiddenNames = new Set(foreignSecretNames(parentEnv));
  for (const name of Object.keys(childEnv)) {
    if (forbiddenNames.has(name)) leaks.push(`nom ${name}`);
  }
  for (const [name, value] of Object.entries(parentEnv)) {
    if (!forbiddenNames.has(name)) continue;
    const secret = typeof value === 'string' ? value.trim() : '';
    // Une valeur courte ne prouve rien : sur 6 caractères, un faux positif vaut plus cher
    // qu'un vrai négatif. Sous 16, on ne compare pas.
    if (secret.length < 16) continue;
    for (const [childName, childValue] of Object.entries(childEnv)) {
      if (childValue.includes(secret)) leaks.push(`valeur de ${name} exposée sous ${childName}`);
    }
  }
  return leaks;
}

/** Ce que le fils recevrait réellement — exposé pour que le test soit lisible et pas dérivé. */
export function projectedChildEnv(parentEnv: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  return childEnvironment(parentEnv, extra);
}
