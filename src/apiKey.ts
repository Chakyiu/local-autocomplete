import * as vscode from 'vscode';
import { clearLegacyApiKey, readLegacyApiKey } from './config';

/** Key inside `context.secrets`; the settings prefix is already implicit there. */
const SECRET_KEY = 'apiKey';

/**
 * The API key for an OpenAI-compatible server, kept in VS Code's secret storage instead of
 * `settings.json`, where it would be synced between machines, sit in backups in plain text, and be
 * easy to commit by accident. Older versions wrote it to the settings file, so the first run of this
 * version moves it across.
 */
export class ApiKeyStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires after the key changed, so cached requests and the status bar can pick it up. */
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[];
  private cached: string | undefined;
  private ready: Promise<void>;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables = [
      this.changed,
      secrets.onDidChange((event) => {
        if (event.key !== SECRET_KEY) return;
        this.cached = undefined;
        this.ready = this.load();
      }),
    ];
    this.ready = this.migrateLegacy();
  }

  async get(): Promise<string> {
    await this.ready;
    return this.cached ?? '';
  }

  async set(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed === '') return this.clear();
    await this.secrets.store(SECRET_KEY, trimmed);
    this.cached = trimmed;
    this.changed.fire();
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
    this.cached = '';
    this.changed.fire();
  }

  /** True when a key is in use, without revealing it. */
  async isSet(): Promise<boolean> {
    return (await this.get()) !== '';
  }

  private async migrateLegacy(): Promise<void> {
    const legacy = readLegacyApiKey();
    const stored = await this.secrets.get(SECRET_KEY);
    if (legacy === '') {
      this.cached = stored ?? '';
      return;
    }
    this.cached = stored ?? legacy;
    await clearLegacyApiKey();
    this.log.info(
      stored === undefined
        ? 'Moved localAutocomplete.apiKey out of your settings file and into secret storage.'
        : 'Ignored the plaintext localAutocomplete.apiKey in your settings file in favour of the stored key, ' +
            'and removed the setting.',
    );
  }

  private async load(): Promise<void> {
    this.cached = (await this.secrets.get(SECRET_KEY)) ?? '';
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}
