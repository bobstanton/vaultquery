import { Chart, ChartConfiguration, ChartDataset, registerables, Colors } from 'chart.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDataset = ChartDataset<any, any>;

let isRegistered = false;
function ensureChartRegistration(): void {
  if (isRegistered) return;
  Chart.register(...registerables, Colors);
  isRegistered = true;
}

export type ChartType = 'bar' | 'line' | 'pie' | 'doughnut' | 'scatter';

export interface ChartConfig {
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
  static renderChart(context: ChartContext): void {
    const { results, container, config } = context;
    container.empty();
    ensureChartRegistration();

    const canvas = container.createEl('canvas');
    canvas.addClass('vaultquery-chart-canvas');

    const chartData = this.prepareChartData(results, config);
    const chartConfig = this.createChartConfig(config, chartData);

    try {
      new Chart(canvas, chartConfig);
    }
    catch (error) {
      container.createDiv({
        cls: 'vaultquery-error',
        text: `Chart rendering failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
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
        const seriesName = String(row.series ?? 'Unknown');
        if (!seriesMap.has(seriesName)) {
          seriesMap.set(seriesName, {
            points: [],
            backgroundColor: row.backgroundColor ? String(row.backgroundColor) : undefined,
            borderColor: row.borderColor ? String(row.borderColor) : undefined
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
      chartType?: string;
      backgroundColor?: string;
      borderColor?: string;
    }
    const seriesMap = new Map<string, SeriesData>();

    for (const row of results) {
      const label = String(row.label ?? 'Unknown');
      const series = String(row.series ?? 'Unknown');
      const value = Number(row.value ?? 0);

      labelSet.add(label);

      if (!seriesMap.has(series)) {
        seriesMap.set(series, {
          values: new Map(),
          chartType: row.chartType ? String(row.chartType) : undefined,
          backgroundColor: row.backgroundColor ? String(row.backgroundColor) : undefined,
          borderColor: row.borderColor ? String(row.borderColor) : undefined
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
    const labels = results.map(row => String(row.label ?? 'Unknown'));
    const data = results.map(row => Number(row.value ?? 0));

    const hasBackgroundColor = results.length > 0 && 'backgroundColor' in results[0];
    const hasBorderColor = results.length > 0 && 'borderColor' in results[0];

    const dataset: AnyDataset = {
      label: config.datasetLabel,
      data,
      borderWidth: 1
    };

    if (hasBackgroundColor) {
      dataset.backgroundColor = results.map(row => String(row.backgroundColor ?? ''));
    }
    else if (config.datasetBackgroundColor) {
      dataset.backgroundColor = config.datasetBackgroundColor;
    }

    if (hasBorderColor) {
      dataset.borderColor = results.map(row => String(row.borderColor ?? ''));
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