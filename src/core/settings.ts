import { DEFAULT_TIMEOUT_MS, PROVIDERS, type BackendOptions, type ProviderId } from './backends';
import type { FimTemplateSetting } from './fim';
import type { MultilineMode } from './postprocess';
import type { StatusBarDisplay } from './status';

export const SECTION = 'localAutocomplete';

/** Every `localAutocomplete.*` key the extension reads, already validated. */
export interface Settings {
  provider: ProviderId;
  endpoint: string;
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
  timeoutMs: number;
  /** Ceiling for the context this extension asks Ollama for; 0 means never send `num_ctx`. */
  maxContextTokens: number;
  /** Ollama `keep_alive`, e.g. "5m". Empty means leave it to the server. */
  keepAlive: string;
  stream: boolean;
  statusBar: StatusBarDisplay;
  /** When false, the commit-message command and its buttons stay hidden. */
  commitMessage: boolean;
  /** Empty means use `model`. An instruct model, not the fill-in-the-middle one. */
  commitMessageModel: string;
  commitMessageMaxDiffChars: number;
}

export const DEFAULT_MODEL = 'qwen2.5-coder:1.5b-base';

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

/** Reads one setting the way `vscode.WorkspaceConfiguration.get` does. */
export type ReadSetting = (key: string) => unknown;

/**
 * Turns whatever VS Code reports into a usable `Settings`. Anything of the wrong type, or outside
 * the range the setting allows, falls back to its default rather than breaking completion.
 */
export function parseSettings(read: ReadSetting): Settings {
  return {
    provider: choice(read('provider'), PROVIDERS, 'ollama'),
    endpoint: text(read('endpoint'), ''),
    model: text(read('model'), '').trim() || DEFAULT_MODEL,
    fimTemplate: choice(read('fimTemplate'), FIM_TEMPLATE_SETTINGS, 'auto'),
    customFimTemplate: text(read('customFimTemplate'), ''),
    stopSequences: textList(read('stopSequences')).filter((stop) => stop !== ''),
    multiline: choice(read('multiline'), ['auto', 'always', 'never'], 'auto'),
    maxTokens: numberSetting(read('maxTokens'), 128, 1, 4096),
    temperature: numberSetting(read('temperature'), 0.1, 0, 2),
    debounceMs: numberSetting(read('debounceMs'), 200, 0, 5000),
    maxPrefixChars: numberSetting(read('maxPrefixChars'), 4000, 0, 100_000),
    maxSuffixChars: numberSetting(read('maxSuffixChars'), 1000, 0, 100_000),
    // Below a second the extension would give up before a warm model answers.
    timeoutMs: numberSetting(read('timeoutMs'), DEFAULT_TIMEOUT_MS, 1000, 600_000),
    maxContextTokens: numberSetting(read('maxContextTokens'), 8192, 0, 1_000_000),
    keepAlive: text(read('keepAlive'), '').trim(),
    stream: bool(read('stream'), true),
    statusBar: choice(read('showStatusBar'), ['always', 'iconOnly', 'hidden'], 'always'),
    commitMessage: bool(read('commitMessage'), true),
    commitMessageModel: text(read('commitMessageModel'), '').trim(),
    commitMessageMaxDiffChars: numberSetting(read('commitMessageMaxDiffChars'), 20_000, 1000, 200_000),
  };
}

/** The parts of `Settings` a backend call needs, plus the API key kept out of the settings file. */
export function backendOptions(settings: Settings, apiKey: string): BackendOptions {
  return {
    provider: settings.provider,
    endpoint: settings.endpoint,
    apiKey,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    keepAlive: settings.keepAlive || undefined,
  };
}

/** Where a setting lives, in the order VS Code resolves it. */
export type SettingScope = 'workspaceFolder' | 'workspace' | 'global';

export interface UpdateDecision {
  scope: SettingScope;
  /** `undefined` removes the key, which puts the setting back to its default. */
  value: unknown;
}

/**
 * Picks where to write a toggle. A value already set in the workspace or the folder's own
 * `settings.json` shadows anything written higher up, so the toggle has to be written there —
 * otherwise it appears to do nothing.
 */
export function resolveUpdateTarget(
  inspected: {
    workspaceFolderValue?: unknown;
    workspaceValue?: unknown;
    defaultValue?: unknown;
  },
  value: unknown,
): UpdateDecision {
  if (inspected.workspaceFolderValue !== undefined) return { scope: 'workspaceFolder', value };
  if (inspected.workspaceValue !== undefined) return { scope: 'workspace', value };

  const backToDefault = JSON.stringify(value) === JSON.stringify(inspected.defaultValue);
  return { scope: 'global', value: backToDefault ? undefined : value };
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberSetting(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((option) => option === value) ?? fallback;
}
