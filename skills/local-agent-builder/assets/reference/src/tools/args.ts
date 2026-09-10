/**
 * Validation des arguments d'outils.
 *
 * Le JSON vient du LLM : c'est une entrée non fiable. On valide contre un
 * mini-schema déclaratif (aucune dépendance) et on refuse tout champ inconnu,
 * pour qu'un prompt injecté ne puisse pas glisser `{ chatId: 999 }` et écrire
 * dans la conversation d'un autre utilisateur.
 */
import type { JsonSchema } from '../core/types.js';

/** Socle commun : `description` est fortement conseillé (il guid le choix du modèle). */
interface ArgSpecBase {
  required?: boolean;
  description?: string;
}

export type ArgSpec =
  | (ArgSpecBase & { type: 'string'; maxLength?: number; enum?: readonly string[]; default?: string })
  | (ArgSpecBase & { type: 'integer'; min?: number; max?: number; default?: number })
  | (ArgSpecBase & { type: 'number'; min?: number; max?: number })
  | (ArgSpecBase & { type: 'boolean'; default?: boolean });

export type ArgSpecs = Record<string, ArgSpec>;
export type Args = Record<string, string | number | boolean>;

export interface ArgValidation {
  /** Arguments validés, prêts pour l'outil. */
  args: Args;
  /** Message d'erreur renvoyé au modèle, qui peut alors se corriger seul. */
  error?: string;
}

export type ParseOutcome = { ok: true; value: unknown } | { ok: false; error: string };

/** Le modèle renvoie parfois une chaîne vide ou un objet mal formé : on exige du JSON strict. */
export function parseToolArguments(raw: string | undefined): ParseOutcome {
  if (raw === undefined || raw.trim() === '') return { ok: true, value: {} };
  if (raw.length > 4000) return { ok: false, error: 'arguments trop longs (> 4000 caractères)' };
  try {
    const value = JSON.parse(raw) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'les arguments doivent être un objet JSON, par ex. {"fuseau":"UTC"}' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: 'JSON invalide dans les arguments' };
  }
}

/** Applique le spec : types, bornes, énumérations, valeurs par défaut, refus des champs inconnus. */
export function validateArgs(value: unknown, spec: ArgSpecs): ArgValidation {
  const input = (value ?? {}) as Record<string, unknown>;
  const out: Args = {};
  const fail = (error: string): ArgValidation => ({ args: {}, error });

  for (const key of Object.keys(input)) {
    if (!(key in spec)) return fail(`paramètre inconnu refusé : « ${key} »`);
  }

  for (const [key, rule] of Object.entries(spec)) {
    const provided = input[key];
    if (provided === undefined || provided === null) {
      if (rule.required) return fail(`paramètre manquant : « ${key} »`);
      if ('default' in rule && rule.default !== undefined) out[key] = rule.default;
      continue;
    }

    switch (rule.type) {
      case 'string': {
        if (typeof provided !== 'string') return fail(`« ${key} » doit être une chaîne`);
        const text = provided.trim();
        if (rule.maxLength !== undefined && text.length > rule.maxLength) {
          return fail(`« ${key} » dépasse ${rule.maxLength} caractères`);
        }
        if (rule.enum !== undefined && !rule.enum.includes(text)) {
          return fail(`« ${key} » doit valoir l'un de : ${rule.enum.join(', ')}`);
        }
        out[key] = text;
        break;
      }
      case 'integer':
      case 'number': {
        const num = typeof provided === 'string' && provided.trim() !== '' ? Number(provided) : provided;
        if (typeof num !== 'number' || !Number.isFinite(num)) return fail(`« ${key} » doit être un nombre`);
        if (rule.type === 'integer' && !Number.isInteger(num)) return fail(`« ${key} » doit être un entier`);
        if (rule.min !== undefined && num < rule.min) return fail(`« ${key} » doit être ≥ ${rule.min}`);
        if (rule.max !== undefined && num > rule.max) return fail(`« ${key} » doit être ≤ ${rule.max}`);
        out[key] = num;
        break;
      }
      case 'boolean': {
        if (typeof provided === 'boolean') out[key] = provided;
        else if (provided === 'true' || provided === 'false') out[key] = provided === 'true';
        else return fail(`« ${key} » doit être un booléen`);
        break;
      }
    }
  }
  return { args: out };
}

/** JSON Schema dérivé du même spec : déclaration et validation ne peuvent diverger. */
export function toJsonSchema(spec: ArgSpecs): JsonSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [key, rule] of Object.entries(spec)) {
    const entry: Record<string, unknown> = {
      type: rule.type === 'integer' ? 'integer' : rule.type,
      // Description explicite si fournie, sinon déduction depuis les contraintes.
      description: rule.description ?? describeRule(key, rule),
    };
    if (rule.type === 'string' && rule.enum !== undefined) entry.enum = [...rule.enum];
    if (rule.type === 'string' && rule.maxLength !== undefined) entry.maxLength = rule.maxLength;
    if ((rule.type === 'integer' || rule.type === 'number') && rule.min !== undefined) entry.minimum = rule.min;
    if ((rule.type === 'integer' || rule.type === 'number') && rule.max !== undefined) entry.maximum = rule.max;
    properties[key] = entry;
    if (rule.required) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function describeRule(key: string, rule: ArgSpec): string {
  switch (rule.type) {
    case 'string':
      return rule.enum !== undefined ? `${key} — valeurs : ${rule.enum.join(' | ')}` : `${key} — texte libre`;
    case 'integer':
      return `${key} — entier${rule.min !== undefined ? ` ≥ ${rule.min}` : ''}${rule.max !== undefined ? ` ≤ ${rule.max}` : ''}`;
    case 'number':
      return `${key} — nombre${rule.min !== undefined ? ` ≥ ${rule.min}` : ''}${rule.max !== undefined ? ` ≤ ${rule.max}` : ''}`;
    case 'boolean':
      return `${key} — vrai/faux`;
  }
}
