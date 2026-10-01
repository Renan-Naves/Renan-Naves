// functions/lib/ctwa-schema.js
//
// Lazily applies migrations/0026_ctwa_tracker.sql at runtime (every statement is
// CREATE ... IF NOT EXISTS, so it's idempotent). Needed because the CTWA tracker
// must work even when the migration hasn't been applied with wrangler yet. Runs
// once per isolate. KEEP IN SYNC with the migration file.

const DDL = [
  "CREATE TABLE IF NOT EXISTS wa_webhook_events ( id INTEGER PRIMARY KEY AUTOINCREMENT, received_at INTEGER NOT NULL, event_type TEXT, instance_name TEXT, message_id TEXT, chat_id TEXT, sender_pn TEXT, sender_name TEXT, from_me INTEGER, is_group INTEGER, message_type TEXT, message_content TEXT, message_ts INTEGER, ctwa_clid TEXT, entry_point_source TEXT, entry_point_app TEXT, ad_source_id TEXT, ad_source_url TEXT, ad_title TEXT, is_ctwa INTEGER NOT NULL DEFAULT 0, ad_hint INTEGER NOT NULL DEFAULT 0, wa_conversation_id INTEGER, raw_payload TEXT NOT NULL )",
  "CREATE INDEX IF NOT EXISTS idx_wwe_received ON wa_webhook_events(received_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_wwe_sender ON wa_webhook_events(sender_pn)",
  "CREATE INDEX IF NOT EXISTS idx_wwe_ctwa ON wa_webhook_events(is_ctwa, received_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_wwe_hint ON wa_webhook_events(ad_hint, received_at DESC)",
  "CREATE TABLE IF NOT EXISTS ctwa_conversions ( id INTEGER PRIMARY KEY AUTOINCREMENT, ctwa_clid TEXT NOT NULL UNIQUE, first_seen_at INTEGER NOT NULL, webhook_event_id INTEGER, wa_conversation_id INTEGER, sender_pn TEXT, sender_name TEXT, ad_id TEXT, ad_source_url TEXT, ad_title TEXT, ad_body TEXT, entry_point_app TEXT, entry_point_source TEXT, lead_status TEXT NOT NULL DEFAULT 'pending', lead_event_id TEXT, lead_sent_at INTEGER, lead_attempts INTEGER NOT NULL DEFAULT 0, lead_last_error TEXT, qualified_lead_status TEXT, qualified_lead_event_id TEXT, qualified_lead_sent_at INTEGER, qualified_lead_attempts INTEGER NOT NULL DEFAULT 0, qualified_lead_last_error TEXT, purchase_status TEXT, purchase_event_id TEXT, purchase_sent_at INTEGER, purchase_value REAL, purchase_currency TEXT, purchase_attempts INTEGER NOT NULL DEFAULT 0, purchase_last_error TEXT )",
  "CREATE INDEX IF NOT EXISTS idx_cc_first_seen ON ctwa_conversions(first_seen_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_cc_sender ON ctwa_conversions(sender_pn)",
  "CREATE INDEX IF NOT EXISTS idx_cc_lead ON ctwa_conversions(lead_status)",
  "CREATE INDEX IF NOT EXISTS idx_cc_ad ON ctwa_conversions(ad_id)",
  "CREATE INDEX IF NOT EXISTS idx_cc_wa_conv ON ctwa_conversions(wa_conversation_id)",
  "CREATE TABLE IF NOT EXISTS ctwa_capi_log ( id INTEGER PRIMARY KEY AUTOINCREMENT, conversion_id INTEGER, attempted_at INTEGER NOT NULL, event_name TEXT NOT NULL, event_id TEXT, request_body TEXT, response_status INTEGER, response_body TEXT, duration_ms INTEGER, was_test INTEGER NOT NULL DEFAULT 0 )",
  "CREATE INDEX IF NOT EXISTS idx_ccl_conv ON ctwa_capi_log(conversion_id, attempted_at DESC)",
  "CREATE TABLE IF NOT EXISTS meta_ads_cache ( ad_id TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ad_name TEXT, adset_id TEXT, adset_name TEXT, campaign_id TEXT, campaign_name TEXT, campaign_objective TEXT, effective_status TEXT, raw_response TEXT )",
  "CREATE TABLE IF NOT EXISTS wa_auto_rules ( id INTEGER PRIMARY KEY AUTOINCREMENT, enabled INTEGER NOT NULL DEFAULT 1, event_type TEXT NOT NULL CHECK (event_type IN ('qualified_lead','purchase')), match_type TEXT NOT NULL DEFAULT 'contains', pattern TEXT NOT NULL, case_sensitive INTEGER NOT NULL DEFAULT 0, direction TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('in','out','any')), value REAL, currency TEXT, notes TEXT, fired_count INTEGER NOT NULL DEFAULT 0, last_fired_at INTEGER, created_at INTEGER NOT NULL )"
];

let ready = null;

export function ensureCtwaSchema(env) {
  if (!env.DB) return Promise.resolve();
  if (!ready) {
    ready = env.DB.batch(DDL.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; });
  }
  return ready;
}
