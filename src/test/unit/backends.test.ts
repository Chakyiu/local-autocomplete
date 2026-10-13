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

function failsWith(kind: BackendErrorKind, message?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof BackendError, `expected a BackendError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    if (message) assert.match(error.message, message);
    return true;
  };
}

const request = { prompt: 'p', stop: [], maxTokens: 8, temperature: 0 };

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

  describe('Ollama', () => {
    const ollama = () => createBackend({ provider: 'ollama', endpoint: baseUrl, model: 'qwen2.5-coder:1.5b-base' });

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

    it('reports a model that has not been pulled', async () => {
      respond = json(404, { error: 'model "qwen2.5-coder:1.5b-base" not found, try pulling it first' });
      await assert.rejects(ollama().complete(request), failsWith('model-not-found', /try pulling it first/));
    });
  });

  describe('OpenAI-compatible', () => {
    const openai = (apiKey?: string) =>
      createBackend({ provider: 'openai-compatible', endpoint: baseUrl, model: 'local-model', apiKey });

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
  });

  it('drops trailing slashes, and adds /v1 to a bare OpenAI-compatible origin', () => {
    assert.equal(resolveBaseUrl('ollama', 'http://gpu-box:11434/'), 'http://gpu-box:11434');
    assert.equal(resolveBaseUrl('openai-compatible', 'http://127.0.0.1:8080'), 'http://127.0.0.1:8080/v1');
    assert.equal(resolveBaseUrl('openai-compatible', 'http://127.0.0.1:8080/api/v1/'), 'http://127.0.0.1:8080/api/v1');
  });
});
