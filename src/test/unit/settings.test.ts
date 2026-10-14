import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateTokens, numCtxToRequest, requiredContextTokens } from '../../core/backends';
import { DEFAULT_MODEL, backendOptions, parseSettings, resolveUpdateTarget } from '../../core/settings';

function withValues(values: Record<string, unknown>) {
  return parseSettings((key) => values[key]);
}

describe('parseSettings', () => {
  it('uses the documented defaults when nothing is configured', () => {
    const settings = parseSettings(() => undefined);
    assert.equal(settings.model, DEFAULT_MODEL);
    assert.equal(settings.provider, 'ollama');
    assert.equal(settings.maxTokens, 128);
    assert.equal(settings.timeoutMs, 30_000);
    assert.equal(settings.maxContextTokens, 8192);
    assert.equal(settings.stream, true);
    assert.equal(settings.statusBar, 'always');
    assert.equal(settings.keepAlive, '');
    assert.equal(settings.commitMessage, true);
    assert.equal(settings.commitMessageModel, '');
    assert.equal(settings.commitMessageMaxDiffChars, 20_000);
  });

  it('keeps a value inside the range the setting allows', () => {
    // A typo like 400000 for maxTokens would otherwise mean a request that never finishes.
    assert.equal(withValues({ maxTokens: 400_000 }).maxTokens, 4096);
    assert.equal(withValues({ maxTokens: 0 }).maxTokens, 1);
    assert.equal(withValues({ temperature: 20 }).temperature, 2);
    assert.equal(withValues({ timeoutMs: 5 }).timeoutMs, 1000);
  });

  it('falls back to the default when a setting holds the wrong type', () => {
    assert.equal(withValues({ maxTokens: 'a lot' }).maxTokens, 128);
    assert.equal(withValues({ stream: 'yes' }).stream, true);
    assert.equal(withValues({ commitMessage: 'yes' }).commitMessage, true);
    assert.equal(withValues({ commitMessage: false }).commitMessage, false);
    assert.equal(withValues({ multiline: 'sometimes' }).multiline, 'auto');
    assert.equal(withValues({ provider: 'llama.cpp' }).provider, 'ollama');
    assert.equal(withValues({ showStatusBar: 'nope' }).statusBar, 'always');
    assert.deepEqual(withValues({ stopSequences: ['ok', 7, ''] }).stopSequences, ['ok']);
  });

  it('treats a blank model as no model, and trims the rest', () => {
    assert.equal(withValues({ model: '   ' }).model, DEFAULT_MODEL);
    assert.equal(withValues({ model: ' qwen2.5-coder:1.5b-base ' }).model, 'qwen2.5-coder:1.5b-base');
    assert.equal(withValues({ keepAlive: ' 5m ' }).keepAlive, '5m');
  });
});

describe('backendOptions', () => {
  it('passes the timeout and keep_alive through, and leaves keep_alive alone when empty', () => {
    assert.deepEqual(backendOptions(withValues({ timeoutMs: 5000 }), 'secret'), {
      provider: 'ollama',
      endpoint: '',
      apiKey: 'secret',
      model: DEFAULT_MODEL,
      timeoutMs: 5000,
      keepAlive: undefined,
    });
    assert.equal(backendOptions(withValues({ keepAlive: '30s' }), '').keepAlive, '30s');
  });
});

describe('context sizing', () => {
  it('estimates tokens from characters', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abc'), 1);
    assert.equal(estimateTokens('abcd'), 2);
    assert.equal(estimateTokens('x'.repeat(3000)), 1000);
  });

  it('asks for room for the reply and a little headroom on top of the prompt', () => {
    assert.equal(requiredContextTokens('x'.repeat(3000), 128), 1000 + 128 + 128);
  });

  it('only sends num_ctx when the prompt really outgrows Ollama default', () => {
    // Sending a smaller num_ctx than the server already uses would shrink a window the user chose.
    assert.equal(numCtxToRequest(4096, 8192), 0);
    assert.equal(numCtxToRequest(5000, 8192), 5000);
    assert.equal(numCtxToRequest(20_000, 8192), 8192);
    assert.equal(numCtxToRequest(20_000, 0), 0);
  });
});

describe('resolveUpdateTarget', () => {
  it('writes back to wherever the value is currently set', () => {
    // A folder setting shadows the user setting, so writing the toggle to the user setting would
    // look like a toggle that does nothing.
    assert.deepEqual(resolveUpdateTarget({ workspaceFolderValue: false, workspaceValue: false }, true), {
      scope: 'workspaceFolder',
      value: true,
    });
    assert.deepEqual(resolveUpdateTarget({ workspaceValue: false }, true), { scope: 'workspace', value: true });
    assert.deepEqual(resolveUpdateTarget({}, true), { scope: 'global', value: true });
  });

  it('removes the key when the toggle goes back to the default', () => {
    assert.deepEqual(resolveUpdateTarget({ defaultValue: true }, true), { scope: 'global', value: undefined });
    assert.deepEqual(resolveUpdateTarget({ defaultValue: ['typescript'] }, ['typescript']), {
      scope: 'global',
      value: undefined,
    });
    // Only the higher scopes keep their value: they are what the user set there on purpose.
    assert.deepEqual(resolveUpdateTarget({ workspaceValue: true }, true), { scope: 'workspace', value: true });
  });
});
