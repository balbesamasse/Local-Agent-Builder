import type { Tool } from '../registry.js';
import type { Args } from '../args.js';
import type { ToolContext, ToolResult } from '../../core/types.js';

/**
 * get_current_time — l'outil de référence du projet.
 *
 * Un LLM ne connaît pas l'heure courante : cet outil montre le patron complet
 * (déclaration → validation → exécution → résultat borné) que suivront les
 * outils suivants, y compris ceux nécessitant une approbation.
 */
type Format = 'complet' | 'heure' | 'date' | 'iso';

const FORMATS: readonly Format[] = ['complet', 'heure', 'date', 'iso'];

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const getCurrentTimeTool: Tool = {
  name: 'get_current_time',
  description:
    "Renvoie la date et l'heure actuelles. À utiliser dès qu'une question dépend du moment présent (aujourd'hui, demain, délai, jour de la semaine). Le modèle n'a aucune horloge fiable.",
  parameters: {
    fuseau: {
      type: 'string',
      maxLength: 64,
      description: "Fuseau IANA optionnel ('Africa/Bamako', 'Europe/Paris', 'UTC'). Défaut : fuseau configuré de l'agent.",
    },
    format: {
      type: 'string',
      enum: FORMATS,
      description: "Précision : 'complet' (défaut), 'heure', 'date', 'iso'.",
    },
  },
  run(args: Args, ctx: ToolContext): ToolResult {
    const timezone = (args.fuseau as string | undefined) ?? ctx.config.systemTimezone;
    if (!isValidTimezone(timezone)) {
      return {
        status: 'invalid_args',
        content: `fuseau horaire invalide : « ${timezone} ». Utiliser un identifiant IANA, ex. UTC, Africa/Bamako, Europe/Paris.`,
      };
    }
    const format = (args.format as Format | undefined) ?? 'complet';
    return { status: 'ok', content: render(new Date(), timezone, format) };
  },
};

function render(now: Date, timezone: string, format: Format): string {
  const date = new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  switch (format) {
    case 'iso':
      return `${now.toISOString()} (fuseau ${timezone})`;
    case 'heure':
      return `${time} — ${timezone}`;
    case 'date':
      return `${date} — ${timezone}`;
    case 'complet':
      return `${date}, ${time} (${timezone}) — epoch ${Math.floor(now.getTime() / 1000)}`;
  }
}
