-- ============================================================================
-- Webhook Subscriptions Table
-- Stores n8n webhook endpoints and their event subscriptions
-- ============================================================================

-- Create enum for webhook event types
CREATE TYPE webhook_event_type AS ENUM (
    'contact.created',
    'contact.updated',
    'contact.deleted',
    'deal.created',
    'deal.updated',
    'deal.deleted',
    'company.created',
    'company.updated',
    'company.deleted',
    'task.created',
    'task.updated',
    'task.deleted',
    'note.created',
    'note.updated',
    'note.deleted'
);

-- Create webhook_subscriptions table
CREATE TABLE IF NOT EXISTS public.webhook_subscriptions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Webhook configuration
    url TEXT NOT NULL,
    events TEXT[] NOT NULL DEFAULT '{}',
    secret TEXT NOT NULL,

    -- Metadata
    name TEXT,
    description TEXT,

    -- Status
    active BOOLEAN NOT NULL DEFAULT true,
    failure_count INTEGER NOT NULL DEFAULT 0,
    last_triggered_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,

    -- Ownership
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Constraints
    CONSTRAINT valid_url CHECK (url ~ '^https?://'),
    CONSTRAINT valid_events CHECK (array_length(events, 1) > 0),
    CONSTRAINT valid_secret CHECK (length(secret) >= 32)
);

-- ============================================================================
-- Indexes for performance
-- ============================================================================

-- Primary query pattern: find active subscriptions for specific events
CREATE INDEX idx_webhook_subscriptions_active_events
    ON public.webhook_subscriptions USING GIN (events)
    WHERE active = true;

-- Find subscriptions by user
CREATE INDEX idx_webhook_subscriptions_user_id
    ON public.webhook_subscriptions (user_id);

-- Find subscriptions by status
CREATE INDEX idx_webhook_subscriptions_active
    ON public.webhook_subscriptions (active)
    WHERE active = true;

-- Composite index for event matching queries
CREATE INDEX idx_webhook_subscriptions_lookup
    ON public.webhook_subscriptions (active, user_id)
    INCLUDE (url, events, secret);

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE public.webhook_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can view their own subscriptions
CREATE POLICY "Users can view own subscriptions"
    ON public.webhook_subscriptions
    FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);

-- Users can create their own subscriptions
CREATE POLICY "Users can create own subscriptions"
    ON public.webhook_subscriptions
    FOR INSERT
    TO authenticated
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own subscriptions
CREATE POLICY "Users can update own subscriptions"
    ON public.webhook_subscriptions
    FOR UPDATE
    TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Users can delete their own subscriptions
CREATE POLICY "Users can delete own subscriptions"
    ON public.webhook_subscriptions
    FOR DELETE
    TO authenticated
    USING (auth.uid() = user_id);

-- Service role can access all subscriptions (for webhook dispatch)
CREATE POLICY "Service role full access"
    ON public.webhook_subscriptions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_webhook_subscription_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_webhook_subscription_timestamp
    BEFORE UPDATE ON public.webhook_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_webhook_subscription_timestamp();

-- ============================================================================
-- Helper Functions
-- ============================================================================

-- Function to generate a secure webhook secret
CREATE OR REPLACE FUNCTION generate_webhook_secret()
RETURNS TEXT AS $$
BEGIN
    RETURN encode(gen_random_bytes(32), 'hex');
END;
$$ LANGUAGE plpgsql;

-- Function to find matching subscriptions for an event
CREATE OR REPLACE FUNCTION find_matching_subscriptions(event_type TEXT)
RETURNS TABLE (
    id BIGINT,
    url TEXT,
    secret TEXT,
    name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        ws.id,
        ws.url,
        ws.secret,
        ws.name
    FROM public.webhook_subscriptions ws
    WHERE ws.active = true
      AND event_type = ANY(ws.events);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to service role
GRANT EXECUTE ON FUNCTION find_matching_subscriptions(TEXT) TO service_role;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE public.webhook_subscriptions IS
    'Stores webhook endpoint configurations for n8n integration';

COMMENT ON COLUMN public.webhook_subscriptions.url IS
    'The n8n webhook URL to POST events to';

COMMENT ON COLUMN public.webhook_subscriptions.events IS
    'Array of event types this subscription listens for';

COMMENT ON COLUMN public.webhook_subscriptions.secret IS
    'HMAC-SHA256 secret for signing webhook payloads';

COMMENT ON COLUMN public.webhook_subscriptions.failure_count IS
    'Consecutive failure count - subscription disabled after threshold';
