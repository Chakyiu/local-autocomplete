export type MultilineMode = 'auto' | 'always' | 'never';

/**
 * In `auto` mode a completion may span lines only where a block is likely to follow: on an empty
 * line, or at the end of a line that ends with an opening bracket or a colon.
 */
export function allowMultiline(mode: MultilineMode, linePrefix: string, lineSuffix: string): boolean {
  if (mode !== 'auto') return mode === 'always';
  if (lineSuffix.trim() !== '') return false;
  const before = linePrefix.trimEnd();
  return before.trim() === '' || /[{([:]$/.test(before);
}

export interface CleanupOptions {
  multiline: boolean;
  /** Text on the cursor's line before the cursor. */
  linePrefix: string;
  /** Document text after the cursor. */
  suffix: string;
  stop: readonly string[];
}

/** Turns raw model output into the text to show, or '' when there is nothing worth showing. */
export function cleanCompletion(raw: string, options: CleanupOptions): string {
  const text = cutAtStopSequences(raw.replace(/\r\n?/g, '\n'), options.stop);

  if (!options.multiline) {
    const newline = text.indexOf('\n');
    return (newline === -1 ? text : text.slice(0, newline)).trimEnd();
  }

  const lines = text.split('\n');
  return lines.slice(0, blockEnd(lines, options)).join('\n').trimEnd();
}

/**
 * True once nothing the model generates next can change what `cleanCompletion` would return, which
 * is how the provider knows it may cancel the request instead of waiting for the whole completion.
 * A half-finished last line never settles a multi-line completion: it may still turn into the line
 * that closes the block, and that line would then be dropped.
 */
export function isCompletionFinal(raw: string, options: CleanupOptions): boolean {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const text = cutAtStopSequences(normalized, options.stop);
  if (text.length !== normalized.length) return true;
  if (!options.multiline) return text.includes('\n');

  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
  return blockEnd(lines, options) < lines.length;
}

/**
 * A stateful finality test for a streamed completion: feed it each chunk, and it returns true once
 * the completion can no longer change. Re-scanning the whole buffer after every character would
 * cost more than the saved wait, so it only looks again when a line finished or enough text arrived
 * to matter — a stop sequence is then caught a few characters late at worst.
 */
export function createFinalityCheck(options: CleanupOptions): (chunk: string) => boolean {
  // Stop sequences are short, so checking every few characters notices one almost as soon as it lands.
  const SCAN_EVERY_CHARS = 8;
  let text = '';
  let sinceScan = 0;

  return (chunk: string) => {
    text += chunk;
    sinceScan += chunk.length;
    if (sinceScan < SCAN_EVERY_CHARS && !chunk.includes('\n')) return false;
    sinceScan = 0;
    return isCompletionFinal(text, options);
  };
}

/** Index of the first line after the cursor's own line that leaves the block, or `lines.length`. */
function blockEnd(lines: readonly string[], options: CleanupOptions): number {
  const baseIndent = indentWidth(options.linePrefix);
  const nextExistingLine = options.suffix
    .split('\n')
    .slice(1)
    .find((line) => line.trim() !== '');

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const leavesBlock = indentWidth(line) < baseIndent;
    const repeatsCodeBelow = nextExistingLine !== undefined && line.trimEnd() === nextExistingLine.trimEnd();
    if (leavesBlock || repeatsCodeBelow) return i;
  }
  return lines.length;
}

function cutAtStopSequences(text: string, stop: readonly string[]): string {
  let result = text;
  // Servers normally stop at these themselves, but some render control tokens as text instead.
  for (const sequence of stop) {
    const index = result.indexOf(sequence);
    if (index !== -1) result = result.slice(0, index);
  }
  return result;
}

/**
 * Number of characters after the cursor that a single-line completion should replace. When the
 * rest of the line (typically auto-closed brackets or quotes) appears in order inside the
 * completion, replacing it avoids duplicating it, and the editor still renders the result as
 * plain ghost text because the edit only inserts characters.
 */
export function replaceableSuffixLength(completion: string, lineSuffix: string): number {
  const rest = lineSuffix.trimEnd();
  if (rest === '' || completion.includes('\n')) return 0;
  let matched = 0;
  for (let i = 0; i < completion.length && matched < rest.length; i++) {
    if (completion[i] === rest[matched]) matched++;
  }
  return matched === rest.length ? rest.length : 0;
}

function indentWidth(line: string): number {
  return line.length - line.trimStart().length;
}
