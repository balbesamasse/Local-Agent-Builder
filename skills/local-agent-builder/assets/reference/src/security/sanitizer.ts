/**
 * Assainissement des entrées.
 *
 * Principe : on ne fait jamais confiance au texte qui arrive, même d'un
 * utilisateur autorisé (compte piraté, copier-coller, tentative d'injection).
 */

/** Longueur max acceptée pour un message utilisateur. */
export const MAX_INPUT_CHARS = 6000;

/**
 * Retire les caractères de contrôle et borne la taille.
 * Les tags HTML Telegram (b/i/code…) sont retirés puis ré-échappés à la sortie :
 * un utilisateur ne doit pas pouvoir casser la mise en forme ni injecter du markup.
 */
export function sanitizeText(input: string, maxChars = MAX_INPUT_CHARS): string {
  // eslint-disable-next-line no-control-regex
  let out = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  out = out.replace(/\r\n/g, '\n');
  out = out.replace(/[ \t]{3,}/g, '  ');
  out = out.replace(/\n{4,}/g, '\n\n\n');
  out = out.trim();
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n[…tronqué ${out.length - maxChars} caractères]`;
  }
  return out;
}

/** Échappement pour sendMessage(parse_mode: 'HTML'). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Nom d'outil : uniquement minuscules, chiffres, tiret bas, 1-64.
 * Le modèle ne doit pas pouvoir inventer « ../../etc/passwd » comme nom de tool.
 */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function isValidToolName(name: unknown): name is string {
  return typeof name === 'string' && TOOL_NAME_RE.test(name);
}

/**
 * Défense contre l'injection de prompt : les données non fiables (mémoire,
 * résultat d'outil) sont enveloppées dans un cadre explicite et les balises du
 * cadre sont neutralisées pour qu'on ne puisse pas s'en échapper.
 */
export function asUntrusted(label: string, payload: string): string {
  // On retire le chevron ouvrant de toute occurrence d'un marqueur de cadre :
  // une charge utile ne peut donc pas fermer le cadre puis rejouer une consigne.
  const safe = payload.replace(/<(\/?(?:BEGIN|END)_)/gi, '$1');
  return `<BEGIN_${label}>\n${safe}\n<END_${label}>`;
}
