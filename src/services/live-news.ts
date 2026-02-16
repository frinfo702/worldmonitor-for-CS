import { isDesktopRuntime, getRemoteApiBaseUrl } from '@/services/runtime';

export interface LatestChannelVideos {
  videoId: string | null;
  recentVideoIds: string[];
}

const liveVideoCache = new Map<string, {
  data: LatestChannelVideos;
  timestamp: number;
}>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function fetchLatestChannelVideos(
  channelHandle: string,
  channelId?: string,
  days = 14,
): Promise<LatestChannelVideos> {
  const cacheKey = channelId ? `${channelHandle}:${channelId}` : channelHandle;
  const cached = liveVideoCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  try {
    const baseUrl = isDesktopRuntime() ? getRemoteApiBaseUrl() : '';
    const params = new URLSearchParams({
      channel: channelHandle,
      days: String(days),
    });
    if (channelId) params.set('channelId', channelId);
    const res = await fetch(`${baseUrl}/api/youtube/latest?${params.toString()}`);
    if (!res.ok) throw new Error('API error');
    const data = await res.json();
    const normalized: LatestChannelVideos = {
      videoId: data.videoId || null,
      recentVideoIds: Array.isArray(data.recentVideoIds)
        ? data.recentVideoIds.filter((id: unknown) => typeof id === 'string')
        : [],
    };
    liveVideoCache.set(cacheKey, { data: normalized, timestamp: Date.now() });
    return normalized;
  } catch (error) {
    console.warn(`[LiveNews] Failed to fetch latest video for ${channelHandle}:`, error);
    return { videoId: null, recentVideoIds: [] };
  }
}

export async function fetchLatestVideoId(
  channelHandle: string,
  channelId?: string,
): Promise<string | null> {
  const data = await fetchLatestChannelVideos(channelHandle, channelId);
  return data.videoId;
}

// Backward-compat alias for callers still using the old name.
export const fetchLiveVideoId = fetchLatestVideoId;
