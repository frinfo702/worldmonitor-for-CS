import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { getCachedJson, setCachedJson, hashString } from './_upstash-cache.js';

export const config = { runtime: 'edge' };

const OPENREVIEW_BASE = 'https://api2.openreview.net';
const ARXIV_BASE = 'https://export.arxiv.org/api/query';
const ALPHAXIV_BASE = 'https://api.alphaxiv.org';

const CACHE_TTL_SECONDS = 20 * 60; // 20 minutes
const SUMMARY_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const CACHE_VERSION = 'v2';

const DEFAULT_LIMIT = 36;
const MAX_LIMIT = 80;

const ARXIV_CATEGORIES = ['cs.AI', 'cs.LG', 'cs.CL', 'cs.CV'];
const ALPHAXIV_FEED_VARIANTS = [
  { sort: 'Hot', source: null, trustBase: 62, venue: 'alphaXiv Hot' },
  { sort: 'Likes', source: null, trustBase: 60, venue: 'alphaXiv Likes' },
  { sort: 'Hot', source: 'GitHub', trustBase: 64, venue: 'alphaXiv GitHub' },
  { sort: 'Hot', source: 'Twitter (X)', trustBase: 61, venue: 'alphaXiv X' },
];

const TRUSTED_TRACKS = [
  { venue: 'NeurIPS', venuePrefix: 'NeurIPS.cc', trust: 100 },
  { venue: 'ICLR', venuePrefix: 'ICLR.cc', trust: 97 },
  { venue: 'ICML', venuePrefix: 'ICML.cc', trust: 96 },
];

const COUNTRY_CENTROIDS = {
  US: { lat: 39.8, lon: -98.6 },
  GB: { lat: 55.4, lon: -3.4 },
  DE: { lat: 51.2, lon: 10.4 },
  FR: { lat: 46.2, lon: 2.2 },
  CH: { lat: 46.8, lon: 8.2 },
  NL: { lat: 52.1, lon: 5.3 },
  BE: { lat: 50.5, lon: 4.5 },
  ES: { lat: 40.2, lon: -3.7 },
  IT: { lat: 41.9, lon: 12.5 },
  SE: { lat: 60.1, lon: 18.6 },
  NO: { lat: 60.5, lon: 8.5 },
  DK: { lat: 56.0, lon: 10.0 },
  FI: { lat: 64.5, lon: 26.0 },
  IE: { lat: 53.1, lon: -8.2 },
  AT: { lat: 47.5, lon: 14.6 },
  PL: { lat: 52.2, lon: 19.1 },
  CZ: { lat: 49.8, lon: 15.5 },
  PT: { lat: 39.5, lon: -8.0 },
  GR: { lat: 39.1, lon: 22.9 },
  TR: { lat: 39.0, lon: 35.2 },
  CA: { lat: 56.1, lon: -106.3 },
  AU: { lat: -25.3, lon: 133.8 },
  NZ: { lat: -41.5, lon: 172.5 },
  JP: { lat: 36.2, lon: 138.2 },
  KR: { lat: 35.9, lon: 127.8 },
  CN: { lat: 35.9, lon: 104.2 },
  TW: { lat: 23.7, lon: 121.0 },
  SG: { lat: 1.35, lon: 103.82 },
  HK: { lat: 22.32, lon: 114.17 },
  IN: { lat: 20.6, lon: 78.9 },
  IL: { lat: 31.0, lon: 35.0 },
  AE: { lat: 24.3, lon: 54.3 },
  SA: { lat: 23.8, lon: 45.1 },
  BR: { lat: -14.2, lon: -51.9 },
  MX: { lat: 23.6, lon: -102.6 },
  AR: { lat: -38.4, lon: -63.6 },
  CL: { lat: -35.7, lon: -71.5 },
  CO: { lat: 4.6, lon: -74.1 },
  ZA: { lat: -30.6, lon: 22.9 },
  NG: { lat: 9.1, lon: 8.7 },
};

