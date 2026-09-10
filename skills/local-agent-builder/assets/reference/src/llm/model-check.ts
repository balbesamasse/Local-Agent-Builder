/**
 * Sonde de démarrage : « les modèles configurés existent-ils vraiment chez le
 * fournisseur ? »
 *
 * Pourquoi ce module existe : la liste des modèles est propre à chaque compte, et
 * un identifiant fantaisiste (celui d'un article de blog, d'une doc périmée, d'un
 * autre fournisseur) ne se voit qu'au premier message de l'utilisateur, sous la
 * forme d'une erreur 400 opaque après plusieurs secondes d'attente. Vérifier une
 * seule requête HTTP au démarrage coûte moins cher qu'une conversation ratée.
 *
 * Garde-fous de conception :
 *   - réseau indisponible ⇒ SIMPLE AVERTISSEMENT, jamais un échec : un agent doit
 *     pouvoir démarrer hors ligne (développement, réseau capricotant) ;
 *   - chez OpenRouter, les identifiants `openrouter/*` sont des alias de routage
 *     qui ne figurent pas tous dans `/models` (`alpha` y échappe) ⇒ avertissement
 *     seulement, sinon on refuserait une configuration valide ;
 *   - une clé refusée (401/403) est en revanche bloquante : rien ne sert de
 *     démarrer un bot qui ne pourra jamais répondre.
 *   - aucun contenu de réponse n'est renvoyé à l'utilisateur : seul l'identifiant
 *     de modèle, qui n'est pas un secret, apparaît dans le message.
 */
import type { AppConfig } from '../config.js';
import { GROQ_BASE, OPENROUTER_BASE } from './providers.js';

export interface ModelCheck {
  /** Message fatal à afficher, ou null si tout est vérifiable et valide. */
  fatal: string | null;
  /** Avertissements non bloquants (réseau injoignable, alias présumé). */
  warnings: string[];
  /** Paires fournisseur/modèle effectivement validées par la liste distante. */
  verified: string[];
}

interface Target {
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** Les identifiants préfixés sont des alias de routage, non listés. */
  aliasPrefix?: string;
}

function targets(config: AppConfig): Target[] {
  const list: Target[] = [];
  if (config.groqApiKey) {
    list.push({
      label: 'Groq',
      baseUrl: config.groqBaseUrl || GROQ_BASE,
      apiKey: config.groqApiKey,
      models: [config.groqModel, config.groqFallbackModel].filter((m) => m.length > 0),
    });
  }
  if (config.openRouterApiKey) {
    list.push({
      label: 'OpenRouter',
      baseUrl: config.openRouterBaseUrl || OPENROUTER_BASE,
      apiKey: config.openRouterApiKey,
      models: config.openRouterModel ? [config.openRouterModel] : [],
      aliasPrefix: 'openrouter/',
    });
  }
  return list;
}

export async function checkConfiguredModels(config: AppConfig, timeoutMs = 15000): Promise<ModelCheck> {
  const out: ModelCheck = { fatal: null, warnings: [], verified: [] };

  for (const target of targets(config)) {
    let ids: string[];
    try {
      const response = await fetch(`${target.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${target.apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401 || response.status === 403) {
        out.fatal = `${target.label} refuse la clé API (HTTP ${response.status}). Vérifie la valeur dans .env.`;
        return out;
      }
      if (!response.ok) {
        out.warnings.push(
          `${target.label} : inventaire des modèles indisponible (HTTP ${response.status}) — démarrage sans vérification.`,
        );
        continue;
      }
      ids = readIds(await response.json());
    } catch (error) {
      // Volontairement non bloquant : hors ligne, le bot doit quand même démarrer.
      out.warnings.push(
        `${target.label} : jointoignable ? ${brief(error)} — vérification des modèles sautée.`,
      );
      continue;
    }

    if (ids.length === 0) {
      out.warnings.push(`${target.label} : inventaire vide ou de forme inattendue — vérification ignorée.`);
      continue;
    }

    for (const model of target.models) {
      if (ids.includes(model)) {
        out.verified.push(`${target.label}/${model}`);
        continue;
      }
      const isAlias = target.aliasPrefix !== undefined && model.startsWith(target.aliasPrefix);
      if (isAlias) {
        out.warnings.push(
          `${target.label} : « ${model} » n'est pas dans l'inventaire mais ressemble à un alias de routage — accepté.`,
        );
        continue;
      }
      out.fatal =
        `${target.label} ne propose pas le modèle « ${model} ». ` +
        `Modèles les plus proches sur ce compte : ${nearest(model, ids).join(', ') || '(aucun)'}.\n` +
        `Corrige la clé concernée dans .env, ou liste l'inventaire : curl -H "Authorization: Bearer $API_KEY" ${target.baseUrl}/models`;
      return out;
    }
  }

  return out;
}

/** Tolère les trois formes rencontrées : {data:[{id}]}, {models:[{id}]}, [{id}]. */
export function readIds(payload: unknown): string[] {
  const root = payload as Record<string, unknown> | undefined;
  const raw = Array.isArray(payload) ? payload : ((root?.['data'] ?? root?.['models'] ?? []) as unknown[]);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const id = (entry as Record<string, unknown> | null)?.['id'];
      return typeof id === 'string' ? id : '';
    })
    .filter((id) => id.length > 0);
}

/** Proches voisins par recouvrement de segments, pour débugger une faute de frappe. */
function nearest(model: string, ids: string[], max = 4): string[] {
  const tokens = model.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
  const scored = ids
    .map((id) => {
      const lower = id.toLowerCase();
      const score = tokens.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
      return { id, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.id.length - b.id.length);
  return scored.slice(0, max).map((entry) => entry.id);
}

function brief(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 120);
  return String(error).slice(0, 120);
}
