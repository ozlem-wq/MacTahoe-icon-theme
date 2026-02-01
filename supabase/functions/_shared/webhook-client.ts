/**
 * Webhook HTTP Client
 * Handles webhook delivery with retry logic and exponential backoff
 */

import { signPayload, buildWebhookHeaders } from './webhook-signature.ts';

// ============================================================================
// Types
// ============================================================================

export interface WebhookPayload {
  event: string;
  table: string;
  action: string;
  data: Record<string, unknown>;
  old_data?: Record<string, unknown> | null;
  metadata: {
    triggered_at: string;
    transaction_id?: number;
    changed_fields?: string[];
    [key: string]: unknown;
  };
  timestamp: number;
}

export interface WebhookDeliveryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseDelayMs?: number;
  /** Maximum delay between retries in ms (default: 60000) */
  maxDelayMs?: number;
  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Custom headers to include */
  customHeaders?: Record<string, string>;
  /** Webhook ID for tracking */
  webhookId?: string;
}

export interface WebhookResponse {
  success: boolean;
  status?: number;
  statusText?: string;
  body?: string;
  headers?: Record<string, string>;
  error?: string;
  errorCode?: string;
  attempts: number;
  durationMs: number;
  webhookId: string;
}

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  lastError?: string;
  nextDelayMs: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_OPTIONS: Required<Omit<WebhookDeliveryOptions, 'customHeaders' | 'webhookId'>> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  timeoutMs: 30000,
};

// Retryable HTTP status codes
const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
]);

// Non-retryable error types
const NON_RETRYABLE_ERRORS = new Set([
  'TypeError', // Usually indicates invalid URL
]);

// ============================================================================
// Main Delivery Function
// ============================================================================

/**
 * Send a webhook with automatic retry on failure
 */
export async function sendWebhook(
  url: string,
  payload: WebhookPayload,
  secret: string,
  options: WebhookDeliveryOptions = {}
): Promise<WebhookResponse> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const webhookId = options.webhookId || crypto.randomUUID();
  const payloadString = JSON.stringify(payload);
  const startTime = Date.now();

  let lastResponse: WebhookResponse | null = null;
  let attempt = 0;

  while (attempt < opts.maxRetries) {
    attempt++;

    try {
      const result = await deliverWebhook(
        url,
        payloadString,
        secret,
        payload.event,
        webhookId,
        opts.timeoutMs,
        options.customHeaders
      );

      const durationMs = Date.now() - startTime;

      if (result.success) {
        return {
          ...result,
          attempts: attempt,
          durationMs,
          webhookId,
        };
      }

      lastResponse = {
        ...result,
        attempts: attempt,
        durationMs,
        webhookId,
      };

      // Check if error is retryable
      if (!isRetryable(result)) {
        return lastResponse;
      }

      // Don't delay after last attempt
      if (attempt < opts.maxRetries) {
        const delay = calculateBackoff(attempt, opts.baseDelayMs, opts.maxDelayMs);
        await sleep(delay);
      }
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorName = error instanceof Error ? error.name : 'Error';

      lastResponse = {
        success: false,
        error: errorMessage,
        errorCode: errorName,
        attempts: attempt,
        durationMs,
        webhookId,
      };

      // Check if error type is retryable
      if (NON_RETRYABLE_ERRORS.has(errorName)) {
        return lastResponse;
      }

      // Don't delay after last attempt
      if (attempt < opts.maxRetries) {
        const delay = calculateBackoff(attempt, opts.baseDelayMs, opts.maxDelayMs);
        await sleep(delay);
      }
    }
  }

  // Return last response after all retries exhausted
  return lastResponse || {
    success: false,
    error: 'All retry attempts exhausted',
    attempts: attempt,
    durationMs: Date.now() - startTime,
    webhookId,
  };
}

/**
 * Send webhook without retry (single attempt)
 */
