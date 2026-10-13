export type ProviderId = 'ollama' | 'openai-compatible';

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible server',
};

const DEFAULT_ENDPOINTS: Readonly<Record<ProviderId, string>> = {
  ollama: 'http://127.0.0.1:11434',
  'openai-compatible': 'http://127.0.0.1:1234/v1',
};

const DEFAULT_TIMEOUT_MS = 30_000;

export interface BackendOptions {
  provider: ProviderId;
  /** Base URL of the server; empty for the provider's default. */
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface CompletionRequest {
  prompt: string;
  stop: readonly string[];
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  /** Number of generated tokens, when the server reports it. */
  tokens?: number;
}

export interface Backend {
  readonly baseUrl: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  listModels(signal?: AbortSignal): Promise<string[]>;
}

export type BackendErrorKind =
  | 'invalid-endpoint'
  | 'unreachable'
  | 'timeout'
  | 'model-not-found'
  | 'http'
  | 'invalid-response';

/**
 * A failure talking to the server. Cancellation through the request's own signal is not a
 * BackendError: the abort error is rethrown unchanged.
 */
export class BackendError extends Error {
  constructor(
    readonly kind: BackendErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BackendError';
  }
}

export function resolveBaseUrl(provider: ProviderId, endpoint: string): string {
  const url = endpoint.trim().replace(/\/+$/, '');
  if (url === '') return DEFAULT_ENDPOINTS[provider];
  if (provider === 'openai-compatible' && pathOf(url) === '/') return `${url}/v1`;
  return url;
}

export function createBackend(options: BackendOptions): Backend {
  return options.provider === 'ollama' ? new OllamaBackend(options) : new OpenAICompatibleBackend(options);
}

class OllamaBackend implements Backend {
  readonly baseUrl: string;

  constructor(private readonly options: BackendOptions) {
    this.baseUrl = resolveBaseUrl('ollama', options.endpoint);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body = await requestJson(this.baseUrl, '/api/generate', this.options, request.signal, {
      model: this.options.model,
      prompt: request.prompt,
      raw: true,
      stream: false,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
        stop: request.stop,
      },
    });
    if (!isRecord(body) || typeof body.response !== 'string') {
      throw invalidResponse(this.baseUrl, '/api/generate');
    }
    return { text: body.response, tokens: numberOrUndefined(body.eval_count) };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const body = await requestJson(this.baseUrl, '/api/tags', this.options, signal);
    const models = isRecord(body) && Array.isArray(body.models) ? body.models : [];
    return models.flatMap((model) => (isRecord(model) && typeof model.name === 'string' ? [model.name] : []));
  }
}

class OpenAICompatibleBackend implements Backend {
  readonly baseUrl: string;

  constructor(private readonly options: BackendOptions) {
    this.baseUrl = resolveBaseUrl('openai-compatible', options.endpoint);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body = await requestJson(this.baseUrl, '/completions', this.options, request.signal, {
      model: this.options.model,
      prompt: request.prompt,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: false,
      ...(request.stop.length > 0 ? { stop: request.stop } : {}),
    });
    const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
    if (!isRecord(body) || !isRecord(choice) || typeof choice.text !== 'string') {
      throw invalidResponse(this.baseUrl, '/completions');
    }
    const usage = isRecord(body.usage) ? body.usage.completion_tokens : undefined;
    return { text: choice.text, tokens: numberOrUndefined(usage) };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const body = await requestJson(this.baseUrl, '/models', this.options, signal);
    const models = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    return models.flatMap((model) => (isRecord(model) && typeof model.id === 'string' ? [model.id] : []));
  }
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: BackendOptions,
  signal: AbortSignal | undefined,
  payload?: unknown,
): Promise<unknown> {
  if (!/^https?:$/.test(protocolOf(baseUrl) ?? '')) {
    throw new BackendError('invalid-endpoint', `"${baseUrl}" is not a valid http:// or https:// URL`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  let status: number;
  let text: string;
  try {
    const response = await fetch(baseUrl + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new BackendError('timeout', `No response from ${baseUrl} within ${timeoutMs / 1000} s`, { cause: error });
    }
    throw new BackendError('unreachable', `Cannot connect to ${baseUrl}${describeCause(error)}`, { cause: error });
  }

  if (status < 200 || status >= 300) {
    const detail = errorMessageFrom(text) ?? (text.trim().slice(0, 200) || 'no details');
    const kind = status === 404 && /model/i.test(detail) ? 'model-not-found' : 'http';
    throw new BackendError(kind, `${baseUrl}${path} responded with ${status}: ${detail}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BackendError('invalid-response', `${baseUrl}${path} did not return JSON`, { cause: error });
  }
}

function errorMessageFrom(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) return undefined;
    if (typeof body.error === 'string') return body.error;
    if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message;
    if (typeof body.message === 'string') return body.message;
  } catch {
    // Not JSON; the caller falls back to the raw text.
  }
  return undefined;
}

function describeCause(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = isRecord(cause) && typeof cause.code === 'string' ? cause.code : undefined;
  return code ? ` (${code})` : '';
}

function invalidResponse(baseUrl: string, path: string): BackendError {
  return new BackendError('invalid-response', `Unexpected response from ${baseUrl}${path}`);
}

function protocolOf(url: string): string | undefined {
  try {
    return new URL(url).protocol;
  } catch {
    return undefined;
  }
}

function pathOf(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
