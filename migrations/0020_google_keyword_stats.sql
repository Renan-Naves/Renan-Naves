-- Google Ads keyword-level performance, for the dashboard's
-- "Palavras-chave de conversão (top 10) — Google Ads" panel.
--
-- INFRA-ONLY for now: this table is populated by /api/sync/google-ads (a stub
-- until the Google Ads reporting credentials are set). NOTE the API asymmetry —
-- uploading conversions uses the Data Manager API (no dev token), but READING
-- keyword reports requires the regular Google Ads API (GAQL) with a developer
-- token + login-customer-id. So this stays empty until that reporting sync is
-- wired. Until then the dashboard falls back to lead-side keywords derived from
-- sessions.utm_term (the {keyword} macro on google-ads traffic).
--
-- One row per (date, campaign, keyword, match_type). Stored as integer cents.
CREATE TABLE IF NOT EXISTS google_keyword_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                  -- 'YYYY-MM-DD' in the ad account TZ
    campaign_id TEXT,
    campaign_name TEXT,
    ad_group_name TEXT,
    keyword TEXT NOT NULL,
    match_type TEXT,                     -- 'EXACT' | 'PHRASE' | 'BROAD'
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    conversions REAL DEFAULT 0,
    spend_cents INTEGER DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'BRL',
    synced_at INTEGER NOT NULL           -- unix seconds
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_google_keyword_unique
    ON google_keyword_stats(date, COALESCE(campaign_id, ''), keyword, COALESCE(match_type, ''));

CREATE INDEX IF NOT EXISTS idx_google_keyword_date ON google_keyword_stats(date);
