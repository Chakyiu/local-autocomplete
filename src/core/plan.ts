import { extractContext, type LineSource, type TextPosition } from './context';
import { allowMultiline, type MultilineMode } from './postprocess';

export interface CompletionPlan {
  /** Where the completion begins; ahead of the cursor while the suggestion list is showing an item. */
  start: TextPosition;
  end: TextPosition;
  /** Text of the selected IntelliSense item, '' when the suggestion list is closed. */
  accepted: string;
  /** Document text before the completion, with `accepted` already spliced in. */
  prefix: string;
  /** The part of the line before the completion; its indentation decides where a block ends. */
  linePrefix: string;
  lineSuffix: string;
  suffix: string;
  multiline: boolean;
  /** True when the completion should not happen at all. */
  suppressed: boolean;
}

/**
 * Works out what to ask the model for, from the cursor, the document, and whatever the IntelliSense
 * list has selected. While that list is open VS Code reports the selected item as if it were text:
 * completing as though it had been accepted keeps the two from fighting over the same characters.
 */
export function planCompletion(args: {
  document: LineSource;
  position: TextPosition;
  selected?: { text: string; start: TextPosition; end: TextPosition };
  multiline: MultilineMode;
  maxPrefixChars: number;
  maxSuffixChars: number;
}): CompletionPlan {
  const accepted = args.selected?.text ?? '';
  const start = args.selected?.start ?? args.position;
  const end = args.selected?.end ?? args.position;

  const lineSuffix = args.document.lineText(end.line).slice(end.character);
  const window = extractContext(args.document, start, end, args.maxPrefixChars, args.maxSuffixChars);
  const linePrefix = args.document.lineText(start.line).slice(0, start.character) + accepted;

  return {
    start,
    end,
    accepted,
    prefix: window.prefix + accepted,
    linePrefix,
    lineSuffix,
    suffix: window.suffix,
    multiline: allowMultiline(args.multiline, linePrefix, lineSuffix),
    // The cursor is inside a word: the user is editing it, not writing new code.
    suppressed: /^[\p{L}\p{N}_$]/u.test(lineSuffix),
  };
}
