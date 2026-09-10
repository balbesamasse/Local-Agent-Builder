/**
 * Registre d'outils.
 *
 * Une capacité = un objet `Tool` enregistré explicitement dans `buildRegistry`.
 * Rien n'est découvert, importé dynamiquement, ni exécutable depuis le LLM :
 * le modèle ne peut nommer que ce qui figure dans cette liste. Les outils
 * marqués `requiresApproval` sont de plus bloqués derrière un accord humain,
 * et `DANGEROUS_TOOLS_ENABLED=false` les retire purement de la vue du modèle.
 */
import type { ToolContext, ToolDefinition, ToolResult, ToolStatus } from '../core/types.js';
import { isValidToolName } from '../security/sanitizer.js';
import { parseToolArguments, toJsonSchema, validateArgs, type ArgSpecs, type Args } from './args.js';
import { log } from '../core/logger.js';

export interface Tool {
  name: string;
  description: string;
  /** Spec de validation ; le schéma envoyé au modèle en est dérivé. */
  parameters: ArgSpecs;
  /** Sortie tronquée avant d'être injectée au modèle (les sorties denses coûtent cher). */
  maxOutputChars?: number;
  /** true → exécution suspendue à une approbation humaine via Telegram. */
  requiresApproval?: boolean;
  /** true → retiré de la vue du modèle tant que DANGEROUS_TOOLS_ENABLED=false. */
  dangerous?: boolean;
  run(args: Args, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export interface ExecutedTool {
  tool: Tool;
  args: Args;
  result: ToolResult;
}

/** Erreur de programmation : levée au démarrage, jamais en pleine conversation. */
export class ToolRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistrationError';
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(
    tools: Tool[],
    private readonly dangerousEnabled: boolean,
  ) {
    for (const tool of tools) {
      if (!isValidToolName(tool.name)) {
        throw new ToolRegistrationError(`nom d'outil invalide : ${JSON.stringify(tool.name)}`);
      }
      if (this.tools.has(tool.name)) {
        throw new ToolRegistrationError(`outil enregistré deux fois : ${tool.name}`);
      }
      // Invariant non négociable, vérifié à l'enregistrement : un outil sensible
      // exige toujours un humain. Aucun chemin de contournement possible.
      if (tool.dangerous === true && tool.requiresApproval !== true) {
        throw new ToolRegistrationError(
          `outil dangereux « ${tool.name} » sans requiresApproval : refusé (un outil sensible ne s'exécute jamais sans accord explicite)`,
        );
      }
      this.tools.set(tool.name, tool);
    }
  }

  get size(): number {
    return this.tools.size;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Outils réellement exposés au modèle. */
  visible(): Tool[] {
    return [...this.tools.values()].filter((t) => t.dangerous !== true || this.dangerousEnabled);
  }

  isVisible(tool: Tool): boolean {
    return this.visible().includes(tool);
  }

  definitions(): ToolDefinition[] {
    return this.visible().map(toolDefinition);
  }
}

export function toolDefinition(tool: Tool): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toJsonSchema(tool.parameters),
    },
  };
}

export type ExecuteOutcome =
  | { kind: 'executed'; executed: ExecutedTool }
  | { kind: 'needs_approval'; tool: Tool; args: Args }
  | { kind: 'rejected'; toolName: string; reason: string };

/**
 * Valide puis exécute un appel d'outil issu du LLM.
 * Ordre imposé : nom → visibilité → arguments → approbation → exécution.
 * Chaque étape journalise son refus en base (audit).
 */
export async function executeToolCall(
  registry: ToolRegistry,
  call: { name: string; args: string },
  ctx: ToolContext,
  options: { skipApproval?: boolean } = {},
): Promise<ExecuteOutcome> {
  const start = Date.now();
  const name = call.name;

  const audit = (status: ToolStatus, extra: { args?: unknown; error?: string; output?: string }) =>
    ctx.store.logToolCall({
      chatId: ctx.chatId,
      userId: ctx.userId,
      toolName: typeof name === 'string' ? name.slice(0, 64) : '?',
      args: extra.args ?? call.args,
      status,
      error: extra.error,
      output: extra.output,
      durationMs: Date.now() - start,
    });

  if (!isValidToolName(name) || !registry.has(name)) {
    audit('denied', { error: 'outil inconnu ou mal nommé' });
    log.warn('appel d’outil refusé', { name, chatId: ctx.chatId });
    return { kind: 'rejected', toolName: String(name).slice(0, 64), reason: `outil « ${name} » inconnu : seul un outil de la liste déclarée est autorisé` };
  }

  const tool = registry.get(name)!;
  if (tool.dangerous === true && !registry.isVisible(tool)) {
    audit('denied', { error: 'outil désactivé par configuration' });
    return { kind: 'rejected', toolName: name, reason: `outil « ${name} » désactivé par configuration (DANGEROUS_TOOLS_ENABLED=false)` };
  }

  const parsed = parseToolArguments(call.args);
  if (!parsed.ok) {
    audit('invalid_args', { error: parsed.error });
    return { kind: 'rejected', toolName: name, reason: `arguments invalides : ${parsed.error}` };
  }

  const validated = validateArgs(parsed.value, tool.parameters);
  if (validated.error !== undefined) {
    audit('invalid_args', { error: validated.error });
    return { kind: 'rejected', toolName: name, reason: `arguments invalides : ${validated.error}` };
  }
  const args = validated.args;

  if (tool.requiresApproval === true && options.skipApproval !== true) {
    return { kind: 'needs_approval', tool, args };
  }

  try {
    const raw = await tool.run(args, ctx);
    const result: ToolResult = { ...raw, content: clamp(raw.content, tool.maxOutputChars ?? 1200) };
    audit(result.status, { args, output: result.content });
    return { kind: 'executed', executed: { tool, args, result } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit('error', { args, error: message });
    log.error('outil en erreur', { name, error: message });
    // L'agent continue : on renvoie l'erreur au modèle plutôt que de tuer le tour.
    return {
      kind: 'executed',
      executed: { tool, args, result: { status: 'error', content: `erreur d'exécution : ${clamp(message, 300)}` } },
    };
  }
}

function clamp(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[tronqué]` : value;
}
