/**
 * n8n Webhook Dispatch Edge Function
 *
 * Receives webhook events from PostgreSQL triggers and dispatches
 * them to registered n8n webhook endpoints.
 *
 * Invocation methods:
 * 1. Direct POST with event payload (from pg_notify listener or cron)
 * 2. POST with queue_id to process queued events
 *
 * Security Features (Deno Runtime 2026 Best Practices):
 * - URL validation to prevent SSRF attacks
 * - Environment variable validation with graceful fallbacks
 * - Input sanitization and validation
 * - Optional URL allowlist for webhook destinations
 * - Runtime permission checks
 * - Safe error handling (no internal detail exposure)
 *
 * @see https://docs.deno.com/runtime/fundamentals/security/
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import {
  sendWebhook,
  sendWebhookBatch,
  WebhookPayload,
  WebhookResponse,
  WebhookSubscription,
} from '../_shared/webhook-client.ts';
import {
  corsHeaders,
  handleCors,
  jsonResponse,
  errorResponse,
} from '../_shared/cors.ts';

// ============================================================================
// Security: Runtime Permission Checks (Deno 2026 Best Practices)
// ============================================================================

/**
 * Verify required Deno permissions are available at runtime.
 * This follows the principle of requesting permissions at point of need.
 * @see https://deno.com/blog/v2.5
 */
async function verifyPermissions(): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];

  // Check network permission (required for webhook dispatch)
  const netStatus = await Deno.permissions.query({ name: 'net' });
  if (netStatus.state !== 'granted') {
    missing.push('net');
  }

  // Check environment variable access
  const envStatus = await Deno.permissions.query({ name: 'env' });
  if (envStatus.state !== 'granted') {
    missing.push('env');
  }

  return { ok: missing.length === 0, missing };
}

// ============================================================================
// Security: URL Validation (SSRF Prevention)
// ============================================================================

/** Blocked IP ranges for SSRF prevention */
const BLOCKED_IP_PATTERNS = [
  /^127\./,                    // Loopback
  /^10\./,                     // Private Class A
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private Class B
  /^192\.168\./,               // Private Class C
  /^169\.254\./,               // Link-local
  /^0\./,                      // Current network
  /^::1$/,                     // IPv6 loopback
  /^fc00:/i,                   // IPv6 unique local
  /^fe80:/i,                   // IPv6 link-local
];

/** Blocked hostnames for SSRF prevention */
const BLOCKED_HOSTNAMES = [
  'localhost',
  'metadata.google.internal',
  '169.254.169.254',           // Cloud metadata endpoints
  'metadata.azure.com',
  'metadata.aws.com',
];

/** Optional allowlist from environment (comma-separated domains) */
const URL_ALLOWLIST = Deno.env.get('WEBHOOK_URL_ALLOWLIST')?.split(',').map(d => d.trim().toLowerCase()) || null;

/**
 * Validates a webhook URL for security.
 * Prevents SSRF attacks by blocking internal/private addresses.
 */
function validateWebhookUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Only allow HTTPS in production (HTTP allowed for local dev)
    const isProduction = Deno.env.get('DENO_DEPLOYMENT_ID') !== undefined;
    if (isProduction && parsed.protocol !== 'https:') {
      return { valid: false, error: 'Only HTTPS URLs are allowed in production' };
    }

    // Check protocol
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'Invalid protocol: only HTTP(S) allowed' };
    }

    // Check against blocked hostnames
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.includes(hostname)) {
      return { valid: false, error: 'Blocked hostname' };
    }

    // Check against blocked IP patterns
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return { valid: false, error: 'Internal IP addresses are not allowed' };
      }
    }

    // Check allowlist if configured
    if (URL_ALLOWLIST && URL_ALLOWLIST.length > 0) {
      const isAllowed = URL_ALLOWLIST.some(domain =>
        hostname === domain || hostname.endsWith(`.${domain}`)
      );
      if (!isAllowed) {
        return { valid: false, error: 'URL not in allowlist' };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

// ============================================================================
// Security: Input Validation & Sanitization
// ============================================================================

/** Maximum allowed payload size in bytes */
const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

/** Maximum string length for event names */
const MAX_EVENT_NAME_LENGTH = 256;

/** Valid event name pattern */
const EVENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]*(\.[a-zA-Z][a-zA-Z0-9_.-]*)*$/;

/**
 * Validates and sanitizes an event name.
 */
function validateEventName(event: unknown): { valid: boolean; value?: string; error?: string } {
  if (typeof event !== 'string') {
    return { valid: false, error: 'Event must be a string' };
  }

  if (event.length === 0) {
    return { valid: false, error: 'Event name cannot be empty' };
  }

  if (event.length > MAX_EVENT_NAME_LENGTH) {
    return { valid: false, error: `Event name exceeds maximum length of ${MAX_EVENT_NAME_LENGTH}` };
  }

  if (!EVENT_NAME_PATTERN.test(event)) {
    return { valid: false, error: 'Invalid event name format' };
  }

  return { valid: true, value: event };
}

/**
 * Sanitizes an object by removing potentially dangerous keys and limiting depth.
 */
function sanitizeObject(obj: unknown, maxDepth = 10, currentDepth = 0): unknown {
  if (currentDepth > maxDepth) {
    return '[max depth exceeded]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    // Sanitize strings to prevent injection
    if (typeof obj === 'string') {
      return obj.slice(0, 100000); // Limit string length
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.slice(0, 1000).map(item => sanitizeObject(item, maxDepth, currentDepth + 1));
  }

  const sanitized: Record<string, unknown> = {};
  const dangerousKeys = ['__proto__', 'constructor', 'prototype'];

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    // Skip dangerous keys (prototype pollution prevention)
    if (dangerousKeys.includes(key)) {
      continue;
    }
    sanitized[key] = sanitizeObject(value, maxDepth, currentDepth + 1);
  }

  return sanitized;
}

// ============================================================================
// Security: Safe Error Handling
// ============================================================================

/**
 * Creates a safe error response that doesn't expose internal details.
 */
function safeErrorResponse(error: unknown, fallbackMessage: string, status: number): Response {
  // Log the full error internally
  console.error('Internal error:', error);

  // Return sanitized message to client
  const isProduction = Deno.env.get('DENO_DEPLOYMENT_ID') !== undefined;

  if (isProduction) {
    // In production, don't expose error details
    return errorResponse(fallbackMessage, status);
  }

  // In development, include error message (but not stack traces)
  const message = error instanceof Error ? error.message : fallbackMessage;
  return errorResponse(message, status);
}

// ============================================================================
// Types
// ============================================================================

interface DispatchRequest {
  /** Direct event payload */
  event?: string;
  table?: string;
  action?: string;
  data?: Record<string, unknown>;
  old_data?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  timestamp?: number;

  /** Queue-based processing */
  queue_id?: number;
  batch_size?: number;

  /** Process all pending queue items */
  process_queue?: boolean;
}

interface DispatchResult {
  event: string;
  subscriptions_matched: number;
  deliveries: {
    successful: number;
    failed: number;
  };
  results: Array<{
    subscription_id: number | string;
    success: boolean;
    status?: number;
    error?: string;
    duration_ms: number;
  }>;
}

interface SubscriptionRow {
  id: number;
  url: string;
  secret: string;
  name: string | null;
  events: string[];
  failure_count: number;
}

interface WebhookLogInsert {
  subscription_id: number;
  event_type: string;
  event_id: string;
  payload: Record<string, unknown>;
  response_status: number | null;
  response_body: string | null;
  attempts: number;
  success: boolean;
  error_message: string | null;
  duration_ms: number;
  completed_at: string;
}

// ============================================================================
// Environment & Configuration (with validation)
// ============================================================================

/**
 * Safe environment variable access with validation.
 * Follows Deno security best practice of validating env vars at startup.
 */
function getRequiredEnvVar(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Validate environment on module load
let SUPABASE_URL: string;
let SUPABASE_SERVICE_ROLE_KEY: string;

try {
  SUPABASE_URL = getRequiredEnvVar('SUPABASE_URL');
  SUPABASE_SERVICE_ROLE_KEY = getRequiredEnvVar('SUPABASE_SERVICE_ROLE_KEY');

  // Validate SUPABASE_URL format
  const urlValidation = validateWebhookUrl(SUPABASE_URL);
  if (!urlValidation.valid) {
    console.warn('SUPABASE_URL validation warning:', urlValidation.error);
  }
} catch (error) {
  console.error('Environment configuration error:', error);
  // Will fail on first request - this is intentional for security
  SUPABASE_URL = '';
  SUPABASE_SERVICE_ROLE_KEY = '';
}

const MAX_FAILURE_COUNT = 10; // Disable subscription after this many consecutive failures
const BATCH_SIZE = 100; // Default batch size for queue processing
const REQUEST_TIMEOUT_MS = 30000; // 30 second timeout for requests

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // Only allow POST
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  try {
    // Security: Verify runtime permissions (Deno 2026 best practice)
    const permissions = await verifyPermissions();
    if (!permissions.ok) {
      console.error('Missing required permissions:', permissions.missing);
      return safeErrorResponse(
        new Error(`Missing permissions: ${permissions.missing.join(', ')}`),
        'Service configuration error',
        503
      );
    }

    // Security: Verify environment is properly configured
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return safeErrorResponse(
        new Error('Missing environment configuration'),
        'Service configuration error',
        503
      );
    }

    // Security: Verify authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return errorResponse('Missing authorization header', 401);
    }

    // Security: Validate authorization header format
    if (!authHeader.startsWith('Bearer ')) {
      return errorResponse('Invalid authorization header format', 401);
    }

    // Security: Check Content-Type
    const contentType = req.headers.get('Content-Type');
    if (!contentType?.includes('application/json')) {
      return errorResponse('Content-Type must be application/json', 415);
    }

    // Security: Check Content-Length to prevent oversized payloads
    const contentLength = req.headers.get('Content-Length');
    if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
      return errorResponse('Payload too large', 413);
    }

    // Initialize Supabase client with service role
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Parse and sanitize request body
    let body: DispatchRequest;
    try {
      const rawBody = await req.json();
      body = sanitizeObject(rawBody) as DispatchRequest;
    } catch {
      return errorResponse('Invalid JSON payload', 400);
    }

    // Route to appropriate handler with input validation
    if (body.process_queue) {
      const batchSize = typeof body.batch_size === 'number'
        ? Math.min(Math.max(1, body.batch_size), 1000) // Limit batch size
        : BATCH_SIZE;
      return await processQueue(supabase, batchSize);
    }

    if (body.queue_id) {
      if (typeof body.queue_id !== 'number' || body.queue_id < 1) {
        return errorResponse('Invalid queue_id: must be a positive number', 400);
      }
      return await processQueueItem(supabase, body.queue_id);
    }

    if (body.event) {
      // Validate event name
      const eventValidation = validateEventName(body.event);
      if (!eventValidation.valid) {
        return errorResponse(`Invalid event: ${eventValidation.error}`, 400);
      }
      return await dispatchEvent(supabase, body);
    }

    return errorResponse('Invalid request: must provide event, queue_id, or process_queue', 400);
  } catch (error) {
    return safeErrorResponse(error, 'Internal server error', 500);
  }
});

