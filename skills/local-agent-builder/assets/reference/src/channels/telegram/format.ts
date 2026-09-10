/**
 * Rendu texte → Telegram (HTML uniquement, jamais MarkdownV2 : moins de cas
 * ambigus et pas d'injection de mise en forme depuis le texte du modèle).
 *
 * La sortie du LLM est traitée comme non fiable : TOUT est échappé, puis on ne
 * réautorise qu'une petite liste de balises. Un `<script>` devient du texte,
 * un `<b>` reste du gras.
 */
import { escapeHtml } from '../../security/sanitizer.js';

/** Limite stricte de l'API Telegram pour sendMessage. */
export const TELEGRAM_HARD_LIMIT = 4096;
/** Marge de sécurité pour la découpe. */
const SAFE_LIMIT = 3800;

const ALLOWED_TAGS = ['b', 'i', 'u', 's', 'code', 'pre', 'blockquote', 'tg-spoiler'] as const;
const TAGS_PATTERN = ALLOWED_TAGS.join('|');

export function toTelegramHtml(text: string): string {
  let html = escapeHtml(text);

  // Les modèles rendent volontiers du Markdown : on le traduit APRÈS échappement,
  // donc uniquement des balises que nous injectons survivent — le contenu, lui,
  // est déjà neutralisé.
  html = html.replace(/\*\*([^*\n]{1,400})\*\*/g, '<b>$1</b>');
  html = html.replace(/`([^`\n]{1,400})`/g, '<code>$1</code>');
  html = html.replace(/^\s{0,3}#{1,4}\s+(.+)$/gm, '<b>$1</b>');
  html = html.replace(/^\s*[-•]\s+/gm, '• ');
  html = html.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g, '<a href="$2">$1</a>');

  // Les liens sont le seul cas où un attribut est toléré — et uniquement en http(s).
  // La paire complète `<a …> … </a>` est traitée d'un seul coup : une balise
  // fermante orpheline (sans ouvrant autorisé) reste du texte échappé, et les
  // guillemets du contenu, déjà neutralisés, ne peuvent pas apporter d'attribut.
  html = html.replace(
    /&lt;a href=&quot;(https?:\/\/[^\s"]{1,500})&quot;&gt;([\s\S]{1,300}?)&lt;\/a&gt;/g,
    (_all, url: string, label: string) => `<a href="${url}">${label}</a>`,
  );

  // Ré-ouverture des balises simples autorisées.
  html = html.replace(new RegExp(`&lt;(${TAGS_PATTERN})&gt;`, 'g'), '<$1>');
  html = html.replace(new RegExp(`&lt;/(${TAGS_PATTERN})&gt;`, 'g'), '</$1>');
  // Attributs résiduels sur les balises autorisées (ex. <code class=...>) : retirés.
  html = html.replace(new RegExp(`&lt;(${TAGS_PATTERN})\\s[^&]*?&gt;`, 'g'), '<$1>');
  return html;
}

/**
 * Découpe en messages de ≤ SAFE_LIMIT caractères en respectant les balises :
 * on referme ce qui est ouvert avant la coupe et on le rouvre après.
 */
export function splitForTelegram(html: string): string[] {
  if (html.length <= SAFE_LIMIT) return [html];

  const chunks: string[] = [];
  let rest = html;
  let guard = 0;
  while (rest.length > SAFE_LIMIT && guard < 64) {
    guard += 1;
    const cut = findCut(rest);
    const openTags = tagsOpenedIn(rest.slice(0, cut));
    let piece = rest.slice(0, cut);
    for (const tag of [...openTags].reverse()) piece += `</${tag}>`;
    chunks.push(piece);
    const reopened = openTags.map((t) => `<${t}>`).join('');
    rest = reopened + rest.slice(cut);
  }
  if (rest.trim() !== '') chunks.push(rest);
  return chunks;
}

function findCut(text: string): number {
  const window = text.slice(0, SAFE_LIMIT);
  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph > SAFE_LIMIT * 0.4) return paragraph + 1;
  const line = window.lastIndexOf('\n');
  if (line > SAFE_LIMIT * 0.25) return line + 1;
  const space = window.lastIndexOf(' ');
  if (space > SAFE_LIMIT * 0.25) return space + 1;
  return SAFE_LIMIT;
}

/** Pile des balises autorisées ouvertes et non refermées dans un fragment. */
export function tagsOpenedIn(fragment: string): string[] {
  const stack: string[] = [];
  const re = new RegExp(`<(\\/?)(${TAGS_PATTERN})\\b[^>]*>`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(fragment)) !== null) {
    const slash = match[1];
    const tag = match[2]!;
    if (slash === '/') {
      const idx = stack.lastIndexOf(tag);
      if (idx >= 0) stack.splice(idx, 1);
    } else {
      stack.push(tag);
    }
  }
  return stack;
}

/** Aperçu compact pour les logs. */
export function preview(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Repli texte brut si Telegram refuse le HTML (balisage imbriqué invalidé). */
export function fallbackPlain(html: string): string {
  return html
    .replace(/<[^>]{0,40}>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .slice(0, TELEGRAM_HARD_LIMIT);
}
