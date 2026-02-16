import type { NewsItem, ResearchProductHotspot, ResearchProductHotspotItem } from '@/types';
import type { AIPaper, AIPaperFeed } from './ai-papers';
import { inferHubsFromTitle } from './tech-hub-index';

interface RegionAnchor {
  name: string;
  country: string;
  lat: number;
  lon: number;
}

interface ResolvedOrigin {
  id: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  confidence: number;
  locationHint?: string;
}

interface HotspotAccumulator {
  id: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  paperCount: number;
  productCount: number;
  paperScore: number;
  productScore: number;
  seenItemKeys: Set<string>;
  items: ResearchProductHotspotItem[];
}

const COUNTRY_REGION_ANCHORS: Record<string, RegionAnchor[]> = {
  US: [
    { name: 'San Francisco Bay', country: 'USA', lat: 37.7749, lon: -122.4194 },
    { name: 'Seattle', country: 'USA', lat: 47.6062, lon: -122.3321 },
    { name: 'Boston', country: 'USA', lat: 42.3601, lon: -71.0589 },
    { name: 'New York', country: 'USA', lat: 40.7128, lon: -74.006 },
    { name: 'Austin', country: 'USA', lat: 30.2672, lon: -97.7431 },
  ],
  CN: [
    { name: 'Beijing', country: 'China', lat: 39.9042, lon: 116.4074 },
    { name: 'Shenzhen', country: 'China', lat: 22.5431, lon: 114.0579 },
    { name: 'Shanghai', country: 'China', lat: 31.2304, lon: 121.4737 },
    { name: 'Hangzhou', country: 'China', lat: 30.2741, lon: 120.1551 },
  ],
  IN: [
    { name: 'Bengaluru', country: 'India', lat: 12.9716, lon: 77.5946 },
    { name: 'Hyderabad', country: 'India', lat: 17.385, lon: 78.4867 },
    { name: 'Mumbai', country: 'India', lat: 19.076, lon: 72.8777 },
    { name: 'Delhi NCR', country: 'India', lat: 28.6139, lon: 77.209 },
  ],
  JP: [
    { name: 'Tokyo', country: 'Japan', lat: 35.6762, lon: 139.6503 },
    { name: 'Osaka', country: 'Japan', lat: 34.6937, lon: 135.5023 },
  ],
  KR: [
    { name: 'Seoul', country: 'South Korea', lat: 37.5665, lon: 126.978 },
    { name: 'Daejeon', country: 'South Korea', lat: 36.3504, lon: 127.3845 },
  ],
  GB: [
    { name: 'London', country: 'United Kingdom', lat: 51.5074, lon: -0.1278 },
    { name: 'Cambridge', country: 'United Kingdom', lat: 52.2053, lon: 0.1218 },
  ],
  DE: [
    { name: 'Berlin', country: 'Germany', lat: 52.52, lon: 13.405 },
    { name: 'Munich', country: 'Germany', lat: 48.1351, lon: 11.582 },
  ],
  FR: [
    { name: 'Paris', country: 'France', lat: 48.8566, lon: 2.3522 },
    { name: 'Grenoble', country: 'France', lat: 45.1885, lon: 5.7245 },
  ],
  CA: [
    { name: 'Toronto', country: 'Canada', lat: 43.6532, lon: -79.3832 },
    { name: 'Montreal', country: 'Canada', lat: 45.5017, lon: -73.5673 },
    { name: 'Vancouver', country: 'Canada', lat: 49.2827, lon: -123.1207 },
  ],
  IL: [
    { name: 'Tel Aviv', country: 'Israel', lat: 32.0853, lon: 34.7818 },
    { name: 'Jerusalem', country: 'Israel', lat: 31.7683, lon: 35.2137 },
  ],
  SG: [{ name: 'Singapore', country: 'Singapore', lat: 1.3521, lon: 103.8198 }],
  TW: [{ name: 'Taipei', country: 'Taiwan', lat: 25.033, lon: 121.5654 }],
  CH: [{ name: 'Zurich', country: 'Switzerland', lat: 47.3769, lon: 8.5417 }],
  NL: [{ name: 'Amsterdam', country: 'Netherlands', lat: 52.3676, lon: 4.9041 }],
  AU: [
    { name: 'Sydney', country: 'Australia', lat: -33.8688, lon: 151.2093 },
    { name: 'Melbourne', country: 'Australia', lat: -37.8136, lon: 144.9631 },
  ],
};

