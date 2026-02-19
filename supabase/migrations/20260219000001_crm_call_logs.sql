-- supabase/migrations/20260219000001_crm_call_logs.sql

CREATE TABLE IF NOT EXISTS crm_call_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  opportunity_id  uuid REFERENCES opportunities(id) ON DELETE SET NULL,
  quote_id        uuid REFERENCES quotes(id) ON DELETE SET NULL,
  ticket_id       uuid REFERENCES tickets(id) ON DELETE SET NULL,
  vapi_call_id    text UNIQUE NOT NULL,
  flow_type       text NOT NULL
                    CHECK (flow_type IN (
                      'lead_qualification',
                      'quote_followup',
                      'sla_escalation'
                    )),
  status          text NOT NULL DEFAULT 'initiated'
                    CHECK (status IN (
                      'initiated','completed','no_answer',
                      'failed','voicemail'
                    )),
  ended_reason    text,
  duration_sec    integer,
  recording_url   text,
  transcript      text,
  summary         text,
  structured_data jsonb,
  sentiment       text CHECK (sentiment IN ('positive','neutral','negative')),
  outcome         text,
  success         boolean,
  telegram_sent   boolean DEFAULT false,
  called_at       timestamptz,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_call_logs_contact    ON crm_call_logs (contact_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_opportunity ON crm_call_logs (opportunity_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_quote       ON crm_call_logs (quote_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_ticket      ON crm_call_logs (ticket_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_flow        ON crm_call_logs (flow_type);
CREATE INDEX IF NOT EXISTS idx_call_logs_created     ON crm_call_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_logs_vapi        ON crm_call_logs (vapi_call_id);

ALTER TABLE crm_call_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_can_read"
  ON crm_call_logs FOR SELECT TO authenticated USING (true);

CREATE POLICY "service_role_full_access"
  ON crm_call_logs FOR ALL TO service_role USING (true);
