# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Generate Commit Message.** A sparkle button in the Source Control title bar (and on the
  `COMMIT_EDITMSG` editor, the status bar menu, and the Command Palette) drafts a message from the
  staged diff, or from the working tree when nothing is staged, and writes it into the commit box.
  Set `localAutocomplete.commitMessageModel` to an instruct model; the request uses the server's
  chat endpoint. `localAutocomplete.commitMessageMaxDiffChars` caps how much of the diff is sent.

## [0.3.0] - 2026-10-14

### Added

- **`localAutocomplete.provider: openai-chat`** for servers that only implement
  `/v1/chat/completions` and answer `/v1/completions` with `404: not found`. The prompt goes in as
  one user message, a markdown fence around the reply is stripped, and `reasoning_content` is
  ignored — with a clear error when a reasoning model spends the whole reply on thinking.

## [0.1.0] - 2026-10-13

Initial release: inline ghost-text completions from a model server on your own machine.

### Added

- **Backends** for Ollama (`/api/generate`, `/api/tags`) and any OpenAI-compatible completion
  endpoint (`/completions`) — Ollama, LM Studio, llama.cpp `llama-server`, vLLM, LocalAI.
- **Fill-in-the-middle prompts** for Qwen Coder, Code Llama, DeepSeek Coder, StarCoder,
  CodeGemma and Codestral, detected from the model name, plus a `customFimTemplate` escape hatch.
- **Streaming** (`localAutocomplete.stream`, on by default): the reply is read as it arrives and the
  request is closed as soon as the completion is clearly finished, so the ghost text appears sooner.
- **Context-window handling**: Ollama silently truncates a prompt that exceeds its `num_ctx`, so the
  extension asks for a bigger window when it needs one (`localAutocomplete.maxContextTokens`) and
  explains a context-overflow error instead of showing a bad completion.
- **Enablement controls**: a master switch, per-language opt-outs, and per-file overrides, all
  reachable from the status bar menu; per-file state is dropped when the file is deleted or renamed.
- **`localAutocomplete.timeoutMs`** (was hard-coded to 30 s), **`keepAlive`** to pin an Ollama model in
  RAM, and **`localAutocomplete.showStatusBar`** (`always` / `iconOnly` / `hidden`).
- **API key in the OS keychain** via VS Code Secret Storage, with `Set API Key` / `Remove API key`
  commands; the old plaintext `localAutocomplete.apiKey` setting is deprecated and migrated once.
- **Language-scoped settings** (`language-overridable` on `multiline`, `maxTokens`, `temperature`,
  `debounceMs`, `maxPrefixChars`, `maxSuffixChars`) and toggles that respect folder-level settings.
- Status bar item, output channel log, one notification per new kind of failure, 64-entry completion
  cache, and unit + integration test suites that need no local model.
- CI (compile + unit tests on Linux/macOS/Windows, integration tests under Xvfb) and a release
  workflow that attaches the `.vsix` to a tag.

[0.1.0]: https://github.com/ChakyiuLI/local-autocomplete/releases/tag/v0.1.0
