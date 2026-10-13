import * as vscode from 'vscode';
import { readSettings } from './config';
import { BackendError, createBackend } from './core/backends';
import { CompletionCache } from './core/cache';
import { extractContext } from './core/context';
import { renderFimPrompt, resolveFimFormat } from './core/fim';
import { allowMultiline, cleanCompletion, replaceableSuffixLength } from './core/postprocess';
import type { EnablementStore } from './enablementStore';
import type { RequestReporter } from './reporter';
import type { StatusBar } from './statusBar';

export class LocalCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new CompletionCache();
  private warnedAboutFormatFor: string | undefined;

  constructor(
    private readonly enablement: EnablementStore,
    private readonly status: StatusBar,
    private readonly reporter: RequestReporter,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  clearCache(): void {
    this.cache.clear();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!this.enablement.get(document).enabled) return undefined;

    const settings = readSettings();
    // While the suggestion list is open, complete as if its selected item had been accepted.
    const selected = context.selectedCompletionInfo;
    const accepted = selected?.text ?? '';
    const start = selected?.range.start ?? position;
    const end = selected?.range.end ?? position;

    const lineSuffix = document.lineAt(end.line).text.slice(end.character);
    // The cursor is inside a word: the user is editing it, not writing new code.
    if (/^[\p{L}\p{N}_$]/u.test(lineSuffix)) return undefined;

    const window = extractContext(
      { lineCount: document.lineCount, lineText: (line) => document.lineAt(line).text },
      start,
      end,
      settings.maxPrefixChars,
      settings.maxSuffixChars,
    );
    const prefix = window.prefix + accepted;
    const linePrefix = document.lineAt(start.line).text.slice(0, start.character) + accepted;
    const multiline = allowMultiline(settings.multiline, linePrefix, lineSuffix);

    const toItems = (completion: string): vscode.InlineCompletionItem[] | undefined => {
      const replaced = replaceableSuffixLength(completion, lineSuffix);
      if (replaced === completion.length) return undefined;
      const range = new vscode.Range(start, end.translate(0, replaced));
      return [new vscode.InlineCompletionItem(accepted + completion, range)];
    };

    const cached = this.cache.get(prefix, window.suffix);
    if (cached !== undefined) return toItems(cached);

    const automatic = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
    if (automatic && !(await delay(settings.debounceMs, token))) return undefined;

    const fim = resolveFimFormat(settings.fimTemplate, settings.model, settings.customFimTemplate);
    if (fim.guessed && this.warnedAboutFormatFor !== settings.model) {
      this.warnedAboutFormatFor = settings.model;
      this.log.warn(
        `No known fill-in-the-middle format for "${settings.model}", using Qwen's. ` +
          'If completions look wrong, set localAutocomplete.fimTemplate.',
      );
    }
    const stop = [...fim.format.stop, ...settings.stopSequences, ...(multiline ? [] : ['\n'])];
    const prompt = renderFimPrompt(fim.format.template, prefix, window.suffix);

    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    const startedAt = Date.now();
    this.status.requestStarted();
    try {
      const result = await createBackend(settings).complete({
        prompt,
        stop,
        maxTokens: settings.maxTokens,
        temperature: settings.temperature,
        signal: abort.signal,
      });
      this.reporter.succeeded();
      const completion = cleanCompletion(result.text, { multiline, linePrefix, suffix: window.suffix, stop });
      this.log.debug(
        `${settings.model} (${fim.id} format): ${Date.now() - startedAt} ms, ${result.tokens ?? '?'} tokens, ` +
          (completion ? `${completion.length} characters kept` : 'nothing usable'),
      );
      this.log.trace(`Prompt:\n${prompt}\nOutput:\n${result.text}`);
      if (completion === '') return undefined;
      this.cache.set(prefix, window.suffix, completion);
      return token.isCancellationRequested ? undefined : toItems(completion);
    } catch (error) {
      if (abort.signal.aborted) return undefined;
      if (error instanceof BackendError) this.reporter.failed(error, settings);
      else this.log.error(error instanceof Error ? error : String(error));
      return undefined;
    } finally {
      cancellation.dispose();
      this.status.requestFinished();
    }
  }
}

/** Resolves to false if the request is cancelled first, which happens whenever the user keeps typing. */
function delay(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  if (token.isCancellationRequested) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose();
      resolve(true);
    }, ms);
    const listener = token.onCancellationRequested(() => {
      clearTimeout(timer);
      listener.dispose();
      resolve(false);
    });
  });
}
