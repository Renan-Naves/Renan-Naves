-- Referral (indicação) tracking on the WhatsApp inbox.
--
-- referral_name: the new patient's name typed by the attendant when tagging a
--   conversation as origin 'indicacao'. The WhatsApp push name is often unreliable
--   (nicknames, business names), so the attendant records the real patient name
--   here. The /dashboard "Indicações" list reads this, deduped by phone number
--   (oldest record wins) so every referred patient is tracked from the start.
ALTER TABLE wa_conversations ADD COLUMN referral_name TEXT;
