-- ============================================================================
-- Webhook Logs Table
-- Stores webhook delivery attempts and their results
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.webhook_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Reference to subscription
    subscription_id BIGINT NOT NULL REFERENCES public.webhook_subscriptions(id) ON DELETE CASCADE,

    -- Event information
    event_type TEXT NOT NULL,
    event_id UUID NOT NULL DEFAULT gen_random_uuid(),

    -- Payload sent
    payload JSONB NOT NULL,

    -- Response details
    response_status INTEGER,
    response_body TEXT,
    response_headers JSONB,

    -- Delivery tracking
    attempts INTEGER NOT NULL DEFAULT 1,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    success BOOLEAN NOT NULL DEFAULT false,

    -- Error tracking
    error_message TEXT,
    error_code TEXT,

    -- Timing
    duration_ms INTEGER,
    next_retry_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Find logs by subscription
CREATE INDEX idx_webhook_logs_subscription_id
    ON public.webhook_logs (subscription_id);

-- Find recent logs
CREATE INDEX idx_webhook_logs_created_at
    ON public.webhook_logs (created_at DESC);

-- Find failed deliveries for retry
CREATE INDEX idx_webhook_logs_pending_retry
    ON public.webhook_logs (next_retry_at)
    WHERE success = false AND attempts < max_attempts;

-- Find logs by event type
CREATE INDEX idx_webhook_logs_event_type
    ON public.webhook_logs (event_type, created_at DESC);

-- Find logs by success status
CREATE INDEX idx_webhook_logs_success
    ON public.webhook_logs (success, created_at DESC);

-- Composite index for subscription analytics
CREATE INDEX idx_webhook_logs_subscription_analytics
    ON public.webhook_logs (subscription_id, success, created_at DESC);

-- ============================================================================
-- Partitioning (Optional - for high-volume systems)
-- ============================================================================

-- If you expect high volume, consider partitioning by created_at
-- This is commented out as it requires additional setup

-- CREATE TABLE public.webhook_logs (
--     ...
-- ) PARTITION BY RANGE (created_at);
--
-- CREATE TABLE webhook_logs_2026_01 PARTITION OF webhook_logs
--     FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;

-- Users can view logs for their own subscriptions
CREATE POLICY "Users can view own subscription logs"
    ON public.webhook_logs
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.webhook_subscriptions ws
            WHERE ws.id = subscription_id
              AND ws.user_id = auth.uid()
        )
    );

-- Only service role can insert logs (from edge function)
CREATE POLICY "Service role can insert logs"
    ON public.webhook_logs
    FOR INSERT
    TO service_role
    WITH CHECK (true);

-- Only service role can update logs (for retry tracking)
CREATE POLICY "Service role can update logs"
    ON public.webhook_logs
    FOR UPDATE
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Users can delete logs for their own subscriptions
CREATE POLICY "Users can delete own subscription logs"
    ON public.webhook_logs
    FOR DELETE
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.webhook_subscriptions ws
            WHERE ws.id = subscription_id
              AND ws.user_id = auth.uid()
        )
    );

-- Service role full access
CREATE POLICY "Service role full access to logs"
    ON public.webhook_logs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- ============================================================================
-- Auto-cleanup: Delete logs older than 7 days
-- ============================================================================

-- Create cleanup function
CREATE OR REPLACE FUNCTION cleanup_old_webhook_logs()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    WITH deleted AS (
        DELETE FROM public.webhook_logs
        WHERE created_at < NOW() - INTERVAL '7 days'
        RETURNING id
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;

    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to service role
GRANT EXECUTE ON FUNCTION cleanup_old_webhook_logs() TO service_role;

-- ============================================================================
-- Scheduled cleanup using pg_cron (if available)
-- ============================================================================

-- Uncomment if pg_cron extension is enabled:
-- SELECT cron.schedule(
--     'cleanup-webhook-logs',
--     '0 3 * * *',  -- Run daily at 3 AM
--     $$SELECT cleanup_old_webhook_logs()$$
-- );

-- Alternative: Create a cron job via Supabase Dashboard or external scheduler
-- that calls the cleanup_old_webhook_logs() function

-- ============================================================================
-- Helper Views
-- ============================================================================

-- View for subscription delivery stats
CREATE OR REPLACE VIEW public.webhook_subscription_stats AS
SELECT
    ws.id AS subscription_id,
    ws.name AS subscription_name,
    ws.url,
    ws.active,
    COUNT(wl.id) AS total_deliveries,
    COUNT(wl.id) FILTER (WHERE wl.success = true) AS successful_deliveries,
    COUNT(wl.id) FILTER (WHERE wl.success = false) AS failed_deliveries,
    ROUND(
        100.0 * COUNT(wl.id) FILTER (WHERE wl.success = true) / NULLIF(COUNT(wl.id), 0),
        2
    ) AS success_rate,
    AVG(wl.duration_ms) FILTER (WHERE wl.success = true) AS avg_duration_ms,
    MAX(wl.created_at) AS last_delivery_at
FROM public.webhook_subscriptions ws
LEFT JOIN public.webhook_logs wl ON ws.id = wl.subscription_id
GROUP BY ws.id, ws.name, ws.url, ws.active;

-- Grant access to authenticated users (filtered by RLS on underlying tables)
GRANT SELECT ON public.webhook_subscription_stats TO authenticated;

-- ============================================================================
-- Analytics Functions
-- ============================================================================

-- Get recent delivery history for a subscription
CREATE OR REPLACE FUNCTION get_webhook_delivery_history(
    p_subscription_id BIGINT,
    p_limit INTEGER DEFAULT 50
)
RETURNS TABLE (
    id BIGINT,
    event_type TEXT,
    event_id UUID,
    success BOOLEAN,
    attempts INTEGER,
    response_status INTEGER,
    duration_ms INTEGER,
    error_message TEXT,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        wl.id,
        wl.event_type,
        wl.event_id,
        wl.success,
        wl.attempts,
        wl.response_status,
        wl.duration_ms,
        wl.error_message,
        wl.created_at
    FROM public.webhook_logs wl
    JOIN public.webhook_subscriptions ws ON ws.id = wl.subscription_id
    WHERE wl.subscription_id = p_subscription_id
      AND ws.user_id = auth.uid()
    ORDER BY wl.created_at DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON TABLE public.webhook_logs IS
    'Stores webhook delivery attempts, responses, and retry information';

COMMENT ON COLUMN public.webhook_logs.event_id IS
    'Unique identifier for this event delivery, useful for deduplication';

COMMENT ON COLUMN public.webhook_logs.attempts IS
    'Number of delivery attempts made for this event';

COMMENT ON COLUMN public.webhook_logs.next_retry_at IS
    'When to retry failed delivery, null if successful or max attempts reached';

COMMENT ON FUNCTION cleanup_old_webhook_logs() IS
    'Deletes webhook logs older than 7 days, returns count of deleted records';
