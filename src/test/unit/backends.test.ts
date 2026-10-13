import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import { BackendError, createBackend, resolveBaseUrl, type BackendErrorKind } from '../../core/backends';

interface ReceivedRequest {
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

type Responder = (response: http.ServerResponse) => void;

function json(status: number, body: unknown): Responder {
  return (response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

const neverRespond: Responder = () => {};

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One JSON object per line, which is how Ollama answers `"stream": true`. */
function ndjson(lines: unknown[]): Responder {
  return (response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const line of lines) response.write(`${JSON.stringify(line)}\n`);
    response.end();
  };
}

/**
 * Writes `messages` one at a time, waiting between them, and records how many made it out before the
 * client hung up. That is the only way to see from the server side that reading really stopped early.
 */
function slowStream(messages: string[], gapMs: number, state: { written: number; closed: boolean }): Responder {
  return async (response) => {
    response.on('error', () => {});
    response.on('close', () => {
      state.closed = true;
    });
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const message of messages) {
      if (state.closed || response.destroyed) break;
      response.write(message);
      state.written++;
      await delay(gapMs);
    }
    response.end();
  };
}

/** Answers once, then goes quiet without closing the connection: only the silence can time out. */
function stallAfter(message: string): Responder {
  return (response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    response.on('error', () => {});
    response.write(message);
  };
}

/** The `text/event-stream` shape: `data: <json>` separated by blank lines, ending with `[DONE]`. */
function sse(events: string[]): Responder {
  return (response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of events) response.write(`data: ${event}\n\n`);
    response.end();
  };
}

