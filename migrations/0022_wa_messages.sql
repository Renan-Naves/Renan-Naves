-- Per-message log for the WhatsApp inbox / mini-CRM.
--
-- wa_conversations holds ONE row per chat (with the first message text); this
-- table holds the full thread so the dashboard can render a conversation and
-- the attendant can read/reply. Forward-only: rows start arriving once the
-- uazapi webhook is connected — we do NOT backfill old history.
--
--   direction 'in'  → inbound message from the lead (written by the webhook)
--   direction 'out' → reply sent BY us, either from the dashboard
--                     (functions/api/send-message.js) or from the phone directly
--                     (the webhook records fromMe messages so the thread is complete)
--
-- Dedup is on wa_message_id (the uazapi message id) so a webhook retry / a reply
-- we already inserted locally doesn't create a duplicate row.
CREATE TABLE IF NOT EXISTS wa_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER,             -- wa_conversations.id (logical FK)
    wa_chat_id TEXT,                     -- uazapi chat id (matches wa_conversations.wa_chat_id)
    wa_message_id TEXT,                  -- uazapi message id (dedup; may be null for locally-sent before id known)
    direction TEXT NOT NULL,             -- 'in' | 'out'
    body TEXT,
    status TEXT,                         -- outbound: 'sent' | 'failed' (null for inbound)
    sender_name TEXT,
    msg_at INTEGER,                      -- message timestamp (unix seconds)
    created_at INTEGER NOT NULL          -- when we wrote the row (unix seconds)
);

-- Dedup guard: ignore a message id we already stored. Partial-unique isn't
-- portable on D1, so we keep a plain unique index and INSERT OR IGNORE; rows
-- with a NULL wa_message_id (rare, locally-sent) are allowed to repeat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_msgid
    ON wa_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wa_messages_conv
    ON wa_messages(conversation_id, msg_at);
CREATE INDEX IF NOT EXISTS idx_wa_messages_chat
    ON wa_messages(wa_chat_id, msg_at);
