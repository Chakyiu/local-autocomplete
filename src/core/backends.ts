export type ProviderId = 'ollama' | 'openai-compatible' | 'openai-chat';

export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible server',
  'openai-chat': 'OpenAI-compatible server (chat only)',
};

export const PROVIDERS: readonly ProviderId[] = ['ollama', 'openai-compatible', 'openai-chat'];

const DEFAULT_ENDPOINTS: Readonly<Record<ProviderId, string>> = {
  ollama: 'http://127.0.0.1:11434',
  'openai-compatible': 'http://127.0.0.1:1234/v1',
  'openai-chat': 'http://127.0.0.1:1234/v1',
};

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Ollama's own default context window. `num_ctx` is only sent to go above it, never below. */
export const OLLAMA_DEFAULT_NUM_CTX = 4096;

/** Characters per token used to size the context window; local code models average 3-4. */
export const CHARS_PER_TOKEN = 3;

/** Tokens left over for the prompt template's own markers and for tokenizer differences. */
export const CONTEXT_HEADROOM_TOKENS = 128;

/** Rough token count of a prompt, deliberately generous so the window is never undersized. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Context the server needs for one request: the prompt, the completion, and a little headroom. */
export function requiredContextTokens(prompt: string, maxTokens: number): number {
  return estimateTokens(prompt) + maxTokens + CONTEXT_HEADROOM_TOKENS;
}

/**
 * The `num_ctx` worth asking Ollama for, or 0 to send nothing at all. Only ever above
 * `OLLAMA_DEFAULT_NUM_CTX`: sending a smaller value would silently shrink a context window the user
 * already configured on the server, and Ollama cuts the front off a prompt that does not fit.
 * `limit` of 0 switches `num_ctx` off entirely, leaving the server to decide.
 */
export function numCtxToRequest(needed: number, limit: number): number {
  if (limit <= 0) return 0;
  const clamped = Math.min(needed, limit);
  return clamped > OLLAMA_DEFAULT_NUM_CTX ? clamped : 0;
}

export interface BackendOptions {
  provider: ProviderId;
  /** Base URL of the server; empty for the provider's default. */
  endpoint: string;
  model: string;
  apiKey?: string;
  /** How long to wait for the first piece of text; re-armed by every chunk while streaming. */
  timeoutMs?: number;
  /** Ollama only: how long the server keeps the model loaded, for example `5m`. Empty means the server default. */
  keepAlive?: string;
}

export interface CompletionRequest {
  prompt: string;
  stop: readonly string[];
  maxTokens: number;
  temperature: number;
  /**
   * Tokens the server must keep room for: the prompt and the generation together. Ollama silently
   * truncates a longer prompt from the front, which cuts the fill-in-the-middle markers off.
   */
  contextTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  /** Number of generated tokens, when the server reports it. */
  tokens?: number;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * An instruction, not a fill-in-the-middle prompt. Commit messages go through this: a base completion
 * model continues text, it does not follow "write a commit message".
 */
export interface ChatRequest {
  messages: readonly ChatMessage[];
  maxTokens: number;
  temperature: number;
  /** Same role as `CompletionRequest.contextTokens`: room Ollama must keep for the whole exchange. */
  contextTokens?: number;
  signal?: AbortSignal;
}

export interface Backend {
  readonly baseUrl: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /**
   * Hands over the completion as the server produces it. Return true from `onText` to stop early:
   * the rest of the generation is cancelled and the result holds everything given so far.
   */
  streamComplete(request: CompletionRequest, onText: (chunk: string) => boolean): Promise<CompletionResult>;
  chat(request: ChatRequest): Promise<CompletionResult>;
  /** Like `streamComplete`, for a chat exchange. Return true from `onText` to stop early. */
  streamChat(request: ChatRequest, onText: (chunk: string) => boolean): Promise<CompletionResult>;
  listModels(signal?: AbortSignal): Promise<string[]>;
}

export type BackendErrorKind =
  'invalid-endpoint' | 'unreachable' | 'timeout' | 'model-not-found' | 'context-overflow' | 'http' | 'invalid-response';

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
  if (provider !== 'ollama' && pathOf(url) === '/') return `${url}/v1`;
  return url;
}

export function createBackend(options: BackendOptions): Backend {
  if (options.provider === 'ollama') return new OllamaBackend(options);
  return new OpenAICompatibleBackend(options, options.provider === 'openai-chat' ? 'chat' : 'completions');
}

/** Which OpenAI-style endpoint a server actually answers on. */
type OpenAIPath = 'completions' | 'chat';

class OllamaBackend implements Backend {
  readonly baseUrl: string;

  constructor(private readonly options: BackendOptions) {
    this.baseUrl = resolveBaseUrl('ollama', options.endpoint);
  }

