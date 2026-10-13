# Local Autocomplete

Inline code completions in VS Code from a model that runs on your own machine — Ollama, LM Studio, `llama-server` (llama.cpp), vLLM, LocalAI. Nothing leaves your computer, and there is no subscription.

The model is chosen by you, and can be switched per file, per language, or everywhere, from the status bar.

## Requirements

1. A local server that can run a completion model: [Ollama](https://ollama.com), LM Studio, llama.cpp's `llama-server`, vLLM, LocalAI, …
2. A code model trained for **fill-in-the-middle** (FIM), preferably a *base* (non-instruct) variant. Chat models are trained to talk, not to continue your code, and give poor completions.

With Ollama:

```sh
ollama pull qwen2.5-coder:1.5b-base
```

Anything from ~1.5B up works; bigger models are better but slower. The default setting is `qwen2.5-coder:1.5b-base`.

## Quick start

Install the extension, start your server, then open the status bar item (bottom right, `✨ Autocomplete`) and pick **Select model…**. That's it — completions appear as ghost text as you type; press `Tab` to accept.

If the server is not on the default port, set `localAutocomplete.provider` and `localAutocomplete.endpoint`:

| Server | provider | endpoint |
| --- | --- | --- |
| Ollama | `ollama` | `http://127.0.0.1:11434` (default) |
| LM Studio | `openai-compatible` | `http://127.0.0.1:1234/v1` (default) |
| llama.cpp `llama-server` | `openai-compatible` | `http://127.0.0.1:8080/v1` |
| vLLM / LocalAI | `openai-compatible` | `http://host:port/v1` |

Leave `endpoint` empty to use the provider's default. A bare origin such as `http://127.0.0.1:1234` gets `/v1` added for you.

## Turning it on and off

Three switches, most specific wins:

1. **Everywhere** — `localAutocomplete.enable`. Off means off: no request is made, whatever the other settings say.
2. **Per language** — `localAutocomplete.disabledLanguages`, e.g. `["markdown", "plaintext"]`.
3. **Per file** — remembered in extension storage, keyed by the file's URI. A notebook cell belongs to its notebook.

The status bar shows which switch decided the current file, and clicking it opens a menu with the three toggles, model selection, settings and the log. The same actions are commands:

| Command | What it does |
| --- | --- |
| `Local Autocomplete: Show Menu` | The status bar menu |
| `Local Autocomplete: Toggle Everywhere` | Flips `localAutocomplete.enable` |
| `Local Autocomplete: Toggle for Current Language` | Adds/removes the language in `disabledLanguages` |
| `Local Autocomplete: Toggle for Current File` | Overrides for this file only |
| `Local Autocomplete: Select Model` | Lists the models on the server and sets `localAutocomplete.model` |
| `Local Autocomplete: Forget All Per-File Settings` | Drops every per-file override |
| `Local Autocomplete: Show Log` | Opens the output channel |

Per-language and everywhere state are settings, so they sync across machines and can be set per workspace. Per-file choices are not.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `enable` | `true` | Master switch |
| `disabledLanguages` | `[]` | [Language identifiers](https://code.visualstudio.com/docs/languages/identifiers) where completions are off |
| `provider` | `ollama` | `ollama` or `openai-compatible` (machine scope) |
| `endpoint` | `""` | Base URL; empty for the provider default (machine scope) |
| `model` | `qwen2.5-coder:1.5b-base` | Name as the server knows it |
| `apiKey` | `""` | Sent as a bearer token, only if your server needs one (machine scope) |
| `fimTemplate` | `auto` | `auto`, `qwen`, `codellama`, `deepseek`, `starcoder`, `codegemma`, `codestral`, `custom` |
| `customFimTemplate` | `<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>` | Used when `fimTemplate` is `custom`; must contain `{prefix}` |
| `stopSequences` | `[]` | Extra sequences that end a completion |
| `multiline` | `auto` | `auto` = multi-line on empty lines and after `{ ( [ :`; `always`; `never` |
| `maxTokens` | `128` | Tokens generated per completion |
| `temperature` | `0.1` | Lower is more predictable |
| `debounceMs` | `200` | Wait after you stop typing before asking the model |
| `maxPrefixChars` | `4000` | Context before the cursor (~3–4 chars per token) |
| `maxSuffixChars` | `1000` | Context after the cursor |

`fimTemplate: auto` recognises the format from the model name. Each family is trained on its own special tokens, and a mismatch gives poor or empty completions — if the log says the format was guessed, set it explicitly.

## How it behaves

- **Works alongside IntelliSense.** While the suggestion list is open, the completion is written as if the selected item had been accepted, so the ghost text fits the code you are about to have.
- **No completion in the middle of a word** — if characters follow the cursor that look like part of an identifier, you are editing a name, not writing code.
- **Multi-line completions stop** when the model's output drops back to a lower indent or repeats the first non-empty line below the cursor.
- **Single-line completions may overwrite the rest of the line** when it appears in order inside the completion, which avoids duplicated auto-closed brackets and quotes.
- **Recent completions are cached** (64 entries) keyed by the text around the cursor: typing the start of a suggestion, or deleting back to where it was made, is answered without asking the model again.
- **The prompt is cut at whole lines** so its start stays put while you type, which lets the server reuse its prompt cache.
- **Requests time out after 30 s** and are cancelled as soon as you keep typing. The first failure of each kind raises one notification (with *Copy Command* for a missing Ollama model, *Open Settings*, *Show Log*); later ones only mark the status bar and the log, so a stopped server does not pop up on every keystroke.
- Completions are offered in normal editors, notebook cells, remote and virtual workspaces — not in output panes, diff views or the commit message box. Untrusted workspaces are supported; nothing is sent anywhere but to the server you configured.

## Development

```sh
npm install
npm run compile          # tsc -> out/
npm run watch
npm test                 # unit tests (node --test)
npm run test:integration # real VS Code via vscode-test
npm run package          # -> local-autocomplete-<version>.vsix
```

The integration test starts a stub Ollama server in-process (`/api/generate` and `/api/tags`), so it needs no local model. To run it against your installed VS Code instead of downloading one:

```sh
VSCODE_EXECUTABLE="/Applications/Visual Studio Code.app/Contents/Code" npm run test:integration
```

`.vscode/` is not committed, so add your own launch config (or run `Extension Development Host`) to try the extension in a second VS Code window.

## License

No license file or `license` field yet, and `package.json` is marked `private: true` — pick one before publishing.