// ============================================================================
// Event Dispatch Handler
// ============================================================================

async function dispatchEvent(
  supabase: SupabaseClient,
  request: DispatchRequest
): Promise<Response> {
  const eventType = request.event!;

  // Build webhook payload
  const payload: WebhookPayload = {
    event: eventType,
    table: request.table || eventType.split('.')[0],
    action: request.action || eventType.split('.')[1] || 'unknown',
    data: request.data || {},
    old_data: request.old_data || null,
    metadata: {
      triggered_at: new Date().toISOString(),
      ...request.metadata,
    },
    timestamp: request.timestamp || Date.now() / 1000,
  };

  // Find matching subscriptions
  const { data: subscriptions, error: fetchError } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, secret, name, events, failure_count')
    .eq('active', true)
    .contains('events', [eventType]);

  if (fetchError) {
    console.error('Error fetching subscriptions:', fetchError);
    return errorResponse('Failed to fetch subscriptions', 500);
  }

  if (!subscriptions || subscriptions.length === 0) {
    return jsonResponse({
      event: eventType,
      subscriptions_matched: 0,
      message: 'No active subscriptions for this event',
    });
  }

  // Deliver to all matching subscriptions
  const results = await deliverToSubscriptions(
    supabase,
    subscriptions as SubscriptionRow[],
    payload
  );

  return jsonResponse(results);
}

