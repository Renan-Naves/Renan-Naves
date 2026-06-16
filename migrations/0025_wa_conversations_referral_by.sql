-- Referral GRAPH: who referred this patient (the indicador).
--
-- 0024 added referral_name (the indicado / new patient's clean name). This adds
-- the OTHER side: when a conversation is tagged origin 'indicacao', the attendant
-- records WHO referred them — name + WhatsApp number. The number lets the
-- dashboard cross-reference the indicador against the base to pull THEIR origin
-- and revenue (e.g. "Paulo veio do Google Ads, gerou R$1200, indicou Ana").
--
--   referral_by_name  — indicador (referrer) name typed by the attendant
--   referral_by_phone — indicador WhatsApp (digits) → links to their patient record
ALTER TABLE wa_conversations ADD COLUMN referral_by_name TEXT;
ALTER TABLE wa_conversations ADD COLUMN referral_by_phone TEXT;
