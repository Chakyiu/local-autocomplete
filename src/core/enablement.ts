export interface EnablementInputs {
  everywhere: boolean;
  language: boolean;
  /** The user's explicit choice for this file, if any. */
  file: boolean | undefined;
}

export interface Enablement extends EnablementInputs {
  enabled: boolean;
  /** The setting that decided `enabled`. */
  decidedBy: 'everywhere' | 'file' | 'language';
}

/** Switching off everywhere always wins; otherwise the most specific setting decides. */
export function resolveEnablement(inputs: EnablementInputs): Enablement {
  if (!inputs.everywhere) return { ...inputs, enabled: false, decidedBy: 'everywhere' };
  if (inputs.file !== undefined) return { ...inputs, enabled: inputs.file, decidedBy: 'file' };
  return { ...inputs, enabled: inputs.language, decidedBy: 'language' };
}

/** Whether the file is on, ignoring the switch for everywhere. */
export function fileEnabled(inputs: EnablementInputs): boolean {
  return inputs.file ?? inputs.language;
}

/**
 * The file setting to store when the user flips the file: none at all when the new state is what
 * the language setting gives anyway, so the file keeps following its language afterwards.
 */
export function flippedFileSetting(inputs: EnablementInputs): boolean | undefined {
  const next = !fileEnabled(inputs);
  return next === inputs.language ? undefined : next;
}
