// GET /api/leads-inbox?key=...&status=...&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=...
//
// The list the commercial attendant works on — WhatsApp conversations from
// wa_conversations, newest first. Each row carries its resolved attribution
// (platform + how it was linked) so the dashboard can show whether a manual
// QualifiedLead / Sale can be fired back to the ad platform.
//
// Returns an empty list (not an error) if wa_conversations isn't migrated yet,
// so the dashboard's WhatsApp panel renders cleanly before uazapi is connected.
//
// Auth: ?key=<DASH_KEY>.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const status = url.searchParams.get('status') || '';
  const archived = url.searchParams.get('archived') === '1';
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  const { from, to } = resolveRange(url.searchParams.get('from'), url.searchParams.get('to'));
  const fromTs = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const toTs = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);

  // soft-deleted leads never show; archived ones only in the "Arquivados" folder
  const wheres = ['created_at >= ? AND created_at <= ?', 'deleted_at IS NULL',
    archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
  const binds = [fromTs, toTs];
  if (status && ['new', 'qualified', 'sale', 'lost'].includes(status)) {
    wheres.push('status = ?');
    binds.push(status);
  }

  try {
    const rows = await env.DB.prepare(`
      SELECT id, wa_phone, wa_contact_name, platform, link_method,
             ctwa_clid, session_id, gclid, utm_source, utm_campaign, utm_content, utm_term,
             status, is_qualified, sale_value_cents, sale_currency,
             first_message_at, qualified_at, sale_at, created_at,
             last_inbound_at, last_outbound_at, last_viewed_at, archived_at
      FROM wa_conversations
      WHERE ${wheres.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(...binds, limit).all();

    const list = (rows.results || []).map(r => ({
      id: r.id,
      phone: maskPhone(r.wa_phone),
      name: r.wa_contact_name || '',
      platform: r.platform || 'unknown',
      link_method: r.link_method || 'unresolved',
      // attributable = we have a click id to fire a conversion with
      attributable: !!(r.gclid || r.ctwa_clid),
      utm_campaign: r.utm_campaign || '',
      utm_content: r.utm_content || '',
      utm_term: r.utm_term || '',
      status: r.status || 'new',
      is_qualified: !!r.is_qualified,
      sale_value: r.sale_value_cents != null ? r.sale_value_cents / 100 : null,
      sale_currency: r.sale_currency || 'BRL',
      created_at: r.created_at,
      qualified_at: r.qualified_at,
      sale_at: r.sale_at,
      // atendimento dot: red=unread, yellow=read-not-replied, green=awaiting lead
      dot: dotFor(r),
      last_inbound_at: r.last_inbound_at,
      last_outbound_at: r.last_outbound_at,
      archived: !!r.archived_at,
    }));

    return json({ from, to, count: list.length, leads: list });
  } catch (_) {
    // table not migrated yet → empty inbox, not an error
    return json({ from, to, count: 0, leads: [], pending_migration: true });
  }
}

// Atendimento dot from the conversation timestamps:
//   red    — unread inbound (lead messaged after we last viewed the chat)
//   yellow — viewed, but the lead's last message is still unanswered
//   green  — we replied last (awaiting the lead) / nothing pending
function dotFor(r) {
  const inAt = r.last_inbound_at || 0;
  const outAt = r.last_outbound_at || 0;
  const viewed = r.last_viewed_at || 0;
  if (!inAt && !outAt) return 'none';
  if (inAt > viewed) return 'red';
  if (inAt > outAt) return 'yellow';
  return 'green';
}

function maskPhone(p) {
  if (!p) return '';
  const d = String(p).replace(/\D/g, '');
  if (d.length < 4) return d;
  return d.slice(0, -4).replace(/\d/g, '•') + d.slice(-4);
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function resolveRange(rawFrom, rawTo) {
  const today = new Date();
  const fallbackTo = ymd(today);
  const fallbackFrom = ymd(addDays(today, -29));
  let from = isYmd(rawFrom) ? rawFrom : fallbackFrom;
  let to = isYmd(rawTo) ? rawTo : fallbackTo;
  if (from > to) [from, to] = [to, from];
  return { from, to };
}
function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function ymd(d) { const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`; }
function addDays(d, n) { const nd = new Date(d); nd.setUTCDate(nd.getUTCDate() + n); return nd; }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
