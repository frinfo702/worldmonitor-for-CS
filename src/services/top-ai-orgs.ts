export interface TopAIOrgMarker {
  id: string;
  name: string;
  kind: 'company' | 'university';
  lat: number;
  lon: number;
  city: string;
  country: string;
  domain: string;
  shortLabel: string;
  aliases: string[];
}

export const TOP_AI_ORG_MARKERS: TopAIOrgMarker[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'company',
    lat: 37.7562,
    lon: -122.4193,
    city: 'San Francisco',
    country: 'United States',
    domain: 'openai.com',
    shortLabel: 'OpenAI',
    aliases: ['openai', 'chatgpt', 'gpt-4', 'gpt-4.1', 'gpt-5'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'company',
    lat: 37.7937,
    lon: -122.3965,
    city: 'San Francisco',
    country: 'United States',
    domain: 'anthropic.com',
    shortLabel: 'Anthropic',
    aliases: ['anthropic', 'claude', 'claude ai', 'constitutional ai'],
  },
  {
    id: 'google-deepmind',
    name: 'Google DeepMind',
    kind: 'company',
    lat: 51.531,
    lon: -0.1247,
    city: 'London',
    country: 'United Kingdom',
    domain: 'deepmind.google',
    shortLabel: 'DeepMind',
    aliases: ['google deepmind', 'deepmind', 'gemini', 'google ai'],
  },
  {
    id: 'google',
    name: 'Google',
    kind: 'company',
    lat: 37.422,
    lon: -122.0841,
    city: 'Mountain View',
    country: 'United States',
    domain: 'google.com',
    shortLabel: 'Google',
    aliases: ['google', 'alphabet', 'google cloud'],
  },
  {
    id: 'meta-ai',
    name: 'Meta AI',
    kind: 'company',
    lat: 37.4848,
    lon: -122.1482,
    city: 'Menlo Park',
    country: 'United States',
    domain: 'ai.meta.com',
    shortLabel: 'Meta AI',
    aliases: ['meta ai', 'meta', 'fair', 'llama', 'facebook ai'],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA',
    kind: 'company',
    lat: 37.3708,
    lon: -121.9646,
    city: 'Santa Clara',
    country: 'United States',
    domain: 'nvidia.com',
    shortLabel: 'NVIDIA',
    aliases: ['nvidia', 'blackwell', 'h100', 'gb200', 'cuda'],
  },
  {
    id: 'stanford-hai',
    name: 'Stanford HAI',
    kind: 'university',
    lat: 37.4275,
    lon: -122.1697,
    city: 'Stanford',
    country: 'United States',
    domain: 'stanford.edu',
    shortLabel: 'Stanford HAI',
    aliases: ['stanford hai', 'stanford ai', 'stanford university'],
  },
  {
    id: 'mit-csail',
    name: 'MIT CSAIL',
    kind: 'university',
    lat: 42.3601,
    lon: -71.0942,
    city: 'Cambridge',
    country: 'United States',
    domain: 'mit.edu',
    shortLabel: 'MIT CSAIL',
    aliases: ['mit csail', 'mit ai', 'massachusetts institute of technology'],
  },
  {
    id: 'berkeley-bair',
    name: 'UC Berkeley BAIR',
    kind: 'university',
    lat: 37.8719,
    lon: -122.2585,
    city: 'Berkeley',
    country: 'United States',
    domain: 'berkeley.edu',
    shortLabel: 'Berkeley BAIR',
    aliases: ['berkeley ai', 'bair', 'uc berkeley', 'berkeley'],
  },
  {
    id: 'cmu-ml',
    name: 'CMU ML',
    kind: 'university',
    lat: 40.4433,
    lon: -79.9436,
    city: 'Pittsburgh',
    country: 'United States',
    domain: 'cmu.edu',
    shortLabel: 'CMU ML',
    aliases: ['cmu ml', 'carnegie mellon', 'cmu ai'],
  },
  {
    id: 'oxford-ai',
    name: 'Oxford AI',
    kind: 'university',
    lat: 51.7548,
    lon: -1.2544,
    city: 'Oxford',
    country: 'United Kingdom',
    domain: 'ox.ac.uk',
    shortLabel: 'Oxford AI',
    aliases: ['oxford ai', 'university of oxford ai', 'oxford machine learning'],
  },
  {
    id: 'eth-zurich-ai',
    name: 'ETH Zurich AI',
    kind: 'university',
    lat: 47.3769,
    lon: 8.5417,
    city: 'Zurich',
    country: 'Switzerland',
    domain: 'ethz.ch',
    shortLabel: 'ETH Zurich AI',
    aliases: ['eth zurich ai', 'eth ai', 'ethz ai', 'eth zurich'],
  },
];

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\w\s.-]/g, ' ');
}

export function getTopAIOrgLogoUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(domain)}`;
}

export function findTopAIOrgByText(text: string): TopAIOrgMarker | null {
  const normalized = normalizeText(text);
  if (!normalized.trim()) return null;

  let best: { org: TopAIOrgMarker; score: number } | null = null;

  for (const org of TOP_AI_ORG_MARKERS) {
    for (const alias of org.aliases) {
      if (!normalized.includes(alias)) continue;
      const score =
        alias.length +
        (alias === org.name.toLowerCase() ? 4 : 0) +
        (org.kind === 'company' ? 2 : 0);
      if (!best || score > best.score) {
        best = { org, score };
      }
    }
  }

  return best?.org ?? null;
}
