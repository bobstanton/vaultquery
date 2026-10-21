import { MarkdownRenderChild } from 'obsidian';
import type { LlmProviderConfig, SqlGenerationProgress } from '../LLM/LlmTypes';

const PHASE_LABELS: Record<SqlGenerationProgress['phase'], string> = {
  'preparing-prompt': 'Preparing request...',
  'waiting-for-model': 'Waiting for model...',
  'validating-query': 'Checking generated query...',
  'executing-query': 'Running query...',
  'previewing-write': 'Preparing change preview...',
  'validating-results': 'Checking results...',
};

export class LlmProgressIndicator extends MarkdownRenderChild {
  private readonly statusEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly elapsedEl: HTMLElement;
  private readonly timerWindow: Window;
  private readonly startedAt: number;
  private stageStartedAt: number;
  private timer: number | null = null;
  private stopped = false;
  private waitingForModel = false;

  public constructor(container: HTMLElement, private readonly provider: LlmProviderConfig, private readonly isCurrent: () => boolean) {
    super(container.createDiv({ cls: 'vaultquery-loading vaultquery-nl-progress' }));
    this.timerWindow = container.ownerDocument.defaultView ?? window;
    this.startedAt = this.timerWindow.performance.now();
    this.stageStartedAt = this.startedAt;

    const text = this.containerEl.createDiv({ cls: 'vaultquery-loading-text' });
    this.statusEl = text.createDiv({ attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
    this.detailEl = text.createDiv({ cls: 'vaultquery-nl-progress-detail' });
    this.elapsedEl = text.createDiv({ cls: 'vaultquery-nl-progress-elapsed', attr: { 'aria-live': 'off' } });
    this.containerEl.createDiv({ cls: 'vaultquery-loading-spinner', attr: { 'aria-hidden': 'true' } });
    this.setStage('Waiting for vault database...');
  }

  public onload(): void {
    if (this.stopped) return;
    this.timer = this.timerWindow.setInterval(() => this.tick(), 1000);
  }

  public onunload(): void {
    this.remove();
  }

  public setStage(label: string, detail = ''): void {
    if (this.stopped || !this.isCurrent()) return;
    this.waitingForModel = false;
    this.stageStartedAt = this.timerWindow.performance.now();
    this.statusEl.textContent = label;
    this.detailEl.textContent = detail;
    this.updateElapsed();
  }

  public setProgress(progress: SqlGenerationProgress): void {
    const { phase, attempt, maxAttempts } = progress;
    const retry = attempt > 1;

    const label = phase === 'waiting-for-model'
      ? `${retry ? 'Waiting for a correction from' : 'Waiting for'} ${this.provider.name}...`
      : PHASE_LABELS[phase];

    const detail = [
      this.provider.model?.trim(),
      `Attempt ${attempt} of ${maxAttempts}`,
      retry ? 'The previous query needs a correction.' : '',
    ].filter(Boolean).join('; ');

    this.setStage(label, detail);
    this.waitingForModel = phase === 'waiting-for-model';
  }

  public remove(): void {
    this.stopped = true;

    if (this.timer !== null) {
      this.timerWindow.clearInterval(this.timer);
      this.timer = null;
    }

    this.containerEl.remove();
  }

  private tick(): void {
    if (!this.containerEl.isConnected || !this.isCurrent()) {
      this.remove();

      return;
    }

    this.updateElapsed();
  }

  private updateElapsed(): void {
    const now = this.timerWindow.performance.now();
    const seconds = Math.max(0, Math.floor((now - this.startedAt) / 1000));
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

    const waiting = this.waitingForModel && now - this.stageStartedAt >= 15000
      ? '; Waiting for provider response'
      : '';

    this.elapsedEl.textContent = `${elapsed} elapsed${waiting}`;
  }
}
