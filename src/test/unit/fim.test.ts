import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FIM_FORMATS, detectFimTemplate, renderFimPrompt, resolveFimFormat } from '../../core/fim';

describe('detectFimTemplate', () => {
  it('recognizes common code models by name', () => {
    const cases: Array<[string, string | undefined]> = [
      ['qwen2.5-coder:1.5b-base', 'qwen'],
      ['Qwen/Qwen3-Coder-30B-A3B-Instruct', 'qwen'],
      ['codellama:7b-code', 'codellama'],
      ['deepseek-coder-v2:16b-lite-base-q4_0', 'deepseek'],
      ['starcoder2:3b', 'starcoder'],
      ['granite-code:3b', 'starcoder'],
      ['stable-code:3b-code', 'starcoder'],
      ['codegemma:2b-code', 'codegemma'],
      ['codestral:22b', 'codestral'],
      ['llama3.2:3b', undefined],
    ];
    for (const [model, expected] of cases) assert.equal(detectFimTemplate(model), expected, model);
  });
});

describe('resolveFimFormat', () => {
  it('falls back to the Qwen format for unknown models, and says it guessed', () => {
    const resolved = resolveFimFormat('auto', 'my-finetune', '');
    assert.equal(resolved.id, 'qwen');
    assert.equal(resolved.guessed, true);
  });

  it('uses an explicit format whatever the model is called', () => {
    assert.deepEqual(resolveFimFormat('codellama', 'qwen2.5-coder:7b', ''), {
      id: 'codellama',
      format: FIM_FORMATS.codellama,
      guessed: false,
    });
  });

  it('uses the custom template, with no built-in stop sequences', () => {
    const resolved = resolveFimFormat('custom', 'anything', '<A>{prefix}<B>{suffix}<C>');
    assert.deepEqual(resolved.format, { template: '<A>{prefix}<B>{suffix}<C>', stop: [] });
  });
});

describe('renderFimPrompt', () => {
  it('fills in the code before and after the cursor', () => {
    assert.equal(
      renderFimPrompt(FIM_FORMATS.qwen.template, 'def area(r):\n    return ', '\n'),
      '<|fim_prefix|>def area(r):\n    return <|fim_suffix|>\n<|fim_middle|>',
    );
  });

  it('supports formats that put the suffix first', () => {
    assert.equal(renderFimPrompt(FIM_FORMATS.codestral.template, 'before', 'after'), '[SUFFIX]after[PREFIX]before');
  });

  it('keeps placeholder-like text and replacement patterns in the code verbatim', () => {
    const code = 'const s = "{suffix}" + "$&" + "$1";';
    assert.equal(renderFimPrompt('<P>{prefix}<S>{suffix}<M>', code, '{prefix}'), `<P>${code}<S>{prefix}<M>`);
  });
});