  /**
   * Ollama keeps a model in memory for five minutes by default, so a cold start is normally paid
   * once per editing session; `keep_alive` is what makes that window longer or shorter.
   */
  private payload(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const numCtx =
      request.contextTokens !== undefined && request.contextTokens > OLLAMA_DEFAULT_NUM_CTX
        ? request.contextTokens
        : undefined;
    const keepAlive = this.options.keepAlive?.trim();
    return {
      model: this.options.model,
      prompt: request.prompt,
      raw: true,
      stream,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
        stop: request.stop,
        ...(numCtx === undefined ? {} : { num_ctx: numCtx }),
      },
      ...(keepAlive ? { keep_alive: keepAlive } : {}),
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body = await requestJson(
      this.baseUrl,
      '/api/generate',
      this.options,
      request.signal,
      this.payload(request, false),
    );
    if (!isRecord(body) || typeof body.response !== 'string') {
      throw invalidResponse(this.baseUrl, '/api/generate');
    }
    return { text: body.response, tokens: numberOrUndefined(body.eval_count) };
  }

  async streamComplete(request: CompletionRequest, onText: (chunk: string) => boolean): Promise<CompletionResult> {
    let text = '';
    let tokens: number | undefined;
    // One JSON object per line. A server that ignores `stream` answers with a single object, which
    // this reads in one go, so the caller cannot tell the difference.
    await readLines(
      this.baseUrl,
      '/api/generate',
      this.options,
      request.signal,
      this.payload(request, true),
      (line) => {
        const event = parseJsonObject(line);
        if (event === undefined) return false;
        if (event.done === true) tokens = numberOrUndefined(event.eval_count);
        if (typeof event.response !== 'string' || event.response === '') return false;
        text += event.response;
        return onText(event.response);
      },
    );
    return { text, tokens };
  }

  async chat(request: ChatRequest): Promise<CompletionResult> {
    const body = await requestJson(
      this.baseUrl,
      '/api/chat',
      this.options,
      request.signal,
      this.chatPayload(request, false),
    );
    const message = isRecord(body) && isRecord(body.message) ? body.message : undefined;
    if (!isRecord(body) || typeof message?.content !== 'string') throw invalidResponse(this.baseUrl, '/api/chat');
    return { text: message.content, tokens: numberOrUndefined(body.eval_count) };
  }

  async streamChat(request: ChatRequest, onText: (chunk: string) => boolean): Promise<CompletionResult> {
    let text = '';
    let tokens: number | undefined;
    await readLines(
      this.baseUrl,
      '/api/chat',
      this.options,
      request.signal,
      this.chatPayload(request, true),
      (line) => {
        const event = parseJsonObject(line);
        if (event === undefined) return false;
        if (event.done === true) tokens = numberOrUndefined(event.eval_count);
        const content = isRecord(event.message) ? event.message.content : undefined;
        if (typeof content !== 'string' || content === '') return false;
        text += content;
        return onText(content);
      },
    );
    return { text, tokens };
  }

  /** Chat, so Ollama applies the model's template. `raw` would send the messages as literal text. */
  private chatPayload(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const numCtx =
      request.contextTokens !== undefined && request.contextTokens > OLLAMA_DEFAULT_NUM_CTX
        ? request.contextTokens
        : undefined;
    const keepAlive = this.options.keepAlive?.trim();
    return {
      model: this.options.model,
      messages: request.messages,
      stream,
      options: {
        temperature: request.temperature,
        num_predict: request.maxTokens,
        ...(numCtx === undefined ? {} : { num_ctx: numCtx }),
      },
      ...(keepAlive ? { keep_alive: keepAlive } : {}),
    };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const body = await requestJson(this.baseUrl, '/api/tags', this.options, signal);
    const models = isRecord(body) && Array.isArray(body.models) ? body.models : [];
    return models.flatMap((model) => (isRecord(model) && typeof model.name === 'string' ? [model.name] : []));
  }
}

class OpenAICompatibleBackend implements Backend {
  readonly baseUrl: string;

  constructor(
    private readonly options: BackendOptions,
    private readonly path: OpenAIPath,
  ) {
    this.baseUrl = resolveBaseUrl(options.provider, options.endpoint);
  }

  private get endpoint(): string {
    return this.path === 'chat' ? '/chat/completions' : '/completions';
  }

