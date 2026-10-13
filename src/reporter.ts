import * as vscode from 'vscode';
import { describeServer, type Settings } from './config';
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

  failed(error: BackendError, settings: Settings): void {
    if (error.message !== this.lastError) this.log.error(error.message);
    this.lastError = error.message;
    this.status.setError(error.message);
    if (this.notified.has(error.kind)) return;
    this.notified.add(error.kind);
    void this.notify(error, settings);
  }

  /** Forgets earlier failures, after a success or when the server settings change. */
  reset(): void {
    this.notified.clear();
    this.lastError = undefined;
    this.status.setError(undefined);
  }

  private async notify(error: BackendError, settings: Settings): Promise<void> {
    const server = describeServer(settings);
    if (error.kind === 'model-not-found') {
      const pull = settings.provider === 'ollama' ? `ollama pull ${settings.model}` : undefined;
      const message = `Local Autocomplete: model "${settings.model}" was not found on ${server}.`;
      const choice = pull
        ? await vscode.window.showWarningMessage(`${message} Download it with "${pull}".`, 'Copy Command', 'Select Model')
        : await vscode.window.showWarningMessage(message, 'Select Model');
      if (choice === 'Copy Command' && pull) await vscode.env.clipboard.writeText(pull);
      if (choice === 'Select Model') await vscode.commands.executeCommand('localAutocomplete.selectModel');
      return;
    }

    const message =
      error.kind === 'unreachable'
        ? `Local Autocomplete can't reach ${server}. ${settings.provider === 'ollama' ? 'Is Ollama running?' : 'Is the server running?'}`
        : `Local Autocomplete: ${error.message}`;
    const choice = await vscode.window.showWarningMessage(message, 'Open Settings', 'Show Log');
    if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.extensionId}`);
    }
    if (choice === 'Show Log') this.log.show();
  }
}
