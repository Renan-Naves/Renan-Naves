-- WhatsApp lead inbox — the central "estrutura de WhatsApp" the commercial
-- attendant works on. One row per WhatsApp conversation.
--
-- This LP has NO form, so the lead is anonymous at click time. We attribute a
-- conversation back to the originating ad click with a HYBRID resolver:
--
--   Meta  → CTWA ads go straight to WhatsApp (skip the LP). The inbound message
--           carries a `referral` object with `ctwa_clid`. There is no LP session
--           and no gclid; the click id is `ctwa_clid` and we fire to Meta CAPI
--           as a business_messaging conversion.
--   Google→ The ad lands on the LP, the middleware captures `gclid` into the
--           `sessions` row, and a short token in the WhatsApp prefilled text
--           carries the `session_id` into the conversation. We resolve
--           session → gclid/fbc and fire to Google Ads (Data Manager) / Meta.
--   Manual→ fallback when neither identifier resolved; the attendant links the
--           conversation to a recent lead by hand in the dashboard.
--
-- Rows are written by the uazapi inbound webhook (functions/webhook/uazapi/),
-- which stays dormant until uazapi is connected. `status`, `is_qualified` and
-- `sale_value_cents` are set MANUALLY by the attendant via the dashboard —
-- there is no automatic qualification or sale signal (a lead can only be
-- qualified / become a sale AFTER it converts on the LP / opens a conversation).
CREATE TABLE IF NOT EXISTS wa_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- WhatsApp side (from uazapi)
    wa_phone TEXT,                       -- contact phone, digits only (E.164-ish)
    wa_contact_name TEXT,
    wa_chat_id TEXT,                     -- uazapi conversation / chat id
    first_message TEXT,                  -- first inbound message text (token lives here)

    -- Attribution / identity resolution
    platform TEXT DEFAULT 'unknown',     -- 'meta' | 'google' | 'organic' | 'unknown'
    link_method TEXT DEFAULT 'unresolved', -- 'ctwa' | 'token' | 'manual' | 'unresolved'
    ctwa_clid TEXT,                      -- Meta CTWA referral click id
    session_id TEXT,                     -- linked LP session (Google/LP path, via token)
    gclid TEXT,                          -- resolved from session (Google)
    fbc TEXT,                            -- resolved (Meta / session)
    fbp TEXT,
    utm_source TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,                       -- Google keyword (macro {keyword})
    referral_raw TEXT,                   -- raw uazapi referral JSON (audit)

    -- Funnel status — set MANUALLY by the attendant
    status TEXT NOT NULL DEFAULT 'new',  -- 'new' | 'qualified' | 'sale' | 'lost'
    is_qualified INTEGER DEFAULT 0,
    sale_value_cents INTEGER,
    sale_currency TEXT DEFAULT 'BRL',

    -- Timestamps (unix seconds)
    first_message_at INTEGER,
    qualified_at INTEGER,
    sale_at INTEGER,
    marked_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- One row per WhatsApp chat so the webhook can UPSERT safely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_conversations_chat
    ON wa_conversations(wa_chat_id);

CREATE INDEX IF NOT EXISTS idx_wa_conversations_created  ON wa_conversations(created_at);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_status   ON wa_conversations(status);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_platform ON wa_conversations(platform);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_ctwa     ON wa_conversations(ctwa_clid);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_session  ON wa_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_phone    ON wa_conversations(wa_phone);
