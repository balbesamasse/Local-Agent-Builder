/**
 * Expurgation des secrets avant toute sortie — journal, trace d'audit, contenu injecté au
 * modèle.
 *
 * Le périmètre est volontairement plus large que « les clés Google » : un outil qui appelle
 * une API externe peut voir transiter n'importe quoi (une réponse de Drive contenant un collage
 * de clé API, un `client_secret` lu dans un fichier du dépôt). Une fuite par un journal est
 * aussi grave qu'une fuite par le réseau, et elle est plus probable parce que personne ne
 * relit les journaux.
 */

interface Rule {
  pattern: RegExp;
  replace: string;
  /** Marque insérée dans le texte expurgé. */
  tag: string;
}

const RULES: Rule[] = [
  // Jetons d'accès Google : préfixe connu, forme longue.
  { pattern: /ya29\.[A-Za-z0-9_\-./]{10,}/g, replace: '[REDACTÉ:jeton Google]', tag: 'ya29.' },
  // Champs d'un JSON de credentials — la valeur part, la clé reste lisible.
  {
    pattern: /"(access_token|refresh_token|id_token|client_secret|private_key|api_key|apiKey)"\s*:\s*"[^"]*"/gi,
    replace: '"$1":"[REDACTÉ]"',
    tag: '_token"',
  },
  // En-tête d'autorisation complet.
  { pattern: /(?:Authorization\s*:\s*)?(?:Bearer|Basic)\s+[A-Za-z0-9._\-+/]{16,}=*/gi, replace: '[REDACTÉ:en-tête d’autorisation]', tag: 'bearer ' },
  // JWT (trois segments) : un refresh token frais en a tous les attributs.
  { pattern: /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, replace: '[REDACTÉ:jeton signé]', tag: '' },
  // Blocs de clé privée PEM, éventuellement échappés dans une chaîne JSON.
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[REDACTÉ:clé privée]',
    tag: 'BEGIN',
  },
  // Clés des fournisseurs utilisés par le projet, au cas où elles rebondiraient ici.
  { pattern: /\bgsk_[A-Za-z0-9_\-]{16,}/g, replace: '[REDACTÉ:clé Groq]', tag: 'gsk_' },
  { pattern: /\bsk-[A-Za-z0-9_\-]{16,}/g, replace: '[REDACTÉ:clé API]', tag: 'sk-' },
  { pattern: /\bAIza[0-9A-Za-z_\-]{20,}/g, replace: '[REDACTÉ:clé API Google]', tag: 'AIza' },
  { pattern: /\bota-[A-Za-z0-9_\-]{20,}/g, replace: '[REDACTÉ:jeton]', tag: 'ota-' },
];

/**
 * Renvoie le texte sans secret. Une seule passe par règle, sur une copie : les motifs se
 * chevauchent (un JWT dans un en-tête Bearer), donc l'ordre importe — les plus spécifiques
 * d'abord, ce qu'assure cet ordre littéral.
 */
export function redact(text: string): string {
  if (text === '') return text;
  let out = text;
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replace);
  return out;
}

/** Le texte porte-t-il encore un secret après expurgation ? (garde de cohérence, testée) */
export function stillSensitive(text: string): boolean {
  return /ya29\.|-----BEGIN |gsk_[A-Za-z0-9]{16}|AIza[0-9A-Za-z_\-]{20}|(?:access|refresh)_token"\s*:\s*"[A-Za-z0-9_\-]{16}/i.test(text);
}

/**
 * Un extrait borné, prêt pour un journal : sur secret, et coupé sur une frontière de ligne
 * pour ne jamais finir à moitié sur un token.
 */
export function safeExcerpt(text: string, maxChars: number): string {
  const clean = redact(text);
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > maxChars / 2 ? cut.slice(0, lastBreak) : cut}… [tronqué]`;
}
