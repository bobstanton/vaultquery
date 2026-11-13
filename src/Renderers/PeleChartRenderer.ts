import { Component, MarkdownRenderer, requireApiVersion } from 'obsidian';
import type { ChartConfig } from './ChartRenderer';
import type { RenderContext } from './BaseRenderer';
import { INFO_MESSAGES } from '../utils/ErrorMessages';
import { formatUnknownValue } from '../utils/ResultFormatUtils';

const renderedCharts = new Map<HTMLElement, { component: Component; source: string }>();

function unsupported(message: string): never {
  throw new Error(`${message} Remove renderer: pele to use Chart.js.`);
}

function singleLine(value: string): string {
  return Array.from(value, char => {
    const code = char.codePointAt(0)!;

    return code < 32 || code === 127 || code === 0x2028 || code === 0x2029 ? ' ' : char;
  }).join('');
}

function quoted(value: string): string {
  const escaped = singleLine(value).replace(/[&<>"#%`\\]/g, char => `#${char.codePointAt(0)!};`);

  return `"${escaped}"`;
}

function numeric(value: unknown): number {
  if (value instanceof Uint8Array) throw new Error('Binary values cannot be used as chart numbers.');
  const number = Number(value ?? 0);

  if (!Number.isFinite(number)) throw new Error('Pele charts require finite numeric values.');

  return number;
}

function decimal(value: number): string {
  const written = String(value);
  const [mantissa, exponent] = written.split('e');

  if (exponent === undefined) return written;
  const sign = value < 0 ? '-' : '';
  const [whole, fraction = ''] = mantissa.replace('-', '').split('.');
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);

  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);

  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export class PeleChartRenderer {
  static cleanupContainer(container: HTMLElement): void {
    for (const [host, { component }] of renderedCharts) {
      if (host !== container && !container.contains(host)) continue;
      renderedCharts.delete(host);
      component.unload();
    }
  }

  static cleanup(): void {
    for (const container of renderedCharts.keys()) this.cleanupContainer(container);
  }

  static getSource(container: HTMLElement): string | undefined {
    return renderedCharts.get(container)?.source;
  }

  static createSource(results: Record<string, unknown>[], config: ChartConfig): string {
    if (!config.type) throw new Error('Chart type required. Add type: bar, line, pie, or doughnut.');
    if (config.type === 'scatter') unsupported('Pele does not support scatter charts.');

    if (config.datasetBackgroundColor !== undefined || config.datasetBorderColor !== undefined ||
        results.some(row => 'backgroundColor' in row || 'borderColor' in row)) {
      unsupported('Pele charts use the native theme palette; custom color options and columns are unsupported.');
    }

    if (results.some(row => !('label' in row) || !('value' in row))) {
      throw new Error('Pele charts require label and value columns.');
    }

    const circular = config.type === 'pie' || config.type === 'doughnut';
    const hasSeries = results.some(row => 'series' in row);
    const labels: string[] = [];
    const labelSet = new Set<string>();
    const series = new Map<string, { type: 'bar' | 'line'; values: Map<string, number> }>();
    const slices: string[] = [];
    const singleValues: number[] = [];
    const pieSeries = new Set<string>();

    if (circular && (config.xLabel !== undefined || config.yLabel !== undefined || config.datasetLabel !== undefined)) {
      unsupported('Pele pie and doughnut charts do not support axis labels or datasetLabel.');
    }

    for (const row of results) {
      const label = singleLine(formatUnknownValue(row.label) || 'Unknown');
      const value = numeric(row.value);
      const name = singleLine(hasSeries ? formatUnknownValue(row.series) || 'Unknown' : config.datasetLabel ?? '');

      if (hasSeries && !('series' in row)) throw new Error('Every chart row must include a series column.');

      if (circular) {
        if (value < 0) throw new Error('Pele pie and doughnut charts require non-negative values.');
        if (labelSet.has(label)) unsupported('Pele pie and doughnut charts require unique labels.');
        if ('chartType' in row) unsupported('Pele pie and doughnut charts do not support per-series chartType.');
        pieSeries.add(name);
        if (pieSeries.size > 1) unsupported('Pele pie and doughnut charts support a single dataset.');
        slices.push(`  ${quoted(label)} : ${decimal(value)}`);
      }
      else {
        if ('chartType' in row && !hasSeries) unsupported('Pele mixed charts require a series column.');
        const type = row.chartType === undefined || row.chartType === null
          ? config.type : typeof row.chartType === 'string' ? row.chartType.toLowerCase() : undefined;

        if (type !== 'bar' && type !== 'line') unsupported('Pele mixed charts support only bar and line series.');
        if (!series.has(name)) series.set(name, { type, values: new Map() });
        const dataset = series.get(name)!;

        if (dataset.type !== type) throw new Error('Each Pele series must have a consistent chartType.');
        dataset.values.set(label, value);
        singleValues.push(value);
      }

      if (!hasSeries || !labelSet.has(label)) labels.push(label);
      labelSet.add(label);
    }

    const lines: string[] = [];

    if (config.type === 'doughnut') lines.push('---', 'config:', '  pie:', '    donutHole: 0.5', '---');
    lines.push(circular ? 'pie' : 'xychart');

    if (config.title) {
      const title = quoted(config.title);

      lines.push(`  title ${circular ? title.slice(1, -1) : title}`);
    }

    if (circular) lines.push(...slices);
    else {
      lines.push(`  x-axis ${config.xLabel ? quoted(config.xLabel) + ' ' : ''}[${labels.map(quoted).join(', ')}]`);
      if (config.yLabel) lines.push(`  y-axis ${quoted(config.yLabel)}`);

      for (const [name, dataset] of series) {
        const values = hasSeries
          ? labels.map(label => decimal(dataset.values.get(label) ?? 0)) : singleValues.map(decimal);

        lines.push(`  ${dataset.type}${name ? ' ' + quoted(name) : ''} [${values.join(', ')}]`);
      }
    }

    return lines.join('\n');
  }

  static async render(context: RenderContext, config: ChartConfig): Promise<boolean> {
    const { container } = context;

    this.cleanupContainer(container);
    container.empty();

    if (!requireApiVersion('1.15.0')) {
      unsupported('Pele chart output requires Obsidian 1.15 or later.');
    }

    if (!context.results.length) {
      container.createDiv({ cls: 'vaultquery-empty', text: INFO_MESSAGES.NO_RESULTS });

      return true;
    }

    const source = this.createSource(context.results, config);
    const component = new Component();

    component.load();
    renderedCharts.set(container, { component, source });
    const drawing = container.createDiv({ cls: 'vaultquery-pele-chart' });

    try {
      await (context.MarkdownRenderer ?? MarkdownRenderer).render(
        context.app, '```mermaid\n' + source + '\n```', drawing, context.sourcePath ?? '', component
      );

      return renderedCharts.get(container)?.component === component;
    }
    catch (error) {
      if (renderedCharts.get(container)?.component !== component) return false;
      this.cleanupContainer(container);

      throw error;
    }
  }
}
