import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildCommitPrompt,
  chooseRepository,
  cleanCommitMessage,
  limitDiff,
  subjectsFromLog,
} from '../../core/commitMessage';

describe('buildCommitPrompt', () => {
  const diff = 'diff --git a/a.ts b/a.ts\n+export const ready = true;';

  it('describes only the staged diff, and quotes a draft and recent subjects', () => {
    const prompt = buildCommitPrompt({
      diff,
      hint: 'wire up the flag',
      recentSubjects: ['feat: add the cart'],
      truncated: false,
    });

    assert.match(prompt.system, /commit message only/);
    assert.match(prompt.user, /staged diff/);
    assert.match(prompt.user, /unstaged or untracked/);
    assert.match(prompt.user, /feat: add the cart/);
    assert.match(prompt.user, /wire up the flag/);
    assert.match(prompt.user, /export const ready/);
  });

  it('says when the diff was cut', () => {
    const prompt = buildCommitPrompt({ diff, hint: '', recentSubjects: [], truncated: true });
    assert.match(prompt.user, /cut to fit/);
    assert.doesNotMatch(prompt.user, /Recent commit subjects/);
  });
});

describe('cleanCommitMessage', () => {
  it('keeps a message the model wrote cleanly', () => {
    const message = 'feat: add a commit button\n\nThe Source Control view drafts the message locally.';
    assert.equal(cleanCommitMessage(message), message);
    assert.equal(cleanCommitMessage(`${message}\n`), message);
  });

  it('drops a preamble, a fence, and wrapping quotes', () => {
    assert.equal(cleanCommitMessage('```\nfeat: add a commit button\n```'), 'feat: add a commit button');
    assert.equal(cleanCommitMessage('Here is a commit message:\n\nfix: stop the spinner'), 'fix: stop the spinner');
    assert.equal(cleanCommitMessage('"chore: bump the timeout"'), 'chore: bump the timeout');
  });

  it('does not eat a subject that merely starts like a preamble', () => {
    assert.equal(cleanCommitMessage('Surely fix the race'), 'Surely fix the race');
    assert.equal(cleanCommitMessage('feat: keep the "quotes"'), 'feat: keep the "quotes"');
  });
});

describe('subjectsFromLog', () => {
  it('takes the first line and skips merge commits', () => {
    assert.deepEqual(subjectsFromLog(['feat: add x\n\nbody', "Merge branch 'main'", '', 'fix: y'], 8), [
      'feat: add x',
      'fix: y',
    ]);
  });
});

describe('limitDiff', () => {
  it('returns a short diff unchanged', () => {
    assert.deepEqual(limitDiff('diff --git a/a b/a\n+x', 100), { text: 'diff --git a/a b/a\n+x', truncated: false });
  });

  it('cuts at a line boundary and says the rest was dropped', () => {
    const limited = limitDiff('first line\nsecond line\nthird line', 24);
    assert.equal(limited.truncated, true);
    assert.match(limited.text, /\[diff truncated\]$/);
    assert.doesNotMatch(limited.text, /third/);
  });
});

describe('chooseRepository', () => {
  const outer = path.resolve('repos', 'outer');
  const inner = path.resolve('repos', 'outer', 'inner');
  const other = path.resolve('repos', 'other');
  const repos = [
    { root: outer, name: 'outer' },
    { root: inner, name: 'inner' },
    { root: other, name: 'other' },
  ];

  it('picks the innermost repository that contains the file', () => {
    const choice = chooseRepository(repos, [path.join(inner, 'src', 'a.ts')]);
    assert.deepEqual(choice, { kind: 'one', repo: repos[1] });
  });

  it('tries hints in order, then the only repository, then asks', () => {
    assert.equal(chooseRepository(repos, []).kind, 'pick');
    assert.deepEqual(chooseRepository([{ root: outer, name: 'outer' }], []), {
      kind: 'one',
      repo: { root: outer, name: 'outer' },
    });
    assert.equal(chooseRepository([], ['/anywhere']).kind, 'none');
  });

  it('uses a later hint when the first one is outside every repository', () => {
    const choice = chooseRepository(repos, [path.resolve('elsewhere', 'note.txt'), path.join(other, 'b.ts')]);
    assert.deepEqual(choice, { kind: 'one', repo: repos[2] });
  });
});
