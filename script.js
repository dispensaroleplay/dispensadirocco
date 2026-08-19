// ================================
// LA DISPENSA DI ROCCO
// Interactions principales
// ================================

const header = document.querySelector(".site-header");
const menuToggle = document.querySelector(".menu-toggle");
const navLinks = document.querySelectorAll(".nav a");
const bookingForm = document.querySelector("#booking-form");
const formMessage = document.querySelector("#form-message");
const year = document.querySelector("#year");

// Header compact au scroll
window.addEventListener("scroll", () => {
  header.classList.toggle("scrolled", window.scrollY > 40);
});

// Menu mobile
menuToggle.addEventListener("click", () => {
  const isOpen = document.body.classList.toggle("menu-open");
  menuToggle.setAttribute("aria-expanded", String(isOpen));
});

navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    document.body.classList.remove("menu-open");
    menuToggle.setAttribute("aria-expanded", "false");
  });
});

// Animation d'apparition au scroll
const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  {
    threshold: 0.12,
  }
);

document.querySelectorAll(".reveal").forEach((element) => {
  revealObserver.observe(element);
});

// Démo du formulaire de réservation
bookingForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const data = new FormData(bookingForm);
  const name = data.get("name");
  const date = data.get("date");
  const time = data.get("time");
  const guests = data.get("guests");

  formMessage.textContent =
    `Merci ${name}. Votre demande pour ${guests}, le ${date} à ${time}, a bien été enregistrée côté démonstration.`;

  bookingForm.reset();
});

// Année automatique
year.textContent = new Date().getFullYear();
