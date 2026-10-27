import { processQueryBlock } from './QueryBlockLifecycle';
import { BaseRenderer } from '../Renderers/BaseRenderer';
import { addFloatingButtons, getFloatingButtonContainer } from '../Renderers/OutputChrome';
import { BaseReadQueryCodeBlockProcessor } from './BaseReadQueryCodeBlockProcessor';
import { LlmProgressIndicator } from '../Renderers/LlmProgressIndicator';
import { cleanupRenderedOutput } from '../Renderers/RendererCleanup';
import { RenderVersionGuard } from './ProcessorUtils';
import { WriteCodeBlockProcessor } from './WriteCodeBlockProcessor';
import { SQL_PROMPT_VERSION } from '../LLM/PromptBuilder';
import { EndpointProvider } from '../LLM/EndpointProvider';
import { generateAndRun, SqlGenerationError } from '../LLM/LlmService';
import { isSelectOnly, isWriteOnly } from '../utils/SQLParsingUtils';
import { GeneratedSqlCache } from '../LLM/GeneratedSqlCache';
import { LatestRuns } from '../LLM/LatestRuns';
import { outputFenceLanguage, READ_OUTPUT_KINDS, resolveOutput } from '../LLM/LlmTypes';
import { getErrorMessage } from '../utils/ErrorMessages';
import { hashString } from '../utils/StringUtils';
import { logger as rootLogger } from '../utils/logger';
import { getConfigKeys } from '../Constants/BlockConfigCatalog';
import { parseBooleanOption, parseKeyValueLines } from '../utils/ConfigParsingUtils';
import { splitQuerySections } from '../utils/QueryParsingUtils';
import type { MarkdownPostProcessorContext } from 'obsidian';
import type { GeneratedVaultQuery, LlmProvider, LlmProviderConfig, LlmReadOutputKind } from '../LLM/LlmTypes';
import type { ParsedQuery } from '../types';
import type { VaultQueryAPI, QueryResult } from '../VaultQueryAPI';

const logger = rootLogger.scope('LlmBlocks');

const REGENERATE_BUTTON_CLASS = 'vaultquery-nl-regenerate';
const DISABLED_MESSAGE = 'Natural language queries are disabled. Enable them in VaultQuery settings.';
const NO_PROVIDER_MESSAGE = 'No provider is configured. Add one in VaultQuery settings.';

interface QuestionBlock {
  question: string;
  showSql: boolean;
  requestedOutput?: LlmReadOutputKind;
  outputOptions?: Record<string, string>;
}

function parseQuestionBlock(source: string, defaultShowSql: boolean): QuestionBlock {
  const sections = splitQuerySections(source);

  if (sections.templateConfigText !== null) {
    throw new Error('Natural language blocks use config: rather than template:.');
  }

  const config = parseKeyValueLines(sections.configSection);
  const outputValue = config.output?.trim().toLowerCase();
  let requestedOutput: LlmReadOutputKind | undefined;

  if (outputValue && outputValue !== 'auto') {
    if (!READ_OUTPUT_KINDS.has(outputValue as LlmReadOutputKind)) {
      throw new Error('Natural language output must be auto, table, markdown, chart, or calendar.');
    }

    requestedOutput = outputValue as LlmReadOutputKind;
  }

  const showSql = parseBooleanOption(config.showsql) ?? defaultShowSql;
  delete config.output;
  delete config.showsql;

  return {
    question: sections.sqlQuery.trim(),
    showSql,
    requestedOutput,
    outputOptions: Object.keys(config).length > 0 ? config : undefined
  };
}

function createProvider(config: LlmProviderConfig): LlmProvider {
  return new EndpointProvider(config);
}

function createCacheKey(request: QuestionBlock, provider: LlmProviderConfig, schemaInfo: string, allowWriteOperations: boolean): string {
  return hashString([
    String(SQL_PROMPT_VERSION),
    request.question,
    request.requestedOutput ?? 'auto',
    JSON.stringify(request.outputOptions ?? {}),
    allowWriteOperations ? 'writes-enabled' : 'read-only',
    provider.id,
    provider.url,
    provider.model ?? '',
    hashString(schemaInfo)
  ].join('\n'));
}

