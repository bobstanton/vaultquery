import { App, Modal } from 'obsidian';

export class ConfirmationModal extends Modal {
  private message: string;
  private resolvePromise: ((value: boolean) => void) | null = null;
  private resolved = false;

  public constructor(app: App, message: string) {
    super(app);
    this.message = message;
  }

  public onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vaultquery-confirmation-modal');

    contentEl.createEl('p', { text: this.message });

    const buttonContainer = contentEl.createDiv({ cls: 'vaultquery-confirmation-buttons' });

    const confirmButton = buttonContainer.createEl('button', {
      cls: 'mod-cta',
      text: 'Confirm'
    });
    confirmButton.addEventListener('click', () => {
      this.resolve(true);
      this.close();
    });

    const cancelButton = buttonContainer.createEl('button', {
      text: 'Cancel'
    });
    cancelButton.addEventListener('click', () => {
      this.resolve(false);
      this.close();
    });

    confirmButton.focus();
  }

  private resolve(value: boolean) {
    if (!this.resolved && this.resolvePromise) {
      this.resolved = true;
      this.resolvePromise(value);
    }
  }

  public onClose(): void {
    const { contentEl } = this;
    contentEl.empty();

    this.resolve(false);
  }

  public async waitForConfirmation(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}
