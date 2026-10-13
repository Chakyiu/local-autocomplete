import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowMultiline, cleanCompletion, replaceableSuffixLength } from '../../core/postprocess';

describe('allowMultiline', () => {
  it('allows several lines on an empty line and after a block opener', () => {
    assert.equal(allowMultiline('auto', '    ', ''), true);
    assert.equal(allowMultiline('auto', 'function f() {', ''), true);
    assert.equal(allowMultiline('auto', 'def f(x):', ''), true);
    assert.equal(allowMultiline('auto', 'items = [  ', '  '), true);
  });

  it('keeps to one line mid-statement or with code after the cursor', () => {
    assert.equal(allowMultiline('auto', 'const x = ', ''), false);
    assert.equal(allowMultiline('auto', 'foo(', ');'), false);
    assert.equal(allowMultiline('auto', '', ')'), false);
  });

  it('follows the explicit modes', () => {
    assert.equal(allowMultiline('always', 'const x = ', ');'), true);
    assert.equal(allowMultiline('never', '', ''), false);
  });
});

describe('cleanCompletion', () => {
  const singleLine = { multiline: false, linePrefix: 'const x = ', suffix: '', stop: [] };

  it('keeps only the first line in single-line mode', () => {
    assert.equal(cleanCompletion('42;\nconst y = 1;', singleLine), '42;');
  });

  it('cuts at stop sequences that the server let through', () => {
    assert.equal(cleanCompletion('42;<|endoftext|>junk', { ...singleLine, stop: ['<|endoftext|>'] }), '42;');
  });

  it('drops trailing whitespace, and gives nothing for blank output', () => {
    assert.equal(cleanCompletion('42;   ', singleLine), '42;');
    assert.equal(cleanCompletion('\nnext line', singleLine), '');
    assert.equal(cleanCompletion('  \n\n', { ...singleLine, multiline: true }), '');
  });

  it('normalizes Windows line endings', () => {
    assert.equal(
      cleanCompletion('a();\r\nb();\r\n', { multiline: true, linePrefix: '', suffix: '', stop: [] }),
      'a();\nb();',
    );
  });

  it('stops a multi-line completion when it leaves the current block', () => {
    const completion = 'const sum = a + b;\n  return sum;\n}\n\nfunction next() {';
    assert.equal(
      cleanCompletion(completion, { multiline: true, linePrefix: '  ', suffix: '\n}', stop: [] }),
      'const sum = a + b;\n  return sum;',
    );
  });

  it('stops before regenerating the code that follows the cursor', () => {
    assert.equal(
      cleanCompletion('const b = 2;\nconst c = 3;\nconst d = 4;', {
        multiline: true,
        linePrefix: '',
        suffix: '\nconst c = 3;\n',
        stop: [],
      }),
      'const b = 2;',
    );
  });

  it('drops a closing brace that already follows the cursor, and keeps one that does not', () => {
    const options = { multiline: true, linePrefix: 'function f() {', stop: [] };
    assert.equal(cleanCompletion('\n  return 1;\n}', { ...options, suffix: '\n}' }), '\n  return 1;');
    assert.equal(cleanCompletion('\n  return 1;\n}', { ...options, suffix: '' }), '\n  return 1;\n}');
  });

  it('keeps an inner closing brace that matches the next line only when ignoring indentation', () => {
    const completion = 'if (x) {\n    y();\n  }\n  return z;';
    assert.equal(cleanCompletion(completion, { multiline: true, linePrefix: '  ', suffix: '\n}', stop: [] }), completion);
  });
});

describe('replaceableSuffixLength', () => {
  it('covers auto-closed characters that the completion already contains', () => {
    assert.equal(replaceableSuffixLength('a, b)', ')'), 1);
    assert.equal(replaceableSuffixLength('user.name}"', '}"'), 2);
    assert.equal(replaceableSuffixLength('x) + 1', ')   '), 1);
  });

  it('covers nothing when the completion lacks them, spans lines, or the line ends at the cursor', () => {
    assert.equal(replaceableSuffixLength('a, b', ')'), 0);
    assert.equal(replaceableSuffixLength('])', ')]'), 0);
    assert.equal(replaceableSuffixLength('a)\nb', ')'), 0);
    assert.equal(replaceableSuffixLength('abc', '  '), 0);
  });
});
