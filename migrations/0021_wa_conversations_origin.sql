-- Attribution-by-UTM support on the WhatsApp inbox.
--
-- manual_origin: lets the attendant TAG the origin of a conversation by hand,
--   overriding the auto-detected origin. Required for sources that carry NO utm:
--   'indicacao' (referral) and 'remarketing' (re-activating an existing patient),
--   and as a manual override for any other canonical origin (see functions/origins.js).
-- utm_medium: stored so the attribution view can show source/medium per lead
--   (the other utm_* were already captured; medium was the missing one).
ALTER TABLE wa_conversations ADD COLUMN manual_origin TEXT;
ALTER TABLE wa_conversations ADD COLUMN utm_medium TEXT;
