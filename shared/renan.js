/* Dr. Renan Naves — interações leves (sem framework) */
(function () {
  "use strict";

  // 1) Nav muda de estado ao rolar
  var nav = document.querySelector(".nav");
  if (nav) {
    var solid = nav.dataset.solid === "true";
    var onScroll = function () {
      nav.classList.toggle("scrolled", solid || window.scrollY > 50);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // 2) Menu mobile (hambúrguer)
  var btn = document.querySelector(".mobile-menu-btn");
  var links = document.querySelector(".nav-links");
  if (btn && links) {
    var setOpen = function (open) {
      links.classList.toggle("open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.querySelector("[data-icon=menu]").style.display = open ? "none" : "";
      btn.querySelector("[data-icon=close]").style.display = open ? "" : "none";
    };
    btn.addEventListener("click", function () {
      setOpen(!links.classList.contains("open"));
    });
    links.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
  }

  // 3) Reveal-on-scroll (IntersectionObserver — sem custo em scroll)
  var reveals = document.querySelectorAll(".reveal");
  if (reveals.length) {
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) {
              en.target.classList.add("active");
              io.unobserve(en.target);
            }
          });
        },
        { rootMargin: "0px 0px -120px 0px" }
      );
      reveals.forEach(function (el) {
        io.observe(el);
      });
    } else {
      reveals.forEach(function (el) {
        el.classList.add("active");
      });
    }
  }
})();

/* ─────────────────────────────────────────────────────────────────────────
   Tracking — Meta Pixel + CAPI (via /tracker) + GA4.
   Conversão = clique no WhatsApp (esta LP não tem formulário). Vive aqui
   porque raiz + blog carregam este script: fonte única, sem duplicação
   (regra do repo: trackers ficam em shared/).
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var META_PIXEL_ID = "1698518024494612";
  var GA4_ID = "G-GT1DY1F536";

  function uuid() {
    return (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
      (Date.now() + "-" + Math.random().toString(36).slice(2));
  }

  // Dispara o evento server-side em /tracker (Meta CAPI + GA4 MP). É deduplicado
  // contra o pixel do browser pelo event_id. user_data vazio: o /tracker enriquece
  // com fbp/fbc/IP/UA dos cookies first-party do middleware.
  function track(eventName, eventId, userData) {
    try {
      fetch("/tracker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          event_name: eventName,
          event_id: eventId,
          event_time: Math.floor(Date.now() / 1000),
          event_source_url: window.location.href,
          user_data: userData || {},
        }),
      }).catch(function () {});
    } catch (_) {}
  }

  // Perf: definimos os STUBS (fbq + gtag) imediatamente, mas adiamos o
  // download/execução das libs pesadas (fbevents.js + gtag.js) para quando a
  // thread principal estiver ociosa (requestIdleCallback). Isso reduz TBT/TTI
  // sem perder evento: o PageView/Lead server-side (/tracker, CAPI) dispara na
  // hora, e as chamadas de pixel/gtag ficam na fila e disparam quando as libs
  // entram (mesmo que o usuário clique no WhatsApp antes — o link abre em nova
  // aba e a página não descarrega).

  // ── Meta Pixel — só o stub (fbq + fila), SEM injetar o fbevents.js ainda ────
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0";
    n.queue = [];
  }(window, document);
  fbq("init", META_PIXEL_ID);

  // ── GA4 — stub gtag/dataLayer já (pushes baratos); o gtag.js carrega depois ─
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA4_ID);

  // ── PageView (pixel enfileirado + CAPI imediato, deduped por event_id) ──────
  // /tracker NÃO loga PageView no D1 — só relaya pro Meta CAPI.
  var pvId = uuid();
  try { fbq("track", "PageView", {}, { eventID: pvId }); } catch (_) {}
  track("PageView", pvId, {});

  // ── Carrega as libs de terceiros quando ocioso (libera a main thread) ──────
  function loadTrackerLibs() {
    if (window._trkLibs) return; window._trkLibs = 1;
    var fb = document.createElement("script");
    fb.async = true; fb.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(fb);
    var ga = document.createElement("script");
    ga.async = true; ga.src = "/scripts/gtag.js?id=" + GA4_ID;
    document.head.appendChild(ga);
  }
  if ("requestIdleCallback" in window) requestIdleCallback(loadTrackerLibs, { timeout: 3000 });
  else setTimeout(loadTrackerLibs, 1500);

  // ── Lead = primeiro clique em WhatsApp por sessão ──────────────────────────
  // Guard em sessionStorage evita inflar a contagem de Lead / o CPL quando o
  // visitante clica em mais de um botão de WhatsApp.
  function isWhatsApp(a) {
    var href = (a.getAttribute("href") || "").toLowerCase();
    return href.indexOf("api.whatsapp.com") !== -1 || href.indexOf("wa.me") !== -1;
  }

  // ── Token de sessão no link do WhatsApp (atribuição Google/LP) ─────────────
  // A LP não tem formulário: para ligar a conversa do WhatsApp de volta ao
  // clique (gclid na sessão), embutimos um ref curto = 8 primeiros hex do
  // _krob_sid no texto pré-preenchido, no fim e discreto (`#xxxxxxxx`, parece
  // um nº de protocolo). O webhook do uazapi extrai esse ref e
  // resolve conversa → sessão → gclid. (Meta vem por CTWA/ctwa_clid e nem
  // passa por aqui.) Best-effort: se o usuário apagar o texto, cai no fallback
  // manual do dashboard.
  function getCookie(name) {
    var m = document.cookie.match("(?:^|; )" + name + "=([^;]*)");
    return m ? decodeURIComponent(m[1]) : "";
  }
  function sessionRef() {
    var sid = getCookie("_krob_sid");
    return sid ? sid.replace(/-/g, "").slice(0, 8) : "";
  }
  function addWaRef(a) {
    try {
      var ref = sessionRef();
      if (!ref) return;
      var u = new URL(a.getAttribute("href") || "", location.href);
      var text = u.searchParams.get("text") || "";
      // Test the DECODED text param, not the raw (URL-encoded) href — otherwise
      // "ref%3A"/"%23" never match and a second click double-appends the token.
      if (/(?:ref:\s*|#)[0-9a-f]{8}/i.test(text)) return; // already tagged
      text += (text ? " " : "") + "#" + ref;
      u.searchParams.set("text", text);
      a.setAttribute("href", u.toString());
    } catch (_) {}
  }

  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || !isWhatsApp(a)) return;
    addWaRef(a); // tag every WhatsApp click so the conversation maps to the session
    try {
      if (sessionStorage.getItem("_lead_fired")) return;
      sessionStorage.setItem("_lead_fired", "1");
    } catch (_) {}
    var leadId = uuid();
    // Health/wellness pixels have the standard `Lead` event RESTRICTED by Meta
    // (fbevents.js suppresses it: "attempting to send a restricted event").
    // So we fire a NEUTRAL CUSTOM event instead (trackCustom). The server still
    // receives "Lead" below — tracker.js keeps GA4 (generate_lead) + Google Ads
    // intact and only re-labels the Meta CAPI event to the same custom name, so
    // pixel↔CAPI dedup by event_id still holds. Build the Meta campaign /
    // custom conversion on the event name 'AgendamentoWhatsApp'.
    try { fbq("trackCustom", "AgendamentoWhatsApp", {}, { eventID: leadId }); } catch (_) {}
    try { if (window.gtag) gtag("event", "generate_lead"); } catch (_) {}
    track("Lead", leadId, {});
  }, true);
})();
