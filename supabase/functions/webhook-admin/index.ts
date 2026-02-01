/**
 * Webhook Administration Edge Function
 *
 * RESTful API for managing webhook subscriptions:
 * - POST /   - Create subscription
 * - GET /    - List subscriptions
 * - GET /:id - Get single subscription
 * - PATCH /:id - Update subscription
 * - DELETE /:id - Delete subscription
 * - GET /:id/logs - Get delivery logs
 * - POST /:id/test - Test webhook delivery
 */

import { createClient, SupabaseClient, User } from 'https://esm.sh/@supabase/supabase-js@2.39.0';
import { generateSecret } from '../_shared/webhook-signature.ts';
import { sendWebhookOnce, WebhookPayload } from '../_shared/webhook-client.ts';
import {
  handleCors,
  jsonResponse,
  errorResponse,
  noContentResponse,
} from '../_shared/cors.ts';

// ============================================================================
// Types
// ============================================================================

interface CreateSubscriptionInput {
  url: string;
  events: string[];
  name?: string;
  description?: string;
  secret?: string; // Optional, auto-generated if not provided
}

interface UpdateSubscriptionInput {
  url?: string;
  events?: string[];
  name?: string;
  description?: string;
  active?: boolean;
  secret?: string;
}

interface SubscriptionResponse {
  id: number;
  url: string;
  events: string[];
  name: string | null;
  description: string | null;
  active: boolean;
  failure_count: number;
  last_triggered_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
  updated_at: string;
  // Secret only included on create
  secret?: string;
}

interface WebhookLogResponse {
  id: number;
  event_type: string;
  event_id: string;
  success: boolean;
  attempts: number;
  response_status: number | null;
  error_message: string | null;
  duration_ms: number;
  created_at: string;
}

// Available webhook event types
const VALID_EVENTS = [
  'contact.created', 'contact.updated', 'contact.deleted',
  'deal.created', 'deal.updated', 'deal.deleted',
  'company.created', 'company.updated', 'company.deleted',
  'task.created', 'task.updated', 'task.deleted',
  'note.created', 'note.updated', 'note.deleted',
  'activity.created', 'activity.updated', 'activity.deleted',
] as const;

// ============================================================================
// Environment & Configuration
// ============================================================================

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

// ============================================================================
// Validation Functions
// ============================================================================

function validateUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'URL must use http or https protocol';
    }
    return null;
  } catch {
    return 'Invalid URL format';
  }
}

function validateEvents(events: unknown): string | null {
  if (!Array.isArray(events)) {
    return 'Events must be an array';
  }

  if (events.length === 0) {
    return 'At least one event is required';
  }

  const invalidEvents = events.filter((e) => !VALID_EVENTS.includes(e));
  if (invalidEvents.length > 0) {
    return `Invalid events: ${invalidEvents.join(', ')}. Valid events: ${VALID_EVENTS.join(', ')}`;
  }

  return null;
}

function validateCreateInput(input: unknown): CreateSubscriptionInput | string {
  if (!input || typeof input !== 'object') {
    return 'Request body must be an object';
  }

  const obj = input as Record<string, unknown>;

  // Validate URL
  if (!obj.url || typeof obj.url !== 'string') {
    return 'url is required and must be a string';
  }
  const urlError = validateUrl(obj.url);
  if (urlError) return urlError;

  // Validate events
  if (!obj.events) {
    return 'events is required';
  }
  const eventsError = validateEvents(obj.events);
  if (eventsError) return eventsError;

  // Validate optional fields
  if (obj.name !== undefined && typeof obj.name !== 'string') {
    return 'name must be a string';
  }

  if (obj.description !== undefined && typeof obj.description !== 'string') {
    return 'description must be a string';
  }

  if (obj.secret !== undefined) {
    if (typeof obj.secret !== 'string') {
      return 'secret must be a string';
    }
    if (obj.secret.length < 32) {
      return 'secret must be at least 32 characters';
    }
  }

  return {
    url: obj.url,
    events: obj.events as string[],
    name: obj.name as string | undefined,
    description: obj.description as string | undefined,
    secret: obj.secret as string | undefined,
  };
}

function validateUpdateInput(input: unknown): UpdateSubscriptionInput | string {
  if (!input || typeof input !== 'object') {
    return 'Request body must be an object';
  }

  const obj = input as Record<string, unknown>;
  const result: UpdateSubscriptionInput = {};

  if (obj.url !== undefined) {
    if (typeof obj.url !== 'string') {
      return 'url must be a string';
    }
    const urlError = validateUrl(obj.url);
    if (urlError) return urlError;
    result.url = obj.url;
  }

  if (obj.events !== undefined) {
    const eventsError = validateEvents(obj.events);
    if (eventsError) return eventsError;
    result.events = obj.events as string[];
  }

  if (obj.name !== undefined) {
    if (obj.name !== null && typeof obj.name !== 'string') {
      return 'name must be a string or null';
    }
    result.name = obj.name as string | undefined;
  }

  if (obj.description !== undefined) {
    if (obj.description !== null && typeof obj.description !== 'string') {
      return 'description must be a string or null';
    }
    result.description = obj.description as string | undefined;
  }

  if (obj.active !== undefined) {
    if (typeof obj.active !== 'boolean') {
      return 'active must be a boolean';
    }
    result.active = obj.active;
  }

  if (obj.secret !== undefined) {
    if (typeof obj.secret !== 'string') {
      return 'secret must be a string';
    }
    if (obj.secret.length < 32) {
      return 'secret must be at least 32 characters';
    }
    result.secret = obj.secret;
  }

  if (Object.keys(result).length === 0) {
    return 'At least one field to update is required';
  }

  return result;
}

