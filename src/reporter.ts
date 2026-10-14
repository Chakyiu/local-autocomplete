import * as vscode from 'vscode';
import { describeServer, updateSetting, type Settings } from './config';
import type { BackendError, BackendErrorKind } from './core/backends';
import type { StatusBar } from './statusBar';

/**
 * Reflects request outcomes in the status bar, and shows a notification the first time each kind
 * of failure happens, so a stopped server doesn't produce a popup on every keystroke.
 */
export class RequestReporter {
  private readonly notified = new Set<BackendErrorKind>();
  private lastError: string | undefined;

  constructor(
    private readonly status: StatusBar,
    private readonly log: vscode.LogOutputChannel,
    private readonly extensionId: string,
  ) {}

  succeeded(): void {
    this.reset();
  }

  /**
   * `once` is for completions, where the same failure would otherwise pop up on every keystroke.
   * A button the user just pressed reports every time. `commit` rewords the context-overflow hint,
   * which otherwise talks about the characters before the cursor.
   */
  failed(error: BackendError, settings: Settings, source: 'completion' | 'commit' = 'completion'): void {
    if (error.message !== this.lastError) this.log.error(error.message);
    this.lastError = error.message;
    this.status.setError(error.message);
    if (source === 'completion' && this.notified.has(error.kind)) return;
    if (source === 'completion') this.notified.add(error.kind);
    void this.notify(error, settings, source);
  }

  /** Forgets earlier failures, after a success or when the server settings change. */
  reset(): void {
    this.notified.clear();
    this.lastError = undefined;
    this.status.setError(undefined);
  }

  private async notify(error: BackendError, settings: Settings, source: 'completion' | 'commit'): Promise<void> {
    const server = describeServer(settings);
    if (error.kind === 'model-not-found') {
      const pull = settings.provider === 'ollama' ? `ollama pull ${settings.model}` : undefined;
      const message = `Local Autocomplete: model "${settings.model}" was not found on ${server}.`;
      const choice = pull
        ? await vscode.window.showWarningMessage(
            `${message} Download it with "${pull}".`,
            'Copy Command',
            'Select Model',
          )
        : await vscode.window.showWarningMessage(message, 'Select Model');
      if (choice === 'Copy Command' && pull) await vscode.env.clipboard.writeText(pull);
      if (choice === 'Select Model') await vscode.commands.executeCommand('localAutocomplete.selectModel');
      return;
    }

    if (error.kind === 'context-overflow') {
      const commit = source === 'commit';
      const choice = await vscode.window.showWarningMessage(
        commit
          ? `Local Autocomplete: the diff does not fit the context of ${server}. ` +
              'Lower localAutocomplete.commitMessageMaxDiffChars, or raise localAutocomplete.maxContextTokens.'
          : `Local Autocomplete: the prompt does not fit the context of ${server}, which was sent up to ` +
              `${settings.maxPrefixChars} characters before the cursor.`,
        ...(commit ? [] : ['Halve the Context']),
        'Open Settings',
        'Show Log',
      );
      if (choice === 'Halve the Context') {
        await updateSetting('maxPrefixChars', Math.max(500, Math.round(settings.maxPrefixChars / 2)));
      }
      if (choice === 'Open Settings') await this.openSettings();
      if (choice === 'Show Log') this.log.show();
      return;
    }

    const message =
      error.kind === 'unreachable'
        ? `Local Autocomplete can't reach ${server}. ${settings.provider === 'ollama' ? 'Is Ollama running?' : 'Is the server running?'}`
        : `Local Autocomplete: ${error.message}`;
    const choice = await vscode.window.showWarningMessage(message, 'Open Settings', 'Show Log');
    if (choice === 'Open Settings') await this.openSettings();
    if (choice === 'Show Log') this.log.show();
  }

  private async openSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.extensionId}`);
  }
}
