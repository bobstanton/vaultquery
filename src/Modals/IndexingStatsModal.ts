import { App, Modal } from 'obsidian';
import type { IndexingStats } from '../types';

export class IndexingStatsModal extends Modal {
    private stats: IndexingStats | null;

    public constructor(app: App, stats: IndexingStats | null) {
        super(app);
        this.stats = stats;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'Indexing statistics' });

        if (!this.stats) {
            contentEl.createEl('p', { 
                text: 'No performance data available. Performance statistics are collected during indexing operations.',
                cls: 'setting-item-description'
            });
            return;
        }

        const generalSection = contentEl.createDiv('performance-stats-section');
        generalSection.createEl('h3', { text: 'Overview' });
        
        const overviewContainer = generalSection.createDiv('performance-stats-grid');
        
        this.createStatItem(overviewContainer, 'Last Indexed', new Date(this.stats.timestamp).toLocaleString());
        this.createStatItem(overviewContainer, 'Total Files', this.stats.totalFiles.toString());
        this.createStatItem(overviewContainer, 'Total Time', `${this.stats.totalTime.toFixed(2)}ms`);
        this.createStatItem(overviewContainer, 'Average Time per File', `${this.stats.avgTimePerFile.toFixed(2)}ms`);
        this.createStatItem(overviewContainer, 'Files per Second', `${this.stats.filesPerSecond.toFixed(1)}`);

        if (this.stats.slowFiles.length > 0) {
            const slowFilesSection = contentEl.createDiv('performance-stats-section');
            slowFilesSection.createEl('h3', { text: `Slowest files (${this.stats.slowFiles.length})` });
            slowFilesSection.createEl('p', { 
                text: 'Files that took longer than normal to process during indexing.',
                cls: 'setting-item-description'
            });
            
            const slowFilesTable = slowFilesSection.createEl('table', { cls: 'performance-stats-table' });
            const headerRow = slowFilesTable.createEl('tr');
            headerRow.createEl('th', { text: 'File' });
            headerRow.createEl('th', { text: 'Size (kb)' });
            headerRow.createEl('th', { text: 'Time (ms)' });
            headerRow.createEl('th', { text: 'Details' });

            const sortedSlowFiles = [...this.stats.slowFiles].sort((a, b) => b.processingTime - a.processingTime);
            
            sortedSlowFiles.forEach((file, index) => {
                const row = slowFilesTable.createEl('tr');
                
                const pathCell = row.createEl('td');
                const pathLink = pathCell.createEl('a', { 
                    text: file.path,
                    cls: 'internal-link'
                });
                pathLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    void this.app.workspace.openLinkText(file.path, '');
                });
                
                row.createEl('td', { text: `${(file.size / 1024).toFixed(1)}` });
                
                const timeCell = row.createEl('td', { text: file.processingTime.toFixed(0) });
                if (file.processingTime > 100) {
                    timeCell.addClass('vaultquery-stats-time-error');
                }
                else if (file.processingTime > 50) {
                    timeCell.addClass('vaultquery-stats-time-warning');
                }
                
                row.createEl('td', { text: file.details });
                
                if (index < 3) {
                    row.addClass('vaultquery-stats-row-highlight');
                }
            });
        }
        else {
            const slowFilesSection = contentEl.createDiv('performance-stats-section');
            slowFilesSection.createEl('h3', { text: 'Performance status' });
            slowFilesSection.createEl('p', {
                text: '✅ No slow files detected! All files processed efficiently.',
                cls: 'setting-item-description'
            });
        }


    }

    private createStatItem(container: HTMLElement, label: string, value: string) {
        const item = container.createDiv('performance-stat-item');
        item.createDiv('performance-stat-label').textContent = label;
        item.createDiv('performance-stat-value').textContent = value;
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}