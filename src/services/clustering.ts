/**
 * News clustering service - main thread wrapper.
 * Core logic is in analysis-core.ts (shared with worker).
 * Hybrid clustering combines Jaccard + semantic similarity when ML is available.
 */

import type { NewsItem, ClusteredEvent } from '@/types';
import { getSourceTier } from '@/config';
import { clusterNewsCore } from './analysis-core';
import { mlWorker } from './ml-worker';
import { ML_THRESHOLDS } from '@/config/ml-config';

type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';
const THREAT_PRIORITY: Record<ThreatLevel, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export function clusterNews(items: NewsItem[]): ClusteredEvent[] {
  return clusterNewsCore(items, getSourceTier) as ClusteredEvent[];
}

/**
 * Hybrid clustering: Jaccard first, then semantic refinement if ML available
 */
export async function clusterNewsHybrid(items: NewsItem[]): Promise<ClusteredEvent[]> {
  // Step 1: Fast Jaccard clustering
  const jaccardClusters = clusterNewsCore(items, getSourceTier) as ClusteredEvent[];

  // Step 2: If ML unavailable or too few clusters, return Jaccard results
  if (!mlWorker.isAvailable || jaccardClusters.length < ML_THRESHOLDS.minClustersForML) {
    return jaccardClusters;
  }

  try {
    // Get cluster primary titles for embedding
    const clusterTexts = jaccardClusters.map(c => ({
      id: c.id,
      text: c.primaryTitle,
    }));

    // Get semantic groupings
    const semanticGroups = await mlWorker.clusterBySemanticSimilarity(
      clusterTexts,
      ML_THRESHOLDS.semanticClusterThreshold
    );

    // Merge semantically similar clusters
    return mergeSemanticallySimilarClusters(jaccardClusters, semanticGroups);
  } catch (error) {
    console.warn('[Clustering] Semantic clustering failed, using Jaccard only:', error);
    return jaccardClusters;
  }
}

/**
 * Merge clusters that are semantically similar
 */
function mergeSemanticallySimilarClusters(
  clusters: ClusteredEvent[],
  semanticGroups: string[][]
): ClusteredEvent[] {
  const clusterMap = new Map(clusters.map(c => [c.id, c]));
  const merged: ClusteredEvent[] = [];
  const usedIds = new Set<string>();

  for (const group of semanticGroups) {
    if (group.length === 0) continue;

    // Get all clusters in this semantic group
    const groupClusters = group
      .map(id => clusterMap.get(id))
      .filter((c): c is ClusteredEvent => c !== undefined && !usedIds.has(c.id));

    if (groupClusters.length === 0) continue;

    // Mark all as used
    groupClusters.forEach(c => usedIds.add(c.id));

    const firstCluster = groupClusters[0];
    if (!firstCluster) continue;

    if (groupClusters.length === 1) {
      // No merging needed
      merged.push(firstCluster);
      continue;
    }

    // Merge multiple clusters into one
    // Use the cluster with the highest-tier primary source as the base
    const sortedByTier = [...groupClusters].sort((a, b) => {
      const tierA = getSourceTier(a.primarySource);
      const tierB = getSourceTier(b.primarySource);
      if (tierA !== tierB) return tierA - tierB;
      return b.lastUpdated.getTime() - a.lastUpdated.getTime();
    });

    const primary = sortedByTier[0];
    if (!primary) continue;

    const others = sortedByTier.slice(1);

    // Combine all items, sources, etc.
    const allItems = [...primary.allItems];
    const topSourcesSet = new Map(primary.topSources.map(s => [s.url, s]));

    for (const other of others) {
      allItems.push(...other.allItems);
      for (const src of other.topSources) {
        if (!topSourcesSet.has(src.url)) {
          topSourcesSet.set(src.url, src);
        }
      }
    }

    // Sort top sources by tier, keep top 5
    const sortedTopSources = Array.from(topSourcesSet.values())
      .sort((a, b) => a.tier - b.tier)
      .slice(0, 5);

    // Calculate merged timestamps
    const allDates = allItems.map(i => i.pubDate.getTime());
    const firstSeen = new Date(Math.min(...allDates));
    const lastUpdated = new Date(Math.max(...allDates));
    const mergedThreat = selectMergedThreat(primary, others);
    const mergedGeo = selectMergedGeo(primary, others, allItems);

    const mergedCluster: ClusteredEvent = {
      id: primary.id,
      primaryTitle: primary.primaryTitle,
      primaryLink: primary.primaryLink,
      primarySource: primary.primarySource,
      sourceCount: allItems.length,
      topSources: sortedTopSources,
      allItems,
      firstSeen,
      lastUpdated,
      isAlert: allItems.some(i => i.isAlert),
      monitorColor: primary.monitorColor,
      velocity: primary.velocity,
      threat: mergedThreat,
      ...(mergedGeo ?? {}),
    };
    merged.push(mergedCluster);
  }

  // Add any clusters that weren't in any semantic group
  for (const cluster of clusters) {
    if (!usedIds.has(cluster.id)) {
      merged.push(cluster);
    }
  }

  // Sort by last updated
  merged.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());

  return merged;
}

function selectMergedThreat(
  primary: ClusteredEvent,
  others: ClusteredEvent[]
): ClusteredEvent['threat'] {
  const candidates = [primary, ...others]
    .map(cluster => cluster.threat)
    .filter((threat): threat is NonNullable<ClusteredEvent['threat']> => !!threat);

  if (candidates.length > 0) {
    return candidates.sort(
      (a, b) => (THREAT_PRIORITY[b.level as ThreatLevel] || 1) - (THREAT_PRIORITY[a.level as ThreatLevel] || 1)
    )[0];
  }

  return undefined;
}

function selectMergedGeo(
  primary: ClusteredEvent,
  others: ClusteredEvent[],
  items: NewsItem[]
): { lat: number; lon: number } | null {
  if (primary.lat != null && primary.lon != null) {
    return { lat: primary.lat, lon: primary.lon };
  }

  for (const cluster of others) {
    if (cluster.lat != null && cluster.lon != null) {
      return { lat: cluster.lat, lon: cluster.lon };
    }
  }

  const withGeo = items.find(item => item.lat != null && item.lon != null);
  if (withGeo && withGeo.lat != null && withGeo.lon != null) {
    return { lat: withGeo.lat, lon: withGeo.lon };
  }

  return null;
}
