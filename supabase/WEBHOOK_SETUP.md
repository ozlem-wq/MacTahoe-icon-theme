# n8n Webhook System Setup Guide

This guide covers the complete setup of the outbound webhook system for n8n integration.

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   CRM Tables    │────▶│  PostgreSQL      │────▶│  n8n Dispatch   │
│ (contacts, etc) │     │  Triggers        │     │  Edge Function  │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                        ┌──────────────────┐              │
                        │  webhook_logs    │◀─────────────┤
                        └──────────────────┘              │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Slack/Email   │◀────│      n8n         │◀────│  Your Webhook   │
│   Analytics     │     │    Workflow      │     │    Endpoint     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## 1. Database Setup

### Run Migrations

```bash
# Using Supabase CLI
supabase db push

# Or run migrations manually
psql -f migrations/20260202_webhook_subscriptions.sql
psql -f migrations/20260202_webhook_logs.sql
psql -f migrations/20260202_webhook_triggers.sql
```

### Add Triggers to Your Tables

If your CRM tables already exist, add webhook triggers:

```sql
-- Add to existing tables
SELECT add_webhook_trigger('contacts');
SELECT add_webhook_trigger('deals');
SELECT add_webhook_trigger('companies');
SELECT add_webhook_trigger('tasks');
SELECT add_webhook_trigger('notes');
```

## 2. Deploy Edge Functions

```bash
# Deploy all functions
supabase functions deploy n8n-dispatch
supabase functions deploy webhook-admin

# Set secrets
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

## 3. Create Webhook Subscription

### Using the Admin API

```bash
# Get your access token
TOKEN="your-supabase-jwt-token"

# Create a subscription
curl -X POST "https://your-project.supabase.co/functions/v1/webhook-admin" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-n8n-instance.com/webhook/crm-contact-webhook",
    "events": ["contact.created", "contact.updated", "deal.created", "deal.updated"],
    "name": "n8n CRM Integration"
  }'
```

Response:
```json
{
  "subscription": {
    "id": 1,
    "url": "https://your-n8n-instance.com/webhook/crm-contact-webhook",
    "events": ["contact.created", "contact.updated", "deal.created", "deal.updated"],
    "name": "n8n CRM Integration",
    "active": true,
    "secret": "a1b2c3d4e5f6..."
  },
  "message": "Subscription created. Store the secret securely - it will not be shown again."
}
```

**Important:** Save the `secret` value - you'll need it in n8n to verify webhook signatures.

### Using SQL Directly

```sql
INSERT INTO webhook_subscriptions (user_id, url, events, name, secret)
VALUES (
  auth.uid(),
  'https://your-n8n-instance.com/webhook/crm-contact-webhook',
  ARRAY['contact.created', 'contact.updated'],
  'n8n Integration',
  encode(gen_random_bytes(32), 'hex')
);
```

## 4. n8n Workflow Setup

### Import the Example Workflow

1. Open n8n
2. Go to **Settings** → **Import from file**
3. Select `examples/n8n-workflow-contact-created.json`

### Configure Environment Variables

In n8n, set these environment variables:

| Variable | Description |
|----------|-------------|
| `WEBHOOK_SECRET` | The secret from your subscription |
| `SLACK_CHANNEL_ID` | Slack channel for notifications |
| `CRM_BASE_URL` | Your CRM frontend URL |

### Signature Verification

The example workflow includes signature verification. The algorithm:

```javascript
// Payload signature format
const signedPayload = `${timestamp}.${bodyString}`;
const signature = 'sha256=' + HMAC_SHA256(signedPayload, secret);
```

Headers sent with each webhook:
- `X-Webhook-Signature`: HMAC-SHA256 signature
- `X-Webhook-Timestamp`: Unix timestamp (ms)
- `X-Webhook-Id`: Unique delivery ID
- `X-Webhook-Event`: Event type (e.g., "contact.created")

## 5. Available Events

| Event | Description |
|-------|-------------|
| `contact.created` | New contact added |
| `contact.updated` | Contact details changed |
| `contact.deleted` | Contact removed |
| `deal.created` | New deal created |
| `deal.updated` | Deal details/stage changed |
| `deal.deleted` | Deal removed |
| `company.created` | New company added |
| `company.updated` | Company details changed |
| `company.deleted` | Company removed |
| `task.created` | New task created |
| `task.updated` | Task modified |
| `task.deleted` | Task removed |
| `note.created` | New note added |
| `note.updated` | Note edited |
| `note.deleted` | Note removed |

## 6. Webhook Payload Format

```json
{
  "event": "contact.created",
  "table": "contacts",
  "action": "created",
  "data": {
    "id": 123,
    "first_name": "John",
    "last_name": "Doe",
    "email": "john@example.com",
    "created_at": "2026-02-02T10:30:00Z"
  },
  "old_data": null,
  "metadata": {
    "triggered_at": "2026-02-02T10:30:00.123Z",
    "transaction_id": 12345,
    "changed_fields": ["email", "phone"]
  },
  "timestamp": 1738494600.123
}
```

## 7. Admin API Reference

### List Subscriptions
```bash
GET /webhook-admin
GET /webhook-admin?active=true&limit=10&offset=0
```

### Get Subscription
```bash
GET /webhook-admin/{id}
```

### Create Subscription
```bash
POST /webhook-admin
{
  "url": "https://...",
  "events": ["contact.created"],
  "name": "Optional name",
  "description": "Optional description"
}
```

### Update Subscription
```bash
PATCH /webhook-admin/{id}
{
  "active": false,
  "events": ["contact.created", "contact.updated"]
}
```

### Delete Subscription
```bash
DELETE /webhook-admin/{id}
```

### Get Delivery Logs
```bash
GET /webhook-admin/{id}/logs
GET /webhook-admin/{id}/logs?success=false&limit=20
```

### Test Subscription
```bash
POST /webhook-admin/{id}/test
```

## 8. Monitoring & Debugging

### Check Delivery Stats

```sql
SELECT * FROM webhook_subscription_stats;
```

### View Recent Failures

```sql
SELECT
  ws.name,
  wl.event_type,
  wl.error_message,
  wl.attempts,
  wl.created_at
