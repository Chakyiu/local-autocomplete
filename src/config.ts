import * as vscode from 'vscode';
import { PROVIDER_NAMES, resolveBaseUrl } from './core/backends';
import { SECTION, parseSettings, resolveUpdateTarget, type Settings, type SettingScope } from './core/settings';

export { SECTION };
export type { Settings };

/**
 * Reads the extension's settings. Pass the document's URI to get language-specific overrides of the
 * keys declared `"scope": "language-overridable"`.
 */
export function readSettings(resource?: vscode.Uri): Settings {
  const config = vscode.workspace.getConfiguration(SECTION, resource);
  return parseSettings((key) => config.get(key));
}

/** For example "Ollama at http://127.0.0.1:11434". */
export function describeServer(settings: Settings): string {
  return `${PROVIDER_NAMES[settings.provider]} at ${resolveBaseUrl(settings.provider, settings.endpoint)}`;
}

const TARGETS: Record<SettingScope, vscode.ConfigurationTarget> = {
  workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
  workspace: vscode.ConfigurationTarget.Workspace,
  global: vscode.ConfigurationTarget.Global,
};

/**
 * Writes a setting where it will actually take effect: in the folder's `settings.json` if the key is
 * set there, else in the workspace file, else in user settings — dropping the key when the value
 * goes back to its default.
 */
export async function updateSetting(key: string, value: unknown, resource?: vscode.Uri): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION, resource);
  const decision = resolveUpdateTarget(config.inspect(key) ?? {}, value);
  await config.update(key, decision.value, TARGETS[decision.scope]);
}

/**
 * The plaintext `localAutocomplete.apiKey` that older versions wrote to the settings file. Read only
 * to move it into secret storage; the setting itself is deprecated.
 */
export function readLegacyApiKey(): string {
  const value: unknown = vscode.workspace.getConfiguration(SECTION).get('apiKey');
  return typeof value === 'string' ? value : '';
}

/** Forgets the plaintext key once it is safely in secret storage. */
export async function clearLegacyApiKey(): Promise<void> {
  await updateSetting('apiKey', undefined);
}
