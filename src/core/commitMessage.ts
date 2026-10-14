import * as path from 'node:path';

/** Tokens reserved for the message itself. A subject and a short body fit well inside this. */
export const COMMIT_MESSAGE_MAX_TOKENS = 256;

export interface RepoRoot {
  /** Absolute filesystem path of the repository. */
  root: string;
}

export interface CommitPromptInput {
  /** Staged diff (`git diff --cached`), already trimmed to the character budget. */
  diff: string;
  /** Text already in the commit box. Empty when the user hasn't drafted anything. */
  hint: string;
  /** Subject lines of recent commits, newest first, so the message can follow the repo's style. */
  recentSubjects: readonly string[];
  truncated: boolean;
}

export interface CommitPrompt {
  system: string;
  user: string;
}

const SYSTEM = [
  'You write git commit messages and nothing else.',
  'Reply with the commit message only: no preamble, no explanation, and no markdown fence.',
  'Use one subject line in the imperative mood, at most 72 characters, with no trailing period.',
  'Add a blank line and a short body only when the subject cannot carry the change on its own.',
  'When recent commit subjects are listed, follow their style. Otherwise use Conventional Commits: feat, fix, refactor, perf, docs, test, build, ci, chore.',
  'Describe only changes that are in the diff.',
].join('\n');

/** A whole line that is the model talking about the message rather than the message. */
const PREAMBLE_LINE =
  /^(?:here(?:'s| is)(?: a| the)?(?: suggested| generated)? commit message|commit message|sure)[:.\s]*$/i;

/** The same preamble used as a label in front of the message on one line. */
const PREAMBLE_PREFIX =
  /^(?:here(?:'s| is)(?: a| the)?(?: suggested| generated)? commit message|commit message)\s*:\s*/i;

export function buildCommitPrompt(input: CommitPromptInput): CommitPrompt {
  const lines = [
    'Write a commit message for this staged diff. It is exactly what git commit would record. Do not mention unstaged or untracked files.',
  ];
  if (input.truncated) lines.push('The diff was cut to fit the context window; do not guess at what was removed.');
  if (input.recentSubjects.length > 0) {
    lines.push('', 'Recent commit subjects, newest first:', ...input.recentSubjects.map((subject) => `- ${subject}`));
  }
  const hint = input.hint.trim();
  if (hint !== '') lines.push('', 'The user already drafted this. Keep its intent:', hint);
  lines.push('', 'Diff:', input.diff);
  return { system: SYSTEM, user: lines.join('\n') };
}

/** Turns model output into the text to put in the commit box. Empty when nothing usable came back. */
export function cleanCommitMessage(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n').trim();
  const fenced = /^```[^\n`]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  text = text.replace(PREAMBLE_PREFIX, '');

  const lines = text.split('\n');
  while (lines.length > 0 && (lines[0].trim() === '' || PREAMBLE_LINE.test(lines[0].trim()))) lines.shift();
  text = lines.join('\n').trim();

  const wrapped =
    text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('`') && text.endsWith('`')));
  if (wrapped) text = text.slice(1, -1).trim();
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** First line of each message, skipping merge commits, which say nothing about the repo's style. */
export function subjectsFromLog(messages: readonly string[], limit = 8): string[] {
  const subjects: string[] = [];
  for (const message of messages) {
    const subject = message.split('\n')[0]?.trim() ?? '';
    if (subject === '' || subject.startsWith('Merge ')) continue;
    subjects.push(subject);
    if (subjects.length === limit) break;
  }
  return subjects;
}

/** Cuts a diff at a line boundary and says so, so the model does not treat a half line as code. */
export function limitDiff(diff: string, maxChars: number): { text: string; truncated: boolean } {
  const text = diff.replace(/\r\n?/g, '\n').trim();
  if (text.length <= maxChars) return { text, truncated: false };
  const note = '\n\n[diff truncated]';
  const budget = Math.max(0, maxChars - note.length);
  let cut = text.lastIndexOf('\n', budget);
  if (cut < budget / 2) cut = budget;
  return { text: `${text.slice(0, cut).trimEnd()}${note}`, truncated: true };
}

/**
 * Which repository a commit message is about. `hints` are tried in order (the command argument,
 * then the active file); a path inside several nested repositories belongs to the innermost one.
 * With no hint and several repositories, the caller has to ask.
 */
export function chooseRepository<T extends RepoRoot>(
  repos: readonly T[],
  hints: readonly string[],
): { kind: 'one'; repo: T } | { kind: 'pick' } | { kind: 'none' } {
  if (repos.length === 0) return { kind: 'none' };
  for (const hint of hints) {
    const repo = innermost(repos, hint);
    if (repo) return { kind: 'one', repo };
  }
  return repos.length === 1 ? { kind: 'one', repo: repos[0] } : { kind: 'pick' };
}

function innermost<T extends RepoRoot>(repos: readonly T[], hint: string): T | undefined {
  let best: T | undefined;
  for (const repo of repos) {
    if (!contains(repo.root, hint)) continue;
    if (!best || repo.root.length > best.root.length) best = repo;
  }
  return best;
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(stripTrailingSep(root), target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function stripTrailingSep(value: string): string {
  return value.length > 1 ? value.replace(/[\\/]+$/, '') : value;
}
