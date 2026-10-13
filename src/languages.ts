import * as vscode from 'vscode';

let names: Map<string, string> | undefined;

/** Display name of a language, such as "TypeScript JSX" for `typescriptreact`. */
export function languageName(languageId: string): string {
  names ??= collectLanguageNames();
  return names.get(languageId) ?? languageId;
}

export function forgetLanguageNames(): void {
  names = undefined;
}

function collectLanguageNames(): Map<string, string> {
  // Plain text is part of the editor itself rather than contributed by an extension.
  const result = new Map<string, string>([['plaintext', 'Plain Text']]);
  for (const extension of vscode.extensions.all) {
    const languages: unknown = extension.packageJSON?.contributes?.languages;
    if (!Array.isArray(languages)) continue;
    for (const language of languages) {
      const alias: unknown = language?.aliases?.[0];
      if (typeof language?.id === 'string' && typeof alias === 'string' && !result.has(language.id)) {
        result.set(language.id, alias);
      }
    }
  }
  return result;
}
