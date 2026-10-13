export type FimTemplateId = 'qwen' | 'codellama' | 'deepseek' | 'starcoder' | 'codegemma' | 'codestral';

export type FimTemplateSetting = FimTemplateId | 'auto' | 'custom';

export interface FimFormat {
  /** Prompt with `{prefix}` and `{suffix}` placeholders. */
  template: string;
  /** End-of-text and control tokens that terminate a completion. */
  stop: string[];
}

export const FIM_FORMATS: Readonly<Record<FimTemplateId, FimFormat>> = {
  qwen: {
    template: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
    stop: [
      '<|endoftext|>',
      '<|fim_prefix|>',
      '<|fim_suffix|>',
      '<|fim_middle|>',
      '<|fim_pad|>',
      '<|file_sep|>',
      '<|repo_name|>',
      '<|im_start|>',
      '<|im_end|>',
    ],
  },
  codellama: {
    template: '<PRE> {prefix} <SUF>{suffix} <MID>',
    stop: ['<EOT>', '<PRE>', '<SUF>', '<MID>'],
  },
  deepseek: {
    template: '<｜fim▁begin｜>{prefix}<｜fim▁hole｜>{suffix}<｜fim▁end｜>',
    stop: ['<｜end▁of▁sentence｜>', '<｜fim▁begin｜>', '<｜fim▁hole｜>', '<｜fim▁end｜>', '<|EOT|>'],
  },
  starcoder: {
    template: '<fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>',
    stop: ['<|endoftext|>', '<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<file_sep>'],
  },
  codegemma: {
    template: '<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>',
    stop: ['<|file_separator|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<eos>'],
  },
  codestral: {
    template: '[SUFFIX]{suffix}[PREFIX]{prefix}',
    stop: ['</s>', '[PREFIX]', '[SUFFIX]', '[MIDDLE]'],
  },
};

export function detectFimTemplate(model: string): FimTemplateId | undefined {
  const name = model.toLowerCase();
  if (name.includes('codegemma')) return 'codegemma';
  if (name.includes('qwen')) return 'qwen';
  if (name.includes('codellama') || name.includes('code-llama')) return 'codellama';
  if (name.includes('deepseek')) return 'deepseek';
  if (name.includes('codestral')) return 'codestral';
  if (/starcoder|santacoder|stable-?code|granite/.test(name)) return 'starcoder';
  return undefined;
}

export interface ResolvedFimFormat {
  id: FimTemplateId | 'custom';
  format: FimFormat;
  /** True when `auto` did not recognize the model and fell back to the Qwen format. */
  guessed: boolean;
}

export function resolveFimFormat(setting: FimTemplateSetting, model: string, customTemplate: string): ResolvedFimFormat {
  if (setting === 'custom') return { id: 'custom', format: { template: customTemplate, stop: [] }, guessed: false };
  if (setting !== 'auto') return { id: setting, format: FIM_FORMATS[setting], guessed: false };
  const detected = detectFimTemplate(model);
  return detected
    ? { id: detected, format: FIM_FORMATS[detected], guessed: false }
    : { id: 'qwen', format: FIM_FORMATS.qwen, guessed: true };
}

export function renderFimPrompt(template: string, prefix: string, suffix: string): string {
  // One pass with a replacer function: code that itself contains "{suffix}" or "$&" must come through verbatim.
  return template.replace(/\{(prefix|suffix)\}/g, (_match, name: string) => (name === 'prefix' ? prefix : suffix));
}
