CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations (phone);
CREATE INDEX IF NOT EXISTS idx_conversations_phone_created ON conversations (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events (type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_phone ON events (phone);
CREATE INDEX IF NOT EXISTS idx_leads_status_followup ON leads (status, has_lead_replied, followup_status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_followup_log_phone ON followup_log (phone, sent_at DESC);
