// ================================
// LA DISPENSA DI ROCCO
// Interactions principales
// ================================

const header = document.querySelector(".site-header");
const menuToggle = document.querySelector(".menu-toggle");
const navLinks = document.querySelectorAll(".nav a");
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



// Ouverture Discord : tente l'application de bureau/mobile en priorité.
// Si l'application ne répond pas, retour automatique vers la version web.
const discordWebUrl =
  "https://discord.com/channels/1529971523924791478/1529977191859879956";
const discordAppUrl =
  "discord://-/channels/1529971523924791478/1529977191859879956";

function openDiscordApp(event) {
  event.preventDefault();

  let appLikelyOpened = false;

  const markAsOpened = () => {
    appLikelyOpened = true;
  };

  const visibilityHandler = () => {
    if (document.visibilityState === "hidden") {
      appLikelyOpened = true;
    }
  };

  window.addEventListener("blur", markAsOpened, { once: true });
  document.addEventListener("visibilitychange", visibilityHandler);

  // Le clic utilisateur déclenche la tentative d'ouverture de l'application.
  window.location.href = discordAppUrl;

  // Si Discord n'est pas installé / le protocole est bloqué,
  // on ouvre le salon dans le navigateur à la place.
  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", visibilityHandler);

    if (!appLikelyOpened && document.visibilityState === "visible") {
      window.location.href = discordWebUrl;
    }
  }, 1400);
}

document.querySelectorAll("[data-discord-link]").forEach((link) => {
  link.addEventListener("click", openDiscordApp);
});

// Année automatique
year.textContent = new Date().getFullYear();
