import * as vscode from 'vscode';
import { PROVIDER_NAMES, resolveBaseUrl, type ProviderId } from './core/backends';
import type { FimTemplateSetting } from './core/fim';
import type { MultilineMode } from './core/postprocess';

export const SECTION = 'localAutocomplete';

export interface Settings {
  provider: ProviderId;
  endpoint: string;
  apiKey: string;
  model: string;
  fimTemplate: FimTemplateSetting;
  customFimTemplate: string;
  stopSequences: string[];
  multiline: MultilineMode;
  maxTokens: number;
  temperature: number;
  debounceMs: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
}

const FIM_TEMPLATE_SETTINGS: readonly FimTemplateSetting[] = [
  'auto',
  'qwen',
  'codellama',
  'deepseek',
  'starcoder',
  'codegemma',
  'codestral',
  'custom',
];

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    provider: choice(config.get('provider'), ['ollama', 'openai-compatible'], 'ollama'),
    endpoint: text(config.get('endpoint'), ''),
    apiKey: text(config.get('apiKey'), ''),
    model: text(config.get('model'), '').trim() || 'qwen2.5-coder:1.5b-base',
    fimTemplate: choice(config.get('fimTemplate'), FIM_TEMPLATE_SETTINGS, 'auto'),
    customFimTemplate: text(config.get('customFimTemplate'), ''),
    stopSequences: textList(config.get('stopSequences')).filter((stop) => stop !== ''),
    multiline: choice(config.get('multiline'), ['auto', 'always', 'never'], 'auto'),
    maxTokens: count(config.get('maxTokens'), 128),
    temperature: count(config.get('temperature'), 0.1),
    debounceMs: count(config.get('debounceMs'), 200),
    maxPrefixChars: count(config.get('maxPrefixChars'), 4000),
    maxSuffixChars: count(config.get('maxSuffixChars'), 1000),
  };
}

/** For example "Ollama at http://127.0.0.1:11434". */
export function describeServer(settings: Settings): string {
  return `${PROVIDER_NAMES[settings.provider]} at ${resolveBaseUrl(settings.provider, settings.endpoint)}`;
}

/**
 * Writes to the workspace when it already sets the key, since a user-level value would be
 * shadowed there; otherwise to user settings, dropping the key when it goes back to its default.
 */
export async function updateSetting(key: string, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const inspected = config.inspect(key);
  if (inspected?.workspaceValue !== undefined) {
    await config.update(key, value, vscode.ConfigurationTarget.Workspace);
    return;
  }
  const isDefault = JSON.stringify(value) === JSON.stringify(inspected?.defaultValue);
  await config.update(key, isDefault ? undefined : value, vscode.ConfigurationTarget.Global);
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((option) => option === value) ?? fallback;
}
