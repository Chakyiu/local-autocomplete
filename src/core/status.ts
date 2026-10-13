import type { Enablement } from './enablement';

export interface StatusInput {
  everywhere: boolean;
  /** The active editor's file; undefined when no supported editor is active. */
  file?: { name: string; languageName: string; enablement: Enablement };
  busy: boolean;
  /** Message of the last failed request, cleared by the next successful one. */
  error?: string;
  model: string;
  server: string;
}

export interface StatusView {
  text: string;
  /** One-line summary, also used as the menu's placeholder. */
  summary: string;
  tooltip: string;
  warning: boolean;
}

export function describeStatus(input: StatusInput): StatusView {
  const disabled = disabledSummary(input);
  let icon: string;
  let summary: string;
  if (disabled) {
    icon = 'circle-slash';
    summary = disabled;
  } else if (input.busy) {
    icon = 'loading~spin';
    summary = 'Generating a completion…';
  } else if (input.error) {
    icon = 'warning';
    summary = 'The last request failed';
  } else {
    icon = 'sparkle';
    summary = input.file ? `Enabled for ${input.file.name}` : 'Enabled';
  }

  const tooltip = [`Local Autocomplete: ${summary}`, `Model: ${input.model} on ${input.server}`];
  if (input.error && !disabled) tooltip.push(`Last error: ${input.error}`);
  tooltip.push('Click for options');

  return {
    text: `$(${icon}) Autocomplete`,
    summary,
    tooltip: tooltip.join('\n'),
    warning: !disabled && !input.busy && input.error !== undefined,
  };
}

function disabledSummary(input: StatusInput): string | undefined {
  if (!input.everywhere) return 'Disabled everywhere';
  const file = input.file;
  if (!file || file.enablement.enabled) return undefined;
  return file.enablement.decidedBy === 'file' ? `Disabled for ${file.name}` : `Disabled for ${file.languageName} files`;
}
