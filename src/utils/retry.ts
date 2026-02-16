export interface ExponentialBackoffOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  factor?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  shouldRetry?: (error: unknown, failedAttempt: number, maxAttempts: number) => boolean;
  onRetry?: (ctx: RetryContext) => void;
}

export interface RetryContext {
  failedAttempt: number;
  maxAttempts: number;
  delayMs: number;
  error: unknown;
}

export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 400;
const DEFAULT_FACTOR = 2;
const DEFAULT_MAX_DELAY_MS = 5000;
const DEFAULT_JITTER_RATIO = 0.2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function computeDelayMs(
  failedAttempt: number,
  initialDelayMs: number,
  factor: number,
  maxDelayMs: number,
  jitterRatio: number
): number {
  const raw = Math.min(maxDelayMs, initialDelayMs * (factor ** Math.max(0, failedAttempt - 1)));
  const jitter = Math.round(raw * jitterRatio * Math.random());
  return Math.min(maxDelayMs, raw + jitter);
}

export async function withExponentialBackoff<T>(
  operation: () => Promise<T>,
  options: ExponentialBackoffOptions = {}
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
  const factor = Math.max(1, options.factor ?? DEFAULT_FACTOR);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
  const jitterRatio = Math.max(0, options.jitterRatio ?? DEFAULT_JITTER_RATIO);
  const shouldRetry = options.shouldRetry ?? (() => true);

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const hasNextAttempt = attempt < maxAttempts;
      if (!hasNextAttempt || !shouldRetry(error, attempt, maxAttempts)) {
        throw error;
      }

      const delayMs = computeDelayMs(attempt, initialDelayMs, factor, maxDelayMs, jitterRatio);
      options.onRetry?.({
        failedAttempt: attempt,
        maxAttempts,
        delayMs,
        error,
      });
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Retry attempts exhausted');
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return isRetryableHttpStatus(error.status);
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return false;
  }
  return true;
}
