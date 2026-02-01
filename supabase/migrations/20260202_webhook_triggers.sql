-- ============================================================================
-- Webhook Trigger Functions
-- Captures changes on CRM tables and notifies webhook dispatch system
-- ============================================================================

-- ============================================================================
-- Core Webhook Notification Function
-- ============================================================================

CREATE OR REPLACE FUNCTION notify_webhook()
RETURNS TRIGGER AS $$
DECLARE
    event_type TEXT;
    payload JSONB;
    table_name TEXT;
    action TEXT;
    record_data JSONB;
    old_data JSONB;
    changed_fields TEXT[];
    metadata JSONB;
BEGIN
    -- Determine table and action
    table_name := TG_TABLE_NAME;
    action := LOWER(TG_OP);

    -- Build event type: {table}.{action}
    -- Singularize common table names
    CASE table_name
        WHEN 'contacts' THEN event_type := 'contact.' || action;
        WHEN 'deals' THEN event_type := 'deal.' || action;
        WHEN 'companies' THEN event_type := 'company.' || action;
        WHEN 'tasks' THEN event_type := 'task.' || action;
        WHEN 'notes' THEN event_type := 'note.' || action;
        WHEN 'activities' THEN event_type := 'activity.' || action;
        WHEN 'deal_stages' THEN event_type := 'deal_stage.' || action;
        WHEN 'tags' THEN event_type := 'tag.' || action;
        ELSE event_type := table_name || '.' || action;
    END CASE;

    -- Set record data based on operation
    CASE TG_OP
        WHEN 'INSERT' THEN
            record_data := to_jsonb(NEW);
            old_data := NULL;
        WHEN 'UPDATE' THEN
            record_data := to_jsonb(NEW);
            old_data := to_jsonb(OLD);
            -- Calculate changed fields
            SELECT array_agg(key) INTO changed_fields
            FROM (
                SELECT key
                FROM jsonb_each(to_jsonb(NEW))
                EXCEPT
                SELECT key
                FROM jsonb_each(to_jsonb(OLD))
                WHERE to_jsonb(NEW) -> key = to_jsonb(OLD) -> key
            ) diff;
        WHEN 'DELETE' THEN
            record_data := to_jsonb(OLD);
            old_data := NULL;
    END CASE;

    -- Build metadata
    metadata := jsonb_build_object(
        'triggered_at', NOW(),
        'transaction_id', txid_current(),
        'schema', TG_TABLE_SCHEMA,
        'trigger_name', TG_NAME
    );

    -- Add changed fields for updates
    IF TG_OP = 'UPDATE' AND changed_fields IS NOT NULL THEN
        metadata := metadata || jsonb_build_object('changed_fields', to_jsonb(changed_fields));
    END IF;

    -- Build complete payload
    payload := jsonb_build_object(
        'event', event_type,
        'table', table_name,
        'schema', TG_TABLE_SCHEMA,
        'action', action,
        'data', record_data,
        'old_data', old_data,
        'metadata', metadata,
        'timestamp', extract(epoch from now())
    );

    -- Send notification to webhook processor
    PERFORM pg_notify('webhook_events', payload::text);

    -- Return appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Alternative: Queue-based approach for reliability
-- ============================================================================

-- Create webhook event queue table
CREATE TABLE IF NOT EXISTS public.webhook_event_queue (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
    error_message TEXT,

    CONSTRAINT valid_status CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
);

-- Index for efficient queue processing
CREATE INDEX idx_webhook_queue_pending
    ON public.webhook_event_queue (next_attempt_at)
    WHERE status = 'pending';

CREATE INDEX idx_webhook_queue_cleanup
    ON public.webhook_event_queue (created_at)
    WHERE status IN ('completed', 'failed');

-- Queue-based notification function (more reliable than pg_notify)
CREATE OR REPLACE FUNCTION queue_webhook_event()
RETURNS TRIGGER AS $$
DECLARE
    event_type TEXT;
    payload JSONB;
    table_name TEXT;
    action TEXT;
    record_data JSONB;
    old_data JSONB;
    changed_fields TEXT[];
