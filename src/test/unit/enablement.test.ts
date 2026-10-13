import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flippedFileSetting, resolveEnablement } from '../../core/enablement';

function outcome(everywhere: boolean, language: boolean, file: boolean | undefined) {
  const { enabled, decidedBy } = resolveEnablement({ everywhere, language, file });
  return { enabled, decidedBy };
}

describe('resolveEnablement', () => {
  it('follows the language when the file has no setting of its own', () => {
    assert.deepEqual(outcome(true, true, undefined), { enabled: true, decidedBy: 'language' });
    assert.deepEqual(outcome(true, false, undefined), { enabled: false, decidedBy: 'language' });
  });

  it('lets a file setting override its language', () => {
    assert.deepEqual(outcome(true, false, true), { enabled: true, decidedBy: 'file' });
    assert.deepEqual(outcome(true, true, false), { enabled: false, decidedBy: 'file' });
  });

  it('is off when disabled everywhere, whatever the file and language say', () => {
    assert.deepEqual(outcome(false, true, true), { enabled: false, decidedBy: 'everywhere' });
  });
});

describe('flippedFileSetting', () => {
  it('disables a file whose language is enabled', () => {
    assert.equal(flippedFileSetting({ everywhere: true, language: true, file: undefined }), false);
  });

  it('enables a file whose language is disabled', () => {
    assert.equal(flippedFileSetting({ everywhere: true, language: false, file: undefined }), true);
  });

  it('goes back to following the language when flipped back', () => {
    assert.equal(flippedFileSetting({ everywhere: true, language: true, file: false }), undefined);
    assert.equal(flippedFileSetting({ everywhere: true, language: false, file: true }), undefined);
  });
});
