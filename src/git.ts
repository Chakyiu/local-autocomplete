import * as vscode from 'vscode';

/** The slice of the built-in Git extension's API this extension actually calls. */
export interface GitChange {
  readonly uri: vscode.Uri;
  readonly status: number;
}

export interface GitCommit {
  readonly message: string;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
  readonly state: {
    readonly indexChanges: readonly GitChange[];
    readonly workingTreeChanges: readonly GitChange[];
    readonly untrackedChanges?: readonly GitChange[];
  };
  diff(cached?: boolean): Promise<string>;
  log(options?: { maxEntries?: number }): Promise<GitCommit[]>;
}

export interface GitApi {
  readonly repositories: readonly GitRepository[];
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

export type GitAvailability = GitApi | 'missing' | 'disabled';

/** The Git extension ships with VS Code. `disabled` means the user turned Git off. */
export async function loadGit(): Promise<GitAvailability> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) return 'missing';
  const exported = extension.isActive ? extension.exports : await extension.activate();
  if (!exported.enabled) return 'disabled';
  return exported.getAPI(1);
}
