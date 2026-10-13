import * as path from 'node:path';
import * as vscode from 'vscode';
import { SECTION, updateSetting } from './config';
import { flippedFileSetting, resolveEnablement, type Enablement } from './core/enablement';

const FILE_SETTINGS_KEY = 'fileSettings';

/**
 * Ceiling on how many per-file choices are remembered. They are keyed by URI, so without a limit a
 * long-lived profile would keep one entry for every file it ever had open.
 */
const MAX_FILE_SETTINGS = 200;

/** Editors that get completions. Output panes, diff views, the commit message box, etc. do not. */
export const SUPPORTED_DOCUMENTS: vscode.DocumentSelector = [
  { scheme: 'file' },
  { scheme: 'untitled' },
  { scheme: 'vscode-notebook-cell' },
  { scheme: 'vscode-remote' },
  { scheme: 'vscode-userdata' },
  { scheme: 'vscode-vfs' },
];

export function isSupported(document: vscode.TextDocument): boolean {
  return vscode.languages.match(SUPPORTED_DOCUMENTS, document) > 0;
}

/** The file that "this file" refers to: a notebook cell belongs to its notebook. */
export function fileUri(document: vscode.TextDocument): vscode.Uri {
  if (document.uri.scheme === 'vscode-notebook-cell') {
    const notebook = vscode.workspace.notebookDocuments.find((candidate) =>
      candidate.getCells().some((cell) => cell.document === document),
    );
    if (notebook) return notebook.uri;
  }
  return document.uri;
}

export function fileName(document: vscode.TextDocument): string {
  return path.posix.basename(fileUri(document).path);
}

/**
 * Where completions are on. Everywhere and per-language state are settings, so they sync and can
 * be set per workspace. Per-file choices are kept in extension storage, keyed by URI.
 */
export class EnablementStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** Untitled files keep their setting only while open, because their names get reused. */
  private readonly untitledFileSettings = new Map<string, boolean>();
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly storage: vscode.Memento) {
    this.disposables = [
      this.changed,
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(`${SECTION}.enable`) ||
          event.affectsConfiguration(`${SECTION}.disabledLanguages`)
        ) {
          this.changed.fire();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme === 'untitled') this.untitledFileSettings.delete(document.uri.toString());
      }),
      // A deleted or renamed file has no reason to keep its choice around.
      vscode.workspace.onDidDeleteFiles((event) => {
        const gone = new Set(event.files.map((uri) => uri.toString()));
        void this.pruneFileSettings((key) => gone.has(key));
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        const gone = new Set(event.files.map(({ oldUri }) => oldUri.toString()));
        void this.pruneFileSettings((key) => gone.has(key));
      }),
    ];
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  get(document: vscode.TextDocument): Enablement {
    return resolveEnablement({
      everywhere: this.enabledEverywhere(),
      language: this.languageEnabled(document.languageId),
      file: this.fileSetting(document),
    });
  }

  enabledEverywhere(): boolean {
    return vscode.workspace.getConfiguration(SECTION).get('enable') !== false;
  }

  languageEnabled(languageId: string): boolean {
    return !this.disabledLanguages().includes(languageId);
  }

  async setEnabledEverywhere(enabled: boolean, resource?: vscode.Uri): Promise<void> {
    await updateSetting('enable', enabled, resource);
  }

  async setLanguageEnabled(languageId: string, enabled: boolean, resource?: vscode.Uri): Promise<void> {
    const others = this.disabledLanguages().filter((id) => id !== languageId);
    await updateSetting('disabledLanguages', enabled ? others : [...others, languageId], resource);
  }

  async toggleFile(document: vscode.TextDocument): Promise<void> {
    await this.setFileSetting(document, flippedFileSetting(this.get(document)));
  }

  /** Drops remembered per-file choices the predicate matches, e.g. files that no longer exist. */
  async pruneFileSettings(matches: (uri: string) => boolean): Promise<void> {
    const settings = this.storedFileSettings();
    const kept: Record<string, boolean> = {};
    let dropped = 0;
    for (const [key, value] of Object.entries(settings)) {
      if (matches(key)) dropped++;
      else kept[key] = value;
    }
    if (dropped === 0) return;
    await this.storage.update(FILE_SETTINGS_KEY, Object.keys(kept).length > 0 ? kept : undefined);
    this.changed.fire();
  }

  async forgetFileSettings(): Promise<void> {
    this.untitledFileSettings.clear();
    await this.storage.update(FILE_SETTINGS_KEY, undefined);
    this.changed.fire();
  }

  private disabledLanguages(): string[] {
    const value: unknown = vscode.workspace.getConfiguration(SECTION).get('disabledLanguages');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  }

  private fileSetting(document: vscode.TextDocument): boolean | undefined {
    const uri = fileUri(document);
    const key = uri.toString();
    return uri.scheme === 'untitled' ? this.untitledFileSettings.get(key) : this.storedFileSettings()[key];
  }

  private async setFileSetting(document: vscode.TextDocument, value: boolean | undefined): Promise<void> {
    const uri = fileUri(document);
    const key = uri.toString();
    if (uri.scheme === 'untitled') {
      if (value === undefined) this.untitledFileSettings.delete(key);
      else this.untitledFileSettings.set(key, value);
    } else {
      const settings = { ...this.storedFileSettings() };
      if (value === undefined) delete settings[key];
      else {
        // Oldest first: the entries people still have open get written again after they are dropped.
        const keys = Object.keys(settings);
        while (keys.length >= MAX_FILE_SETTINGS) {
          const oldest = keys.shift();
          if (oldest === undefined) break;
          delete settings[oldest];
        }
        settings[key] = value;
      }
      await this.storage.update(FILE_SETTINGS_KEY, Object.keys(settings).length > 0 ? settings : undefined);
    }
    this.changed.fire();
  }

  private storedFileSettings(): Record<string, boolean> {
    return this.storage.get<Record<string, boolean>>(FILE_SETTINGS_KEY) ?? {};
  }
}
