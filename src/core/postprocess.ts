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
  let text = raw.replace(/\r\n?/g, '\n');
  // Servers normally stop at these themselves, but some render control tokens as text instead.
  for (const stop of options.stop) {
    const index = text.indexOf(stop);
    if (index !== -1) text = text.slice(0, index);
  }

  if (!options.multiline) {
    const newline = text.indexOf('\n');
    return (newline === -1 ? text : text.slice(0, newline)).trimEnd();
  }

  const lines = text.split('\n');
  const baseIndent = indentWidth(options.linePrefix);
  const nextExistingLine = options.suffix
    .split('\n')
    .slice(1)
    .find((line) => line.trim() !== '');

  let end = lines.length;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const leavesBlock = indentWidth(line) < baseIndent;
    const repeatsCodeBelow = nextExistingLine !== undefined && line.trimEnd() === nextExistingLine.trimEnd();
    if (leavesBlock || repeatsCodeBelow) {
      end = i;
      break;
    }
  }
  return lines.slice(0, end).join('\n').trimEnd();
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
