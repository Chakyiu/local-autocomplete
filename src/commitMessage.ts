import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ApiKeyStore } from './apiKey';
import { readSettings, type Settings } from './config';
import { BackendError, createBackend, numCtxToRequest, requiredContextTokens } from './core/backends';
import {
  COMMIT_MESSAGE_MAX_TOKENS,
  GIT_STATUS_UNTRACKED,
  buildCommitPrompt,
  chooseRepository,
  cleanCommitMessage,
  limitDiff,
  renderWorkingTreeDiff,
  subjectsFromLog,
  untrackedUris,
  type DiffFile,
} from './core/commitMessage';
import { backendOptions } from './core/settings';
import { loadGit, type GitChange, type GitRepository } from './git';
import type { RequestReporter } from './reporter';

/** Low, so the same diff keeps producing the same message, but not zero. */
const TEMPERATURE = 0.2;
const MAX_UNTRACKED_FILES = 30;
/** Past this, the file is named in the prompt instead of being read into it. */
const MAX_FILE_BYTES = 100_000;
const MAX_HINT_CHARS = 1000;

/**
 * Drafts a commit message from the git diff and writes it into the commit box. A second click
 * abandons the request already running and starts another.
 */
export class CommitMessages implements vscode.Disposable {
  private generation = 0;
  private current: AbortController | undefined;

