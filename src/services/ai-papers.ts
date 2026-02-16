import { API_URLS } from '@/config';
import type { NewsItem } from '@/types';
import { createCircuitBreaker } from '@/utils';

export interface AIPaper {
  id: string;
  title: string;
  abstract: string;
  summary: string;
  authors: string[];
  venue: string;
  source: 'openreview' | 'arxiv' | 'alphaxiv';
  sourceType: 'accepted' | 'preprint';
  trustScore: number;
  acceptedLabel: string;
  publishedAt: string;
  link: string;
  pdfLink?: string | null;
  institution?: string | null;
  institutionCountry?: string | null;
  lat?: number | null;
  lon?: number | null;
}

export interface AIPaperActivityPoint {
  id: string;
  name: string;
  country: string | null;
  lat: number;
  lon: number;
  paperCount: number;
  weightedScore: number;
  intensity: number;
  topVenues: string[];
}

export interface AIPaperFeed {
  generatedAt: string;
  trustedCount: number;
  preprintCount: number;
  papers: AIPaper[];
  activityPoints: AIPaperActivityPoint[];
  cached: boolean;
}

const breaker = createCircuitBreaker<AIPaperFeed>({ name: 'AI Papers Feed' });

export async function fetchAIPapers(limit = 36): Promise<AIPaperFeed> {
  return breaker.execute(async () => {
    const response = await fetch(API_URLS.aiPapers(limit));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const papers = Array.isArray(data?.papers) ? data.papers : [];
    const activityPoints = Array.isArray(data?.activityPoints) ? data.activityPoints : [];

    return {
      generatedAt: typeof data?.generatedAt === 'string' ? data.generatedAt : new Date().toISOString(),
      trustedCount: Number(data?.trustedCount) || 0,
      preprintCount: Number(data?.preprintCount) || 0,
      papers,
      activityPoints,
      cached: !!data?.cached,
    };
  }, {
    generatedAt: new Date(0).toISOString(),
    trustedCount: 0,
    preprintCount: 0,
    papers: [],
    activityPoints: [],
    cached: false,
  });
}

function buildMetadata(paper: AIPaper): string {
  const parts: string[] = [];
  parts.push(paper.sourceType === 'accepted' ? 'Accepted' : 'Preprint');
  parts.push(`Trust ${Math.round(paper.trustScore)}`);
  if (paper.institution) parts.push(paper.institution);
  if (paper.institutionCountry) parts.push(paper.institutionCountry);
  return parts.join(' · ');
}

export function mapAIPapersToNewsItems(papers: AIPaper[]): NewsItem[] {
  return papers.map((paper) => {
    const publishedDate = new Date(paper.publishedAt);
    return {
      source: paper.venue,
      title: paper.title,
      link: paper.link || paper.pdfLink || '#',
      pubDate: Number.isNaN(publishedDate.getTime()) ? new Date() : publishedDate,
      isAlert: paper.sourceType === 'accepted' && paper.trustScore >= 97,
      summary: paper.summary,
      metadata: buildMetadata(paper),
      trustScore: paper.trustScore,
      accepted: paper.sourceType === 'accepted',
      lat: paper.lat ?? undefined,
      lon: paper.lon ?? undefined,
      locationName: paper.institution || paper.institutionCountry || undefined,
    };
  });
}

export function getAIPapersStatus(): string {
  return breaker.getStatus();
}
