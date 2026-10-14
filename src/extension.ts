import * as vscode from 'vscode';
import { ApiKeyStore } from './apiKey';
import { CommitMessages } from './commitMessage';
import { SECTION, describeServer, readSettings } from './config';
import { EnablementStore, SUPPORTED_DOCUMENTS, isSupported } from './enablementStore';
import { forgetLanguageNames } from './languages';
import { selectModel, setApiKey, showMenu } from './menu';
import { LocalCompletionProvider } from './provider';
import { RequestReporter } from './reporter';
import { StatusBar } from './statusBar';

/** Changing these points requests at a different server or model, so earlier failures no longer apply. */
const SERVER_SETTINGS = ['provider', 'endpoint', 'model'];

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Local Autocomplete', { log: true });
  const enablement = new EnablementStore(context.globalState);
  const apiKeys = new ApiKeyStore(context.secrets, log);
  const status = new StatusBar(enablement);
  const reporter = new RequestReporter(status, log, context.extension.id);
  const provider = new LocalCompletionProvider(enablement, status, reporter, apiKeys, log);
  const commitMessages = new CommitMessages(apiKeys, reporter, log);

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
    apiKeys,
    commitMessages,
    vscode.languages.registerInlineCompletionItemProvider(SUPPORTED_DOCUMENTS, provider),
    enablement.onDidChange(() => {
      // The old ghost text was computed for the text before the toggle.
      void vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(SECTION)) return;
      provider.clearCache();
      if (SERVER_SETTINGS.some((key) => event.affectsConfiguration(`${SECTION}.${key}`))) reporter.reset();
    }),
    vscode.extensions.onDidChange(forgetLanguageNames),
    apiKeys.onDidChange(() => {
      provider.clearCache();
      reporter.reset();
    }),

    vscode.commands.registerCommand('localAutocomplete.showMenu', () =>
      showMenu(enablement, status, apiKeys, context.extension.id),
    ),
    vscode.commands.registerCommand(
      'localAutocomplete.toggleFile',
      forActiveFile((document) => enablement.toggleFile(document)),
    ),
    vscode.commands.registerCommand(
      'localAutocomplete.toggleLanguage',
      forActiveFile((document) =>
        enablement.setLanguageEnabled(
          document.languageId,
          !enablement.languageEnabled(document.languageId),
          document.uri,
        ),
      ),
    ),
    vscode.commands.registerCommand('localAutocomplete.toggleEverywhere', () =>
      enablement.setEnabledEverywhere(!enablement.enabledEverywhere()),
    ),
    vscode.commands.registerCommand('localAutocomplete.selectModel', () => selectModel(log, apiKeys)),
    vscode.commands.registerCommand('localAutocomplete.generateCommitMessage', (argument?: unknown) =>
      commitMessages.run(argument),
    ),
    vscode.commands.registerCommand('localAutocomplete.setApiKey', () => setApiKey(apiKeys)),
    vscode.commands.registerCommand('localAutocomplete.forgetFileSettings', () => enablement.forgetFileSettings()),
    vscode.commands.registerCommand('localAutocomplete.showLog', () => log.show()),
  );
}
