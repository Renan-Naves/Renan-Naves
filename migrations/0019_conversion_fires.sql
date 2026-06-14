-- Audit log of offline conversions fired to the ad platforms from the manual
-- WhatsApp marking flow (QualifiedLead / Purchase). One row per fire attempt.
--
-- Purpose:
--   * idempotency — a conversation should not double-fire the same event to the
--     same platform (the API checks for an existing ok row first);
--   * observability — Google Ads uploads are NOT written to event_log, so this
--     is the single place to see whether a manual conversion actually landed;
--   * audit — keeps the exact click id + value sent, for reconciliation.
CREATE TABLE IF NOT EXISTS conversion_fires (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER,             -- wa_conversations.id
    event_name TEXT NOT NULL,            -- 'QualifiedLead' | 'Purchase'
    platform TEXT NOT NULL,              -- 'meta' | 'google'
    click_id TEXT,                       -- gclid (google) or ctwa_clid/fbc (meta) used
    click_id_type TEXT,                  -- 'gclid' | 'ctwa_clid' | 'fbc'
    value_cents INTEGER,
    currency TEXT DEFAULT 'BRL',
    event_id TEXT,                       -- dedup id shared with the pixel/CAPI
    status_code INTEGER,
    response_ok INTEGER DEFAULT 0,
    response_body TEXT,
    fired_at INTEGER NOT NULL            -- unix seconds
);

CREATE INDEX IF NOT EXISTS idx_conversion_fires_conv
    ON conversion_fires(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversion_fires_fired_at
    ON conversion_fires(fired_at);
-- Used by the idempotency check (don't re-send the same event to the same
-- platform for the same conversation once it succeeded).
CREATE INDEX IF NOT EXISTS idx_conversion_fires_dedup
    ON conversion_fires(conversation_id, event_name, platform, response_ok);