BEGIN
    table_name := TG_TABLE_NAME;
    action := LOWER(TG_OP);

    -- Build event type
    CASE table_name
        WHEN 'contacts' THEN event_type := 'contact.' || action;
        WHEN 'deals' THEN event_type := 'deal.' || action;
        WHEN 'companies' THEN event_type := 'company.' || action;
        WHEN 'tasks' THEN event_type := 'task.' || action;
        WHEN 'notes' THEN event_type := 'note.' || action;
        ELSE event_type := table_name || '.' || action;
    END CASE;

    -- Set record data
    CASE TG_OP
        WHEN 'INSERT' THEN
            record_data := to_jsonb(NEW);
            old_data := NULL;
        WHEN 'UPDATE' THEN
            record_data := to_jsonb(NEW);
            old_data := to_jsonb(OLD);
        WHEN 'DELETE' THEN
            record_data := to_jsonb(OLD);
            old_data := NULL;
    END CASE;

    -- Build payload
    payload := jsonb_build_object(
        'event', event_type,
        'table', table_name,
        'action', action,
        'data', record_data,
        'old_data', old_data,
        'metadata', jsonb_build_object(
            'triggered_at', NOW(),
            'transaction_id', txid_current()
        ),
        'timestamp', extract(epoch from now())
    );

    -- Insert into queue
    INSERT INTO public.webhook_event_queue (event_type, payload)
    VALUES (event_type, payload);

    -- Also send pg_notify for immediate processing
    PERFORM pg_notify('webhook_events', jsonb_build_object(
        'queue_id', currval('webhook_event_queue_id_seq'),
        'event', event_type
    )::text);

    -- Return
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- Create Triggers on CRM Tables
-- ============================================================================

-- Note: These triggers assume the tables exist.
-- Uncomment and modify based on your actual table names.

-- Contacts table triggers
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'contacts') THEN
        DROP TRIGGER IF EXISTS trigger_contacts_webhook ON contacts;
        CREATE TRIGGER trigger_contacts_webhook
            AFTER INSERT OR UPDATE OR DELETE ON contacts
            FOR EACH ROW
            EXECUTE FUNCTION notify_webhook();
    END IF;
END $$;

-- Deals table triggers
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'deals') THEN
        DROP TRIGGER IF EXISTS trigger_deals_webhook ON deals;
        CREATE TRIGGER trigger_deals_webhook
            AFTER INSERT OR UPDATE OR DELETE ON deals
            FOR EACH ROW
            EXECUTE FUNCTION notify_webhook();
    END IF;
END $$;

-- Companies table triggers
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'companies') THEN
        DROP TRIGGER IF EXISTS trigger_companies_webhook ON companies;
        CREATE TRIGGER trigger_companies_webhook
            AFTER INSERT OR UPDATE OR DELETE ON companies
            FOR EACH ROW
            EXECUTE FUNCTION notify_webhook();
    END IF;
END $$;

-- Tasks table triggers
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tasks') THEN
        DROP TRIGGER IF EXISTS trigger_tasks_webhook ON tasks;
        CREATE TRIGGER trigger_tasks_webhook
            AFTER INSERT OR UPDATE OR DELETE ON tasks
            FOR EACH ROW
            EXECUTE FUNCTION notify_webhook();
    END IF;
END $$;

-- Notes table triggers
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'notes') THEN
        DROP TRIGGER IF EXISTS trigger_notes_webhook ON notes;
        CREATE TRIGGER trigger_notes_webhook
            AFTER INSERT OR UPDATE OR DELETE ON notes
            FOR EACH ROW
            EXECUTE FUNCTION notify_webhook();
    END IF;
END $$;

-- ============================================================================
-- Helper function to add webhook trigger to any table
-- ============================================================================

CREATE OR REPLACE FUNCTION add_webhook_trigger(target_table TEXT)
RETURNS VOID AS $$
DECLARE
    trigger_name TEXT;
