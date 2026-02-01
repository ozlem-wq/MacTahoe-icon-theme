/**
 * CORS Utilities for Supabase Edge Functions
 */

// ============================================================================
// Types
// ============================================================================

export interface CorsOptions {
  /** Allowed origins (default: '*') */
  allowedOrigins?: string | string[];
  /** Allowed HTTP methods */
  allowedMethods?: string[];
  /** Allowed headers */
  allowedHeaders?: string[];
  /** Exposed headers */
  exposedHeaders?: string[];
  /** Max age for preflight cache in seconds */
  maxAge?: number;
  /** Allow credentials */
  credentials?: boolean;
}

// ============================================================================
// Default CORS Headers
// ============================================================================

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-signature, x-webhook-event, x-webhook-timestamp, x-webhook-id',
  'Access-Control-Max-Age': '86400',
};

// ============================================================================
// CORS Handler Functions
// ============================================================================

/**
 * Handle CORS preflight request
 * Returns a Response for OPTIONS requests, null otherwise
 */
export function handleCors(req: Request, options?: CorsOptions): Response | null {
  // Only handle OPTIONS requests
  if (req.method !== 'OPTIONS') {
    return null;
  }

  const headers = buildCorsHeaders(req, options);
  return new Response(null, { status: 204, headers });
}

/**
 * Build CORS headers based on request and options
 */
export function buildCorsHeaders(
  req: Request,
  options: CorsOptions = {}
): Record<string, string> {
  const headers: Record<string, string> = {};

  // Handle origin
  const origin = req.headers.get('Origin');
  const allowedOrigins = options.allowedOrigins;

  if (allowedOrigins) {
    if (Array.isArray(allowedOrigins)) {
      // Check if request origin is in allowed list
      if (origin && allowedOrigins.includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Vary'] = 'Origin';
      } else if (allowedOrigins.includes('*')) {
        headers['Access-Control-Allow-Origin'] = '*';
      }
    } else if (allowedOrigins === '*') {
      headers['Access-Control-Allow-Origin'] = '*';
    } else if (origin === allowedOrigins) {
      headers['Access-Control-Allow-Origin'] = allowedOrigins;
      headers['Vary'] = 'Origin';
    }
  } else {
    headers['Access-Control-Allow-Origin'] = '*';
  }

  // Allowed methods
  const methods = options.allowedMethods || [
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'
  ];
  headers['Access-Control-Allow-Methods'] = methods.join(', ');

  // Allowed headers
  const allowedHeaders = options.allowedHeaders || [
    'authorization',
    'x-client-info',
    'apikey',
    'content-type',
    'x-webhook-signature',
    'x-webhook-event',
    'x-webhook-timestamp',
    'x-webhook-id',
  ];
  headers['Access-Control-Allow-Headers'] = allowedHeaders.join(', ');

  // Exposed headers
  if (options.exposedHeaders && options.exposedHeaders.length > 0) {
    headers['Access-Control-Expose-Headers'] = options.exposedHeaders.join(', ');
  }

  // Max age
  headers['Access-Control-Max-Age'] = String(options.maxAge || 86400);

  // Credentials
  if (options.credentials) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  return headers;
}

/**
 * Add CORS headers to an existing Response
 */
export function withCors(
  response: Response,
  req?: Request,
  options?: CorsOptions
): Response {
  const corsHeadersToApply = req
    ? buildCorsHeaders(req, options)
    : corsHeaders;

  const newHeaders = new Headers(response.headers);

  for (const [key, value] of Object.entries(corsHeadersToApply)) {
    newHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// ============================================================================
// Response Helpers with CORS
// ============================================================================

/**
 * Create a JSON response with CORS headers
 */
export function jsonResponse(
  data: unknown,
  status: number = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

/**
 * Create an error response with CORS headers
 */
export function errorResponse(
  message: string,
  status: number = 400,
  code?: string,
  details?: unknown
): Response {
  return jsonResponse(
    {
      error: message,
      code: code || `HTTP_${status}`,
      details,
    },
    status
  );
}

/**
 * Create a success response with CORS headers
 */
export function successResponse(
  data: unknown,
  message?: string
): Response {
  return jsonResponse({
    success: true,
    message,
    data,
  });
}

/**
 * Create a 204 No Content response with CORS headers
 */
export function noContentResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// ============================================================================
// CORS Middleware Pattern
// ============================================================================

export type RequestHandler = (req: Request) => Promise<Response> | Response;

/**
 * Wrap a handler with CORS support
 */
export function withCorsMiddleware(
  handler: RequestHandler,
  options?: CorsOptions
): RequestHandler {
  return async (req: Request): Promise<Response> => {
    // Handle preflight
    const preflightResponse = handleCors(req, options);
    if (preflightResponse) {
      return preflightResponse;
    }

    // Execute handler
    const response = await handler(req);

    // Add CORS headers
    return withCors(response, req, options);
  };
}
