/**
 * Point d'entrée unique des capacités de l'agent.
 *
 * Ajouter un outil = écrire un module dans builtin/ puis l'ajouter dans
 * `buildRegistry`. Rien d'autre ne change : la boucle d'agent, le prompt et la
 * validation s'adaptent à la liste.
 */
import { ToolRegistry, type Tool } from './registry.js';
import type { AppConfig } from '../config.js';
import { coreTools } from './builtin/index.js';
import { log } from '../core/logger.js';

export function buildRegistry(config: AppConfig, external: Tool[] = []): ToolRegistry {
  const tools: Tool[] = [...coreTools(), ...external];

  // Point d'extension des futurs outils sensibles : ils doivent être marqués
  // `dangerous: true` ET `requiresApproval: true` (invariant vérifié par le
  // constructeur du registre), et ne sont ajoutés qu'ici.
  // ex. if (config.dangerousToolsEnabled) tools.push(fsWriteTool, shellTool);

  // Les outils Google arrivent par le même guichet que les outils internes : mêmes bornes
  // d'arguments, même invariant « sensible = accord humain », même troncature de sortie.
  const registry = new ToolRegistry(tools, config.dangerousToolsEnabled);
  log.debug('registry construit', { count: registry.size, names: registry.names() });
  return registry;
}

export { ToolRegistry, ToolRegistrationError, executeToolCall, toolDefinition } from './registry.js';
export type { Tool, ExecuteOutcome, ExecutedTool } from './registry.js';
export { parseToolArguments, validateArgs, toJsonSchema } from './args.js';
export type { ArgSpec, Args } from './args.js';
export { evaluateExpression, formatNumber } from './calculator.js';
export { coreTools } from './builtin/index.js';
export { getCurrentTimeTool } from './builtin/get-current-time.js';
