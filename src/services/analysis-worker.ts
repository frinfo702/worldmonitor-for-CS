/**
 * Worker Manager for heavy computational tasks.
 * Provides typed async interface to the analysis Web Worker.
 */

import type { NewsItem, ClusteredEvent, PredictionMarket, MarketData } from '@/types';
import type { CorrelationSignal } from './correlation';
import { SOURCE_TIERS, SOURCE_TYPES, type SourceType } from '@/config/feeds';
import { clusterNewsCore, analyzeCorrelationsCore, type StreamSnapshot } from './analysis-core';

// Import worker using Vite's worker syntax
import AnalysisWorker from '@/workers/analysis.worker?worker';

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ClusterResult {
  type: 'cluster-result';
  id: string;
  clusters: ClusteredEvent[];
}

interface CorrelationResult {
  type: 'correlation-result';
  id: string;
  signals: CorrelationSignal[];
}

type WorkerResult = ClusterResult | CorrelationResult | { type: 'ready' };

class AnalysisWorkerManager {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest<unknown>> = new Map();
  private requestIdCounter = 0;
  private isReady = false;
  private workerUnavailableError: Error | null = null;
  private fallbackSnapshot: StreamSnapshot | null = null;
  private recentSignalKeys = new Set<string>();
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimeout: ReturnType<typeof setTimeout> | null = null;

  private static readonly READY_TIMEOUT_MS = 10000; // 10 seconds to become ready