const PRODUCT_SOURCES = ['product hunt', 'github', 'show hn', 'yc launches', 'hacker news'];

const PRODUCT_KEYWORDS = [
  'launch',
  'launched',
  'launches',
  'released',
  'release',
  'unveiled',
  'unveils',
  'announced',
  'announces',
  'debut',
  'debuts',
  'open-source',
  'open sourced',
  'ships',
  'shipping',
  'roll out',
  'rollout',
  'beta',
  'agent',
  'assistant',
  'api',
  'sdk',
  'model',
  'platform',
  'framework',
  'copilot',
  'startup',
  'product',
];

function stableHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pickCountryAnchor(countryCode: string, seed: string): RegionAnchor | null {
  const anchors = COUNTRY_REGION_ANCHORS[countryCode];
  if (!anchors || anchors.length === 0) return null;
  if (anchors.length === 1) return anchors[0] || null;
  const idx = stableHash(seed) % anchors.length;
  return anchors[idx] || anchors[0] || null;
}

function isLikelyProductNews(item: NewsItem): boolean {
  const sourceLower = item.source.toLowerCase();
  if (PRODUCT_SOURCES.some((source) => sourceLower.includes(source))) return true;

  const titleLower = item.title.toLowerCase();
  return PRODUCT_KEYWORDS.some((keyword) => titleLower.includes(keyword));
}

function toIsoDateString(input: Date | string): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function upsertHotspot(
  map: Map<string, HotspotAccumulator>,
  origin: ResolvedOrigin,
): HotspotAccumulator {
  const key = origin.id;
  const existing = map.get(key);
  if (existing) return existing;

  const created: HotspotAccumulator = {
    id: key,
    name: origin.name,
    country: origin.country,
    lat: origin.lat,
    lon: origin.lon,
    paperCount: 0,
    productCount: 0,
    paperScore: 0,
    productScore: 0,
    seenItemKeys: new Set(),
    items: [],
  };
  map.set(key, created);
  return created;
}

function addItem(acc: HotspotAccumulator, item: ResearchProductHotspotItem): void {
  const dedupeKey = `${item.type}|${item.link}|${item.title}`;
  if (acc.seenItemKeys.has(dedupeKey)) return;
  acc.seenItemKeys.add(dedupeKey);
  acc.items.push(item);
}

function resolvePaperOrigin(paper: AIPaper): ResolvedOrigin | null {
  const context = `${paper.institution || ''} ${paper.title}`.trim();
  const hubMatch = inferHubsFromTitle(context).find((match) => match.confidence >= 0.55);
  if (hubMatch) {
    return {
      id: `hub:${hubMatch.hub.id}`,
      name: hubMatch.hub.name,
      country: hubMatch.hub.country,
      lat: hubMatch.hub.lat,
      lon: hubMatch.hub.lon,
      confidence: hubMatch.confidence,
      locationHint: paper.institution || undefined,
    };
  }

  const countryCode = (paper.institutionCountry || '').toUpperCase();
  if (countryCode) {
    const seed = `${paper.id}:${paper.institution || paper.title}`;
    const anchor = pickCountryAnchor(countryCode, seed);
    if (anchor) {
      return {
        id: `country:${countryCode}:${anchor.name}`,
        name: anchor.name,
        country: anchor.country,
        lat: anchor.lat,
        lon: anchor.lon,
        confidence: 0.6,
        locationHint: paper.institution || countryCode,
      };
    }
  }

  if (typeof paper.lat === 'number' && typeof paper.lon === 'number') {
    return {
      id: `coord:${paper.lat.toFixed(2)}:${paper.lon.toFixed(2)}`,
      name: paper.institution || (paper.institutionCountry ? `Research Hub (${paper.institutionCountry})` : 'Research Hub'),
      country: paper.institutionCountry || 'Unknown',
      lat: paper.lat,
      lon: paper.lon,
      confidence: 0.45,
      locationHint: paper.institution || undefined,
    };
  }

  return null;
}

