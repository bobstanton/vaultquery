import { requestUrl } from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';
import type { LlmCompletionOptions, LlmPrompt, LlmProvider, LlmProviderConfig } from './LlmTypes';
import { getErrorMessage } from '../utils/ErrorMessages';

const BODY_SNIPPET_LIMIT = 400;

interface ChatCompletionChoice {
  message?: { content?: string };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: { message?: string } | string;
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');

  if (trimmed.length === 0) {
    throw new Error('This provider has no server URL. Set one in VaultQuery settings.');
  }

  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}/chat/completions`;
}

function bodySnippet(response: RequestUrlResponse): string {
  const text = (response.text || '').trim();
  if (text.length === 0) return '(empty response body)';

  return text.length > BODY_SNIPPET_LIMIT ? `${text.slice(0, BODY_SNIPPET_LIMIT)}...` : text;
}

function parseResponse(response: RequestUrlResponse): ChatCompletionResponse {
  try {
    return JSON.parse(response.text) as ChatCompletionResponse;
  }
  catch {
    throw new Error(`The server returned a response that is not JSON: ${bodySnippet(response)}`);
  }
}

function readContent(payload: ChatCompletionResponse): string {
  const content = payload.choices?.[0]?.message?.content;

  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('The server returned no completion text.');
  }

  return content;
}

export class EndpointProvider implements LlmProvider {
  public readonly config: LlmProviderConfig;

  constructor(config: LlmProviderConfig) {
    this.config = config;
  }

  public async complete(prompt: LlmPrompt, options?: LlmCompletionOptions): Promise<string> {
    const url = buildChatCompletionsUrl(this.config.url);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = this.config.apiKey?.trim();

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify({
      model: this.config.model ?? '',
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      temperature: options?.temperature ?? 0,
      stream: false
    });

    let response: RequestUrlResponse;

    try {
      response = await requestUrl({ url, method: 'POST', headers, body, throw: false });
    }
    catch (error) {
      throw new Error(`Could not reach the model server at ${url}: ${getErrorMessage(error)}`);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`The model server at ${url} returned ${response.status}: ${bodySnippet(response)}`);
    }

    const payload = parseResponse(response);

    if (payload.error) {
      const message = typeof payload.error === 'string' ? payload.error : payload.error.message;
      throw new Error(`The model server reported an error: ${message ?? bodySnippet(response)}`);
    }

    return readContent(payload);
  }
}