function readStringField(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.value === 'string') return value.value;
  return '';
}

function readStringArrayField(value) {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string');
  if (value && typeof value === 'object' && Array.isArray(value.value)) {
    return value.value.filter(v => typeof v === 'string');
  }
  return [];
}

function normalizeWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(title) {
  return normalizeWhitespace(title).toLowerCase();
}

function toIsoDate(value) {
  if (!value) return new Date().toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}

function sentenceTrim(text, maxSentences = 2) {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) return '';
  const chunks = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, maxSentences);
  return normalizeWhitespace(chunks.join(' '));
}

function fallbackSummary(paper) {
  const anchor = paper.venue ? `${paper.venue}: ` : '';
  if (paper.tldr) {
    return `${anchor}${sentenceTrim(paper.tldr, 2)}`;
  }
  if (paper.abstract) {
    const summary = sentenceTrim(paper.abstract, 2);
    if (summary) return `${anchor}${summary}`;
  }
  return `${anchor}${paper.title}`;
}

function parseLimit(raw) {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(10, Math.min(MAX_LIMIT, parsed));
}

function parseNumeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toAlphaXivTrustScore(baseTrust, paper) {
  const likes = parseNumeric(paper?.metrics?.public_total_votes) + parseNumeric(paper?.metrics?.total_votes);
  const stars = parseNumeric(paper?.github_stars);
  const bonus = Math.min(8, Math.log10(1 + likes + stars) * 3);
  return Math.max(50, Math.min(72, Math.round(baseTrust + bonus)));
}

function parseArxivIdentifier(value) {
  if (!value) return null;
  const normalized = normalizeWhitespace(String(value));
  const match = normalized.match(/\d{4}\.\d{4,5}(?:v\d+)?/);
  return match ? match[0] : null;
}

function toArxivPdfLink(universalPaperId, canonicalId) {
  const raw = parseArxivIdentifier(universalPaperId) || parseArxivIdentifier(canonicalId);
  if (!raw) return null;
  const withoutVersion = raw.replace(/v\d+$/, '');
  return `https://arxiv.org/pdf/${withoutVersion}.pdf`;
}

function parseAlphaXivPapers(payload, variant) {
  const papers = [];
  const entries = Array.isArray(payload?.papers) ? payload.papers : [];

  for (const entry of entries) {
    const title = normalizeWhitespace(entry?.title || '');
    const abstract = normalizeWhitespace(entry?.abstract || '');
    if (!title || !abstract) continue;

    const universalPaperId = normalizeWhitespace(entry?.universal_paper_id || '');
    const canonicalId = normalizeWhitespace(entry?.canonical_id || '');
    const firstOrg = Array.isArray(entry?.organization_info) ? entry.organization_info[0] : null;
    const firstOrgName = normalizeWhitespace(firstOrg?.name || '');
    const authors = Array.isArray(entry?.full_authors)
      ? entry.full_authors.map((author) => normalizeWhitespace(author?.full_name || '')).filter(Boolean)
      : [];
    const fallbackAuthors = Array.isArray(entry?.authors)
      ? entry.authors.map((author) => normalizeWhitespace(author || '')).filter(Boolean)
      : [];
    const summary = normalizeWhitespace(entry?.paper_summary?.summary || '');
    const linkId = universalPaperId || canonicalId || normalizeWhitespace(entry?.id || '');
    if (!linkId) continue;

    papers.push({
      id: `alphaxiv:${linkId}`,
      title,
      abstract,
      tldr: summary,
      authors: authors.length > 0 ? authors : fallbackAuthors,
      authorIds: [],
      firstAuthorId: null,
      venue: variant.venue,
      acceptedLabel: 'trending',
      source: 'alphaxiv',
      sourceType: 'preprint',
      trustScore: toAlphaXivTrustScore(variant.trustBase, entry),
      publishedAt: toIsoDate(entry?.publication_date || entry?.first_publication_date || entry?.updated_at),
      link: `https://www.alphaxiv.org/abs/${encodeURIComponent(linkId)}`,
      pdfLink: toArxivPdfLink(universalPaperId, canonicalId),
      citations: parseNumeric(entry?.metrics?.public_total_votes) || null,
      institution: firstOrgName || null,
      institutionCountry: null,
      lat: null,
      lon: null,
    });
  }

  return papers;
}

