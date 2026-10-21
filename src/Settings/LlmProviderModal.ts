import { App, Modal, Setting } from 'obsidian';
import { CUSTOM_PRESET_URL, findPresetByUrl, getPresetOptions } from './LlmProviderPresets';
import type { LlmProviderConfig } from '../LLM/LlmTypes';

const ENDPOINT_URL_PLACEHOLDER = 'http://localhost:11434/v1';

export class LlmProviderModal extends Modal {
  private draft: LlmProviderConfig;
  private isNew: boolean;
  private onSubmit: (provider: LlmProviderConfig) => void;

  public constructor(app: App, provider: LlmProviderConfig | null, onSubmit: (provider: LlmProviderConfig) => void) {
    super(app);
    this.isNew = provider === null;

    this.draft = provider
      ? { ...provider }
      : { id: crypto.randomUUID(), name: '', url: '' };

    this.onSubmit = onSubmit;
  }

  public onOpen(): void {
    this.titleEl.setText(this.isNew ? 'Add provider' : 'Edit provider');
    this.renderForm();
  }

  public onClose(): void {
    this.contentEl.empty();
  }

  private renderForm(): void {
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl)
      .setName('Name')
      .addText(text => text
        .setPlaceholder('Local model')
        .setValue(this.draft.name)
        .onChange(value => {
          this.draft.name = value;
        }));

    new Setting(contentEl)
      .setName('Preset')
      .addDropdown(dropdown => dropdown
        .addOptions(getPresetOptions())
        .setValue(findPresetByUrl(this.draft.url)?.url ?? CUSTOM_PRESET_URL)
        .onChange(value => {
          this.applyPreset(value);
        }));

    new Setting(contentEl)
      .setName('URL')
      .addText(text => text
        .setPlaceholder(ENDPOINT_URL_PLACEHOLDER)
        .setValue(this.draft.url)
        .onChange(value => {
          this.draft.url = value;
        }));

    new Setting(contentEl)
      .setName('Model')
      .addText(text => text
        .setPlaceholder('qwen2.5-coder:7b')
        .setValue(this.draft.model ?? '')
        .onChange(value => {
          this.draft.model = value;
        }));

    new Setting(contentEl)
      .setName('API key')
      .setDesc('Optional.')
      .addText(text => {
        text.inputEl.type = 'password';

        text
          .setValue(this.draft.apiKey ?? '')
          .onChange(value => {
            this.draft.apiKey = value;
          });
      });

    const errorEl = contentEl.createDiv({ cls: 'mod-warning' });
    errorEl.hide();

    new Setting(contentEl)
      .addButton(button => button
        .setButtonText('Cancel')
        .onClick(() => {
          this.close();
        }))
      .addButton(button => button
        .setButtonText('Save')
        .setCta()
        .onClick(() => {
          const error = this.validate();

          if (error) {
            errorEl.setText(error);
            errorEl.show();

            return;
          }

          this.onSubmit(this.normalizedDraft());
          this.close();
        }));
  }

  private applyPreset(url: string): void {
    const preset = findPresetByUrl(url);

    if (!preset) {
      this.draft.url = CUSTOM_PRESET_URL;
      this.renderForm();

      return;
    }

    this.draft.url = preset.url;
    this.draft.model = preset.model;

    if (!this.draft.name.trim()) {
      this.draft.name = preset.name;
    }

    this.renderForm();
  }

  private validate(): string | null {
    if (!this.draft.name.trim()) return 'Enter a name for this provider.';
    if (!this.draft.url.trim()) return 'Enter a URL for this provider.';
    if (!this.draft.model?.trim()) return 'Enter the model name the server hosts.';

    return null;
  }

  private normalizedDraft(): LlmProviderConfig {
    const provider: LlmProviderConfig = {
      id: this.draft.id,
      name: this.draft.name.trim(),
      url: this.draft.url.trim()
    };

    provider.model = (this.draft.model ?? '').trim();
    const apiKey = (this.draft.apiKey ?? '').trim();
    if (apiKey) provider.apiKey = apiKey;

    return provider;
  }
}
