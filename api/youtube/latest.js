// YouTube Latest Upload Detection API
// Resolves a channel handle/id and returns the latest uploaded video.

import { getCorsHeaders, isDisallowedOrigin } from '../_cors.js';

export const config = {
  runtime: 'edge',
};

function sanitizeHandle(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const handle = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
  return /^@[A-Za-z0-9._-]{3,40}$/.test(handle) ? handle : null;
}

function sanitizeChannelId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^UC[A-Za-z0-9_-]{22}$/.test(trimmed) ? trimmed : null;
}

function sanitizePositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function decodeXml(value) {
  if (!value) return '';
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function resolveChannelIdFromHandle(handle) {
  const response = await fetch(`https://www.youtube.com/${handle}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    redirect: 'follow',
  });
  if (!response.ok) return null;
  const html = await response.text();
  const match = html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/);
  return match ? match[1] : null;
}

async function fetchLatestFromFeed(channelId) {
  const response = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      redirect: 'follow',
    },
  );
  if (!response.ok) return null;

  const xml = await response.text();
  const entries = [];
  const entryMatches = xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g);

  for (const match of entryMatches) {
    const entryXml = match[1];
    if (!entryXml) continue;

    const videoIdMatch = entryXml.match(/<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/);
    if (!videoIdMatch) continue;

    const titleMatch = entryXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const publishedMatch = entryXml.match(/<published>([^<]+)<\/published>/);
    const publishedAt = publishedMatch?.[1] || null;
    const publishedMs = publishedAt ? Date.parse(publishedAt) : NaN;

    entries.push({
      videoId: videoIdMatch[1],
      title: decodeXml(titleMatch?.[1] || ''),
      publishedAt,
      publishedMs,
    });
  }

  return entries;
}

export default async function handler(request) {
  const cors = getCorsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (isDisallowedOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const handle = sanitizeHandle(url.searchParams.get('channel'));
  const explicitChannelId = sanitizeChannelId(url.searchParams.get('channelId'));
  const recentDays = sanitizePositiveInt(url.searchParams.get('days'), 14, 1, 90);
  const recentLimit = sanitizePositiveInt(url.searchParams.get('limit'), 30, 1, 100);

  if (!handle && !explicitChannelId) {
    return new Response(JSON.stringify({ error: 'Missing channel or channelId parameter' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  try {
    const channelId = explicitChannelId || (handle ? await resolveChannelIdFromHandle(handle) : null);
    if (!channelId) {
      return new Response(JSON.stringify({ videoId: null, channelId: null }), {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
        },
      });
    }

    const entries = await fetchLatestFromFeed(channelId);
    if (!entries || entries.length === 0) {
      return new Response(JSON.stringify({ videoId: null, channelId }), {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
        },
      });
    }

    const cutoffMs = Date.now() - recentDays * 24 * 60 * 60 * 1000;

    return new Response(
      JSON.stringify({
        videoId: entries[0].videoId,
        channelId,
        title: entries[0].title,
        publishedAt: entries[0].publishedAt,
        recentVideoIds: entries
          .filter((entry) => {
            if (!Number.isFinite(entry.publishedMs)) return false;
            return entry.publishedMs >= cutoffMs;
          })
          .slice(0, recentLimit)
          .map((entry) => entry.videoId),
      }),
      {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
        },
      },
    );
  } catch (error) {
    console.error('YouTube latest check error:', error);
    return new Response(JSON.stringify({ videoId: null, error: error.message }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
}
