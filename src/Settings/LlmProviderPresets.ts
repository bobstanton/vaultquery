export interface LlmProviderPreset {
  name: string;
  url: string;
  model?: string;
}

export const CUSTOM_PRESET_URL = '';

const ENDPOINT_PRESETS: LlmProviderPreset[] = [
  {
    name: 'Kilo Free',
    url: 'https://api.kilo.ai/api/gateway/',
    model: 'kilo-auto/free'
  },
  {
    name: 'Ollama',
    url: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:7b'
  }
];

export function findPresetByUrl(url: string): LlmProviderPreset | undefined {
  const trimmed = url.trim();

  return ENDPOINT_PRESETS.find(preset => preset.url === trimmed);
}

export function getPresetOptions(): Record<string, string> {
  const options: Record<string, string> = { [CUSTOM_PRESET_URL]: 'Custom' };

  for (const preset of ENDPOINT_PRESETS) {
    options[preset.url] = preset.name;
  }

  return options;
}
