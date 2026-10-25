// Re-renders every [data-status] chip from integration-status.json (SCHO-229). The HTML already
// carries the chip that build.mjs stamped from the same file, so without JavaScript nothing changes.
fetch("/assets/integration-status.json")
  .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
  .then(({levels, features}) => {
    for (const el of document.querySelectorAll("[data-status]")) {
      const level = levels[features[el.dataset.status]];
      if (!level) continue;
      el.className = `status ${level.class}`;
      el.textContent = level.label;
    }
  })
  .catch(() => {});