async function fetchAlphaXivVariant(variant, pageSize) {
  const url = new URL(`${ALPHAXIV_BASE}/papers/v3/feed`);
  url.searchParams.set('pageNum', '0');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('sort', variant.sort);
  url.searchParams.set('interval', '90 Days');
  if (variant.source) url.searchParams.set('source', variant.source);

  try {
    const payload = await fetchJson(url.toString(), 15000);
    return parseAlphaXivPapers(payload, variant);
  } catch (error) {
    const suffix = variant.source ? ` (${variant.source})` : '';
    console.warn(`[ai-papers] alphaXiv fetch failed for ${variant.sort}${suffix}:`, error?.message || error);
    return [];
  }
}

async function fetchAlphaXivPapers(limitTotal) {
  const pageSize = Math.max(6, Math.ceil(limitTotal / ALPHAXIV_FEED_VARIANTS.length));
  const settled = await Promise.allSettled(
    ALPHAXIV_FEED_VARIANTS.map((variant) => fetchAlphaXivVariant(variant, pageSize))
  );

  const papers = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') papers.push(...result.value);
  }

  const deduped = [];
  const seen = new Set();
  for (const paper of papers) {
    const key = normalizeTitle(paper.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(paper);
  }

  deduped.sort((a, b) => {
    if (b.trustScore !== a.trustScore) return b.trustScore - a.trustScore;
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });

  return deduped.slice(0, limitTotal);
}

function buildVenueIds(venuePrefix) {
  const nowYear = new Date().getUTCFullYear();
  return [nowYear, nowYear - 1, nowYear - 2].map((year) => `${venuePrefix}/${year}/Conference`);
}

async function fetchJson(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'WorldMonitor/1.0 (AI Papers)',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchText(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'WorldMonitor/1.0 (AI Papers)',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.text();
}

function venueAcceptedLabel(rawVenue) {
  const lower = normalizeWhitespace(rawVenue).toLowerCase();
  if (lower.includes('spotlight')) return 'spotlight';
  if (lower.includes('oral')) return 'oral';
  if (lower.includes('poster')) return 'poster';
  return 'accepted';
}

async function fetchOpenReviewTrack(track, limitPerTrack) {
  const results = [];

  for (const venueId of buildVenueIds(track.venuePrefix)) {
    if (results.length >= limitPerTrack) break;

    const url = new URL(`${OPENREVIEW_BASE}/notes`);
    url.searchParams.set('content.venueid', venueId);
    url.searchParams.set('limit', String(Math.min(100, limitPerTrack * 2)));

    try {
      const payload = await fetchJson(url.toString(), 15000);
      const notes = Array.isArray(payload?.notes) ? payload.notes : [];
      for (const note of notes) {
        const content = note?.content || {};
        const title = normalizeWhitespace(readStringField(content.title));
        const abstract = normalizeWhitespace(readStringField(content.abstract));
        if (!title || !abstract) continue;

        const rawVenue = normalizeWhitespace(readStringField(content.venue));
        if (rawVenue && rawVenue.toLowerCase().includes('withdrawn')) continue;

        const authors = readStringArrayField(content.authors);
        const authorIds = readStringArrayField(content.authorids);
        const firstAuthorId = authorIds[0] || null;

        const pdate = note?.pdate || note?.cdate || note?.tmdate;
        const publishedAt = toIsoDate(pdate || Date.now());

        const paperId = note?.forum || note?.id || `${track.venue}:${hashString(title)}`;
        const paperUrl = typeof note?.id === 'string' ? `https://openreview.net/forum?id=${encodeURIComponent(note.id)}` : '';
        const pdfPath = readStringField(content.pdf);
        const pdfUrl = pdfPath
          ? (pdfPath.startsWith('http') ? pdfPath : `https://openreview.net${pdfPath}`)
          : null;

        results.push({
          id: `or:${paperId}`,
          title,
          abstract,
          tldr: normalizeWhitespace(readStringField(content.TLDR)),
          authors,
          authorIds,
          firstAuthorId,
          venue: track.venue,
          acceptedLabel: venueAcceptedLabel(rawVenue),
          source: 'openreview',
          sourceType: 'accepted',
          trustScore: track.trust,
          publishedAt,
          link: paperUrl,
          pdfLink: pdfUrl,
          citations: null,
        });
      }
    } catch (error) {
      console.warn(`[ai-papers] OpenReview fetch failed for ${venueId}:`, error?.message || error);
    }
  }

  results.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return results.slice(0, limitPerTrack);
}

async function fetchOpenReviewPapers(limitTotal) {
  const perTrack = Math.max(8, Math.ceil(limitTotal / TRUSTED_TRACKS.length));
  const settled = await Promise.allSettled(TRUSTED_TRACKS.map(track => fetchOpenReviewTrack(track, perTrack)));

  const papers = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') papers.push(...result.value);
  }

  return papers;
}

