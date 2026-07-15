import { Chart, ChartConfiguration, ChartDataset, registerables, Colors } from 'chart.js';
import type { BubbleDataPoint, ChartTypeRegistry, Point } from 'chart.js';
import { BaseRenderer } from './BaseRenderer';
import { getErrorMessage } from '../utils/ErrorMessages';
import { formatUnknownValue } from '../utils/ResultFormatUtils';

type ChartDataPoint = number | Point | [number, number] | BubbleDataPoint | null;
type AnyDataset = ChartDataset<keyof ChartTypeRegistry, ChartDataPoint[]>;

let isRegistered = false;
function ensureChartRegistration(): void {
  if (isRegistered) return;
  Chart.register(...registerables, Colors);
  isRegistered = true;
}

const CHART_TYPES = ['bar', 'line', 'pie', 'doughnut', 'scatter'] as const;
type ChartType = (typeof CHART_TYPES)[number];

interface ChartConfig {
  type: ChartType;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  datasetLabel?: string;
  datasetBackgroundColor?: string;
  datasetBorderColor?: string;
}

export interface ChartContext {
  results: Record<string, unknown>[];
  container: HTMLElement;
  config: ChartConfig;
}

export class ChartRenderer {
  private static instances = new WeakMap<HTMLElement, Chart>();

  static parseConfig(options?: Record<string, unknown>): ChartConfig {
    const config: Partial<ChartConfig> = {};

    const type = this.parseChartType(options?.type);
    if (type) {
      config.type = type;
    }

    if (typeof options?.title === 'string') config.title = options.title;
    if (typeof options?.xlabel === 'string') config.xLabel = options.xlabel;
    if (typeof options?.ylabel === 'string') config.yLabel = options.ylabel;
    if (typeof options?.datasetlabel === 'string') config.datasetLabel = options.datasetlabel;
    if (typeof options?.datasetbackgroundcolor === 'string') config.datasetBackgroundColor = options.datasetbackgroundcolor;
    if (typeof options?.datasetbordercolor === 'string') config.datasetBorderColor = options.datasetbordercolor;

    return config as ChartConfig;
  }

  static renderChart(context: ChartContext): void {
    const { results, container, config } = context;

    const existingChart = this.instances.get(container);
    if (existingChart) {
      existingChart.destroy();
      this.instances.delete(container);
    }

    container.empty();
    ensureChartRegistration();

    if (!results.length) {
      container.createDiv({
        cls: 'vaultquery-empty',
        text: 'No results to display'
      });
      return;
    }

    this.validateResults(results, config);

    const canvas = container.createEl('canvas');
    canvas.addClass('vaultquery-chart-canvas');

    const chartData = this.prepareChartData(results, config);
    const chartConfig = this.createChartConfig(config, chartData);

    try {
      const chart = new Chart(canvas, chartConfig);
      this.instances.set(container, chart);
    }
    catch (error) {
      BaseRenderer.renderError(container, {
        title: 'Chart Error',
        message: `Chart rendering failed: ${getErrorMessage(error)}`
      });
    }
  }

  private static validateResults(results: Record<string, unknown>[], config: Partial<ChartConfig>): asserts config is ChartConfig {
    if (!config.type) {
      throw new Error('Chart type required. Add config: with type: bar, line, pie, doughnut, or scatter.');
    }

    const firstRow = results[0];
    if (config.type === 'scatter') {
      if (!('x' in firstRow) || !('y' in firstRow)) {
        throw new Error('Scatter charts require x and y columns.');
      }
      return;
    }

    if (!('label' in firstRow) || !('value' in firstRow)) {
      throw new Error('Charts require label and value columns (or x and y for scatter).');
    }
  }

  private static prepareChartData(results: Record<string, unknown>[], config: ChartConfig): ChartConfiguration['data'] {
    if (config.type === 'scatter') {
      return this.prepareScatterData(results, config);
    }

    const hasSeries = results.length > 0 && 'series' in results[0];

    if (hasSeries) {
      return this.prepareMultiSeriesData(results, config);
    }

    return this.prepareSingleSeriesData(results, config);
  }

