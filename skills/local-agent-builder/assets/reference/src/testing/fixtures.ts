/**
 * Fabriques utilisées par les tests (et uniquement par eux).
 * Exclu du build de production via tsconfig.build.json.
 */
import type { AppConfig } from '../config.js';
import type { ToolContext } from '../core/types.js';
import type { AgentDeps } from '../core/agent.js';
import { ToolRegistry, type Tool } from '../tools/registry.js';
import { ApprovalGate } from '../security/approvals.js';
import type { LlmClient } from '../llm/providers.js';
import type { LlmRequest, LlmResponse } from '../llm/openai-compat.js';

export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    agentName: 'TestGravity',
    telegramBotToken: '123456:AAtesttokenfortlong1234567890abcdefghij',
    allowedUserIds: new Set([4242]),
    groqApiKey: 'gsk_test',
    groqModel: 'test-model',
    groqFallbackModel: '',
    openRouterApiKey: '',
    openRouterModel: 'openrouter/free',
    elevenLabsApiKey: '',
    elevenLabsVoiceId: '',
    elevenLabsTtsModel: 'eleven_flash_v2_5',
    elevenLabsSttModel: 'scribe_v1',
    elevenLabsWsUrl: 'ws://127.0.0.1:0/v1',
    realtimeTtsModel: 'eleven_flash_v2_5',
    whisperModel: 'whisper-large-v3',
    transcriptionOrder: 'groq,elevenlabs',
    elevenLabsStability: 0.5,
    elevenLabsSimilarity: 0.75,
    voiceMode: 'mirror',
    ttsMaxChars: 1200,
    mediaMaxBytes: 8388608,
    realtimeEnabled: false,
    realtimePort: 0, // port libre attribué : deux tests ne doivent jamais se marcher dessus
    realtimeBind: '127.0.0.1',
    realtimePublicUrl: '',
    realtimeMaxMinutes: 10,
    realtimeMaxTurns: 40,
    realtimeSttModel: 'scribe_v2_realtime',
    realtimeTicketTtlSeconds: 120,
    realtimeVadSilenceMs: 450,
    realtimeMaxFrameKbps: 128,
    // Eteint par defaut : un test ne doit jamais pouvoir appeler un service Google reel, pas
    // plus qu'un fournisseur payant. Les tests Google construisent leur propre config.
    googleEnabled: false,
    googleBin: 'gws',
    googleServices: new Set(['gmail', 'drive', 'docs', 'sheets', 'calendar', 'auth']),
    googleAllowWrites: false,
    googleTimeoutMs: 20000,
    googleMaxOutputBytes: 400000,
    googleMaxInFlight: 2,
    googleReadAttempts: 2,
    googleCredentialsFile: '',
    googleKeyringBackend: 'keyring',
    googleProjectId: '',
    dbPath: ':memory:',
    maxIterations: 4,
    forceFinalIteration: 4,
    systemTimezone: 'UTC',
    historyLimit: 20,
    maxMessageChars: 6000,
    maxMemoryItems: 100,
    validateModelsAtBoot: true,
    llmTimeoutMs: 5000,
    llmMaxRetries: 0,
    rateLimitBurst: 5,
    rateLimitPerMinute: 60,
    approvalTtlMinutes: 15,
    workspaceRoot: '.',
    dangerousToolsEnabled: false,
    idCommandEnabled: true,
    debug: false,
    logFile: '', // jamais de journal fichier dans les tests : pas d'effet de bord sur le dépôt
    telegramApiRoot: '',
    groqBaseUrl: '',
    openRouterBaseUrl: '',
    elevenLabsBaseUrl: 'http://127.0.0.1:0/v1',
  };
  return { ...base, ...overrides };
}

export function makeToolContext(overrides: Partial<ToolContext> & { config: AppConfig; store: ToolContext['store'] }): ToolContext {
  return {
    chatId: 1,
    userId: 4242,
    requestApproval: async () => false,
    ...overrides,
  };
}

export function makeRegistry(tools: Tool[], dangerousEnabled = false): ToolRegistry {
  return new ToolRegistry(tools, dangerousEnabled);
}

export function makeGate(store: AgentDeps['store'], registry: ToolRegistry, ttlMinutes = 15): ApprovalGate {
  return new ApprovalGate(store, registry, ttlMinutes);
}

/** Fournisseur LLM scripté : chaque entrée de la liste = une réponse du modèle. */
export class FakeLlm implements LlmClient {
  public readonly requests: LlmRequest[] = [];

  constructor(private readonly script: Array<Partial<LlmResponse> | Error>) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error('FakeLlm : script épuisé');
    if (next instanceof Error) throw next;
    return {
      text: next.text ?? '',
      toolCalls: next.toolCalls ?? [],
      wantsTools: (next.toolCalls?.length ?? 0) > 0,
      model: next.model ?? 'fake-model',
      provider: next.provider ?? 'fake',
      ...(next.usage ? { usage: next.usage } : {}),
    };
  }
}
