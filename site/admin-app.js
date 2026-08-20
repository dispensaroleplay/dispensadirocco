(() => {
  const form = document.getElementById("production-form");
  const uploadZone = document.getElementById("upload-zone");
  const proofInput = document.getElementById("proof");
  const uploadTitle = document.getElementById("upload-title");
  const previewImage = document.getElementById("preview-image");
  const status = document.getElementById("form-status");
  const submitButton = document.getElementById("submit-button");
  const submitLabel = document.getElementById("submit-label");

  if (!form || !uploadZone || !proofInput || !status || !submitButton) {
    console.error("[admin-app] éléments du formulaire introuvables");
    return;
  }

  const maxFileSize = 8 * 1024 * 1024;
  const maxFiles = 10;
  let previewUrls = [];

  // Le CSS injecté place #proof en overlay cliquable ; pas besoin de .click() JS.
  proofInput.multiple = true;
  proofInput.accept =
    "image/png,image/jpeg,image/jpg,image/webp,image/*,.png,.jpg,.jpeg,.webp";
  proofInput.required = true;

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
    if (previewImage) previewImage.removeAttribute("src");
    uploadZone.classList.remove("has-file");
    if (uploadTitle) uploadTitle.textContent = "Ajouter une ou plusieurs images";
  };

  const isAllowedImage = (file) => {
    const type = String(file.type || "").toLowerCase();
    if (type.startsWith("image/")) return true;
    return /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name || "");
  };

  const collectValidFiles = (fileList) => {
    const files = [...(fileList || [])].filter(Boolean);
    if (!files.length) return [];

    if (files.length > maxFiles) {
      setStatus(`Maximum ${maxFiles} images par déclaration.`, "error");
      return null;
    }

    for (const file of files) {
      if (!isAllowedImage(file)) {
        setStatus("Formats acceptés : PNG, JPEG, WEBP (ou image téléphone).", "error");
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
    const files = collectValidFiles(fileList);
    if (files === null) {
      proofInput.value = "";
      resetPreview();
      return;
    }

    resetPreview();
    if (!files.length) return;

    if (previewImage) {
      const firstUrl = URL.createObjectURL(files[0]);
      previewUrls = [firstUrl];
      previewImage.src = firstUrl;
    }

    if (uploadTitle) {
      uploadTitle.textContent =
        files.length === 1
          ? files[0].name
          : `${files.length} images sélectionnées`;
    }
    uploadZone.classList.add("has-file");
    setStatus(`${files.length} image(s) prête(s) à envoyer.`);
  };

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
    const dropped = [...(event.dataTransfer?.files || [])];
    if (!dropped.length) return;
    const transfer = new DataTransfer();
    for (const file of dropped.slice(0, maxFiles)) transfer.items.add(file);
    proofInput.files = transfer.files;
    updateFiles(proofInput.files);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = form.elements.name.value.trim();
    const stock = form.elements.stock.value;
    const proofs = [...(proofInput.files || [])];

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

    const endpoint = (
      document.documentElement.dataset.submitEndpoint || "/api/submit"
    ).trim();

    submitButton.disabled = true;
    if (submitLabel) submitLabel.textContent = "Envoi en cours…";
    setStatus("Transmission de votre déclaration…");

    try {
      const payload = new FormData();
      payload.append("name", name);
      payload.append("stock", stock);
      for (const file of proofs) payload.append("proof", file);

      const response = await fetch(endpoint, {
        method: "POST",
        body: payload,
        credentials: "same-origin"
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      form.reset();
      resetPreview();
      setStatus(data.message || "Votre déclaration a bien été envoyée.", "success");
    } catch (error) {
      setStatus(
        `Impossible d'envoyer la déclaration : ${error?.message || "erreur"}`,
        "error"
      );
    } finally {
      submitButton.disabled = false;
      if (submitLabel) submitLabel.textContent = "Envoyer la déclaration";
    }
  });
})();
