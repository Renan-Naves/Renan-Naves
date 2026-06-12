-- Lead-qualification quiz responses for the /captura funnel (Comunidade KROB,
-- ticket R$ 3.000). One row per finished run of the post-signup quiz. Written
-- by functions/captura-response.js. Linked to the originating visit via
-- session_id (the _krob_sid cookie) so the dashboard / ad-hoc queries can join
-- back to `sessions` for the originating UTMs / fbclid / gclid.
--
-- The quiz branches by `profile` (the first question): the gestor branch fills
-- clients_band / service_revenue_band / ad_spend_band; the dono branch fills
-- business_revenue_band / traffic_usage / ad_spend_band; the equipe/iniciante
-- branch fills `goal`. `qualified` mirrors the LeadQualificado rule the page
-- evaluates (gestor with 3+ clients, or dono billing R$ 10k+/mês who actually
-- runs paid traffic). `answers_json` holds the full [{question, answer}, ...]
-- audit trail. Raw PII (email/phone) is stored here for the commercial team /
-- analysis only and never leaves this infra — same convention as
-- `event_log.raw_email` / `quiz_responses.raw_*`.
CREATE TABLE IF NOT EXISTS captura_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    raw_email TEXT,
    raw_phone TEXT,
    profile TEXT,                 -- P1: gestor | dono | equipe | iniciante
    clients_band TEXT,            -- gestor branch (A2)
    service_revenue_band TEXT,    -- gestor branch (A3)
    business_revenue_band TEXT,   -- dono branch (B2)
    traffic_usage TEXT,           -- dono branch (B3)
    ad_spend_band TEXT,           -- A4 (gestor) or B4 (dono)
    goal TEXT,                    -- equipe/iniciante branch (C1)
    qualified INTEGER DEFAULT 0,
    answers_json TEXT,
    event_source_url TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_captura_responses_created ON captura_responses(created_at);
CREATE INDEX IF NOT EXISTS idx_captura_responses_session ON captura_responses(session_id);
CREATE INDEX IF NOT EXISTS idx_captura_responses_qualified ON captura_responses(qualified);
