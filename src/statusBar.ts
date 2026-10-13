import * as vscode from 'vscode';
import { SECTION, describeServer, readSettings } from './config';
import { describeStatus, type StatusView } from './core/status';
import { fileName, isSupported, type EnablementStore } from './enablementStore';
import { languageName } from './languages';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingRequests = 0;
  private error: string | undefined;

  constructor(private readonly enablement: EnablementStore) {
    this.item = vscode.window.createStatusBarItem('localAutocomplete.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Local Autocomplete';
    this.item.command = 'localAutocomplete.showMenu';
    this.disposables.push(
      this.item,
      enablement.onDidChange(() => this.render()),
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      // Changing a document's language closes and reopens it.
      vscode.workspace.onDidOpenTextDocument(() => this.render()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(SECTION)) this.render();
      }),
    );
    this.render();
    this.item.show();
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }

  requestStarted(): void {
    this.pendingRequests++;
    this.render();
  }

  requestFinished(): void {
    this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    this.render();
  }

  setError(message: string | undefined): void {
    if (message === this.error) return;
    this.error = message;
    this.render();
  }

  view(): StatusView {
    const settings = readSettings();
    const editor = vscode.window.activeTextEditor;
    const document = editor && isSupported(editor.document) ? editor.document : undefined;
    return describeStatus({
      everywhere: this.enablement.enabledEverywhere(),
      file: document && {
        name: fileName(document),
        languageName: languageName(document.languageId),
        enablement: this.enablement.get(document),
      },
      busy: this.pendingRequests > 0,
      error: this.error,
      model: settings.model,
      server: describeServer(settings),
    });
  }

  private render(): void {
    const view = this.view();
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    this.item.backgroundColor = view.warning ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }
}