// ============================================================================
// Queue Processing Handlers
// ============================================================================

async function processQueue(
  supabase: SupabaseClient,
  batchSize: number
): Promise<Response> {
  // Claim batch of events
  const { data: events, error: claimError } = await supabase.rpc(
    'claim_webhook_events',
    { batch_size: batchSize }
  );

  if (claimError) {
    console.error('Error claiming events:', claimError);
    return errorResponse('Failed to claim events', 500);
  }

  if (!events || events.length === 0) {
    return jsonResponse({
      processed: 0,
      message: 'No pending events in queue',
    });
  }

  // Process each event
  const results = await Promise.all(
    events.map(async (event: { id: number; event_type: string; payload: WebhookPayload }) => {
      try {
        const dispatchResult = await dispatchPayload(supabase, event.payload);

        // Mark as completed
        await supabase.rpc('complete_webhook_event', { event_id: event.id });

        return { queue_id: event.id, success: true, result: dispatchResult };
      } catch (error) {
        // Mark as failed
        await supabase.rpc('fail_webhook_event', {
          event_id: event.id,
          error_msg: error instanceof Error ? error.message : 'Unknown error',
        });

        return { queue_id: event.id, success: false, error: String(error) };
      }
    })
  );

  const successful = results.filter((r) => r.success).length;

  return jsonResponse({
    processed: results.length,
    successful,
    failed: results.length - successful,
    results,
  });
}

async function processQueueItem(
  supabase: SupabaseClient,
  queueId: number
): Promise<Response> {
  // Get queue item
  const { data: item, error: fetchError } = await supabase
    .from('webhook_event_queue')
    .select('id, event_type, payload, status, attempts')
    .eq('id', queueId)
    .single();

  if (fetchError || !item) {
    return errorResponse('Queue item not found', 404);
  }

  if (item.status === 'completed') {
    return jsonResponse({ message: 'Event already processed', queue_id: queueId });
  }

  try {
    const result = await dispatchPayload(supabase, item.payload as WebhookPayload);

    // Mark as completed
    await supabase.rpc('complete_webhook_event', { event_id: queueId });

    return jsonResponse({ queue_id: queueId, success: true, result });
  } catch (error) {
    // Mark as failed
    await supabase.rpc('fail_webhook_event', {
      event_id: queueId,
      error_msg: error instanceof Error ? error.message : 'Unknown error',
    });

    return errorResponse('Failed to process event', 500);
  }
}

// ============================================================================
// Core Dispatch Logic
// ============================================================================

async function dispatchPayload(
  supabase: SupabaseClient,
  payload: WebhookPayload
): Promise<DispatchResult> {
  const eventType = payload.event;

  // Find matching subscriptions
  const { data: subscriptions, error } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, secret, name, events, failure_count')
    .eq('active', true)
    .contains('events', [eventType]);

  if (error) {
    throw new Error(`Failed to fetch subscriptions: ${error.message}`);
  }

  if (!subscriptions || subscriptions.length === 0) {
    return {
      event: eventType,
      subscriptions_matched: 0,
      deliveries: { successful: 0, failed: 0 },
      results: [],
    };
  }

  return deliverToSubscriptions(supabase, subscriptions as SubscriptionRow[], payload);
}