  constructor(
    private readonly apiKeys: ApiKeyStore,
    private readonly reporter: RequestReporter,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  dispose(): void {
    this.generation++;
    this.current?.abort();
  }

  async run(argument?: unknown): Promise<void> {
    const generation = ++this.generation;
    this.current?.abort();
    const abort = new AbortController();
    this.current = abort;

    const git = await loadGit();
    if (generation !== this.generation) return;
    if (git === 'missing' || git === 'disabled') {
      const why =
        git === 'missing' ? 'the built-in Git extension is not available' : 'Git is turned off in this workspace';
      void vscode.window.showInformationMessage(`Local Autocomplete can't read the diff: ${why}.`);
      return;
    }

    const editor = vscode.window.activeTextEditor;
    // COMMIT_EDITMSG, opened when VS Code is the editor Git itself launches. Distinct from the
    // Source Control input box, which is not a text editor.
    const commitEditor = editor?.document.languageId === 'git-commit' ? editor : undefined;
    const hints = [filePath(argument), commitEditor?.document.uri.fsPath, editor?.document.uri.fsPath].filter(
      (hint): hint is string => typeof hint === 'string' && hint !== '',
    );
    const choice = chooseRepository(
      git.repositories.map((repo) => ({ repo, root: repo.rootUri.fsPath })),
      hints,
    );

    let repo: GitRepository | undefined;
    if (choice.kind === 'none') {
      void vscode.window.showInformationMessage('Local Autocomplete: open a folder that is a Git repository.');
      return;
    } else if (choice.kind === 'pick') {
      repo = await pickRepository(git.repositories);
    } else {
      repo = choice.repo.repo;
    }
    if (!repo || generation !== this.generation) return;

    const settings = readSettings(repo.rootUri);
    const target = repo;
    // The Source Control location only spins the view icon. The notification is what can be cancelled.
    await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Generating commit message…', cancellable: true },
        async (_progress, token) => {
          const subscription = token.onCancellationRequested(() => abort.abort());
          try {
            await this.generate(target, commitEditor, settings, abort.signal, generation);
          } finally {
            subscription.dispose();
          }
        },
      ),
    );
  }

  private async generate(
    repo: GitRepository,
    commitEditor: vscode.TextEditor | undefined,
    settings: Settings,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    try {
      const collected = await collectDiff(repo, settings.commitMessageMaxDiffChars, signal);
      if (signal.aborted || generation !== this.generation) return;
      if (!collected) {
        void vscode.window.showInformationMessage('Local Autocomplete: there are no changes to describe.');
        return;
      }

      let recentSubjects: string[] = [];
      try {
        const history = await repo.log({ maxEntries: 12 });
        recentSubjects = subjectsFromLog(history.map((commit) => commit.message));
      } catch (error) {
        this.log.debug(`Commit history is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (signal.aborted || generation !== this.generation) return;

      const hint = (commitEditor ? commitEditor.document.getText() : repo.inputBox.value)
        .trim()
        .slice(0, MAX_HINT_CHARS);
      const prompt = buildCommitPrompt({ ...collected, hint, recentSubjects });
      const options = backendOptions(settings, await this.apiKeys.get());
      if (settings.commitMessageModel !== '') options.model = settings.commitMessageModel;
      const messages = [
        { role: 'system' as const, content: prompt.system },
        { role: 'user' as const, content: prompt.user },
      ];
      const request = {
        messages,
        maxTokens: COMMIT_MESSAGE_MAX_TOKENS,
        temperature: TEMPERATURE,
        contextTokens: numCtxToRequest(
          requiredContextTokens(prompt.system + prompt.user, COMMIT_MESSAGE_MAX_TOKENS),
          settings.maxContextTokens,
        ),
        signal,
      };

      const started = Date.now();
      const backend = createBackend(options);
      const result = settings.stream ? await backend.streamChat(request, () => false) : await backend.chat(request);
      if (signal.aborted || generation !== this.generation) return;

      const message = cleanCommitMessage(result.text);
      this.log.info(
        `Commit message from ${options.model}: ${Date.now() - started} ms, ${result.tokens ?? '?'} tokens` +
          (collected.truncated ? ', diff truncated' : ''),
      );
      this.log.trace(`Commit prompt:\n${prompt.user}\nOutput:\n${result.text}`);
      if (message === '') {
        void vscode.window.showInformationMessage("Local Autocomplete: the model didn't return a commit message.");
        return;
      }

      if (commitEditor) {
        const applied = await replaceDocument(commitEditor, message);
        if (!applied) {
          void vscode.window.showWarningMessage('Local Autocomplete: the commit message editor could not be updated.');
        }
      } else {
        repo.inputBox.value = message;
        await vscode.commands.executeCommand('workbench.view.scm');
      }
      this.reporter.succeeded();
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return;
      if (error instanceof BackendError) {
        const model = settings.commitMessageModel || settings.model;
        this.reporter.failed(error, { ...settings, model }, 'commit');
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(message);
      void vscode.window.showWarningMessage(`Local Autocomplete: ${message}`);
    }
  }
}

interface CollectedDiff {
  diff: string;
  staged: boolean;
  truncated: boolean;
}

async function collectDiff(
  repo: GitRepository,
  maxChars: number,
  signal: AbortSignal,
): Promise<CollectedDiff | undefined> {
  const staged = repo.state.indexChanges;
  const working = repo.state.workingTreeChanges;
  const untracked = repo.state.untrackedChanges ?? [];
  if (staged.length === 0 && working.length === 0 && untracked.length === 0) return undefined;

  if (staged.length > 0) {
    const diff = (await repo.diff(true)).trim();
    if (signal.aborted) return undefined;
    return collected(true, limitDiff(diff === '' ? fileList(repo, staged) : diff, maxChars));
  }

  const tracked = working.some((change) => change.status !== GIT_STATUS_UNTRACKED);
  const unstaged = tracked ? await repo.diff(false) : '';
  const files = await readNewFiles(repo, untrackedUris(asRefs(working), asRefs(untracked)), signal);
  if (signal.aborted) return undefined;
  const rendered = renderWorkingTreeDiff(unstaged, files, maxChars);
  if (rendered.text.trim() === '') {
    return collected(false, limitDiff(fileList(repo, [...working, ...untracked]), maxChars));
  }
  return collected(false, rendered);
}

function collected(staged: boolean, diff: { text: string; truncated: boolean }): CollectedDiff {
  return { staged, diff: diff.text, truncated: diff.truncated };
}

function asRefs(changes: readonly GitChange[]): { uri: string; status: number }[] {
  return changes.map((change) => ({ uri: change.uri.toString(), status: change.status }));
}

async function readNewFiles(repo: GitRepository, uris: readonly string[], signal: AbortSignal): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  for (const key of uris.slice(0, MAX_UNTRACKED_FILES)) {
    if (signal.aborted) return files;
    const uri = vscode.Uri.parse(key);
    const relative = relativePath(repo.rootUri, uri);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) continue;
      if (stat.size > MAX_FILE_BYTES) {
        files.push({ path: relative, omitted: `${stat.size} bytes` });
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.includes(0)) {
        files.push({ path: relative, omitted: 'binary' });
        continue;
      }
      files.push({ path: relative, content: new TextDecoder().decode(bytes) });
    } catch {
      files.push({ path: relative, omitted: 'unreadable' });
    }
  }
  const rest = uris.length - Math.min(uris.length, MAX_UNTRACKED_FILES);
  if (rest > 0) files.push({ path: `${rest} more untracked files`, omitted: 'not included' });
  return files;
}

function fileList(repo: GitRepository, changes: readonly GitChange[]): string {
  const names = changes.map((change) => `- ${relativePath(repo.rootUri, change.uri)}`);
  return `Files changed with no text diff:\n${names.join('\n')}`;
}

function relativePath(root: vscode.Uri, uri: vscode.Uri): string {
  const relative = path.relative(root.fsPath, uri.fsPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return uri.path.replace(/^\/+/, '');
  return relative.split(path.sep).join('/');
}

async function replaceDocument(editor: vscode.TextEditor, text: string): Promise<boolean> {
  const last = editor.document.lineAt(editor.document.lineCount - 1).range.end;
  return editor.edit((builder) => builder.replace(new vscode.Range(new vscode.Position(0, 0), last), text));
}

async function pickRepository(repos: readonly GitRepository[]): Promise<GitRepository | undefined> {
  const picked = await vscode.window.showQuickPick(
    repos.map((repo) => ({ label: path.basename(repo.rootUri.fsPath), description: repo.rootUri.fsPath, repo })),
    { title: 'Generate Commit Message', placeHolder: 'Which repository?' },
  );
  return picked?.repo;
}

/**
 * The Source Control toolbar forwards the provider, and its `rootUri` says which repository was
 * clicked. A command argument crosses processes, so the URI may arrive revived or as its components.
 */
function filePath(argument: unknown): string | undefined {
  const direct = asUri(argument);
  if (direct) return direct.fsPath;
  if (typeof argument === 'object' && argument !== null && 'rootUri' in argument) {
    return asUri((argument as { rootUri?: unknown }).rootUri)?.fsPath;
  }
  return undefined;
}

function asUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { scheme?: unknown; path?: unknown };
  if (typeof candidate.scheme !== 'string' || typeof candidate.path !== 'string') return undefined;
  return vscode.Uri.from({ scheme: candidate.scheme, path: candidate.path });
}
