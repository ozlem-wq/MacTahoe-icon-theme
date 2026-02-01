/**
 * n8n Webhook Dispatch Edge Function
 *
 * Receives webhook events from PostgreSQL triggers and dispatches
 * them to registered n8n webhook endpoints.
 *
 * Invocation methods:
 * 1. Direct POST with event payload (from pg_notify listener or cron)
 * 2. POST with queue_id to process queued events
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
// Environment & Configuration
// ============================================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MAX_FAILURE_COUNT = 10; // Disable subscription after this many consecutive failures
const BATCH_SIZE = 100; // Default batch size for queue processing

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
    // Verify service role or valid JWT
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return errorResponse('Missing authorization header', 401);
    }

    // Initialize Supabase client with service role
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Parse request body
    const body: DispatchRequest = await req.json();

    // Route to appropriate handler
    if (body.process_queue) {
      return await processQueue(supabase, body.batch_size || BATCH_SIZE);
    }

    if (body.queue_id) {
      return await processQueueItem(supabase, body.queue_id);
    }

    if (body.event) {
      return await dispatchEvent(supabase, body);
    }

    return errorResponse('Invalid request: must provide event, queue_id, or process_queue', 400);
  } catch (error) {
    console.error('Dispatch error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Internal server error',
      500
    );
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

  // Prepare subscriptions for batch delivery
  const webhookSubscriptions: WebhookSubscription[] = subscriptions.map((s) => ({
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

  // Build response
  return {
    event: eventType,
    subscriptions_matched: subscriptions.length,
    deliveries: {
      successful: batchResult.successful,
      failed: batchResult.failed,
    },
    results: batchResult.results.map((r) => ({
      subscription_id: r.subscriptionId,
      success: r.response.success,
      status: r.response.status,
      error: r.response.error,
      duration_ms: r.response.durationMs,
    })),
  };
}