  /**
   * Initialize the worker. Called lazily on first use.
   */
  private initWorker(): void {
    if (this.worker || this.workerUnavailableError) return;

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    // Set ready timeout - reject if worker doesn't become ready in time
    this.readyTimeout = setTimeout(() => {
      if (!this.isReady) {
        const error = new Error('Worker failed to become ready within timeout');
        console.error('[AnalysisWorker]', error.message);
        this.workerUnavailableError = error;
        this.readyReject?.(error);
        this.cleanup();
      }
    }, AnalysisWorkerManager.READY_TIMEOUT_MS);

    try {
      this.worker = new AnalysisWorker();
    } catch (error) {
      console.error('[AnalysisWorker] Failed to create worker:', error);
      const workerError = error instanceof Error ? error : new Error(String(error));
      this.workerUnavailableError = workerError;
      this.readyReject?.(workerError);
      this.cleanup();
      return;
    }

    this.worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      const data = event.data;

      if (data.type === 'ready') {
        this.isReady = true;
        if (this.readyTimeout) {
          clearTimeout(this.readyTimeout);
          this.readyTimeout = null;
        }
        this.readyResolve?.();
        return;
      }

      if ('id' in data) {
        const pending = this.pendingRequests.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(data.id);

          if (data.type === 'cluster-result') {
            // Deserialize dates
            const clusters = data.clusters.map(cluster => ({
              ...cluster,
              firstSeen: new Date(cluster.firstSeen),
              lastUpdated: new Date(cluster.lastUpdated),
              allItems: cluster.allItems.map(item => ({
                ...item,
                pubDate: new Date(item.pubDate),
              })),
            }));
            pending.resolve(clusters);
          } else if (data.type === 'correlation-result') {
            // Deserialize dates
            const signals = data.signals.map(signal => ({
              ...signal,
              timestamp: new Date(signal.timestamp),
            }));
            pending.resolve(signals);
          }
        }
      }
    };

    this.worker.onerror = (error) => {
      console.error('[AnalysisWorker] Error:', error);

      // If not ready yet, reject the ready promise
      if (!this.isReady) {
        const workerError = new Error(`Worker failed to initialize: ${error.message}`);
        this.workerUnavailableError = workerError;
        this.readyReject?.(workerError);
        this.cleanup();
        return;
      }

      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Worker error: ${error.message}`));
        this.pendingRequests.delete(id);
      }
    };
  }

  /**
   * Cleanup worker state (for re-initialization)
   */
  private cleanup(): void {
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout);
      this.readyTimeout = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.isReady = false;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
  }

  private getSourceTier = (source: string): number => SOURCE_TIERS[source] ?? 4;

  private getSourceType = (source: string): SourceType =>
    (SOURCE_TYPES[source] as SourceType | undefined) ?? 'other';

  private isRecentDuplicate = (key: string): boolean => this.recentSignalKeys.has(key);

  private markSignalSeen = (key: string): void => {
    this.recentSignalKeys.add(key);
    setTimeout(() => this.recentSignalKeys.delete(key), 30 * 60 * 1000);
  };

  private runClusterFallback(items: NewsItem[]): ClusteredEvent[] {
    return clusterNewsCore(items, this.getSourceTier) as ClusteredEvent[];
  }

  private runCorrelationFallback(
    clusters: ClusteredEvent[],
    predictions: PredictionMarket[],
    markets: MarketData[]
  ): CorrelationSignal[] {
    const { signals, snapshot } = analyzeCorrelationsCore(
      clusters,
      predictions,
      markets,
      this.fallbackSnapshot,
      this.getSourceType,
      this.isRecentDuplicate,
      this.markSignalSeen
    );
    this.fallbackSnapshot = snapshot;
    return signals as CorrelationSignal[];
  }

  /**
   * Wait for worker to be ready
   */
  private async waitForReady(): Promise<void> {
    if (this.workerUnavailableError) {
      throw this.workerUnavailableError;
    }
    this.initWorker();
    if (this.isReady) return;
    await this.readyPromise;
  }

  /**
   * Generate unique request ID
   */
  private generateId(): string {
    return `req-${++this.requestIdCounter}-${Date.now()}`;
  }

  /**
   * Cluster news articles using Web Worker.
   * Runs O(n²) Jaccard similarity off the main thread.
   */
  async clusterNews(items: NewsItem[]): Promise<ClusteredEvent[]> {
    try {
      await this.waitForReady();
    } catch (error) {
      if (!this.workerUnavailableError) {
        this.workerUnavailableError = error instanceof Error ? error : new Error(String(error));
      }
      return this.runClusterFallback(items);
    }

    return new Promise((resolve, reject) => {
      const id = this.generateId();

      // Set timeout (30 seconds - clustering can take a while for large datasets)
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Clustering request timed out'));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.worker!.postMessage({
        type: 'cluster',
        id,
        items,
        sourceTiers: SOURCE_TIERS,
      });
    });
  }

  /**
   * Run correlation analysis using Web Worker.
   * Detects signal patterns across news, markets, and predictions.
   */
  async analyzeCorrelations(
    clusters: ClusteredEvent[],
    predictions: PredictionMarket[],
    markets: MarketData[]
  ): Promise<CorrelationSignal[]> {
    try {
      await this.waitForReady();
    } catch (error) {
      if (!this.workerUnavailableError) {
        this.workerUnavailableError = error instanceof Error ? error : new Error(String(error));
      }
      return this.runCorrelationFallback(clusters, predictions, markets);
    }

    return new Promise((resolve, reject) => {
      const id = this.generateId();

      // Set timeout (10 seconds should be plenty for correlation)
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Correlation analysis request timed out'));
      }, 10000);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.worker!.postMessage({
        type: 'correlation',
        id,
        clusters,
        predictions,
        markets,
        sourceTypes: SOURCE_TYPES as Record<string, SourceType>,
      });
    });
  }

  /**
   * Reset worker state (useful for testing)
   */
  reset(): void {
    // Reject all pending requests - reset worker won't answer old queries
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Worker reset'));
    }
    this.pendingRequests.clear();

    if (this.worker) {
      this.worker.postMessage({ type: 'reset' });
    }
    this.fallbackSnapshot = null;
    this.recentSignalKeys.clear();
  }

  /**
   * Terminate worker (cleanup)
   */
  terminate(): void {
    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Worker terminated'));
      this.pendingRequests.delete(id);
    }
    this.cleanup();
    this.workerUnavailableError = null;
    this.fallbackSnapshot = null;
    this.recentSignalKeys.clear();
  }

  /**
   * Check if worker is available and ready
   */
  get ready(): boolean {
    return this.isReady;
  }
}

// Singleton instance
export const analysisWorker = new AnalysisWorkerManager();

// Export types for consumers
export type { CorrelationSignal };