function resolveProductOrigin(item: NewsItem): ResolvedOrigin | null {
  const matches = inferHubsFromTitle(`${item.title} ${item.source}`);
  const top = matches.find((match) => match.confidence >= 0.55);
  if (!top) return null;

  return {
    id: `hub:${top.hub.id}`,
    name: top.hub.name,
    country: top.hub.country,
    lat: top.hub.lat,
    lon: top.hub.lon,
    confidence: top.confidence,
    locationHint: top.matchedKeyword,
  };
}

export function buildResearchProductHotspots(
  papersFeed: AIPaperFeed | null,
  allNews: NewsItem[],
  options: { maxHotspots?: number; maxItemsPerHotspot?: number } = {},
): ResearchProductHotspot[] {
  const maxHotspots = options.maxHotspots ?? 28;
  const maxItemsPerHotspot = options.maxItemsPerHotspot ?? 10;
  const accumulators = new Map<string, HotspotAccumulator>();

  const papers = papersFeed?.papers ?? [];
  for (const paper of papers) {
    const origin = resolvePaperOrigin(paper);
    if (!origin) continue;

    const hotspot = upsertHotspot(accumulators, origin);
    hotspot.paperCount += 1;
    hotspot.paperScore += Math.max(0.8, paper.trustScore / 75);

    addItem(hotspot, {
      id: paper.id,
      type: 'paper',
      title: paper.title,
      source: paper.venue,
      link: paper.link || paper.pdfLink || '#',
      publishedAt: toIsoDateString(paper.publishedAt),
      confidence: origin.confidence,
      locationHint: origin.locationHint,
    });
  }

  const productNewsWindowMs = 21 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const item of allNews) {
    if (!isLikelyProductNews(item)) continue;
    if (now - item.pubDate.getTime() > productNewsWindowMs) continue;

    const origin = resolveProductOrigin(item);
    if (!origin) continue;

    const hotspot = upsertHotspot(accumulators, origin);
    hotspot.productCount += 1;
    hotspot.productScore += item.isAlert ? 1.8 : 1;

    addItem(hotspot, {
      id: `${stableHash(`${item.source}|${item.title}|${item.link}`)}`,
      type: 'product',
      title: item.title,
      source: item.source,
      link: item.link,
      publishedAt: toIsoDateString(item.pubDate),
      confidence: origin.confidence,
      locationHint: origin.locationHint,
    });
  }

  const hotspots = Array.from(accumulators.values())
    .map((acc) => {
      const activityScore = Number((acc.paperScore * 1.25 + acc.productScore).toFixed(2));
      const items = acc.items
        .sort((a, b) => {
          const dateA = new Date(a.publishedAt).getTime();
          const dateB = new Date(b.publishedAt).getTime();
          if (dateA !== dateB) return dateB - dateA;
          return b.confidence - a.confidence;
        })
        .slice(0, maxItemsPerHotspot);

      return {
        id: acc.id,
        name: acc.name,
        country: acc.country,
        lat: acc.lat,
        lon: acc.lon,
        paperCount: acc.paperCount,
        productCount: acc.productCount,
        activityScore,
        intensity: 0,
        items,
      } satisfies ResearchProductHotspot;
    })
    .filter((hotspot) => hotspot.paperCount + hotspot.productCount > 0)
    .sort((a, b) => {
      if (b.activityScore !== a.activityScore) return b.activityScore - a.activityScore;
      return (b.paperCount + b.productCount) - (a.paperCount + a.productCount);
    })
    .slice(0, maxHotspots);

  const maxScore = Math.max(1, ...hotspots.map((hotspot) => hotspot.activityScore));
  return hotspots.map((hotspot) => ({
    ...hotspot,
    intensity: Number((hotspot.activityScore / maxScore).toFixed(3)),
  }));
}
