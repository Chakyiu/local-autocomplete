import * as vscode from 'vscode';
import type { ApiKeyStore } from './apiKey';
import { readSettings } from './config';
import {
  BackendError,
  createBackend,
  numCtxToRequest,
  requiredContextTokens,
  type CompletionRequest,
} from './core/backends';
import { CompletionCache } from './core/cache';
import { renderFimPrompt, resolveFimFormat } from './core/fim';
import { planCompletion } from './core/plan';
import { cleanCompletion, createFinalityCheck, replaceableSuffixLength } from './core/postprocess';
import { backendOptions, type Settings } from './core/settings';
import type { EnablementStore } from './enablementStore';
import type { RequestReporter } from './reporter';
import type { StatusBar } from './statusBar';

export class LocalCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new CompletionCache();
  private warnedAboutFormatFor: string | undefined;
  private warnedAboutContextFor: string | undefined;

  constructor(
    private readonly enablement: EnablementStore,
    private readonly status: StatusBar,
    private readonly reporter: RequestReporter,
    private readonly apiKeys: ApiKeyStore,
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

    const settings = readSettings(document.uri);
    const selected = context.selectedCompletionInfo;
    const plan = planCompletion({
      document: { lineCount: document.lineCount, lineText: (line) => document.lineAt(line).text },
      position,
      selected: selected && { text: selected.text, start: selected.range.start, end: selected.range.end },
      multiline: settings.multiline,
      maxPrefixChars: settings.maxPrefixChars,
      maxSuffixChars: settings.maxSuffixChars,
    });
    if (plan.suppressed) return undefined;

    const toItems = (completion: string): vscode.InlineCompletionItem[] | undefined => {
      const replaced = replaceableSuffixLength(completion, plan.lineSuffix);
      if (replaced === completion.length) return undefined;
      const range = new vscode.Range(
        plan.start.line,
        plan.start.character,
        plan.end.line,
        plan.end.character + replaced,
      );
      return [new vscode.InlineCompletionItem(plan.accepted + completion, range)];
    };

    const cached = this.cache.get(plan.prefix, plan.suffix);
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
    const stop = [...fim.format.stop, ...settings.stopSequences, ...(plan.multiline ? [] : ['\n'])];
    const prompt = renderFimPrompt(fim.format.template, plan.prefix, plan.suffix);
    const cleanup = {
      multiline: plan.multiline,
      linePrefix: plan.linePrefix,
      suffix: plan.suffix,
      stop,
    };

    const abort = new AbortController();
    const cancellation = token.onCancellationRequested(() => abort.abort());
    const startedAt = Date.now();
    this.status.requestStarted();
    try {
      const request: CompletionRequest = {
        prompt,
        stop,
        maxTokens: settings.maxTokens,
        temperature: settings.temperature,
        contextTokens: this.askedContextTokens(prompt, settings),
        signal: abort.signal,
      };
      const backend = createBackend(backendOptions(settings, await this.apiKeys.get()));
      // Streaming does not make the ghost text appear sooner word by word — VS Code shows an
      // InlineCompletionItem all at once — but it lets us stop as soon as the completion is settled,
      // which is usually well before the model runs out of tokens.
      const result = settings.stream
        ? await backend.streamComplete(request, createFinalityCheck(cleanup))
        : await backend.complete(request);

      if (token.isCancellationRequested || abort.signal.aborted) return undefined;
      this.reporter.succeeded();
      const completion = cleanCompletion(result.text, cleanup);
      this.log.debug(
        `${settings.model} (${fim.id} format${settings.stream ? ', streamed' : ''}): ${Date.now() - startedAt} ms, ` +
          `${result.tokens ?? '?'} tokens, ` +
          (completion ? `${completion.length} characters kept` : 'nothing usable'),
      );
      this.log.trace(`Prompt:\n${prompt}\nOutput:\n${result.text}`);
      if (completion === '') return undefined;
      this.cache.set(plan.prefix, plan.suffix, completion);
      return token.isCancellationRequested ? undefined : toItems(completion);
    } catch (error) {
      if (abort.signal.aborted || token.isCancellationRequested) return undefined;
      if (error instanceof BackendError) this.reporter.failed(error, settings);
      else this.log.error(error instanceof Error ? error : String(error));
      return undefined;
    } finally {
      cancellation.dispose();
      this.status.requestFinished();
    }
  }

  /**
   * How much context to ask the server for, or undefined to let it decide. Ollama cuts the front off
   * a prompt that does not fit — taking the `fim_prefix` marker with it — and only mentions this in
   * its own log, so the request has to state the room it needs.
   */
  private askedContextTokens(prompt: string, settings: Settings): number | undefined {
    const needed = requiredContextTokens(prompt, settings.maxTokens);
    if (settings.maxContextTokens > 0 && needed > settings.maxContextTokens) {
      const key = `${settings.model}@${settings.maxContextTokens}`;
      if (this.warnedAboutContextFor !== key) {
        this.warnedAboutContextFor = key;
        this.log.warn(
          `The prompt needs about ${needed} tokens, but localAutocomplete.maxContextTokens is ` +
            `${settings.maxContextTokens}. The server will drop the oldest part of the prompt, which usually ` +
            'means unusable completions: lower localAutocomplete.maxPrefixChars, or raise maxContextTokens ' +
            'if your model can take it.',
        );
      }
    }
    return numCtxToRequest(needed, settings.maxContextTokens) || undefined;
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
