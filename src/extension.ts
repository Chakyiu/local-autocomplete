import * as vscode from 'vscode';
import { SECTION, describeServer, readSettings } from './config';
import { EnablementStore, SUPPORTED_DOCUMENTS, isSupported } from './enablementStore';
import { forgetLanguageNames } from './languages';
import { selectModel, showMenu } from './menu';
import { LocalCompletionProvider } from './provider';
import { RequestReporter } from './reporter';
import { StatusBar } from './statusBar';

/** Changing these points requests at a different server or model, so earlier failures no longer apply. */
const SERVER_SETTINGS = ['provider', 'endpoint', 'apiKey', 'model'];

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Local Autocomplete', { log: true });
  const enablement = new EnablementStore(context.globalState);
  const status = new StatusBar(enablement);
  const reporter = new RequestReporter(status, log, context.extension.id);
  const provider = new LocalCompletionProvider(enablement, status, reporter, log);

  const settings = readSettings();
  log.info(`Using ${settings.model} on ${describeServer(settings)}`);

  const forActiveFile = (action: (document: vscode.TextDocument) => Promise<void>) => async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (document && isSupported(document)) await action(document);
    else void vscode.window.showInformationMessage('Local Autocomplete: open a file first.');
  };

  context.subscriptions.push(
    log,
    enablement,
    status,
    vscode.languages.registerInlineCompletionItemProvider(SUPPORTED_DOCUMENTS, provider),
    enablement.onDidChange(() => vscode.commands.executeCommand('editor.action.inlineSuggest.hide')),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(SECTION)) return;
      provider.clearCache();
      if (SERVER_SETTINGS.some((key) => event.affectsConfiguration(`${SECTION}.${key}`))) reporter.reset();
    }),
    vscode.extensions.onDidChange(forgetLanguageNames),

    vscode.commands.registerCommand('localAutocomplete.showMenu', () =>
      showMenu(enablement, status, context.extension.id),
    ),
    vscode.commands.registerCommand(
      'localAutocomplete.toggleFile',
      forActiveFile((document) => enablement.toggleFile(document)),
    ),
    vscode.commands.registerCommand(
      'localAutocomplete.toggleLanguage',
      forActiveFile((document) =>
        enablement.setLanguageEnabled(document.languageId, !enablement.languageEnabled(document.languageId)),
      ),
    ),
    vscode.commands.registerCommand('localAutocomplete.toggleEverywhere', () =>
      enablement.setEnabledEverywhere(!enablement.enabledEverywhere()),
    ),
    vscode.commands.registerCommand('localAutocomplete.selectModel', () => selectModel(log)),
    vscode.commands.registerCommand('localAutocomplete.forgetFileSettings', () => enablement.forgetFileSettings()),
    vscode.commands.registerCommand('localAutocomplete.showLog', () => log.show()),
  );
}
