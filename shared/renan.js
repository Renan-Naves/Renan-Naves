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

  // ── Meta Pixel (base code) ───────────────────────────────────────────────
  !function (f, b, e, v, n, t, s) {
    if (f.fbq) return; n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0";
    n.queue = []; t = b.createElement(e); t.async = !0; t.src = v;
    s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
  fbq("init", META_PIXEL_ID);

  // ── GA4 (script first-party via proxy /scripts/gtag.js → googletagmanager) ─
  var ga = document.createElement("script");
  ga.async = true;
  ga.src = "/scripts/gtag.js?id=" + GA4_ID;
  document.head.appendChild(ga);
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA4_ID);

  // ── PageView (pixel + CAPI, deduped por event_id) ──────────────────────────
  // /tracker NÃO loga PageView no D1 — só relaya pro Meta CAPI.
  var pvId = uuid();
  try { fbq("track", "PageView", {}, { eventID: pvId }); } catch (_) {}
  track("PageView", pvId, {});

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
  // _krob_sid no texto pré-preenchido. O webhook do uazapi extrai esse ref e
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
      var raw = a.getAttribute("href") || "";
      if (/ref:\s*[0-9a-f]{8}/i.test(raw)) return; // already tagged
      var u = new URL(raw, location.href);
      var text = u.searchParams.get("text") || "";
      text += (text ? "\n\n" : "") + "(ref: " + ref + ")";
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
    try { fbq("track", "Lead", {}, { eventID: leadId }); } catch (_) {}
    try { if (window.gtag) gtag("event", "generate_lead"); } catch (_) {}
    track("Lead", leadId, {});
  }, true);
})();
