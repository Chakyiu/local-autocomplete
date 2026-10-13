interface Entry {
  prefix: string;
  suffix: string;
  completion: string;
}

/**
 * Recent completions keyed by the text around the cursor. Typing the start of a suggestion, or
 * deleting back to where it was made, is then answered without asking the model again.
 */
export class CompletionCache {
  private entries: Entry[] = [];

  constructor(private readonly capacity = 64) {}

  get(prefix: string, suffix: string): string | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry.suffix !== suffix || !prefix.startsWith(entry.prefix)) continue;
      const typed = prefix.slice(entry.prefix.length);
      if (entry.completion.length > typed.length && entry.completion.startsWith(typed)) {
        return entry.completion.slice(typed.length);
      }
    }
    return undefined;
  }

  set(prefix: string, suffix: string, completion: string): void {
    this.entries = this.entries.filter((entry) => entry.prefix !== prefix || entry.suffix !== suffix);
    this.entries.push({ prefix, suffix, completion });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  clear(): void {
    this.entries = [];
  }
}