  private payload(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    return {
      model: this.options.model,
      // A chat-only server has no raw prompt field, so the fill-in-the-middle prompt goes in as one user message.
      ...(this.path === 'chat'
        ? { messages: [{ role: 'user', content: request.prompt }] }
        : { prompt: request.prompt }),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream,
      ...(request.stop.length > 0 ? { stop: request.stop } : {}),
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const path = this.endpoint;
    const body = await requestJson(this.baseUrl, path, this.options, request.signal, this.payload(request, false));
    const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
    if (!isRecord(body) || !isRecord(choice)) throw invalidResponse(this.baseUrl, path);
    const text = this.path === 'chat' ? this.chatText(choice, path) : this.rawText(choice, path);
    const usage = isRecord(body.usage) ? body.usage.completion_tokens : undefined;
    return { text: this.fence(text), tokens: numberOrUndefined(usage) };
  }

  async streamComplete(request: CompletionRequest, onText: (chunk: string) => boolean): Promise<CompletionResult> {
    const path = this.endpoint;
    let text = '';
    let tokens: number | undefined;
    let sawReasoning = false;
    await readLines(this.baseUrl, path, this.options, request.signal, this.payload(request, true), (line) => {
      const data = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (data === '' || data === '[DONE]') return data === '[DONE]';
      const event = parseJsonObject(data);
      if (event === undefined) return false;
      const usage = isRecord(event.usage) ? numberOrUndefined(event.usage.completion_tokens) : undefined;
      if (usage !== undefined) tokens = usage;
      const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
      if (isRecord(choice)) sawReasoning ||= isReasoningChunk(choice);
      const delta = isRecord(choice) ? this.deltaText(choice) : '';
      if (delta === '') return false;
      text += delta;
      return onText(delta);
    });
    if (this.path === 'chat' && text === '' && sawReasoning) throw noMessageContent(this.baseUrl, path, true);
    return { text: this.fence(text), tokens };
  }

  async chat(request: ChatRequest): Promise<CompletionResult> {
    return this.exchange(request, false);
  }

  async streamChat(request: ChatRequest, onText: (chunk: string) => boolean): Promise<CompletionResult> {
    return this.exchange(request, true, onText);
  }

  /**
   * Always `/chat/completions`, even for a server whose completions go to `/completions`. An instruct
   * model follows a commit-message request; the raw completions route would only continue the text.
   */
  private async exchange(
    request: ChatRequest,
    stream: boolean,
    onText?: (chunk: string) => boolean,
  ): Promise<CompletionResult> {
    const path = '/chat/completions';
    const payload = {
      model: this.options.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream,
    };
    if (!stream) {
      const body = await requestJson(this.baseUrl, path, this.options, request.signal, payload);
      const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
      if (!isRecord(body) || !isRecord(choice)) throw invalidResponse(this.baseUrl, path);
      const usage = isRecord(body.usage) ? body.usage.completion_tokens : undefined;
      return { text: chatMessageText(this.baseUrl, path, choice), tokens: numberOrUndefined(usage) };
    }

    let text = '';
    let tokens: number | undefined;
    let sawReasoning = false;
    await readLines(this.baseUrl, path, this.options, request.signal, payload, (line) => {
      const data = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (data === '' || data === '[DONE]') return data === '[DONE]';
      const event = parseJsonObject(data);
      if (event === undefined) return false;
      const usage = isRecord(event.usage) ? numberOrUndefined(event.usage.completion_tokens) : undefined;
      if (usage !== undefined) tokens = usage;
      const choice = Array.isArray(event.choices) ? event.choices[0] : undefined;
      if (!isRecord(choice)) return false;
      sawReasoning ||= isReasoningChunk(choice);
      const delta = isRecord(choice.delta) && typeof choice.delta.content === 'string' ? choice.delta.content : '';
      if (delta === '') return false;
      text += delta;
      return onText?.(delta) ?? false;
    });
    if (text === '' && sawReasoning) throw noMessageContent(this.baseUrl, path, true);
    return { text, tokens };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const body = await requestJson(this.baseUrl, '/models', this.options, signal);
    const models = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    return models.flatMap((model) => (isRecord(model) && typeof model.id === 'string' ? [model.id] : []));
  }

  /** Completions stream the answer in `text`; chat streams it in `delta.content`. */
  private deltaText(choice: Record<string, unknown>): string {
    if (this.path !== 'chat') return this.field(choice, 'text');
    return this.field(isRecord(choice.delta) ? choice.delta : undefined, 'content');
  }

  private rawText(choice: Record<string, unknown>, path: string): string {
    if (typeof choice.text !== 'string') throw invalidResponse(this.baseUrl, path);
    return choice.text;
  }

  private field(record: Record<string, unknown> | undefined, key: string): string {
    const value = record?.[key];
    return typeof value === 'string' ? value : '';
  }

  /** Chat servers answer with `message.content`; `reasoning_content` is chain-of-thought, never code. */
  private chatText(choice: Record<string, unknown>, path: string): string {
    return chatMessageText(this.baseUrl, path, choice);
  }

  /**
   * A chat model wraps code in a markdown fence; ghost text is not a chat window.
   * shortcut: also unwraps a fence a chat model wrote as the answer itself, e.g. when completing a
   * markdown document; upgrade by only doing this when the cursor is not inside a fenced block.
   */
  private fence(text: string): string {
    if (this.path !== 'chat') return text;
    const match = /^```[^\n`]*\n([\s\S]*?)\s*`*\s*$/.exec(text.trim());
    return match === null ? text : match[1];
  }
}

function isReasoningChunk(choice: Record<string, unknown>): boolean {
  return isRecord(choice.delta) && typeof choice.delta.reasoning_content === 'string';
}

function chatMessageText(baseUrl: string, path: string, choice: Record<string, unknown>): string {
  const message = isRecord(choice.message) ? choice.message : undefined;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (content !== null && content !== undefined) throw invalidResponse(baseUrl, path);
  // A reasoning model can spend the whole reply on `reasoning_content` and leave `content` null.
  throw noMessageContent(baseUrl, path, typeof message?.reasoning_content === 'string');
}

function noMessageContent(baseUrl: string, path: string, reasoning: boolean): BackendError {
  return new BackendError(
    'invalid-response',
    `${baseUrl}${path} returned no message content${reasoning ? ', only reasoning text: raise localAutocomplete.maxTokens or use a base completion model' : ''}`,
  );
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
    throw errorForStatus(baseUrl, path, status, text);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BackendError('invalid-response', `${baseUrl}${path} did not return JSON`, { cause: error });
  }
}

/**
 * Reads a streamed response a line at a time. The timeout is a gap timeout rather than a total one:
 * every chunk re-arms it, so a slow first token is caught without cutting a long generation off.
 */
async function readLines(
  baseUrl: string,
  path: string,
  options: BackendOptions,
  caller: AbortSignal | undefined,
  payload: unknown,
  onLine: (line: string) => boolean,
): Promise<void> {
  if (!/^https?:$/.test(protocolOf(baseUrl) ?? '')) {
    throw new BackendError('invalid-endpoint', `"${baseUrl}" is not a valid http:// or https:// URL`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = startIdleTimeout(timeoutMs, caller);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { ...headersFor(options), Accept: 'text/event-stream, application/x-ndjson, application/json' },
      body: JSON.stringify(payload),
      signal: pending.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      throw errorForStatus(baseUrl, path, response.status, await response.text().catch(() => ''));
    }
    if (response.body === null) {
      throw invalidResponse(baseUrl, path);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      pending.touch();
      buffer += decoder.decode(value, { stream: true });
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== '' && onLine(line)) {
          // Enough text has arrived that nothing more can change the completion: stop paying for it.
          await reader.cancel();
          return;
        }
      }
    }
  } catch (error) {
    if (error instanceof BackendError) throw error;
    if (caller?.aborted) throw error;
    if (pending.timedOut()) {
      throw new BackendError('timeout', `No text from ${baseUrl} within ${timeoutMs / 1000} s`, { cause: error });
    }
    if (isAbortError(error)) return; // cancelled while a chunk was in flight; what arrived stands
    throw new BackendError('unreachable', `Cannot connect to ${baseUrl}${describeCause(error)}`, { cause: error });
  } finally {
    pending.dispose();
    reader?.releaseLock();
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

interface IdleTimeout {
  readonly signal: AbortSignal;
  /** Re-arm the timer, because the server has just said something. */
  touch(): void;
  timedOut(): boolean;
  dispose(): void;
}

function startIdleTimeout(timeoutMs: number, caller?: AbortSignal): IdleTimeout {
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      expired = true;
      idle.abort(new Error('TimeoutError'));
    }, timeoutMs);
    timer.unref();
  };
  arm();
  return {
    signal: caller ? AbortSignal.any([caller, idle.signal]) : idle.signal,
    touch: arm,
    timedOut: () => expired,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function headersFor(options: BackendOptions): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  return headers;
}

/** Sequences servers use to say the prompt and the generation do not fit the context window. */
const CONTEXT_OVERFLOW_PATTERN =
  /context length|too many tokens|maximum context|context window|num_ctx|input is too long/i;

const CHAT_ONLY_HINT =
  '. This server has no /v1/completions endpoint: if it answers /v1/chat/completions, set localAutocomplete.provider to "openai-chat"';

function errorForStatus(baseUrl: string, path: string, status: number, text: string): BackendError {
  const detail = errorMessageFrom(text) ?? (text.trim().slice(0, 200) || 'no details');
  const overflow = status >= 400 && status < 500 && CONTEXT_OVERFLOW_PATTERN.test(detail);
  const kind = status === 404 && /model/i.test(detail) ? 'model-not-found' : overflow ? 'context-overflow' : 'http';
  // A 404 on the raw-completions route is how a chat-only gateway says so; name the setting that fixes
  // it where the user is already looking instead of leaving them to find it in the docs.
  const hint = kind === 'http' && status === 404 && path === '/completions' ? CHAT_ONLY_HINT : '';
  return new BackendError(kind, `${baseUrl}${path} responded with ${status}: ${detail}${hint}`);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
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
