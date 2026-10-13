import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';

const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const CURSOR = '‸';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settings = () => vscode.workspace.getConfiguration('localAutocomplete');

/** Puts back everything the tests change, including what a failed test left behind. */
async function resetEnablement(): Promise<void> {
  for (const key of ['enable', 'disabledLanguages', 'model']) {
    await settings().update(key, undefined, vscode.ConfigurationTarget.Global);
  }
  await vscode.commands.executeCommand('localAutocomplete.forgetFileSettings');
}

/** Opens an untitled document with the cursor where `text` has a ‸. */
async function open(language: string, text: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language, content: text.replace(CURSOR, '') });
  const editor = await vscode.window.showTextDocument(document);
  const position = document.positionAt(text.indexOf(CURSOR));
  editor.selection = new vscode.Selection(position, position);
  return editor;
}

/** Asks for an inline suggestion and accepts it, as pressing Alt+\ then Tab would. False if none appears. */
async function acceptSuggestion(editor: vscode.TextEditor, timeoutMs = 5000): Promise<boolean> {
  const before = editor.document.getText();
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    await sleep(50);
    await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
    if (editor.document.getText() !== before) return true;
  }
  return false;
}

/**
 * Moves focus to the status bar and back, as using the status bar or the command palette does.
 * VS Code keeps an inline completion result until the cursor, the text, or the focus changes.
 */
async function refocusEditor(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.focusStatusBar');
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
}

/** Runs a command that shows a quick pick, and accepts the first item once it appears. */
async function pickFirstItem(command: string): Promise<void> {
  let finished = false;
  const running = Promise.resolve(vscode.commands.executeCommand(command)).finally(() => (finished = true));
  for (const deadline = Date.now() + 5000; !finished && Date.now() < deadline; ) {
    await sleep(100);
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  }
  await running;
}

describe('Local Autocomplete in VS Code', () => {
  /** Stands in for Ollama: answers every completion with `reply` and records the prompts. */
  let server: http.Server;
  let reply = '';
  const prompts: string[] = [];
  const promptsMentioning = (text: string) => prompts.filter((prompt) => prompt.includes(text));

  before(async () => {
    server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/api/generate') {
          prompts.push(JSON.parse(body).prompt);
          response.end(JSON.stringify({ response: reply, done: true }));
        } else if (request.url === '/api/tags') {
          response.end(JSON.stringify({ models: [{ name: 'starcoder2:3b' }, { name: 'qwen2.5-coder:1.5b-base' }] }));
        } else {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'not found' }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    await settings().update('endpoint', `http://127.0.0.1:${port}`, vscode.ConfigurationTarget.Global);
    // Keep IntelliSense out of the way so that only inline suggestions are involved.
    await vscode.workspace
      .getConfiguration('editor')
      .update('quickSuggestions', { other: 'off', comments: 'off', strings: 'off' }, vscode.ConfigurationTarget.Global);
    await vscode.extensions.getExtension(EXTENSION_ID)!.activate();
    await resetEnablement();
  });

  after(async () => {
    await settings().update('endpoint', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('editor').update('quickSuggestions', undefined, vscode.ConfigurationTarget.Global);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(async () => {
    for (let i = 0; i < 10 && vscode.window.activeTextEditor; i++) {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    await resetEnablement();
  });

  it('inserts what the model returns, using a fill-in-the-middle prompt', async () => {
    const editor = await open('typescript', 'const greeting = "hello ‸');
    reply = 'world";';

    assert.equal(await acceptSuggestion(editor), true);
    assert.equal(editor.document.getText(), 'const greeting = "hello world";');
    assert.equal(promptsMentioning('greeting')[0], '<|fim_prefix|>const greeting = "hello <|fim_suffix|><|fim_middle|>');
  });

  it('completes inside auto-closed brackets without duplicating them', async () => {
    const editor = await open('javascript', 'console.log(‸)');
    reply = '"hi")';

    assert.equal(await acceptSuggestion(editor), true);
    assert.equal(editor.document.getText(), 'console.log("hi")');
  });

  it('ends a multi-line completion with the current block', async () => {
    const editor = await open('javascript', 'function add(a, b) {\n  ‸\n}\n');
    reply = 'return a + b;\n}\n\nfunction subtract(a, b) {';

    assert.equal(await acceptSuggestion(editor), true);
    assert.equal(editor.document.getText(), 'function add(a, b) {\n  return a + b;\n}\n');
  });

  it('does not ask the model again while the user types the suggestion', async () => {
    const editor = await open('typescript', 'const typedAhead = ‸');
    reply = 'computeTotal(items);';

    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    for (const deadline = Date.now() + 5000; promptsMentioning('typedAhead').length === 0 && Date.now() < deadline; ) {
      await sleep(50);
    }
    await sleep(200);
    await vscode.commands.executeCommand('type', { text: 'comp' });
    await sleep(500);
    const requestsBeforeAccepting = promptsMentioning('typedAhead').length;
    await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');

    assert.equal(editor.document.getText(), 'const typedAhead = computeTotal(items);');
    assert.equal(requestsBeforeAccepting, 1);
  });

  it('stays quiet in a file switched off from the status bar menu', async () => {
    const editor = await open('typescript', 'const fromMenu = ‸');
    reply = '1;';

    await pickFirstItem('localAutocomplete.showMenu');
    assert.equal(await acceptSuggestion(editor, 1000), false);
    assert.equal(promptsMentioning('fromMenu').length, 0);

    await pickFirstItem('localAutocomplete.showMenu');
    assert.equal(await acceptSuggestion(editor), true);
    assert.equal(editor.document.getText(), 'const fromMenu = 1;');
  });

  it('stays quiet for a disabled language, unless the file is switched back on', async () => {
    const editor = await open('typescript', 'const byLanguage = ‸');
    reply = '2;';

    await vscode.commands.executeCommand('localAutocomplete.toggleLanguage');
    assert.deepEqual(settings().get('disabledLanguages'), ['typescript']);
    assert.equal(await acceptSuggestion(editor, 1000), false);
    assert.equal(promptsMentioning('byLanguage').length, 0);

    await vscode.commands.executeCommand('localAutocomplete.toggleFile');
    await refocusEditor();
    assert.equal(await acceptSuggestion(editor), true);
    assert.equal(editor.document.getText(), 'const byLanguage = 2;');

    await vscode.commands.executeCommand('localAutocomplete.toggleFile');
    await vscode.commands.executeCommand('localAutocomplete.toggleLanguage');
    assert.equal(settings().inspect('disabledLanguages')?.globalValue, undefined);
  });

  it('stays quiet everywhere when switched off everywhere', async () => {
    const editor = await open('python', 'everywhere = ‸');
    reply = '3';

    await vscode.commands.executeCommand('localAutocomplete.toggleEverywhere');
    assert.equal(settings().get('enable'), false);
    assert.equal(await acceptSuggestion(editor, 1000), false);
    assert.equal(promptsMentioning('everywhere').length, 0);

    await vscode.commands.executeCommand('localAutocomplete.toggleEverywhere');
    assert.equal(settings().inspect('enable')?.globalValue, undefined);
    await refocusEditor();
    assert.equal(await acceptSuggestion(editor), true);
    assert.equal(editor.document.getText(), 'everywhere = 3');
  });

  it('picks a model from the ones on the server', async () => {
    await pickFirstItem('localAutocomplete.selectModel');
    assert.equal(settings().get('model'), 'starcoder2:3b');
  });
});