export async function sendWebhookOnce(
  url: string,
  payload: WebhookPayload,
  secret: string,
  options: Pick<WebhookDeliveryOptions, 'timeoutMs' | 'customHeaders' | 'webhookId'> = {}
): Promise<WebhookResponse> {
  const webhookId = options.webhookId || crypto.randomUUID();
  const payloadString = JSON.stringify(payload);
  const startTime = Date.now();

  try {
    const result = await deliverWebhook(
      url,
      payloadString,
      secret,
      payload.event,
      webhookId,
      options.timeoutMs || DEFAULT_OPTIONS.timeoutMs,
      options.customHeaders
    );

    return {
      ...result,
      attempts: 1,
      durationMs: Date.now() - startTime,
      webhookId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: error instanceof Error ? error.name : 'Error',
      attempts: 1,
      durationMs: Date.now() - startTime,
      webhookId,
    };
  }
}

// ============================================================================
// Internal Functions
// ============================================================================

/**
 * Perform actual HTTP delivery
 */
async function deliverWebhook(
  url: string,
  payloadString: string,
  secret: string,
  eventType: string,
  webhookId: string,
  timeoutMs: number,
  customHeaders?: Record<string, string>
): Promise<Omit<WebhookResponse, 'attempts' | 'durationMs' | 'webhookId'>> {
  // Build signed headers
  const headers = await buildWebhookHeaders(
    payloadString,
    secret,
    eventType,
    webhookId
  );

  // Merge custom headers
  const allHeaders: Record<string, string> = {
    ...headers,
    ...customHeaders,
  };

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: allHeaders,
      body: payloadString,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Read response body
    let body: string;
    try {
      body = await response.text();
    } catch {
      body = '';
    }

    // Extract response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Consider 2xx as success
    const success = response.status >= 200 && response.status < 300;

    return {
      success,
      status: response.status,
      statusText: response.statusText,
      body: body.slice(0, 10000), // Limit stored body size
      headers: responseHeaders,
      error: success ? undefined : `HTTP ${response.status}: ${response.statusText}`,
    };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        error: `Request timeout after ${timeoutMs}ms`,
        errorCode: 'TIMEOUT',
      };
    }

    throw error;
  }
}

/**
 * Check if a response indicates a retryable error
 */
function isRetryable(response: Omit<WebhookResponse, 'attempts' | 'durationMs' | 'webhookId'>): boolean {
  // Network errors are generally retryable
  if (!response.status && response.error) {
    return true;
  }

  // Check status code
  if (response.status && RETRYABLE_STATUS_CODES.has(response.status)) {
    return true;
  }

  return false;
}

/**
 * Calculate exponential backoff delay
 * Formula: baseDelay * (2 ^ attempt) with jitter
 */
function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  // Exponential backoff: 1s, 4s, 16s, 64s...
  const exponentialDelay = baseDelayMs * Math.pow(4, attempt - 1);

  // Add jitter (±25%)
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
  const delayWithJitter = exponentialDelay + jitter;

  // Clamp to max delay
  return Math.min(delayWithJitter, maxDelayMs);
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Batch Delivery
// ============================================================================

export interface BatchDeliveryResult {
  total: number;
  successful: number;
  failed: number;
  results: Array<{
    subscriptionId: string | number;
    response: WebhookResponse;
  }>;
}

export interface WebhookSubscription {
  id: string | number;
  url: string;
  secret: string;
  name?: string;
}

/**
 * Deliver webhook to multiple subscriptions concurrently
 */
export async function sendWebhookBatch(
  subscriptions: WebhookSubscription[],
  payload: WebhookPayload,
  options: WebhookDeliveryOptions = {}
): Promise<BatchDeliveryResult> {
  const results = await Promise.all(
    subscriptions.map(async (subscription) => {
      const response = await sendWebhook(
        subscription.url,
        payload,
        subscription.secret,
        {
          ...options,
          webhookId: `${subscription.id}-${crypto.randomUUID()}`,
        }
      );

      return {
        subscriptionId: subscription.id,
        response,
      };
    })
  );

  const successful = results.filter((r) => r.response.success).length;

  return {
    total: results.length,
    successful,
    failed: results.length - successful,
    results,
  };
}