function parseArxivXml(xmlText, category) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'text/xml');
  const entries = xml.querySelectorAll('entry');

  const papers = [];
  entries.forEach((entry) => {
    const idRaw = normalizeWhitespace(entry.querySelector('id')?.textContent || '');
    const title = normalizeWhitespace(entry.querySelector('title')?.textContent || '');
    const summary = normalizeWhitespace(entry.querySelector('summary')?.textContent || '');
    if (!idRaw || !title) return;

    const authors = [];
    entry.querySelectorAll('author name').forEach((author) => {
      const name = normalizeWhitespace(author.textContent || '');
      if (name) authors.push(name);
    });

    const published = normalizeWhitespace(entry.querySelector('published')?.textContent || '');
    let link = idRaw;
    let pdfLink = idRaw.replace('/abs/', '/pdf/') + '.pdf';

    entry.querySelectorAll('link').forEach((node) => {
      const href = node.getAttribute('href');
      const rel = node.getAttribute('rel');
      const titleAttr = node.getAttribute('title');
      if (!href) return;
      if (rel === 'alternate') link = href;
      if (titleAttr === 'pdf') pdfLink = href;
    });

    papers.push({
      id: `arxiv:${idRaw.split('/').pop() || hashString(idRaw)}`,
      title,
      abstract: summary,
      tldr: '',
      authors,
      authorIds: [],
      firstAuthorId: null,
      venue: `arXiv ${category}`,
      acceptedLabel: 'preprint',
      source: 'arxiv',
      sourceType: 'preprint',
      trustScore: 45,
      publishedAt: toIsoDate(published),
      link,
      pdfLink,
      citations: null,
    });
  });

  return papers;
}

