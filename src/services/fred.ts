export interface FredSeries {
  id: string;
  name: string;
  value: number | null;
  previousValue: number | null;
  change: number | null;
  changePercent: number | null;
  date: string;
  unit: string;
}

interface FredConfig {
  id: string;
  name: string;
  unit: string;
  precision: number;
}

const FRED_SERIES: FredConfig[] = [
  { id: 'WALCL', name: 'Fed Total Assets', unit: '$B', precision: 0 },
  { id: 'FEDFUNDS', name: 'Fed Funds Rate', unit: '%', precision: 2 },
  { id: 'T10Y2Y', name: '10Y-2Y Spread', unit: '%', precision: 2 },
  { id: 'UNRATE', name: 'Unemployment', unit: '%', precision: 1 },
  { id: 'CPIAUCSL', name: 'CPI Index', unit: '', precision: 1 },
  { id: 'DGS10', name: '10Y Treasury', unit: '%', precision: 2 },
  { id: 'VIXCLS', name: 'VIX', unit: '', precision: 2 },
];

const FRED_CSV_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

async function fetchSeriesData(seriesId: string): Promise<{ date: string; value: number }[]> {
  try {
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const url = `${FRED_CSV_BASE}?id=${seriesId}&cosd=${startDate}&coed=${endDate}`;
    const response = await fetch(url);

    if (!response.ok) return [];

    const csv = await response.text();
    const lines = csv.trim().split('\n').slice(1);

    return lines
      .map(line => {
        const parts = line.split(',');
        const date = parts[0];
        const valueStr = parts[1];
        if (!date || !valueStr) return null;
        const value = parseFloat(valueStr);
        if (!isNaN(value)) {
          return { date, value };
        }
        return null;
      })
      .filter((d): d is { date: string; value: number } => d !== null);
  } catch (error) {
    console.error(`Failed to fetch FRED series ${seriesId}:`, error);
    return [];
  }
}

export async function fetchFredData(): Promise<FredSeries[]> {
  const results: FredSeries[] = [];

  for (const config of FRED_SERIES) {
    const data = await fetchSeriesData(config.id);

    if (data.length >= 2) {
      const latest = data[data.length - 1]!;
      const previous = data[data.length - 2]!;
      const change = latest.value - previous.value;
      const changePercent = (change / previous.value) * 100;

      let displayValue = latest.value;
      if (config.id === 'WALCL') {
        displayValue = latest.value / 1000;
      }

      results.push({
        id: config.id,
        name: config.name,
        value: Number(displayValue.toFixed(config.precision)),
        previousValue: Number(previous.value.toFixed(config.precision)),
        change: Number(change.toFixed(config.precision)),
        changePercent: Number(changePercent.toFixed(2)),
        date: latest.date,
        unit: config.unit,
      });
    } else if (data.length === 1) {
      const latest = data[0]!;
      let displayValue = latest.value;
      if (config.id === 'WALCL') {
        displayValue = latest.value / 1000;
      }

      results.push({
        id: config.id,
        name: config.name,
        value: Number(displayValue.toFixed(config.precision)),
        previousValue: null,
        change: null,
        changePercent: null,
        date: latest.date,
        unit: config.unit,
      });
    }
  }

  return results;
}

export function getChangeClass(change: number | null): string {
  if (change === null) return '';
  if (change > 0) return 'positive';
  if (change < 0) return 'negative';
  return '';
}

export function formatChange(change: number | null, unit: string): string {
  if (change === null) return 'N/A';
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change}${unit}`;
}
