-- CRM state on the WhatsApp inbox (dashboard mini-CRM).
--
-- Atendimento "dots" (computed in functions/api/leads-inbox.js):
--   last_inbound_at   — timestamp of the most recent message FROM the lead
--   last_outbound_at  — timestamp of the most recent message WE sent
--   last_viewed_at    — when the attendant last opened the conversation in the CRM
--     red    (unread)        last_inbound_at  > last_viewed_at
--     yellow (read, no reply) viewed, but last_inbound_at > last_outbound_at
--     green  (awaiting lead)  last_outbound_at >= last_inbound_at
--
-- Lifecycle (filtered in leads-inbox.js + utm-attribution.js):
--   archived_at — moved to the "Contatos arquivados" folder (recoverable)
--   deleted_at  — soft-delete: hidden from the UI, attribution/audit preserved
ALTER TABLE wa_conversations ADD COLUMN last_inbound_at INTEGER;
ALTER TABLE wa_conversations ADD COLUMN last_outbound_at INTEGER;
ALTER TABLE wa_conversations ADD COLUMN last_viewed_at INTEGER;
ALTER TABLE wa_conversations ADD COLUMN archived_at INTEGER;
ALTER TABLE wa_conversations ADD COLUMN deleted_at INTEGER;