async function fetchArxivCategory(category, maxResults = 12) {
  const query = `cat:${category}`;
  const url = `${ARXIV_BASE}?search_query=${encodeURIComponent(query)}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;
  const xml = await fetchText(url, 15000);
  return parseArxivXml(xml, category);
}

async function fetchArxivPapers(limitTotal) {
  const perCategory = Math.max(6, Math.ceil(limitTotal / ARXIV_CATEGORIES.length));
  const settled = await Promise.allSettled(ARXIV_CATEGORIES.map(cat => fetchArxivCategory(cat, perCategory)));
  const papers = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') papers.push(...result.value);
  }
  papers.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return papers.slice(0, limitTotal);
}

function parseInstitution(historyEntry) {
  const institution = historyEntry?.institution;
  if (!institution || typeof institution !== 'object') return null;
  const name = normalizeWhitespace(institution.name || '');
  const country = normalizeWhitespace(institution.country || '');
  if (!name && !country) return null;
  return {
    name,
    country: country.toUpperCase(),
  };
}

function pickInstitutionFromProfile(profile) {
  const history = Array.isArray(profile?.content?.history) ? profile.content.history : [];
  const withInstitution = history
    .map((entry) => {
      const institution = parseInstitution(entry);
      if (!institution) return null;
      return {
        institution,
        start: Number(entry?.start) || 0,
        end: Number(entry?.end) || 9999,
      };
    })
    .filter(Boolean);

  if (withInstitution.length === 0) return null;

  withInstitution.sort((a, b) => {
    if (a.end !== b.end) return b.end - a.end;
    return b.start - a.start;
  });

  return withInstitution[0]?.institution || null;
}

async function fetchProfilesByIds(ids) {
  if (!ids.length) return new Map();
  const profileMap = new Map();

  const chunkSize = 25;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const url = new URL(`${OPENREVIEW_BASE}/profiles`);
    url.searchParams.set('ids', chunk.join(','));

    try {
      const payload = await fetchJson(url.toString(), 15000);
      const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
      for (const profile of profiles) {
        const id = typeof profile?.id === 'string' ? profile.id : null;
        if (!id) continue;
        const inst = pickInstitutionFromProfile(profile);
        if (inst) profileMap.set(id, inst);
      }
    } catch (error) {
      console.warn('[ai-papers] OpenReview profile fetch failed:', error?.message || error);
    }
  }

  return profileMap;
}

function getPaperSummaryCacheKey(paper) {
  const seed = `${paper.id}|${paper.venue}|${paper.title}|${paper.abstract?.slice(0, 800) || ''}`;
  return `paper-summary:${CACHE_VERSION}:${hashString(seed)}`;
}

async function summarizeWithGroq(paper, apiKey) {
  if (!apiKey || !paper?.abstract) return null;
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'You summarize AI papers into short news briefs. Keep it factual and concise.',
        },
        {
          role: 'user',
          content: `Venue: ${paper.venue}\nTitle: ${paper.title}\nAbstract: ${paper.abstract}\n\nWrite exactly 2 short sentences:\n1) what is proposed/found\n2) why it matters`,
        },
      ],
      temperature: 0.2,
      max_tokens: 120,
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!response.ok) return null;
  const data = await response.json();
  return normalizeWhitespace(data?.choices?.[0]?.message?.content || '');
}

async function summarizeWithOpenRouter(paper, apiKey) {
  if (!apiKey || !paper?.abstract) return null;
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://worldmonitor.app',
      'X-Title': 'WorldMonitor AI Papers',
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      messages: [
        {
          role: 'system',
          content: 'You summarize AI papers into short news briefs. Keep it factual and concise.',
        },
        {
          role: 'user',
          content: `Venue: ${paper.venue}\nTitle: ${paper.title}\nAbstract: ${paper.abstract}\n\nWrite exactly 2 short sentences:\n1) what is proposed/found\n2) why it matters`,
        },
      ],
      temperature: 0.2,
      max_tokens: 120,
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!response.ok) return null;
  const data = await response.json();
  return normalizeWhitespace(data?.choices?.[0]?.message?.content || '');
}

async function enrichSummaries(papers, llmCount) {
  const groqKey = process.env.GROQ_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const canUseLlm = Boolean(groqKey || openRouterKey);

  const tasks = papers.map(async (paper, index) => {
    const fallback = fallbackSummary(paper);
    const cacheKey = getPaperSummaryCacheKey(paper);
    const cached = await getCachedJson(cacheKey);
    if (cached && typeof cached === 'string') {
      return { ...paper, summary: cached };
    }

    if (!canUseLlm || index >= llmCount || !paper.abstract || paper.abstract.length < 120) {
      await setCachedJson(cacheKey, fallback, SUMMARY_CACHE_TTL_SECONDS);
      return { ...paper, summary: fallback };
    }

    let summary = null;
    try {
      summary = await summarizeWithGroq(paper, groqKey);
      if (!summary) {
        summary = await summarizeWithOpenRouter(paper, openRouterKey);
      }
    } catch {
      // Ignore and use fallback.
    }

    const finalSummary = summary || fallback;
    await setCachedJson(cacheKey, finalSummary, SUMMARY_CACHE_TTL_SECONDS);
    return { ...paper, summary: finalSummary };
  });

  return Promise.all(tasks);
}

function mergeDeduplicatePapers(primaryPapers, secondaryPapers) {
  const merged = [];
  const seenTitle = new Set();

  for (const paper of [...primaryPapers, ...secondaryPapers]) {
    const key = normalizeTitle(paper.title);
    if (!key || seenTitle.has(key)) continue;
    seenTitle.add(key);
    merged.push(paper);
  }

  merged.sort((a, b) => {
    if (b.trustScore !== a.trustScore) return b.trustScore - a.trustScore;
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  });

  return merged;
}

function deduplicateByTitle(papers) {
  const deduped = [];
  const seen = new Set();
  for (const paper of papers) {
    const key = normalizeTitle(paper.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(paper);
  }
  return deduped;
}

function selectBalancedPapers({ trustedPapers, alphaXivPapers, arxivPapers, limit }) {
  const trusted = deduplicateByTitle(trustedPapers);
  const alpha = deduplicateByTitle(alphaXivPapers);
  const arxiv = deduplicateByTitle(arxivPapers);

  const minAlpha = Math.min(alpha.length, Math.max(4, Math.floor(limit * 0.2)));
  const minArxiv = Math.min(arxiv.length, Math.max(4, Math.floor(limit * 0.15)));
  const maxTrusted = Math.min(trusted.length, Math.max(0, limit - minAlpha - minArxiv));

  const selected = [];
  const seen = new Set();
  const pushIfUnique = (paper) => {
    const key = normalizeTitle(paper.title);
    if (!key || seen.has(key) || selected.length >= limit) return false;
    seen.add(key);
    selected.push(paper);
    return true;
  };

  let addedTrusted = 0;
  for (const paper of trusted) {
    if (addedTrusted >= maxTrusted || selected.length >= limit) break;
    if (pushIfUnique(paper)) addedTrusted += 1;
  }

  let addedAlpha = 0;
  for (const paper of alpha) {
    if (addedAlpha >= minAlpha || selected.length >= limit) break;
    if (pushIfUnique(paper)) addedAlpha += 1;
  }

  let addedArxiv = 0;
  for (const paper of arxiv) {
    if (addedArxiv >= minArxiv || selected.length >= limit) break;
    if (pushIfUnique(paper)) addedArxiv += 1;
  }

  if (selected.length < limit) {
    const fallback = mergeDeduplicatePapers(trusted, [...alpha, ...arxiv]);
    for (const paper of fallback) {
      if (selected.length >= limit) break;
      pushIfUnique(paper);
    }
  }

  return selected.slice(0, limit);
}

function attachInstitutionAndGeo(papers, profileMap) {
  return papers.map((paper) => {
    const institution = paper.firstAuthorId ? profileMap.get(paper.firstAuthorId) : null;
    if (!institution) {
      return {
        ...paper,
        institution: paper.institution ?? null,
        institutionCountry: paper.institutionCountry ?? null,
        lat: paper.lat ?? null,
        lon: paper.lon ?? null,
      };
    }

    const centroid = COUNTRY_CENTROIDS[institution.country] || null;
    return {
      ...paper,
      institution: institution.name || paper.institution || null,
      institutionCountry: institution.country || paper.institutionCountry || null,
      lat: centroid?.lat ?? paper.lat ?? null,
      lon: centroid?.lon ?? paper.lon ?? null,
    };
  });
}

function buildActivityPoints(papers) {
  const grouped = new Map();

  for (const paper of papers) {
    if (paper.lat == null || paper.lon == null) continue;
    const label = paper.institution || (paper.institutionCountry ? `Research Hub (${paper.institutionCountry})` : paper.venue);
    const key = `${paper.lat.toFixed(2)},${paper.lon.toFixed(2)}:${label}`;

    let point = grouped.get(key);
    if (!point) {
      point = {
        id: `paper-point-${hashString(key)}`,
        name: label,
        country: paper.institutionCountry || null,
        lat: paper.lat,
        lon: paper.lon,
        paperCount: 0,
        weightedScore: 0,
        topVenues: new Set(),
      };
      grouped.set(key, point);
    }

    point.paperCount += 1;
    point.weightedScore += paper.trustScore / 100;
    point.topVenues.add(paper.venue);
  }

  const points = Array.from(grouped.values());
  const maxScore = Math.max(1, ...points.map((p) => p.weightedScore));

  return points
    .map((point) => ({
      id: point.id,
      name: point.name,
      country: point.country,
      lat: point.lat,
      lon: point.lon,
      paperCount: point.paperCount,
      weightedScore: Number(point.weightedScore.toFixed(2)),
      intensity: Number((point.weightedScore / maxScore).toFixed(3)),
      topVenues: Array.from(point.topVenues).slice(0, 3),
    }))
    .sort((a, b) => b.weightedScore - a.weightedScore);
}

export default async function handler(request) {
  const cors = getCorsHeaders(request, 'GET, OPTIONS');

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = parseLimit(searchParams.get('limit'));
    const llmCount = Math.max(0, Math.min(8, Number.parseInt(searchParams.get('llm') || '5', 10) || 0));

    const cacheKey = `ai-papers:${CACHE_VERSION}:${hashString(`${limit}:${llmCount}`)}`;
    const cached = await getCachedJson(cacheKey);
    if (cached && typeof cached === 'object' && Array.isArray(cached.papers)) {
      return new Response(JSON.stringify({ ...cached, cached: true }), {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=600, s-maxage=600, stale-while-revalidate=120',
        },
      });
    }

    const [trustedPapers, arxivPapers, alphaXivPapers] = await Promise.all([
      fetchOpenReviewPapers(limit),
      fetchArxivPapers(Math.ceil(limit * 0.8)),
      fetchAlphaXivPapers(Math.ceil(limit * 1.2)),
    ]);

    const capped = selectBalancedPapers({
      trustedPapers,
      alphaXivPapers,
      arxivPapers,
      limit,
    });

    const firstAuthorIds = Array.from(new Set(capped.map((p) => p.firstAuthorId).filter(Boolean)));
    const profileMap = await fetchProfilesByIds(firstAuthorIds);
    const geoEnriched = attachInstitutionAndGeo(capped, profileMap);
    const withSummaries = await enrichSummaries(geoEnriched, llmCount);
    const activityPoints = buildActivityPoints(withSummaries);

    const payload = {
      generatedAt: new Date().toISOString(),
      trustedCount: withSummaries.filter((p) => p.sourceType === 'accepted').length,
      preprintCount: withSummaries.filter((p) => p.sourceType === 'preprint').length,
      papers: withSummaries,
      activityPoints,
      cached: false,
    };

    await setCachedJson(cacheKey, payload, CACHE_TTL_SECONDS);

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600, s-maxage=600, stale-while-revalidate=120',
      },
    });
  } catch (error) {
    console.error('[ai-papers] Error:', error?.message || error);
    return new Response(JSON.stringify({
      error: 'Failed to fetch AI papers',
      message: error?.message || 'Unknown error',
    }), {
      status: 500,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
      },
    });
  }
}
