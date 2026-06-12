-- Post-signup qualification quiz responses for the /lp-do-sobral funnel.
-- One row per completed quiz (the "finish" screen) or early-exit (the
-- "decline" screen). Written by functions/quiz-response.js. Linked to the
-- originating visit via session_id (the _krob_sid cookie), so the dashboard
-- / ad-hoc queries can join back to `sessions` for the originating UTMs.
--
-- `answers_json` holds the full ordered answer array; `age_band` / `education`
-- are denormalized copies of the questions used for funnel cuts. Raw PII
-- (email/name) is stored here for analysis only and never leaves this infra,
-- same convention as `event_log.raw_email` / `purchase_log.raw_*`.
CREATE TABLE IF NOT EXISTS quiz_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    raw_email TEXT,
    raw_name TEXT,
    age_band TEXT,
    education TEXT,
    qualified INTEGER DEFAULT 0,
    answers_json TEXT,
    event_source_url TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quiz_responses_created ON quiz_responses(created_at);
CREATE INDEX IF NOT EXISTS idx_quiz_responses_session ON quiz_responses(session_id);
