// La Dispensa Di Rocco — V4
const BUSINESS_OPEN = true; // Mets false quand le restaurant est fermé.

const body = document.body;
const header = document.querySelector(".header");
const menuToggle = document.querySelector(".menu-toggle");
const navLinks = [...document.querySelectorAll(".nav a[href^='#']")];
const statusBadge = document.querySelector("#business-status");
const lightbox = document.querySelector("#menu-lightbox");
const menuOpen = document.querySelector("#menu-open");
const menuClose = document.querySelector("#menu-close");

document.querySelector("#year").textContent = new Date().getFullYear();

window.addEventListener("scroll", () => {
  header.classList.toggle("scrolled", window.scrollY > 35);
}, { passive: true });

menuToggle.addEventListener("click", () => {
  const open = body.classList.toggle("menu-open");
  menuToggle.setAttribute("aria-expanded", String(open));
});

navLinks.forEach(link => {
  link.addEventListener("click", () => {
    body.classList.remove("menu-open");
    menuToggle.setAttribute("aria-expanded", "false");
  });
});

const revealObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add("visible");
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: .12 });

document.querySelectorAll(".reveal").forEach(el => revealObserver.observe(el));

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

statusBadge.textContent = BUSINESS_OPEN ? "OUVERT" : "FERMÉ";
statusBadge.classList.add(BUSINESS_OPEN ? "open" : "closed");

function closeLightbox() {
  lightbox.classList.remove("open");
  lightbox.setAttribute("aria-hidden", "true");
  body.classList.remove("lightbox-open");
}

menuOpen.addEventListener("click", () => {
  lightbox.classList.add("open");
  lightbox.setAttribute("aria-hidden", "false");
  body.classList.add("lightbox-open");
  menuClose.focus();
});

menuClose.addEventListener("click", closeLightbox);

lightbox.addEventListener("click", event => {
  if (event.target === lightbox) closeLightbox();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && lightbox.classList.contains("open")) closeLightbox();
});
