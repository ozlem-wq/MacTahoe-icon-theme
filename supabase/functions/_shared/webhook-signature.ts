/**
 * Webhook Signature Utilities
 * HMAC-SHA256 signing and verification for webhook payloads
 */

// ============================================================================
// Types
// ============================================================================

export interface SignatureOptions {
  algorithm?: 'SHA-256' | 'SHA-384' | 'SHA-512';
  encoding?: 'hex' | 'base64';
  prefix?: string;
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_OPTIONS: Required<SignatureOptions> = {
  algorithm: 'SHA-256',
  encoding: 'hex',
  prefix: 'sha256=',
};

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Sign a payload using HMAC-SHA256
 * @param payload - The payload string to sign
 * @param secret - The secret key for HMAC
 * @param options - Signature options
 * @returns The signature string (prefixed by default)
 */
export async function signPayload(
  payload: string,
  secret: string,
  options: SignatureOptions = {}
): Promise<string> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Encode the secret and payload
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const payloadData = encoder.encode(payload);

  // Import the key for HMAC
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: opts.algorithm },
    false,
    ['sign']
  );

  // Sign the payload
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, payloadData);

  // Convert to desired encoding
  const signatureString = encodeSignature(signature, opts.encoding);

  // Return with optional prefix
  return opts.prefix ? `${opts.prefix}${signatureString}` : signatureString;
}

/**
 * Verify a signature against a payload
 * @param payload - The original payload string
 * @param signature - The signature to verify (with or without prefix)
 * @param secret - The secret key used for signing
 * @param options - Signature options
 * @returns Verification result with validity and optional error
 */
export async function verifySignature(
  payload: string,
  signature: string,
  secret: string,
  options: SignatureOptions = {}
): Promise<VerificationResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  try {
    // Generate expected signature
    const expectedSignature = await signPayload(payload, secret, options);

    // Remove prefix from provided signature if present
    let cleanSignature = signature;
    if (opts.prefix && signature.startsWith(opts.prefix)) {
      cleanSignature = signature.slice(opts.prefix.length);
    }

    // Remove prefix from expected signature for comparison
    let cleanExpected = expectedSignature;
    if (opts.prefix && expectedSignature.startsWith(opts.prefix)) {
      cleanExpected = expectedSignature.slice(opts.prefix.length);
    }

    // Constant-time comparison to prevent timing attacks
    const valid = timingSafeEqual(cleanSignature, cleanExpected);

    return { valid };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Generate a secure webhook secret
 * @param length - Length of the secret in bytes (default 32 = 64 hex chars)
 * @returns A cryptographically secure random secret
 */
export function generateSecret(length: number = 32): string {
  const buffer = new Uint8Array(length);
  crypto.getRandomValues(buffer);
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a UUID-based secret (simpler alternative)
 * @returns A secret based on multiple UUIDs
 */
export function generateUuidSecret(): string {
  // Combine multiple UUIDs for sufficient entropy
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`.replace(/-/g, '');
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Encode signature buffer to string
 */
function encodeSignature(
  buffer: ArrayBuffer,
  encoding: 'hex' | 'base64'
): string {
  const bytes = new Uint8Array(buffer);

  if (encoding === 'base64') {
    return btoa(String.fromCharCode(...bytes));
  }

  // Default: hex
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

// ============================================================================
// Webhook Header Builders
// ============================================================================

export interface WebhookHeaders {
  'X-Webhook-Signature': string;
  'X-Webhook-Event': string;
  'X-Webhook-Timestamp': string;
  'X-Webhook-Id': string;
  'Content-Type': string;
}

/**
 * Build complete webhook headers for a request
 */
export async function buildWebhookHeaders(
  payload: string,
  secret: string,
  eventType: string,
  webhookId?: string
): Promise<WebhookHeaders> {
  const timestamp = Date.now().toString();
  const id = webhookId || crypto.randomUUID();

  // Sign payload with timestamp for replay protection
  const signedPayload = `${timestamp}.${payload}`;
  const signature = await signPayload(signedPayload, secret);

  return {
    'X-Webhook-Signature': signature,
    'X-Webhook-Event': eventType,
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Id': id,
    'Content-Type': 'application/json',
  };
}

/**
 * Verify webhook request with timestamp validation
 */
export async function verifyWebhookRequest(
  payload: string,
  headers: Record<string, string>,
  secret: string,
  maxAgeMs: number = 300000 // 5 minutes
): Promise<VerificationResult> {
  const signature = headers['x-webhook-signature'] || headers['X-Webhook-Signature'];
  const timestamp = headers['x-webhook-timestamp'] || headers['X-Webhook-Timestamp'];

  if (!signature) {
    return { valid: false, error: 'Missing signature header' };
  }

  if (!timestamp) {
    return { valid: false, error: 'Missing timestamp header' };
  }

  // Validate timestamp to prevent replay attacks
  const requestTime = parseInt(timestamp, 10);
  const now = Date.now();

  if (isNaN(requestTime)) {
    return { valid: false, error: 'Invalid timestamp format' };
  }

  if (now - requestTime > maxAgeMs) {
    return { valid: false, error: 'Request timestamp too old' };
  }

  if (requestTime > now + 60000) {
    return { valid: false, error: 'Request timestamp in future' };
  }

  // Verify signature
  const signedPayload = `${timestamp}.${payload}`;
  return verifySignature(signedPayload, signature, secret);
}