  private static parseChartType(value: unknown): ChartType | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const chartType = value.toLowerCase();
    return (CHART_TYPES as readonly string[]).includes(chartType)
      ? chartType as ChartType
      : undefined;
  }

  private static prepareScatterData(results: Record<string, unknown>[], config: ChartConfig): ChartConfiguration['data'] {
    const hasSeries = results.length > 0 && 'series' in results[0];

    if (hasSeries) {
      interface SeriesData {
        points: { x: number; y: number }[];
        backgroundColor?: string;
        borderColor?: string;
      }
      const seriesMap = new Map<string, SeriesData>();

      for (const row of results) {
        const seriesName = formatUnknownValue(row.series) || 'Unknown';
        if (!seriesMap.has(seriesName)) {
          seriesMap.set(seriesName, {
            points: [],
            backgroundColor: formatUnknownValue(row.backgroundColor) || undefined,
            borderColor: formatUnknownValue(row.borderColor) || undefined
          });
        }
        seriesMap.get(seriesName)!.points.push({
          x: Number(row.x ?? 0),
          y: Number(row.y ?? 0)
        });
      }

      return {
        datasets: Array.from(seriesMap.entries()).map(([seriesName, seriesData]) => {
          const dataset: AnyDataset = {
            label: seriesName,
            data: seriesData.points
          };
          if (seriesData.backgroundColor) {
            dataset.backgroundColor = seriesData.backgroundColor;
          }
          if (seriesData.borderColor) {
            dataset.borderColor = seriesData.borderColor;
          }
          return dataset;
        })
      };
    }

    const dataset: AnyDataset = {
      label: config.datasetLabel,
      data: results.map(row => ({
        x: Number(row.x ?? 0),
        y: Number(row.y ?? 0)
      }))
    };

    if (config.datasetBackgroundColor) {
      dataset.backgroundColor = config.datasetBackgroundColor;
    }
    if (config.datasetBorderColor) {
      dataset.borderColor = config.datasetBorderColor;
    }

    return {
      datasets: [dataset]
    };
  }

  private static prepareMultiSeriesData(results: Record<string, unknown>[], _config: ChartConfig): ChartConfiguration['data'] {
    const labelSet = new Set<string>();

    interface SeriesData {
      values: Map<string, number>;
      chartType?: ChartType;
      backgroundColor?: string;
      borderColor?: string;
    }
    const seriesMap = new Map<string, SeriesData>();

    for (const row of results) {
      const label = formatUnknownValue(row.label) || 'Unknown';
      const series = formatUnknownValue(row.series) || 'Unknown';
      const value = Number(row.value ?? 0);

      labelSet.add(label);

      if (!seriesMap.has(series)) {
        seriesMap.set(series, {
          values: new Map(),
          chartType: this.parseChartType(row.chartType),
          backgroundColor: formatUnknownValue(row.backgroundColor) || undefined,
          borderColor: formatUnknownValue(row.borderColor) || undefined
        });
      }
      seriesMap.get(series)!.values.set(label, value);
    }

    const labels = Array.from(labelSet);

    const datasets: AnyDataset[] = Array.from(seriesMap.entries()).map(([seriesName, seriesData]) => {
      const dataset: AnyDataset = {
        label: seriesName,
        data: labels.map(label => seriesData.values.get(label) ?? 0),
        borderWidth: 1
      };

      if (seriesData.chartType) {
        dataset.type = seriesData.chartType;
      }

      if (seriesData.backgroundColor) {
        dataset.backgroundColor = seriesData.backgroundColor;
      }
      if (seriesData.borderColor) {
        dataset.borderColor = seriesData.borderColor;
      }

      return dataset;
    });

    return { labels, datasets };
  }

  private static prepareSingleSeriesData(results: Record<string, unknown>[], config: ChartConfig): ChartConfiguration['data'] {
    const labels = results.map(row => formatUnknownValue(row.label) || 'Unknown');
    const data = results.map(row => Number(row.value ?? 0));

    const hasBackgroundColor = results.length > 0 && 'backgroundColor' in results[0];
    const hasBorderColor = results.length > 0 && 'borderColor' in results[0];

    const dataset: AnyDataset = {
      label: config.datasetLabel,
      data,
      borderWidth: 1
    };

    if (hasBackgroundColor) {
      dataset.backgroundColor = results.map(row => formatUnknownValue(row.backgroundColor));
    }
    else if (config.datasetBackgroundColor) {
      dataset.backgroundColor = config.datasetBackgroundColor;
    }

    if (hasBorderColor) {
      dataset.borderColor = results.map(row => formatUnknownValue(row.borderColor));
    }
    else if (config.datasetBorderColor) {
      dataset.borderColor = config.datasetBorderColor;
    }

    return {
      labels,
      datasets: [dataset]
    };
  }

  private static createChartConfig(config: ChartConfig, chartData: ChartConfiguration['data']): ChartConfiguration {
    const needsAxisLabels = ['bar', 'line', 'scatter'].includes(config.type);

    const datasets = chartData.datasets ?? [];
    const isMultiSeries = datasets.length > 1;
    const hasExplicitLabel = !!config.datasetLabel;
    const isPieOrDoughnut = config.type === 'pie' || config.type === 'doughnut';
    const showLegend = isMultiSeries || hasExplicitLabel || isPieOrDoughnut;

    const hasCustomColors = datasets.some(ds =>
      'backgroundColor' in ds || 'borderColor' in ds
    ) || config.datasetBackgroundColor || config.datasetBorderColor;

    const isMixedChart = datasets.some(ds => 'type' in ds && ds.type !== config.type);

    return {
      type: config.type,
      data: chartData,
      options: {
        responsive: true,
        maintainAspectRatio: true,
        ...(isMixedChart && {
          interaction: {
            mode: 'index',
            intersect: false
          }
        }),
        plugins: {
          title: {
            display: !!config.title,
            text: config.title
          },
          legend: {
            display: showLegend
          },
          colors: {
            enabled: !hasCustomColors,
            forceOverride: false
          },
          tooltip: {
            filter: (tooltipItem) => {
              return tooltipItem.raw !== null && tooltipItem.raw !== undefined;
            }
          }
        },
        ...(needsAxisLabels && (config.xLabel || config.yLabel) && {
          scales: {
            x: { title: { display: !!config.xLabel, text: config.xLabel } },
            y: { title: { display: !!config.yLabel, text: config.yLabel } }
          }
        })
      }
    };
  }
}
