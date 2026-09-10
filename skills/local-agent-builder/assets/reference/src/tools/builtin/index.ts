import type { Tool } from '../registry.js';
import { evaluateExpression, formatNumber } from '../calculator.js';
import { getCurrentTimeTool } from './get-current-time.js';
import { rememberTool, recallTool, forgetTool } from './remember.js';

/**
 * calculator — arithmétique exacte.
 *
 * Les LLM se trompent en calcul mental ; un outil déterministe coûte moins cher
 * qu'une erreur. L'évaluation passe par un parseur fermé (src/tools/calculator.ts),
 * jamais par `eval` ni `new Function`.
 */
export const calculatorTool: Tool = {
  name: 'calculator',
  description:
    'Évalue une expression arithmétique : + - * / % ^ ( ), pourcentages, fonctions sqrt, abs, round, floor, ceil, sin, cos, tan, ln, log, constantes pi et e. À utiliser pour tout calcul numérique au lieu de le faire de tête.',
  parameters: {
    expression: { type: 'string', required: true, maxLength: 200, description: 'Exemple : (250 * 1.2) + 18' },
  },
  run(args) {
    const expression = args.expression as string;
    const outcome = evaluateExpression(expression);
    if (!outcome.ok) return { status: 'invalid_args', content: `expression refusée : ${outcome.error}` };
    return { status: 'ok', content: `${expression} = ${formatNumber(outcome.value!)}` };
  },
};

/** Outils livrés en v0.1 : horloge, mémoire persistante, calcul. */
export function coreTools(): Tool[] {
  return [getCurrentTimeTool, rememberTool, recallTool, forgetTool, calculatorTool];
}

export { getCurrentTimeTool, rememberTool, recallTool, forgetTool };