function formatGeneratedOutputConfig(generated: GeneratedVaultQuery, request: QuestionBlock): string | null {
  const { kind: outputKind, options } = resolveOutput(generated, request.requestedOutput, request.outputOptions);
  const includeOutput = outputKind !== 'table' || request.requestedOutput !== undefined;
  if (!includeOutput && Object.keys(options).length === 0) return null;

  const displayKeys = new Map(getConfigKeys(outputFenceLanguage(outputKind)).map(definition => [definition.key.toLowerCase(), definition.key]));
  const lines = ['config:'];
  if (includeOutput) lines.push(`output: ${outputKind}`);

  for (const [key, value] of Object.entries(options)) {
    if (key === 'output' || key === 'showsql') continue;
    lines.push(`${displayKeys.get(key.toLowerCase()) ?? key}: ${value}`);
  }

  return lines.join('\n');
}

export class LlmCodeBlockProcessor extends BaseReadQueryCodeBlockProcessor {
  private readonly cache = new GeneratedSqlCache(this.app);
  private readonly writeProcessor = new WriteCodeBlockProcessor(this.app, this.plugin);
  private readonly generations = new LatestRuns<GeneratedVaultQuery>((key, generated) => this.cache.set(key, generated));
  private generationGuard = new RenderVersionGuard();
  private regenerateHandlers = new WeakMap<HTMLElement, () => Promise<void>>();

  protected executeQuery(api: VaultQueryAPI, query: string, sourcePath: string): Promise<QueryResult[]> {
    return api.query(query, sourcePath);
  }

  public async process(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    await processQueryBlock(source, el, ctx, {
      app: this.app,
      plugin: this.plugin,
      prepare: container => {
        const request = parseQuestionBlock(source, this.plugin.settings.llm.showSql);

        if (!request.question) {
          container.createDiv({
            cls: 'vaultquery-empty',
            text: 'Enter a query request.'
          });

          return;
        }

        const unavailable = this.describeUnavailableProvider();

        if (unavailable) {
          BaseRenderer.renderError(container, {
            title: 'Natural language queries',
            message: unavailable
          });

          return;
        }

        return request;
      },
      render: (container, request) => this.renderQuestion(container, request, ctx)
    });
  }

  protected afterRender(container: HTMLElement): void {
    const regenerate = this.regenerateHandlers.get(container);

    if (regenerate) {
      this.addRegenerateButton(container, regenerate);
    }
  }

  private getDefaultProvider(): LlmProviderConfig | null {
    const llm = this.plugin.settings.llm;

    return llm.enabled ? llm.providers.find(provider => provider.id === llm.defaultProviderId) ?? null : null;
  }

  private describeUnavailableProvider(): string | null {
    if (this.getDefaultProvider()) {
      return null;
    }

    return this.plugin.settings.llm.enabled ? NO_PROVIDER_MESSAGE : DISABLED_MESSAGE;
  }

  private async renderQuestion(container: HTMLElement, request: QuestionBlock, ctx: MarkdownPostProcessorContext, regenerate = false): Promise<void> {
    const api = this.plugin.api;
    const providerConfig = this.getDefaultProvider();
    if (!api || !providerConfig) return;

    const version = this.generationGuard.begin(container);
    const isCurrent = (): boolean => this.generationGuard.isCurrent(container, version);
    const onRegenerate = (): Promise<void> => this.renderQuestion(container, request, ctx, true);
    cleanupRenderedOutput(container);
    const loading = new LlmProgressIndicator(container, providerConfig, isCurrent);
    ctx.addChild(loading);

    try {
      await api.waitForInitialQueryReadiness();
      if (!isCurrent()) return;
      loading.setStage('Reading vault structure...');
      const schema = await api.getSchemaTables();
      if (!isCurrent()) return;

      const allowWriteOperations = this.plugin.settings.llm.allowWriteOperations && this.plugin.settings.allowWriteOperations;
      const key = createCacheKey(request, providerConfig, JSON.stringify(schema), allowWriteOperations);
      let run = regenerate ? undefined : this.generations.current(key);

      if (!regenerate && !run) {
        loading.setStage('Checking saved query...');
        const cached = await this.cache.get(key);
        if (!isCurrent()) return;

        if (cached) {
          loading.setStage(cached.statementKind === 'write' ? 'Preparing saved change preview...' : 'Running saved query...');
          await this.renderGeneratedQuery(container, cached, request, ctx, version, onRegenerate);

          return;
        }

        run = this.generations.current(key);
      }

      run ??= this.generations.start(key, async () => {
        if (regenerate) await this.cache.invalidate(key);
        loading.setStage('Reading property names...');
        const propertyKeys = await this.readPropertyKeys();

        return generateAndRun(request.question, {
          schema,
          propertyKeys,
          provider: createProvider(providerConfig),
          runSql: (sql: string) => api.query(sql, ctx.sourcePath),
          previewWriteSql: (sql: string) => api.previewQuery(sql, [], ctx.sourcePath),
          allowWriteOperations,
          requestedOutput: request.requestedOutput,
          requestedOutputOptions: request.outputOptions,
          onProgress: progress => loading.setProgress(progress)
        });
      });

      const generated = await this.generations.settle(key, run) ?? await this.cache.get(key);
      if (!isCurrent()) return;

      if (!generated) {
        // A newer run for this question finished without leaving a result; ask again rather than show its stale outcome.
        await this.renderQuestion(container, request, ctx);

        return;
      }

      loading.setStage('Displaying results...');
      await this.renderGeneratedQuery(container, generated, request, ctx, version, onRegenerate);
    }
    catch (error: unknown) {
      if (!isCurrent()) {
        return;
      }

      this.renderGenerationError(container, error, onRegenerate);
    }
    finally {
      loading.remove();
    }
  }

