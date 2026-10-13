export interface LineSource {
  readonly lineCount: number;
  lineText(line: number): string;
}

export interface TextPosition {
  readonly line: number;
  readonly character: number;
}

export interface ContextWindow {
  /** Document text before the cursor. */
  prefix: string;
  /** Document text after the cursor. */
  suffix: string;
}

/**
 * When the prefix has to be cut, its first line is rounded to a multiple of this. The start of the
 * prompt then stays put while typing, so the server can reuse its prompt cache between requests.
 */
const PREFIX_LINE_STEP = 16;

/**
 * Collects whole lines around the cursor within the character budgets. `start` and `end` are
 * normally the cursor; they differ when an IntelliSense suggestion is about to replace a range.
 */
export function extractContext(
  doc: LineSource,
  start: TextPosition,
  end: TextPosition,
  maxPrefixChars: number,
  maxSuffixChars: number,
): ContextWindow {
  return {
    prefix: extractPrefix(doc, start, maxPrefixChars),
    suffix: extractSuffix(doc, end, maxSuffixChars),
  };
}

function extractPrefix(doc: LineSource, at: TextPosition, maxChars: number): string {
  const head = doc.lineText(at.line).slice(0, at.character);
  if (head.length >= maxChars) return head.slice(head.length - maxChars);

  let budget = maxChars - head.length;
  let first = at.line;
  while (first > 0) {
    const cost = doc.lineText(first - 1).length + 1;
    if (cost > budget) break;
    budget -= cost;
    first--;
  }
  if (first > 0) first = Math.min(at.line, Math.ceil(first / PREFIX_LINE_STEP) * PREFIX_LINE_STEP);

  const lines: string[] = [];
  for (let line = first; line < at.line; line++) lines.push(doc.lineText(line));
  lines.push(head);
  return lines.join('\n');
}

function extractSuffix(doc: LineSource, at: TextPosition, maxChars: number): string {
  const tail = doc.lineText(at.line).slice(at.character);
  if (tail.length >= maxChars) return tail.slice(0, maxChars);

  let budget = maxChars - tail.length;
  const lines = [tail];
  for (let line = at.line + 1; line < doc.lineCount; line++) {
    const text = doc.lineText(line);
    if (text.length + 1 > budget) break;
    budget -= text.length + 1;
    lines.push(text);
  }
  return lines.join('\n');
}
