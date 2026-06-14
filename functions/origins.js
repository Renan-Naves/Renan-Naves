// Canonical traffic-origin taxonomy for Dr. Renan, shared by the attribution
// view (/api/utm-attribution) and the manual origin-tagging flow.
//
// Each lead/conversation is mapped to exactly one origin. Detection order:
//   1. manual_origin (the attendant tagged it by hand — always wins)
//   2. ctwa_clid present                → meta-ads (Click-to-WhatsApp)
//   3. utm_source matches the map below → that origin
//   4. gclid present                    → google-ads
//   5. no utm + search-engine referrer  → organico-site
//   6. otherwise                        → outro
//
// PRE-ESTABLISHED utm_source values to use when building links (so every source
// is tagged consistently). Organic and Indicação/Remarketing carry no utm:
//   Google Ads Site      → utm_source=google-ads      (gclid também identifica)
//   Google Meu Negócio   → utm_source=google-meu-negocio
//   Instagram Bio        → utm_source=instagram-bio   (linktree → site/whatsapp)
//   Meta Ads             → utm_source=meta-ads        (+ CTWA/ctwa_clid)
//   TikTok Bio           → utm_source=tiktok-bio      (linktree → site/whatsapp)
//   Orgânico Site        → (sem utm)  detectado pelo referrer de busca
//   Indicação            → (sem utm)  TAG manual
//   Remarketing          → (sem utm)  TAG manual

export const ORIGINS = [
  { key: 'organico-site',      label: 'Orgânico Site (pesquisa Google)', manual: false },
  { key: 'google-ads',         label: 'Google Ads Site',                 manual: false },
  { key: 'google-meu-negocio', label: 'Google Meu Negócio',              manual: false },
  { key: 'instagram-bio',      label: 'Instagram Bio',                   manual: false },
  { key: 'meta-ads',           label: 'Meta Ads',                        manual: false },
  { key: 'tiktok-bio',         label: 'TikTok Bio',                      manual: false },
  { key: 'indicacao',          label: 'Indicação',                       manual: true  },
  { key: 'remarketing',        label: 'Remarketing',                     manual: true  },
  { key: 'outro',              label: 'Outro / não identificado',        manual: false },
];

const LABELS = Object.fromEntries(ORIGINS.map(o => [o.key, o.label]));
const VALID = new Set(ORIGINS.map(o => o.key));

// Accept a few aliases so links built slightly differently still resolve.
const UTM_SOURCE_MAP = {
  'google-ads': 'google-ads', 'googleads': 'google-ads', 'google_ads': 'google-ads', 'adwords': 'google-ads',
  'meta-ads': 'meta-ads', 'meta_ads': 'meta-ads', 'facebook-ads': 'meta-ads', 'fb-ads': 'meta-ads',
  'google-meu-negocio': 'google-meu-negocio', 'gmb': 'google-meu-negocio', 'google-my-business': 'google-meu-negocio',
  'instagram-bio': 'instagram-bio', 'instagram': 'instagram-bio', 'ig-bio': 'instagram-bio', 'ig': 'instagram-bio',
  'tiktok-bio': 'tiktok-bio', 'tiktok': 'tiktok-bio', 'tt-bio': 'tiktok-bio',
};

export function originLabel(key) { return LABELS[key] || key; }
export function isValidOrigin(key) { return VALID.has(key); }

// conv: { manual_origin, utm_source, gclid, ctwa_clid, referrer }
export function resolveOrigin(conv) {
  if (conv.manual_origin && VALID.has(conv.manual_origin)) return conv.manual_origin;

  const src = String(conv.utm_source || '').trim().toLowerCase();
  if (conv.ctwa_clid) return 'meta-ads';
  if (UTM_SOURCE_MAP[src]) return UTM_SOURCE_MAP[src];
  if (conv.gclid) return 'google-ads';

  if (!src) {
    const ref = String(conv.referrer || '').toLowerCase();
    if (/(google|bing|duckduckgo|yahoo|ecosia)\./.test(ref)) return 'organico-site';
    return 'outro';
  }
  return 'outro';
}
