import { App, MarkdownRenderer } from 'obsidian';
import type { VaultQueryPluginContext } from '../types/PluginContext';
import * as triggerHelp from '../generated-help/vaultquery-trigger-help.generated';
import { BaseHelpCodeBlockProcessor } from './BaseHelpCodeBlockProcessor';

export class TriggerHelpCodeBlockProcessor extends BaseHelpCodeBlockProcessor {
  public constructor(app: App, plugin: VaultQueryPluginContext) {
    super(app, plugin, 'vaultquery-trigger-help', triggerHelp);
  }

  protected renderDynamicContent(container: HTMLElement, key: string): void {
    if (key === 'triggers') {
      void this.generateTriggersMarkdown().then(markdown => {
        void MarkdownRenderer.render(this.app, markdown, container, '', this.component);
      });
    }
    else {
      super.renderDynamicContent(container, key);
    }
  }

  private async generateTriggersMarkdown(): Promise<string> {
    const triggers = await this.plugin.api?.getAllUserTriggers() ?? [];

    const sections: string[] = [];

    if (triggers.length === 0) {
      sections.push('> No triggers registered. Create a `vaultquery-trigger` code block to define one.\n');
    }
    else {
      sections.push('| Trigger Name | Source File | Status |');
      sections.push('|--------------|-------------|--------|');

      for (const trigger of triggers.sort((a, b) => a.trigger_name.localeCompare(b.trigger_name))) {
        const fileName = trigger.path.split('/').pop() || trigger.path;
        const status = trigger.enabled ? 'Active' : 'Disabled';
        sections.push(`| \`${trigger.trigger_name}\` | ${fileName} | ${status} |`);
      }
      sections.push('');
    }

    return sections.join('\n');
  }
}