// ============================================================================
// Route Parsing
// ============================================================================

interface ParsedRoute {
  subscriptionId?: number;
  action?: 'logs' | 'test';
}

function parseRoute(pathname: string): ParsedRoute {
  // Remove /webhook-admin prefix if present
  const cleanPath = pathname.replace(/^\/webhook-admin\/?/, '');
  const segments = cleanPath.split('/').filter(Boolean);

  if (segments.length === 0) {
    return {};
  }

  const id = parseInt(segments[0], 10);
  if (isNaN(id)) {
    return {};
  }

  if (segments.length === 1) {
    return { subscriptionId: id };
  }

  if (segments[1] === 'logs') {
    return { subscriptionId: id, action: 'logs' };
  }

  if (segments[1] === 'test') {
    return { subscriptionId: id, action: 'test' };
  }

  return { subscriptionId: id };
}

// ============================================================================
// Main Handler
// ============================================================================

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Authenticate user
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse('Missing or invalid authorization header', 401);
    }

    const token = authHeader.replace('Bearer ', '');

    // Create Supabase client with user's token
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: { Authorization: `Bearer ${token}` },
      },
    });

    // Verify user
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return errorResponse('Invalid or expired token', 401);
    }

    // Parse route
    const url = new URL(req.url);
    const route = parseRoute(url.pathname);

    // Route to handler
    switch (req.method) {
      case 'GET':
        if (route.action === 'logs' && route.subscriptionId) {
          return await getSubscriptionLogs(supabase, user, route.subscriptionId, url.searchParams);
        }
        if (route.subscriptionId) {
          return await getSubscription(supabase, user, route.subscriptionId);
        }
        return await listSubscriptions(supabase, user, url.searchParams);

      case 'POST':
        if (route.action === 'test' && route.subscriptionId) {
          return await testSubscription(supabase, user, route.subscriptionId);
        }
        return await createSubscription(supabase, user, await req.json());

      case 'PATCH':
        if (!route.subscriptionId) {
          return errorResponse('Subscription ID required', 400);
        }
        return await updateSubscription(supabase, user, route.subscriptionId, await req.json());

      case 'DELETE':
        if (!route.subscriptionId) {
          return errorResponse('Subscription ID required', 400);
        }
        return await deleteSubscription(supabase, user, route.subscriptionId);

      default:
        return errorResponse('Method not allowed', 405);
    }
  } catch (error) {
    console.error('Admin API error:', error);
    return errorResponse(
      error instanceof Error ? error.message : 'Internal server error',
      500
    );
  }
});

// ============================================================================
// Handler Functions
// ============================================================================

async function listSubscriptions(
  supabase: SupabaseClient,
  user: User,
  params: URLSearchParams
): Promise<Response> {
  const limit = Math.min(parseInt(params.get('limit') || '50', 10), 100);
  const offset = parseInt(params.get('offset') || '0', 10);
  const active = params.get('active');

  let query = supabase
    .from('webhook_subscriptions')
    .select('id, url, events, name, description, active, failure_count, last_triggered_at, last_success_at, last_failure_at, created_at, updated_at', { count: 'exact' })
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (active !== null) {
    query = query.eq('active', active === 'true');
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('List subscriptions error:', error);
    return errorResponse('Failed to list subscriptions', 500);
  }

  return jsonResponse({
    subscriptions: data,
    pagination: {
      total: count,
      limit,
      offset,
      has_more: count !== null && offset + limit < count,
    },
  });
}

async function getSubscription(
  supabase: SupabaseClient,
  user: User,
  subscriptionId: number
): Promise<Response> {
  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, events, name, description, active, failure_count, last_triggered_at, last_success_at, last_failure_at, created_at, updated_at')
    .eq('id', subscriptionId)
    .eq('user_id', user.id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return errorResponse('Subscription not found', 404);
    }
    console.error('Get subscription error:', error);
    return errorResponse('Failed to get subscription', 500);
  }

  return jsonResponse({ subscription: data });
}