function failsWith(kind: BackendErrorKind, message?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof BackendError, `expected a BackendError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    if (message) assert.match(error.message, message);
    return true;
  };
}

const request = { prompt: 'p', stop: [], maxTokens: 8, temperature: 0 };

/** The `num_ctx` the request asked Ollama for, or undefined when it left the server default alone. */
function contextOf(entry: ReceivedRequest): number | undefined {
  const options = (entry.body as { options?: Record<string, unknown> } | undefined)?.options;
  return options?.num_ctx as number | undefined;
}

describe('backends', () => {
  let server: http.Server;
  let baseUrl: string;
  let received: ReceivedRequest[] = [];
  let respond: Responder = neverRespond;

  before(async () => {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        received.push({ url: req.url, headers: req.headers, body: data ? JSON.parse(data) : undefined });
        respond(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    received = [];
    respond = neverRespond;
  });

  const ollama = () => createBackend({ provider: 'ollama', endpoint: baseUrl, model: 'qwen2.5-coder:1.5b-base' });
  const openai = (apiKey?: string) =>
    createBackend({ provider: 'openai-compatible', endpoint: baseUrl, model: 'local-model', apiKey });
  const openaiChat = () => createBackend({ provider: 'openai-chat', endpoint: baseUrl, model: 'chat-model' });

  describe('Ollama', () => {
    it('sends the prompt raw, so the model sees the fill-in-the-middle tokens as written', async () => {
      respond = json(200, { response: 'world', done: true, eval_count: 2 });
      const result = await ollama().complete({ prompt: '<P>hello ', stop: ['\n'], maxTokens: 16, temperature: 0.1 });

      assert.deepEqual(result, { text: 'world', tokens: 2 });
      assert.equal(received[0].url, '/api/generate');
      assert.deepEqual(received[0].body, {
        model: 'qwen2.5-coder:1.5b-base',
        prompt: '<P>hello ',
        raw: true,
        stream: false,
        options: { temperature: 0.1, num_predict: 16, stop: ['\n'] },
      });
    });

    it('lists installed models', async () => {
      respond = json(200, { models: [{ name: 'qwen2.5-coder:1.5b-base' }, { name: 'starcoder2:3b' }] });
      assert.deepEqual(await ollama().listModels(), ['qwen2.5-coder:1.5b-base', 'starcoder2:3b']);
      assert.equal(received[0].url, '/api/tags');
    });

    it('asks for a bigger context window only when the prompt needs one', async () => {
      respond = json(200, { response: '', done: true });
      await ollama().complete({ ...request, contextTokens: 8192 });
      await ollama().complete({ ...request, contextTokens: 2048 });

      // Ollama silently cuts the front off a prompt that does not fit, so a long prompt has to say how
      // much room it needs. A short one must not send num_ctx at all: that would shrink whatever the
      // user configured for the server.
      assert.equal(contextOf(received[0]), 8192);
      assert.equal(contextOf(received[1]), undefined);
    });

    it('passes keep_alive through so the model can stay loaded between requests', async () => {
      respond = json(200, { response: '', done: true });
      await createBackend({ provider: 'ollama', endpoint: baseUrl, model: 'm', keepAlive: '30m' }).complete(request);
      await ollama().complete(request);

      assert.equal((received[0].body as Record<string, unknown>).keep_alive, '30m');
      assert.equal((received[1].body as Record<string, unknown>).keep_alive, undefined);
    });

    it('reports a prompt the server refused to fit', async () => {
      respond = json(400, { error: "client error: this model's context window is 4096 tokens" });
      await assert.rejects(ollama().complete(request), failsWith('context-overflow', /context window/));
    });

    it('reports a model that has not been pulled', async () => {
      respond = json(404, { error: 'model "qwen2.5-coder:1.5b-base" not found, try pulling it first' });
      await assert.rejects(ollama().complete(request), failsWith('model-not-found', /try pulling it first/));
    });
  });

  describe('OpenAI-compatible', () => {
    it('posts to /v1/completions with the API key', async () => {
      respond = json(200, { choices: [{ text: 'world', finish_reason: 'stop' }], usage: { completion_tokens: 3 } });
      const result = await openai('secret').complete({ ...request, stop: ['\n'] });

      assert.deepEqual(result, { text: 'world', tokens: 3 });
      assert.equal(received[0].url, '/v1/completions');
      assert.equal(received[0].headers.authorization, 'Bearer secret');
      assert.deepEqual(received[0].body, {
        model: 'local-model',
        prompt: 'p',
        max_tokens: 8,
        temperature: 0,
        stream: false,
        stop: ['\n'],
      });
    });

    it('leaves out the stop field when there are no stop sequences, and the key when there is none', async () => {
      respond = json(200, { choices: [{ text: '' }] });
      await openai().complete(request);
      assert.equal(received[0].headers.authorization, undefined);
      assert.equal((received[0].body as Record<string, unknown>).stop, undefined);
    });

    it('lists models', async () => {
      respond = json(200, { data: [{ id: 'a' }, { id: 'b' }] });
      assert.deepEqual(await openai().listModels(), ['a', 'b']);
      assert.equal(received[0].url, '/v1/models');
    });

    it('points at openai-chat when the server has no raw completions route', async () => {
      respond = json(404, { error: { message: 'not found' } });

      await assert.rejects(openai().complete(request), failsWith('http', /"openai-chat"/));
    });
  });

  describe('OpenAI-compatible chat only', () => {
    it('sends the prompt as one user message to /v1/chat/completions', async () => {
      respond = json(200, {
        choices: [{ message: { role: 'assistant', content: 'world' } }],
        usage: { completion_tokens: 3 },
      });
      const result = await openaiChat().complete({ ...request, stop: ['\n'] });

      assert.deepEqual(result, { text: 'world', tokens: 3 });
      assert.equal(received[0].url, '/v1/chat/completions');
      assert.deepEqual(received[0].body, {
        model: 'chat-model',
        messages: [{ role: 'user', content: 'p' }],
        max_tokens: 8,
        temperature: 0,
        stream: false,
        stop: ['\n'],
      });
    });

    it('unwraps the markdown fence a chat model wraps code in, and ignores chain-of-thought', async () => {
      respond = json(200, {
        choices: [
          {
            message: {
              content: '```python\ndef f():\n    return 1\n```',
              reasoning_content: 'The user wants code…',
            },
          },
        ],
      });

      assert.equal((await openaiChat().complete(request)).text, 'def f():\n    return 1');
    });

    it('says why a reasoning model that used its whole budget on thinking has no completion', async () => {
      respond = json(200, { choices: [{ message: { content: null, reasoning_content: 'We need to respond' } }] });

      await assert.rejects(
        openaiChat().complete(request),
        failsWith('invalid-response', /no message content, only reasoning/),
      );
    });

    it('streams message content and skips reasoning deltas', async () => {
      respond = sse([
        '{"choices":[{"delta":{"reasoning_content":"think"}}]}',
        '{"choices":[{"delta":{"content":"re"}}]}',
        '{"choices":[{"delta":{"content":"sult"}}],"usage":{"completion_tokens":2}}',
        '[DONE]',
      ]);

      // Chain-of-thought arrives in the same `delta` object as the answer, under `reasoning_content`.
      assert.deepEqual(await openaiChat().streamComplete(request, () => false), { text: 'result', tokens: 2 });
      assert.equal(received[0].url, '/v1/chat/completions');
    });
  });

  describe('streaming', () => {
    const body = (index: number) => received[index].body as Record<string, unknown>;

    it('reassembles Ollama ndjson and takes the token count from the last line', async () => {
      respond = ndjson([{ response: 're' }, { response: 'sult' }, { response: '', done: true, eval_count: 7 }]);
      const chunks: string[] = [];
      const result = await ollama().streamComplete(request, (chunk) => {
        chunks.push(chunk);
        return false;
      });

      assert.deepEqual(result, { text: 'result', tokens: 7 });
      assert.deepEqual(chunks, ['re', 'sult']);
      assert.equal(body(0).stream, true);
    });

    it('reassembles OpenAI-compatible server-sent events', async () => {
      respond = sse([
        '{"choices":[{"text":"re"}]}',
        '{"choices":[{"text":"sult"}],"usage":{"completion_tokens":4}}',
        '[DONE]',
      ]);

      assert.deepEqual(await openai().streamComplete(request, () => false), { text: 'result', tokens: 4 });
      assert.equal(body(0).stream, true);
    });

    it('waits for a whole event when a packet splits in the middle of the json', async () => {
      respond = (response) => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"choices":[{"te');
        response.write('xt":"re"}]}\n\n');
        response.write('data: {"choices":[{"text":"sult"}]}\n\ndata: [DONE]\n\n');
        response.end();
      };

      assert.equal((await openai().streamComplete(request, () => false)).text, 'result');
    });

    it('hangs up as soon as the caller says the completion is settled', async () => {
      const state = { written: 0, closed: false };
      const parts = ['re', 'sult', '(', ')', ' junk', ' and more'];
      respond = slowStream(
        parts.map((part) => `${JSON.stringify({ response: part })}\n`),
        25,
        state,
      );

      const result = await ollama().streamComplete(request, (chunk) => chunk.includes(')'));
      await delay(50); // the server needs a moment to notice the hang-up

      // The whole point of streaming: the rest of the reply is never generated, so the ghost text lands
      // early. Returning true has to close the connection, not just stop the callback.
      assert.equal(result.text, 'result()');
      assert.ok(state.closed, 'the server should see the connection close early');
      assert.ok(state.written < parts.length, `the server wrote all ${state.written} parts, so nothing was saved`);
    });

    it('counts a stream that goes quiet against the timeout', async () => {
      respond = stallAfter('{"response":"a"}\n');
      const stalling = createBackend({ provider: 'ollama', endpoint: baseUrl, model: 'm', timeoutMs: 100 });
      await assert.rejects(
        stalling.streamComplete(request, () => false),
        failsWith('timeout', /within 0\.1 s/),
      );
    });

    it('does not time out a slow stream that keeps talking', async () => {
      respond = slowStream(
        [0, 1, 2, 3, 4].map((index) => `{"response":"${index}"}\n`),
        40,
        { written: 0, closed: false },
      );
      // 200 ms of reply on a 120 ms timeout: the wait is between pieces, not for the whole request.
      const patient = createBackend({ provider: 'ollama', endpoint: baseUrl, model: 'm', timeoutMs: 120 });
      assert.equal((await patient.streamComplete(request, () => false)).text, '01234');
    });

    it('lets cancellation through without calling it a server failure', async () => {
      respond = slowStream(['{"response":"a"}\n', '{"response":"b"}\n'], 50, { written: 0, closed: false });
      const controller = new AbortController();
      const pending = ollama().streamComplete({ ...request, signal: controller.signal }, () => false);
      setTimeout(() => controller.abort(), 20);

      await assert.rejects(pending, (error: unknown) => {
        assert.ok(!(error instanceof BackendError));
        assert.equal((error as Error).name, 'AbortError');
        return true;
      });
    });

    it('reports a server that answers a streaming request with a plain error', async () => {
      respond = json(500, { error: 'out of memory' });
      await assert.rejects(
        ollama().streamComplete(request, () => false),
        failsWith('http', /500: out of memory/),
      );
    });
  });

  describe('failures', () => {
    const backend = (timeoutMs?: number) =>
      createBackend({ provider: 'ollama', endpoint: baseUrl, model: 'm', timeoutMs });

    it('passes on the server message for other HTTP errors', async () => {
      respond = json(500, { error: 'out of memory' });
      await assert.rejects(backend().complete(request), failsWith('http', /500: out of memory/));
    });

    it('rejects responses of the wrong shape', async () => {
      respond = json(200, { unexpected: true });
      await assert.rejects(backend().complete(request), failsWith('invalid-response'));
    });

    it('times out when the server does not answer', async () => {
      await assert.rejects(backend(100).complete(request), failsWith('timeout'));
    });

    it('lets cancellation through as an abort rather than a server failure', async () => {
      const controller = new AbortController();
      const pending = backend().complete({ ...request, signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(!(error instanceof BackendError));
        assert.equal((error as Error).name, 'AbortError');
        return true;
      });
    });

    it('reports a server that is not running', async () => {
      const closed = http.createServer();
      await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const { port } = closed.address() as AddressInfo;
      await new Promise((resolve) => closed.close(resolve));

      const stopped = createBackend({ provider: 'ollama', endpoint: `http://127.0.0.1:${port}`, model: 'm' });
      await assert.rejects(stopped.complete(request), failsWith('unreachable', /ECONNREFUSED/));
    });

    it('rejects an endpoint that is not an http(s) URL', async () => {
      const invalid = createBackend({ provider: 'ollama', endpoint: 'localhost:11434', model: 'm' });
      await assert.rejects(invalid.complete(request), failsWith('invalid-endpoint'));
    });
  });
});

describe('resolveBaseUrl', () => {
  it('uses the provider default when empty', () => {
    assert.equal(resolveBaseUrl('ollama', ''), 'http://127.0.0.1:11434');
    assert.equal(resolveBaseUrl('openai-compatible', '  '), 'http://127.0.0.1:1234/v1');
    assert.equal(resolveBaseUrl('openai-chat', '  '), 'http://127.0.0.1:1234/v1');
  });

  it('drops trailing slashes, and adds /v1 to a bare OpenAI-compatible origin', () => {
    assert.equal(resolveBaseUrl('ollama', 'http://gpu-box:11434/'), 'http://gpu-box:11434');
    assert.equal(resolveBaseUrl('openai-compatible', 'http://127.0.0.1:8080'), 'http://127.0.0.1:8080/v1');
    assert.equal(resolveBaseUrl('openai-compatible', 'http://127.0.0.1:8080/api/v1/'), 'http://127.0.0.1:8080/api/v1');
    assert.equal(resolveBaseUrl('openai-chat', 'http://192.168.1.60:8080'), 'http://192.168.1.60:8080/v1');
  });
});
