import { API_URLS } from '@/config';
import type { NewsItem } from '@/types';
import {
  HttpStatusError,
  createCircuitBreaker,
  isRetryableFetchError,
  withExponentialBackoff,
} from '@/utils';
import { findTopAIOrgByText } from './top-ai-orgs';

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
    const data = await withExponentialBackoff(async () => {
      const response = await fetch(API_URLS.aiPapers(limit));
      if (!response.ok) throw new HttpStatusError(response.status);
      return response.json();
    }, {
      maxAttempts: 3,
      initialDelayMs: 500,
      factor: 2,
      maxDelayMs: 5000,
      jitterRatio: 0.2,
      shouldRetry: (error) => isRetryableFetchError(error),
      onRetry: ({ failedAttempt, maxAttempts, delayMs, error }) => {
        console.warn(
          `[AI Papers] fetch attempt ${failedAttempt}/${maxAttempts} failed; retrying in ${delayMs}ms`,
          error
        );
      },
    });
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
    const inferredOrg = findTopAIOrgByText(
      [paper.institution, paper.institutionCountry, paper.title, paper.venue]
        .filter(Boolean)
        .join(' ')
    );
    const lat = paper.lat ?? inferredOrg?.lat ?? undefined;
    const lon = paper.lon ?? inferredOrg?.lon ?? undefined;

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
      lat,
      lon,
      locationName:
        paper.institution || inferredOrg?.name || paper.institutionCountry || undefined,
    };
  });
}

export function getAIPapersStatus(): string {
  return breaker.getStatus();
}