async function createSubscription(
  supabase: SupabaseClient,
  user: User,
  body: unknown
): Promise<Response> {
  // Validate input
  const validation = validateCreateInput(body);
  if (typeof validation === 'string') {
    return errorResponse(validation, 400);
  }

  const input = validation;
  const secret = input.secret || generateSecret();

  // Insert subscription
  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .insert({
      user_id: user.id,
      url: input.url,
      events: input.events,
      name: input.name || null,
      description: input.description || null,
      secret,
    })
    .select('id, url, events, name, description, active, failure_count, created_at, updated_at')
    .single();

  if (error) {
    console.error('Create subscription error:', error);
    return errorResponse('Failed to create subscription', 500);
  }

  // Return subscription with secret (only shown on create)
  return jsonResponse(
    {
      subscription: {
        ...data,
        secret,
      },
      message: 'Subscription created. Store the secret securely - it will not be shown again.',
    },
    201
  );
}

async function updateSubscription(
  supabase: SupabaseClient,
  user: User,
  subscriptionId: number,
  body: unknown
): Promise<Response> {
  // Validate input
  const validation = validateUpdateInput(body);
  if (typeof validation === 'string') {
    return errorResponse(validation, 400);
  }

  const input = validation;

  // Build update object
  const updateData: Record<string, unknown> = {};
  if (input.url !== undefined) updateData.url = input.url;
  if (input.events !== undefined) updateData.events = input.events;
  if (input.name !== undefined) updateData.name = input.name;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.active !== undefined) updateData.active = input.active;
  if (input.secret !== undefined) updateData.secret = input.secret;

  // Reset failure count if reactivating
  if (input.active === true) {
    updateData.failure_count = 0;
  }

  // Update subscription
  const { data, error } = await supabase
    .from('webhook_subscriptions')
    .update(updateData)
    .eq('id', subscriptionId)
    .eq('user_id', user.id)
    .select('id, url, events, name, description, active, failure_count, last_triggered_at, last_success_at, last_failure_at, created_at, updated_at')
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return errorResponse('Subscription not found', 404);
    }
    console.error('Update subscription error:', error);
    return errorResponse('Failed to update subscription', 500);
  }

  return jsonResponse({ subscription: data });
}

async function deleteSubscription(
  supabase: SupabaseClient,
  user: User,
  subscriptionId: number
): Promise<Response> {
  const { error, count } = await supabase
    .from('webhook_subscriptions')
    .delete({ count: 'exact' })
    .eq('id', subscriptionId)
    .eq('user_id', user.id);

  if (error) {
    console.error('Delete subscription error:', error);
    return errorResponse('Failed to delete subscription', 500);
  }

  if (count === 0) {
    return errorResponse('Subscription not found', 404);
  }

  return noContentResponse();
}

async function getSubscriptionLogs(
  supabase: SupabaseClient,
  user: User,
  subscriptionId: number,
  params: URLSearchParams
): Promise<Response> {
  // Verify subscription belongs to user
  const { data: subscription, error: subError } = await supabase
    .from('webhook_subscriptions')
    .select('id')
    .eq('id', subscriptionId)
    .eq('user_id', user.id)
    .single();

  if (subError || !subscription) {
    return errorResponse('Subscription not found', 404);
  }

  // Parse query params
  const limit = Math.min(parseInt(params.get('limit') || '50', 10), 100);
  const offset = parseInt(params.get('offset') || '0', 10);
  const success = params.get('success');

  let query = supabase
    .from('webhook_logs')
    .select('id, event_type, event_id, success, attempts, response_status, error_message, duration_ms, created_at', { count: 'exact' })
    .eq('subscription_id', subscriptionId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (success !== null) {
    query = query.eq('success', success === 'true');
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('Get logs error:', error);
    return errorResponse('Failed to get logs', 500);
  }

  return jsonResponse({
    logs: data,
    pagination: {
      total: count,
      limit,
      offset,
      has_more: count !== null && offset + limit < count,
    },
  });
}

async function testSubscription(
  supabase: SupabaseClient,
  user: User,
  subscriptionId: number
): Promise<Response> {
  // Get subscription with secret
  const { data: subscription, error: subError } = await supabase
    .from('webhook_subscriptions')
    .select('id, url, secret, events')
    .eq('id', subscriptionId)
    .eq('user_id', user.id)
    .single();

  if (subError || !subscription) {
    return errorResponse('Subscription not found', 404);
  }

  // Create test payload
  const testPayload: WebhookPayload = {
    event: 'test.ping',
    table: 'test',
    action: 'ping',
    data: {
      message: 'This is a test webhook from your CRM',
      subscription_id: subscription.id,
      timestamp: new Date().toISOString(),
    },
    old_data: null,
    metadata: {
      triggered_at: new Date().toISOString(),
      test: true,
    },
    timestamp: Date.now() / 1000,
  };

  // Send test webhook
  const result = await sendWebhookOnce(
    subscription.url,
    testPayload,
    subscription.secret,
    { timeoutMs: 10000 }
  );

  return jsonResponse({
    test_result: {
      success: result.success,
      status: result.status,
      duration_ms: result.durationMs,
      error: result.error,
      response_preview: result.body?.slice(0, 500),
    },
  });
}