FROM webhook_logs wl
JOIN webhook_subscriptions ws ON ws.id = wl.subscription_id
WHERE wl.success = false
ORDER BY wl.created_at DESC
LIMIT 20;
```

### Manual Queue Processing

```sql
-- Check queue status
SELECT status, COUNT(*)
FROM webhook_event_queue
GROUP BY status;

-- Reprocess failed events
UPDATE webhook_event_queue
SET status = 'pending', next_attempt_at = NOW()
WHERE status = 'failed';
```

## 9. Scheduled Tasks

### Set Up Log Cleanup (pg_cron)

```sql
-- Enable pg_cron extension
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule daily cleanup at 3 AM
SELECT cron.schedule(
  'cleanup-webhook-logs',
  '0 3 * * *',
  $$SELECT cleanup_old_webhook_logs()$$
);

-- Schedule queue cleanup
SELECT cron.schedule(
  'cleanup-webhook-queue',
  '0 4 * * *',
  $$SELECT cleanup_webhook_queue(7)$$
);
```

### Alternative: External Cron

If pg_cron isn't available, use an external scheduler to call:

```bash
# Daily cleanup
curl -X POST "https://your-project.supabase.co/rest/v1/rpc/cleanup_old_webhook_logs" \
  -H "apikey: YOUR_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY"
```

## 10. Security Considerations

1. **Secret Management**: Never expose webhook secrets in logs or responses
2. **Signature Verification**: Always verify signatures in n8n workflows
3. **Timestamp Validation**: Reject requests older than 5 minutes
4. **HTTPS Only**: Only register HTTPS webhook URLs
5. **Rate Limiting**: Consider adding rate limits for high-volume events
6. **Failure Threshold**: Subscriptions auto-disable after 10 consecutive failures

## Troubleshooting

### Webhooks Not Firing

1. Check trigger exists: `SELECT * FROM pg_trigger WHERE tgname LIKE 'trigger_%_webhook';`
2. Verify subscription is active: `SELECT * FROM webhook_subscriptions WHERE active = true;`
3. Check event type matches: Ensure subscription events include the event being triggered

### Signature Verification Failing

1. Ensure you're using the raw request body (not parsed JSON)
2. Check timestamp format (milliseconds, not seconds)
3. Verify secret matches exactly (no extra whitespace)

### High Failure Count

1. Check webhook URL is accessible
2. Verify n8n workflow is active
3. Check for timeout issues (increase timeout or optimize workflow)
