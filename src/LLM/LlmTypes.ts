export interface LlmProviderConfig {
  id: string;
  name: string;
  url: string;
  model?: string;
  apiKey?: string;
}

export interface LlmSettings {
  enabled: boolean;
  providers: LlmProviderConfig[];
  defaultProviderId: string | null;
  showSql: boolean;
  allowWriteOperations: boolean;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  enabled: false,
  providers: [],
  defaultProviderId: null,
  showSql: true,
  allowWriteOperations: false
};

export type LlmReadOutputKind = 'table' | 'markdown' | 'chart' | 'calendar';

export const READ_OUTPUT_KINDS: ReadonlySet<LlmReadOutputKind> = new Set<LlmReadOutputKind>(['table', 'markdown', 'chart', 'calendar']);

export function outputFenceLanguage(kind: LlmReadOutputKind): string {
  return kind === 'table' ? 'vaultquery' : `vaultquery-${kind}`;
}

export interface GeneratedVaultQuery {
  sql: string;
  statementKind: 'read' | 'write';
  outputKind: LlmReadOutputKind;
  outputOptions?: Record<string, string>;
}

export interface ResolvedOutput {
  kind: LlmReadOutputKind;
  options: Record<string, string>;
}

export function resolveOutput(generated: GeneratedVaultQuery, requestedOutput?: LlmReadOutputKind, requestedOptions?: Record<string, string>): ResolvedOutput {
  return { kind: requestedOutput ?? generated.outputKind, options: { ...generated.outputOptions, ...requestedOptions } };
}

export interface LlmPrompt {
  system: string;
  user: string;
}

export interface SqlGenerationAttempt {
  sql: string;
  error: string;
}

export interface SqlGenerationProgress {
  phase: 'preparing-prompt' | 'waiting-for-model' | 'validating-query' | 'executing-query' | 'previewing-write' | 'validating-results';
  attempt: number;
  maxAttempts: number;
}

export interface LlmCompletionOptions {
  temperature: number;
}

export interface LlmProvider {
  readonly config: LlmProviderConfig;
  complete(prompt: LlmPrompt, options?: LlmCompletionOptions): Promise<string>;
}
