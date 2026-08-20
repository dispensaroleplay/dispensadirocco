// La Dispensa Di Rocco — V5
const body = document.body;
const header = document.querySelector(".header");
const intro = document.querySelector("#intro");
const menuToggle = document.querySelector(".menu-toggle");
const nav = document.querySelector(".nav");
const navLinks = [...document.querySelectorAll(".nav a[href^='#']")];

const lightbox = document.querySelector("#menu-lightbox");
const menuOpen = document.querySelector("#menu-open");
const menuClose = document.querySelector("#menu-close");
const lightboxImage = document.querySelector("#lightbox-image");
const zoomIn = document.querySelector("#zoom-in");
const zoomOut = document.querySelector("#zoom-out");
const zoomValue = document.querySelector("#zoom-value");

const yearEl = document.querySelector("#year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

const DISCORD_WEB = "https://discord.com/channels/1529971523924791478/1529977191859879956";
const DISCORD_APP = "discord://discord.com/channels/1529971523924791478/1529977191859879956";

function openDiscord(event) {
  event.preventDefault();
  window.location.href = DISCORD_APP;
  window.setTimeout(() => {
    window.open(DISCORD_WEB, "_blank", "noopener,noreferrer");
  }, 700);
}

document.querySelectorAll(".discord-open").forEach(link => {
  link.addEventListener("click", openDiscord);
});

async function refreshAdminAccess() {
  try {
    const response = await fetch("/api/admin/access", { credentials: "same-origin" });
    if (!response.ok) throw new Error("admin access");
    const data = await response.json();
    document.querySelectorAll(".admin-gated").forEach(link => {
      link.hidden = !data.allowed;
    });
  } catch {
    document.querySelectorAll(".admin-gated").forEach(link => {
      link.hidden = true;
    });
  }
}

refreshAdminAccess();
window.addEventListener("focus", refreshAdminAccess);

if (new URLSearchParams(location.search).get("admin") === "connected") {
  window.setTimeout(refreshAdminAccess, 100);
}

// Intro : ne pas bloquer le site si des assets lents retardent `load`.
let introHidden = false;
function hideIntro() {
  if (introHidden || !intro) return;
  introHidden = true;
  intro.classList.add("hidden");
}

const isMobileViewport = window.matchMedia("(max-width: 980px)").matches;
if (isMobileViewport) {
  hideIntro();
} else {
  window.setTimeout(hideIntro, 700);
  window.addEventListener("DOMContentLoaded", () => window.setTimeout(hideIntro, 450));
  window.addEventListener("load", () => window.setTimeout(hideIntro, 200));
  window.setTimeout(hideIntro, 1600);
}

window.addEventListener("scroll", () => {
  header?.classList.toggle("scrolled", window.scrollY > 35);
}, { passive: true });

function setMenuOpen(open) {
  body.classList.toggle("menu-open", open);
  menuToggle?.setAttribute("aria-expanded", String(open));
  menuToggle?.setAttribute("aria-label", open ? "Fermer le menu" : "Ouvrir le menu");
}

menuToggle?.addEventListener("click", (event) => {
  event.stopPropagation();
  setMenuOpen(!body.classList.contains("menu-open"));
});

nav?.addEventListener("click", event => {
  if (event.target.closest("a")) setMenuOpen(false);
});

const revealObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add("visible");
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: .08, rootMargin: "0px 0px -8% 0px" });

document.querySelectorAll(".reveal").forEach(el => revealObserver.observe(el));

// Filet de sécurité : si l’observer rate (viewport / timing), afficher le contenu.
window.setTimeout(() => {
  document.querySelectorAll(".reveal:not(.visible)").forEach(el => {
    el.classList.add("visible");
  });
}, 2200);

const sectionObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const id = entry.target.id;
    navLinks.forEach(link => {
      link.classList.toggle("active", id && link.getAttribute("href") === `#${id}`);
    });
  });
}, { rootMargin: "-35% 0px -55% 0px" });

document.querySelectorAll("main section[id]").forEach(section => sectionObserver.observe(section));

// Carte plein écran + zoom.
let zoom = 1;

function applyZoom() {
  if (!lightboxImage || !zoomValue) return;
  const isMobile = window.innerWidth <= 650;
  const baseWidth = isMobile
    ? Math.max(window.innerWidth - 28, 320)
    : Math.min(1500, window.innerWidth * 0.94);
  lightboxImage.style.width = `${Math.round(baseWidth * zoom)}px`;
  zoomValue.textContent = `${Math.round(zoom * 100)}%`;
}

function openLightbox() {
  if (!lightbox || !lightboxImage) return;
  if (!lightboxImage.getAttribute("src")) {
    const src = lightboxImage.getAttribute("data-src");
    if (src) lightboxImage.src = src;
  }
  zoom = 1;
  lightbox.classList.add("open");
  lightbox.setAttribute("aria-hidden", "false");
  body.classList.add("lightbox-open");
  applyZoom();
  menuClose?.focus();
}

function closeLightbox() {
  if (!lightbox) return;
  lightbox.classList.remove("open");
  lightbox.setAttribute("aria-hidden", "true");
  body.classList.remove("lightbox-open");
}

menuOpen?.addEventListener("click", openLightbox);
menuClose?.addEventListener("click", closeLightbox);

zoomIn?.addEventListener("click", () => {
  zoom = Math.min(2.2, zoom + .2);
  applyZoom();
});

zoomOut?.addEventListener("click", () => {
  zoom = Math.max(.6, zoom - .2);
  applyZoom();
});

lightbox?.addEventListener("click", event => {
  if (event.target === lightbox) closeLightbox();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (lightbox?.classList.contains("open")) closeLightbox();
    if (body.classList.contains("menu-open")) setMenuOpen(false);
  }
  if (lightbox?.classList.contains("open") && event.key === "+") {
    zoom = Math.min(2.2, zoom + .2);
    applyZoom();
  }
  if (lightbox?.classList.contains("open") && event.key === "-") {
    zoom = Math.max(.6, zoom - .2);
    applyZoom();
  }
});

window.addEventListener("resize", () => {
  if (lightbox?.classList.contains("open")) applyZoom();
  if (window.innerWidth > 980 && body.classList.contains("menu-open")) {
    setMenuOpen(false);
  }
});
