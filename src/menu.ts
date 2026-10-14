import * as vscode from 'vscode';
import type { ApiKeyStore } from './apiKey';
import { describeServer, readSettings, updateSetting } from './config';
import { BackendError, createBackend } from './core/backends';
import { backendOptions } from './core/settings';
import { fileEnabled } from './core/enablement';
import { detectFimTemplate } from './core/fim';
import { fileName, isSupported, type EnablementStore } from './enablementStore';
import { languageName } from './languages';
import type { StatusBar } from './statusBar';

interface MenuItem extends vscode.QuickPickItem {
  run?: () => unknown;
}

/** The menu behind the status bar item. */
export async function showMenu(
  enablement: EnablementStore,
  status: StatusBar,
  apiKeys: ApiKeyStore,
  extensionId: string,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const document = editor && isSupported(editor.document) ? editor.document : undefined;
  const items: MenuItem[] = [];

  if (document) {
    const state = enablement.get(document);
    const name = fileName(document);
    const language = languageName(document.languageId);
    items.push(
      {
        label: fileEnabled(state) ? '$(circle-slash) Disable for this file' : '$(check) Enable for this file',
        description: name,
        run: () => enablement.toggleFile(document),
      },
      {
        label: state.language
          ? `$(circle-slash) Disable for ${language} files`
          : `$(check) Enable for ${language} files`,
        description: state.file === undefined ? undefined : `${name} keeps its own setting`,
        run: () => enablement.setLanguageEnabled(document.languageId, !state.language, document.uri),
      },
    );
  }

  const everywhere = enablement.enabledEverywhere();
  const apiKeySet = await apiKeys.isSet();
  items.push(
    {
      label: everywhere ? '$(circle-slash) Disable everywhere' : '$(check) Enable everywhere',
      run: () => enablement.setEnabledEverywhere(!everywhere, document?.uri),
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: '$(hubot) Select model…',
      description: readSettings(document?.uri).model,
      run: () => vscode.commands.executeCommand('localAutocomplete.selectModel'),
    },
    {
      label: '$(sparkle) Generate commit message',
      description: 'from the git diff',
      run: () => vscode.commands.executeCommand('localAutocomplete.generateCommitMessage'),
    },
    {
      label: apiKeySet ? '$(key) Change API key…' : '$(key) Set API key…',
      description: apiKeySet ? 'kept in your keychain' : 'only needed by OpenAI-compatible servers',
      run: () => setApiKey(apiKeys),
    },
    ...(apiKeySet ? [{ label: '$(trash) Remove API key', run: () => apiKeys.clear() } satisfies MenuItem] : []),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: '$(gear) Settings',
      run: () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`),
    },
    {
      label: '$(output) Show log',
      run: () => vscode.commands.executeCommand('localAutocomplete.showLog'),
    },
  );

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Local Autocomplete',
    placeHolder: status.view().summary,
  });
  await picked?.run?.();
}

/**
 * Stores the API key in secret storage. Pressing Enter with an empty box removes the stored key, so
 * there is no separate command to forget it; Esc leaves everything as it was.
 */
export async function setApiKey(apiKeys: ApiKeyStore): Promise<void> {
  const current = await apiKeys.get();
  const entered = await vscode.window.showInputBox({
    title: 'Local Autocomplete: API Key',
    prompt: 'Sent as "Authorization: Bearer …" to an OpenAI-compatible server.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: current === '' ? 'Enter the API key' : 'Enter a new key, or nothing to remove the stored one',
  });
  if (entered === undefined) return;
  if (entered.trim() === '') {
    if (current !== '') await apiKeys.clear();
    return;
  }
  await apiKeys.set(entered);
  void vscode.window.showInformationMessage('Local Autocomplete: API key saved in your keychain.');
}

export async function selectModel(log: vscode.LogOutputChannel, apiKeys: ApiKeyStore): Promise<void> {
  const settings = readSettings();
  const server = describeServer(settings);
  let models: string[];
  try {
    models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Fetching models from ${server}` },
      async () => createBackend(backendOptions(settings, await apiKeys.get())).listModels(),
    );
  } catch (error) {
    const message = error instanceof BackendError ? error.message : String(error);
    log.error(`Listing models failed: ${message}`);
    void vscode.window.showErrorMessage(`Local Autocomplete couldn't list the models on ${server}: ${message}`);
    return;
  }

  if (models.length === 0) {
    const hint = settings.provider === 'ollama' ? ` Download one with "ollama pull ${settings.model}".` : '';
    void vscode.window.showInformationMessage(`Local Autocomplete: no models found on ${server}.${hint}`);
    return;
  }

  const items = models.map((name): vscode.QuickPickItem => {
    const notes: string[] = [];
    if (name === settings.model) notes.push('current');
    if (settings.fimTemplate === 'auto' && !detectFimTemplate(name)) notes.push('unknown fill-in-the-middle format');
    return { label: name, description: notes.join(' · ') };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Local Autocomplete: Select Model',
    placeHolder: `Models on ${server}`,
  });
  if (picked) await updateSetting('model', picked.label);
}
