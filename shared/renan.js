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
