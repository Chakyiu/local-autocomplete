import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractContext, type LineSource } from '../../core/context';

function doc(text: string): LineSource {
  const lines = text.split('\n');
  return { lineCount: lines.length, lineText: (line) => lines[line] };
}

const at = (line: number, character: number) => ({ line, character });

describe('extractContext', () => {
  it('returns the whole document when it fits', () => {
    assert.deepEqual(extractContext(doc('function add(a, b) {\n  return \n}\n'), at(1, 9), at(1, 9), 1000, 1000), {
      prefix: 'function add(a, b) {\n  return ',
      suffix: '\n}\n',
    });
  });

  it('starts the prefix on the same line while the current line grows', () => {
    // 99 lines of 7 characters (8 with the newline), then the line being typed.
    const above = Array.from({ length: 99 }, (_, i) => `line ${String(i).padStart(2, '0')}`);
    const short = extractContext(doc([...above, 'x'].join('\n')), at(99, 1), at(99, 1), 400, 0).prefix;
    const long = extractContext(doc([...above, 'x'.repeat(60)].join('\n')), at(99, 60), at(99, 60), 400, 0).prefix;

    assert.ok(short.startsWith('line 64\n'), short.slice(0, 20));
    assert.ok(long.startsWith('line 64\n'), long.slice(0, 20));
    assert.ok(short.length <= 400 && long.length <= 400);
  });

  it('keeps the end of a current line that alone exceeds the budget', () => {
    assert.equal(extractContext(doc('a\n' + 'b'.repeat(50)), at(1, 50), at(1, 50), 10, 0).prefix, 'b'.repeat(10));
  });

  it('takes whole lines after the cursor within the suffix budget', () => {
    assert.equal(extractContext(doc('x\nfirst\nsecond\nthird'), at(0, 1), at(0, 1), 100, 14).suffix, '\nfirst\nsecond');
  });

  it('splits around the range an IntelliSense item is about to replace', () => {
    assert.deepEqual(extractContext(doc('console.lo(x)'), at(0, 8), at(0, 10), 100, 100), {
      prefix: 'console.',
      suffix: '(x)',
    });
  });
});