BEGIN
    trigger_name := 'trigger_' || target_table || '_webhook';

    -- Drop existing trigger if exists
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trigger_name, target_table);

    -- Create new trigger
    EXECUTE format(
        'CREATE TRIGGER %I
            AFTER INSERT OR UPDATE OR DELETE ON %I
            FOR EACH ROW
            EXECUTE FUNCTION notify_webhook()',
        trigger_name,
        target_table
    );

    RAISE NOTICE 'Webhook trigger created for table: %', target_table;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Queue Processing Functions
-- ============================================================================

-- Mark events as processing (claim batch)
CREATE OR REPLACE FUNCTION claim_webhook_events(batch_size INTEGER DEFAULT 100)
RETURNS TABLE (
    id BIGINT,
    event_type TEXT,
    payload JSONB
) AS $$
BEGIN
    RETURN QUERY
    WITH claimed AS (
        UPDATE public.webhook_event_queue
        SET
            status = 'processing',
            attempts = attempts + 1
        WHERE id IN (
            SELECT weq.id
            FROM public.webhook_event_queue weq
            WHERE weq.status = 'pending'
              AND weq.next_attempt_at <= NOW()
            ORDER BY weq.created_at
            LIMIT batch_size
            FOR UPDATE SKIP LOCKED
        )
        RETURNING
            webhook_event_queue.id,
            webhook_event_queue.event_type,
            webhook_event_queue.payload
    )
    SELECT * FROM claimed;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Mark event as completed
CREATE OR REPLACE FUNCTION complete_webhook_event(event_id BIGINT)
RETURNS VOID AS $$
BEGIN
    UPDATE public.webhook_event_queue
    SET
        status = 'completed',
        processed_at = NOW()
    WHERE id = event_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Mark event as failed with retry
CREATE OR REPLACE FUNCTION fail_webhook_event(
    event_id BIGINT,
    error_msg TEXT DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
    current_attempts INTEGER;
    current_max INTEGER;
    backoff_seconds INTEGER;
BEGIN
    SELECT attempts, max_attempts INTO current_attempts, current_max
    FROM public.webhook_event_queue
    WHERE id = event_id;

    -- Calculate exponential backoff: 1s, 4s, 16s, 64s...
    backoff_seconds := POWER(4, current_attempts);

    IF current_attempts >= current_max THEN
        -- Max attempts reached, mark as failed
        UPDATE public.webhook_event_queue
        SET
            status = 'failed',
            error_message = error_msg,
            processed_at = NOW()
        WHERE id = event_id;
    ELSE
        -- Schedule retry
        UPDATE public.webhook_event_queue
        SET
            status = 'pending',
            error_message = error_msg,
            next_attempt_at = NOW() + (backoff_seconds || ' seconds')::interval
        WHERE id = event_id;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Cleanup old processed events
CREATE OR REPLACE FUNCTION cleanup_webhook_queue(retention_days INTEGER DEFAULT 7)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    WITH deleted AS (
        DELETE FROM public.webhook_event_queue
        WHERE status IN ('completed', 'failed')
          AND created_at < NOW() - (retention_days || ' days')::interval
        RETURNING id
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;

    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION claim_webhook_events(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION complete_webhook_event(BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION fail_webhook_event(BIGINT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_webhook_queue(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION add_webhook_trigger(TEXT) TO service_role;

-- ============================================================================
-- Comments
-- ============================================================================

COMMENT ON FUNCTION notify_webhook() IS
    'Trigger function that builds webhook payload and sends pg_notify';

COMMENT ON FUNCTION queue_webhook_event() IS
    'Alternative trigger function that queues events for reliable delivery';

COMMENT ON TABLE public.webhook_event_queue IS
    'Persistent queue for webhook events, ensures delivery even if pg_notify is missed';

COMMENT ON FUNCTION add_webhook_trigger(TEXT) IS
    'Utility to add webhook trigger to any table dynamically';
