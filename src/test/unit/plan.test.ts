import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LineSource } from '../../core/context';
import { planCompletion } from '../../core/plan';

function document(...lines: string[]): LineSource {
  return { lineCount: lines.length, lineText: (line: number) => lines[line] ?? '' };
}

const at = (line: number, character: number) => ({ line, character });

const always = { multiline: 'always' as const, maxPrefixChars: 4000, maxSuffixChars: 1000 };

describe('planCompletion', () => {
  it('reports the text around the cursor', () => {
    const plan = planCompletion({
      document: document('function add(a, b) {', '  ', '}'),
      position: at(1, 2),
      ...always,
    });

    assert.equal(plan.linePrefix, '  ');
    assert.equal(plan.lineSuffix, '');
    assert.equal(plan.suffix, '\n}');
    assert.equal(plan.accepted, '');
    assert.equal(plan.suppressed, false);
    assert.deepEqual(plan.start, at(1, 2));
  });

  it('completes as though the selected IntelliSense item had already been accepted', () => {
    // VS Code reports the highlighted suggestion as if it were text; without splicing it in, the
    // model is asked to continue from the middle of a word it cannot see.
    const plan = planCompletion({
      document: document('const greeting = '),
      position: at(0, 17),
      selected: { text: '"hello"', start: at(0, 17), end: at(0, 17) },
      ...always,
    });

    assert.equal(plan.accepted, '"hello"');
    assert.equal(plan.prefix, 'const greeting = "hello"');
    assert.equal(plan.linePrefix, 'const greeting = "hello"');
    assert.equal(plan.lineSuffix, '');
  });

  it('refuses to complete in the middle of a word but not at its end', () => {
    const midWord = planCompletion({ document: document('const value = foo'), position: at(0, 16), ...always });
    assert.equal(midWord.suppressed, true);

    const endOfWord = planCompletion({ document: document('const value = foo'), position: at(0, 17), ...always });
    assert.equal(endOfWord.suppressed, false);

    // A bracket after the cursor is not part of a word, so completing inside empty parentheses is fine.
    const insideParens = planCompletion({ document: document('add()'), position: at(0, 4), ...always });
    assert.equal(insideParens.suppressed, false);
  });

  it('only allows several lines where a block can follow', () => {
    const inside = planCompletion({
      document: document('function add(a, b) {', '  ', '}'),
      position: at(1, 2),
      multiline: 'auto',
      maxPrefixChars: 4000,
      maxSuffixChars: 1000,
    });
    assert.equal(inside.multiline, true);

    const midExpression = planCompletion({
      document: document('const total = add(a, b) + '),
      position: at(0, 26),
      multiline: 'auto',
      maxPrefixChars: 4000,
      maxSuffixChars: 1000,
    });
    assert.equal(midExpression.multiline, false);

    const forced = planCompletion({
      document: document('const total = add(a, b) + '),
      position: at(0, 26),
      multiline: 'never',
      maxPrefixChars: 4000,
      maxSuffixChars: 1000,
    });
    assert.equal(forced.multiline, false);
  });

  it('starts the completion where the selected item begins, not at the cursor', () => {
    const plan = planCompletion({
      document: document('const x = 0'),
      position: at(0, 11),
      selected: { text: '1', start: at(0, 10), end: at(0, 11) },
      ...always,
    });

    assert.deepEqual(plan.start, at(0, 10));
    assert.deepEqual(plan.end, at(0, 11));
    assert.equal(plan.prefix, 'const x = 1');
  });
});
