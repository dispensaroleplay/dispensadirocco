(() => {
  const form = document.getElementById("production-form");
  const uploadZone = document.getElementById("upload-zone");
  const proofInput = document.getElementById("proof");
  const uploadTitle = document.getElementById("upload-title");
  const previewImage = document.getElementById("preview-image");
  const status = document.getElementById("form-status");
  const submitButton = document.getElementById("submit-button");
  const submitLabel = document.getElementById("submit-label");
  const maxFileSize = 8 * 1024 * 1024;
  const maxFiles = 10;
  const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
  let previewUrls = [];

  if (proofInput) {
    proofInput.setAttribute("multiple", "multiple");
  }

  const setStatus = (message, state = "") => {
    status.textContent = message;
    status.dataset.state = state;
  };

  const clearPreviewUrls = () => {
    for (const url of previewUrls) URL.revokeObjectURL(url);
    previewUrls = [];
  };

  const resetPreview = () => {
    clearPreviewUrls();
    previewImage.removeAttribute("src");
    uploadZone.classList.remove("has-file");
    uploadTitle.textContent = "Ajouter une ou plusieurs images";
  };

  const collectValidFiles = (fileList) => {
    const files = [...fileList].filter(Boolean);
    if (!files.length) return [];

    if (files.length > maxFiles) {
      setStatus(`Maximum ${maxFiles} images par déclaration.`, "error");
      return null;
    }

    for (const file of files) {
      if (!allowedTypes.includes(file.type)) {
        setStatus("Formats acceptés : PNG, JPEG ou WEBP.", "error");
        return null;
      }
      if (file.size === 0 || file.size > maxFileSize) {
        setStatus("Chaque image doit peser entre 1 octet et 8 Mo.", "error");
        return null;
      }
    }

    return files;
  };

  const updateFiles = (fileList) => {
    resetPreview();
    const files = collectValidFiles(fileList);
    if (files === null) {
      proofInput.value = "";
      return;
    }
    if (!files.length) return;

    const firstUrl = URL.createObjectURL(files[0]);
    previewUrls = [firstUrl];
    previewImage.src = firstUrl;
    uploadTitle.textContent =
      files.length === 1
        ? files[0].name
        : `${files.length} images sélectionnées`;
    uploadZone.classList.add("has-file");
    setStatus("");
  };

  uploadZone.addEventListener("click", () => proofInput.click());
  uploadZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      proofInput.click();
    }
  });

  proofInput.addEventListener("change", () => updateFiles(proofInput.files));

  ["dragenter", "dragover"].forEach((eventName) => {
    uploadZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      uploadZone.classList.add("is-dragging");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    uploadZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      uploadZone.classList.remove("is-dragging");
    });
  });

  uploadZone.addEventListener("drop", (event) => {
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    const transfer = new DataTransfer();
    for (const file of files.slice(0, maxFiles)) transfer.items.add(file);
    proofInput.files = transfer.files;
    updateFiles(proofInput.files);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = form.elements.name.value.trim();
    const stock = form.elements.stock.value;
    const proofs = [...(proofInput.files || [])];
    const turnstileToken = form
      .querySelector('[name="cf-turnstile-response"]')
      ?.value?.trim();

    if (!name || stock === "" || !proofs.length) {
      setStatus(
        "Merci de remplir les champs obligatoires et d'ajouter au moins une image.",
        "error"
      );
      return;
    }

    if (proofs.length > maxFiles) {
      setStatus(`Maximum ${maxFiles} images par déclaration.`, "error");
      return;
    }

    // Turnstile optionnel ici : l'accès /admin/app exige déjà une session Discord admin.
    // Si le widget Cloudflare est en erreur (110200), on laisse quand même envoyer.

    const endpoint = document.documentElement.dataset.submitEndpoint.trim();
    if (!endpoint) {
      setStatus("Le formulaire est temporairement indisponible.", "error");
      return;
    }

    submitButton.disabled = true;
    submitLabel.textContent = "Envoi en cours…";
    setStatus("Transmission sécurisée de votre déclaration…");

    try {
      const payload = new FormData();
      payload.append("name", name);
      payload.append("stock", stock);
      for (const file of proofs) payload.append("proof", file);
      if (turnstileToken) {
        payload.append("cf-turnstile-response", turnstileToken);
      }

      const response = await fetch(endpoint, { method: "POST", body: payload });
      if (!response.ok) throw new Error("La transmission a échoué.");

      form.reset();
      resetPreview();
      window.turnstile?.reset?.();
      setStatus("Votre déclaration a bien été envoyée.", "success");
    } catch (error) {
      window.turnstile?.reset?.();
      setStatus(
        "Impossible d'envoyer la déclaration. Réessayez dans quelques instants.",
        "error"
      );
    } finally {
      submitButton.disabled = false;
      submitLabel.textContent = "Envoyer la déclaration";
    }
  });
})();