async function deliverToSubscriptions(
  supabase: SupabaseClient,
  subscriptions: SubscriptionRow[],
  payload: WebhookPayload
): Promise<DispatchResult> {
  const eventType = payload.event;
  const webhookId = crypto.randomUUID();

  // Security: Validate all webhook URLs before delivery (SSRF prevention)
  const validatedSubscriptions: SubscriptionRow[] = [];
  const rejectedSubscriptions: Array<{ id: number; error: string }> = [];

  for (const subscription of subscriptions) {
    const urlValidation = validateWebhookUrl(subscription.url);
    if (urlValidation.valid) {
      validatedSubscriptions.push(subscription);
    } else {
      console.warn(
        `Subscription ${subscription.id} rejected: ${urlValidation.error} (URL: ${subscription.url.slice(0, 50)}...)`
      );
      rejectedSubscriptions.push({
        id: subscription.id,
        error: urlValidation.error || 'URL validation failed',
      });
    }
  }

  // Log rejected subscriptions for security audit
  if (rejectedSubscriptions.length > 0) {
    console.warn(
      `Security: ${rejectedSubscriptions.length} subscriptions rejected due to URL validation`
    );
  }

  // If no valid subscriptions, return early
  if (validatedSubscriptions.length === 0) {
    return {
      event: eventType,
      subscriptions_matched: subscriptions.length,
      deliveries: { successful: 0, failed: subscriptions.length },
      results: rejectedSubscriptions.map((r) => ({
        subscription_id: r.id,
        success: false,
        error: r.error,
        duration_ms: 0,
      })),
    };
  }

  // Prepare subscriptions for batch delivery
  const webhookSubscriptions: WebhookSubscription[] = validatedSubscriptions.map((s) => ({
    id: s.id,
    url: s.url,
    secret: s.secret,
    name: s.name || undefined,
  }));

  // Deliver to all subscriptions concurrently
  const batchResult = await sendWebhookBatch(webhookSubscriptions, payload, {
    maxRetries: 3,
    baseDelayMs: 1000,
    timeoutMs: 30000,
  });

  // Process results and log
  const logEntries: WebhookLogInsert[] = [];
  const subscriptionUpdates: Array<{ id: number; success: boolean }> = [];

  for (const result of batchResult.results) {
    const subscriptionId = result.subscriptionId as number;
    const response = result.response;

    // Prepare log entry
    logEntries.push({
      subscription_id: subscriptionId,
      event_type: eventType,
      event_id: response.webhookId,
      payload: payload as unknown as Record<string, unknown>,
      response_status: response.status || null,
      response_body: response.body?.slice(0, 10000) || null,
      attempts: response.attempts,
      success: response.success,
      error_message: response.error || null,
      duration_ms: response.durationMs,
      completed_at: new Date().toISOString(),
    });

    subscriptionUpdates.push({ id: subscriptionId, success: response.success });
  }

  // Batch insert logs
  if (logEntries.length > 0) {
    const { error: logError } = await supabase
      .from('webhook_logs')
      .insert(logEntries);

    if (logError) {
      console.error('Error inserting webhook logs:', logError);
    }
  }

  // Update subscription failure counts and timestamps
  await Promise.all(
    subscriptionUpdates.map(async ({ id, success }) => {
      if (success) {
        // Reset failure count on success
        await supabase
          .from('webhook_subscriptions')
          .update({
            failure_count: 0,
            last_triggered_at: new Date().toISOString(),
            last_success_at: new Date().toISOString(),
          })
          .eq('id', id);
      } else {
        // Increment failure count
        const subscription = subscriptions.find((s) => s.id === id);
        const newFailureCount = (subscription?.failure_count || 0) + 1;

        const updateData: Record<string, unknown> = {
          failure_count: newFailureCount,
          last_triggered_at: new Date().toISOString(),
          last_failure_at: new Date().toISOString(),
        };

        // Disable subscription if too many failures
        if (newFailureCount >= MAX_FAILURE_COUNT) {
          updateData.active = false;
          console.warn(`Disabling subscription ${id} due to ${newFailureCount} consecutive failures`);
        }

        await supabase
          .from('webhook_subscriptions')
          .update(updateData)
          .eq('id', id);
      }
    })
  );

  // Build response (including rejected subscriptions)
  const allResults = [
    ...batchResult.results.map((r) => ({
      subscription_id: r.subscriptionId,
      success: r.response.success,
      status: r.response.status,
      error: r.response.error,
      duration_ms: r.response.durationMs,
    })),
    ...rejectedSubscriptions.map((r) => ({
      subscription_id: r.id,
      success: false,
      status: undefined,
      error: `Security: ${r.error}`,
      duration_ms: 0,
    })),
  ];

  return {
    event: eventType,
    subscriptions_matched: subscriptions.length,
    deliveries: {
      successful: batchResult.successful,
      failed: batchResult.failed + rejectedSubscriptions.length,
    },
    results: allResults,
  };
}
