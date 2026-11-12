-- 0027_ctwa_funil_v03.sql
-- CTWA tracker -> KROB v0.3 clinic funnel (five stages per CTWA click):
--
--   Lead novo       -> LeadSubmitted   (lead_*            ja existia)
--   Respondeu       -> ViewContent     (replied_*         novo)
--   Orcou           -> QualifiedLead   (qualified_lead_*  ja existia)
--   Agendou         -> Purchase        (purchase_*        ja existia)
--   Desqualificado  -> OrderCanceled   (disqualified_*    novo; publico de exclusao,
--                                       nunca evento de otimizacao)
--
-- Respondeu fires by itself (functions/lib/ctwa-funnel.js detectReply) when the
-- lead writes after a HUMAN message from the clinic. The clinic's automatic
-- messages are told apart by 'auto_message' rules + a time window.
--
-- wa_auto_rules is rebuilt: its CHECK only allowed qualified_lead|purchase and
-- SQLite can't alter a CHECK. Rule ids are preserved.
-- NOT re-runnable (the ALTERs fail once the columns exist).

ALTER TABLE ctwa_conversions ADD COLUMN replied_status      TEXT;   -- sending|sent|failed|skipped_no_creds
ALTER TABLE ctwa_conversions ADD COLUMN replied_event_id    TEXT;
ALTER TABLE ctwa_conversions ADD COLUMN replied_sent_at     INTEGER;
ALTER TABLE ctwa_conversions ADD COLUMN replied_attempts    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ctwa_conversions ADD COLUMN replied_last_error  TEXT;
ALTER TABLE ctwa_conversions ADD COLUMN replied_source      TEXT;   -- auto|manual|rule

ALTER TABLE ctwa_conversions ADD COLUMN disqualified_at         INTEGER; -- unix ms; NULL = not disqualified
ALTER TABLE ctwa_conversions ADD COLUMN disqualified_reason     TEXT;    -- nao_respondeu|fora_do_perfil|sem_orcamento|outro
ALTER TABLE ctwa_conversions ADD COLUMN disqualified_note       TEXT;
ALTER TABLE ctwa_conversions ADD COLUMN disqualified_source     TEXT;    -- manual|rule
ALTER TABLE ctwa_conversions ADD COLUMN disqualified_status     TEXT;    -- sending|sent|failed|skipped_no_creds
ALTER TABLE ctwa_conversions ADD COLUMN disqualified_event_id   TEXT;
ALTER TABLE ctwa_conversions ADD COLUMN disqualified_sent_at    INTEGER;
ALTER TABLE ctwa_conversions ADD COLUMN disqualified_attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ctwa_conversions ADD COLUMN disqualified_last_error TEXT;

CREATE TABLE IF NOT EXISTS wa_auto_rules_v2 (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  event_type     TEXT NOT NULL CHECK (event_type IN ('replied','qualified_lead','purchase','disqualified','auto_message')),
  match_type     TEXT NOT NULL DEFAULT 'contains',
  pattern        TEXT NOT NULL,
  case_sensitive INTEGER NOT NULL DEFAULT 0,
  direction      TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('in','out','any')),
  value          REAL,
  currency       TEXT,
  reason         TEXT,
  notes          TEXT,
  fired_count    INTEGER NOT NULL DEFAULT 0,
  last_fired_at  INTEGER,
  created_at     INTEGER NOT NULL
);
INSERT INTO wa_auto_rules_v2 (id, enabled, event_type, match_type, pattern, case_sensitive, direction,
  value, currency, notes, fired_count, last_fired_at, created_at)
SELECT id, enabled, event_type, match_type, pattern, case_sensitive, direction,
  value, currency, notes, fired_count, last_fired_at, created_at
FROM wa_auto_rules;
DROP TABLE wa_auto_rules;
ALTER TABLE wa_auto_rules_v2 RENAME TO wa_auto_rules;

CREATE INDEX IF NOT EXISTS idx_cc_disqualified ON ctwa_conversions(disqualified_at);
CREATE INDEX IF NOT EXISTS idx_wwe_chat_fromme ON wa_webhook_events(chat_id, from_me, received_at);