  private async readPropertyKeys(): Promise<string[]> {
    try {
      const rows = await this.plugin.api?.query('SELECT DISTINCT key FROM properties ORDER BY key');

      return (rows ?? []).map(row => String(row.key)).filter(key => key.length > 0);
    }
    catch (error: unknown) {
      logger.debug('Could not read the frontmatter names', getErrorMessage(error));

      return [];
    }
  }

  private async renderGeneratedQuery(
    container: HTMLElement, generated: GeneratedVaultQuery, request: QuestionBlock,
    ctx: MarkdownPostProcessorContext, version: number, onRegenerate: () => Promise<void>
  ): Promise<void> {
    if (!this.generationGuard.isCurrent(container, version)) {
      return;
    }

    if (generated.statementKind === 'write') {
      if (!this.plugin.settings.llm.allowWriteOperations || !this.plugin.settings.allowWriteOperations) {
        throw new Error('Natural-language write operations are disabled. The generated statement was not run.');
      }

      if (!isWriteOnly(generated.sql)) {
        throw new Error('The saved query is not a supported INSERT, UPDATE, or DELETE statement. It was not run.');
      }
    }
    else if (!isSelectOnly(generated.sql)) {
      throw new Error('The saved query is not a single SELECT statement. It was not run.');
    }

    if (request.showSql && generated.statementKind !== 'write') {
      const sqlEl = container.createDiv({ cls: 'vaultquery-nl-sql' });
      BaseRenderer.renderSqlCodeBlock(this.app, sqlEl, generated.sql);

      const outputConfig = formatGeneratedOutputConfig(generated, request);

      if (outputConfig) {
        const configEl = container.createDiv({ cls: 'vaultquery-nl-config' });
        const pre = configEl.createEl('pre');
        pre.createEl('code', { text: outputConfig });
      }
    }

    const output = container.createDiv({ cls: 'vaultquery-nl-output' });
    this.regenerateHandlers.set(output, onRegenerate);

    if (generated.statementKind === 'write') {
      await this.writeProcessor.processGeneratedQuery(output, { query: generated.sql }, ctx);
      this.addRegenerateButton(output, onRegenerate);

      return;
    }

    const { kind, options } = resolveOutput(generated, request.requestedOutput, request.outputOptions);

    const parsed: ParsedQuery = {
      query: generated.sql,
      output: {
        kind,
        options: Object.keys(options).length > 0 ? options : undefined
      }
    };

    await this.processQueryInContainer(output, parsed, ctx);
  }

  private renderGenerationError(container: HTMLElement, error: unknown, onRegenerate: () => Promise<void>): void {
    cleanupRenderedOutput(container);

    if (error instanceof SqlGenerationError && error.sql.trim()) {
      const sqlEl = container.createDiv({ cls: 'vaultquery-nl-sql' });
      BaseRenderer.renderSqlCodeBlock(this.app, sqlEl, error.sql);
    }

    BaseRenderer.renderError(container, {
      title: 'Natural language query error',
      message: getErrorMessage(error)
    });

    this.addRegenerateButton(container, onRegenerate);
  }

  private addRegenerateButton(host: HTMLElement, onRegenerate: () => Promise<void>): void {
    let buttons = getFloatingButtonContainer(host);

    if (!buttons) {
      addFloatingButtons(host, {});
      buttons = getFloatingButtonContainer(host);
    }

    if (!buttons || buttons.querySelector(`.${REGENERATE_BUTTON_CLASS}`)) {
      return;
    }

    BaseRenderer.addRegenerateButton(buttons, onRegenerate).addClass(REGENERATE_BUTTON_CLASS);
  }
}
