import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveEnablement } from '../../core/enablement';
import { describeStatus, type StatusInput } from '../../core/status';

const base: StatusInput = {
  everywhere: true,
  busy: false,
  model: 'qwen2.5-coder:1.5b-base',
  server: 'Ollama at http://127.0.0.1:11434',
};

function withFile(language: boolean, file: boolean | undefined, everywhere = true): StatusInput {
  return {
    ...base,
    everywhere,
    file: { name: 'app.ts', languageName: 'TypeScript', enablement: resolveEnablement({ everywhere, language, file }) },
  };
}

describe('describeStatus', () => {
  it('shows the model and server, and names the file when enabled', () => {
    const view = describeStatus(withFile(true, undefined));
    assert.equal(view.text, '$(sparkle) Autocomplete');
    assert.equal(view.summary, 'Enabled for app.ts');
    assert.match(view.tooltip, /Model: qwen2\.5-coder:1\.5b-base on Ollama at http:\/\/127\.0\.0\.1:11434/);
  });

  it('says which setting turned completions off', () => {
    assert.equal(describeStatus(withFile(true, false)).summary, 'Disabled for app.ts');
    assert.equal(describeStatus(withFile(false, undefined)).summary, 'Disabled for TypeScript files');
    assert.equal(describeStatus(withFile(true, true, false)).summary, 'Disabled everywhere');
    assert.equal(describeStatus({ ...base, everywhere: false }).summary, 'Disabled everywhere');
    assert.equal(describeStatus(withFile(false, undefined)).text, '$(circle-slash) Autocomplete');
  });

  it('shows a spinner while generating, then the last failure', () => {
    assert.equal(describeStatus({ ...withFile(true, undefined), busy: true }).text, '$(loading~spin) Autocomplete');

    const failed = describeStatus({ ...withFile(true, undefined), error: 'Cannot connect' });
    assert.equal(failed.text, '$(warning) Autocomplete');
    assert.equal(failed.warning, true);
    assert.match(failed.tooltip, /Last error: Cannot connect/);
  });

  it('does not flag failures while completions are off', () => {
    const view = describeStatus({ ...withFile(true, false), error: 'Cannot connect' });
    assert.equal(view.text, '$(circle-slash) Autocomplete');
    assert.equal(view.warning, false);
    assert.doesNotMatch(view.tooltip, /Last error/);
  });

  it('takes up less of the status bar when asked to', () => {
    assert.equal(describeStatus({ ...base, display: 'always' }).text, '$(sparkle) Autocomplete');
    assert.equal(describeStatus({ ...base, display: 'iconOnly' }).text, '$(sparkle)');
    assert.equal(describeStatus({ ...base, display: 'iconOnly' }).visible, true);
    assert.equal(describeStatus({ ...base, display: 'hidden' }).visible, false);
    assert.equal(describeStatus(base).visible, true, 'hidden has to be asked for');
  });
});
