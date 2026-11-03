const data = JSON.parse(document.querySelector("#sign-data")?.textContent ?? "{}");
const stage = document.querySelector("#stage");
const status = document.querySelector("#stage-status");
const images = new Map();
let activeId = null;
let lastImage = "";

const dialog = document.querySelector("#pad-dialog");
const pad = document.querySelector("#pad");
const padCtx = pad?.getContext("2d");

init().catch((error) => {
  if (status) status.textContent = "This PDF could not be shown. Use the download link.";
  console.error(error);
});

async function init() {
  if (!stage || !data.fileUrl) {
    if (status) status.textContent = "";
    return;
  }
  const pdfjs = await import("/pdfjs/pdf.min.mjs");
  const lib = pdfjs.getDocument ? pdfjs : pdfjs.default;
  lib.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const pdf = await lib.getDocument({ url: data.fileUrl, isEvalSupported: false }).promise;
  const width = Math.min(820, stage.clientWidth || 640);
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const wrap = document.createElement("div");
    wrap.className = "page";
    wrap.style.width = `${viewport.width}px`;
    wrap.style.height = `${viewport.height}px`;
    const canvas = document.createElement("canvas");
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.dataset.page = String(pageNumber);
    wrap.append(canvas, overlay);
    stage.append(wrap);
    const context = canvas.getContext("2d");
    if (!context) continue;
    context.scale(ratio, ratio);
    await page.render({ canvasContext: context, viewport }).promise;
  }
  if (data.mode === "sign") drawFields();
  if (status) status.textContent = "";
  wirePad();
  document.querySelector("#submit-sign")?.addEventListener("click", submit);
}

function drawFields() {
  for (const field of data.fields ?? []) {
    const overlay = document.querySelector(`.overlay[data-page="${field.page}"]`);
    if (!overlay) continue;
    const box = document.createElement("div");
    box.className = "field";
    box.style.left = `${field.x * 100}%`;
    box.style.top = `${field.y * 100}%`;
    box.style.width = `${field.w * 100}%`;
    box.style.height = `${field.h * 100}%`;
    box.append(control(field));
    overlay.append(box);
  }
}

function control(field) {
  if (field.type === "signature" || field.type === "initials") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sign-hit";
    button.dataset.field = field.id;
    const img = document.createElement("img");
    img.alt = "";
    img.hidden = true;
    const caption = document.createElement("span");
    caption.textContent = field.label || (field.type === "initials" ? "Initial" : "Sign");
    button.append(img, caption);
    button.addEventListener("click", () => openPad(field.id));
    return button;
  }
  if (field.type === "checkbox") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `f-${field.id}`;
    input.setAttribute("aria-label", field.label || "Checkbox");
    return input;
  }
  const input = document.createElement("input");
  input.id = `f-${field.id}`;
  input.type = field.type === "date" ? "date" : "text";
  input.placeholder = field.label || (field.type === "date" ? "Date" : "Text");
  input.maxLength = 500;
  if (field.type === "date") input.value = new Date().toISOString().slice(0, 10);
  return input;
}

function wirePad() {
  if (!pad || !padCtx || !dialog) return;
  let drawing = false;
  const pos = (event) => {
    const rect = pad.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * pad.width,
      y: ((event.clientY - rect.top) / rect.height) * pad.height,
    };
  };
  pad.addEventListener("pointerdown", (event) => {
    drawing = true;
    pad.setPointerCapture(event.pointerId);
    const point = pos(event);
    padCtx.beginPath();
    padCtx.moveTo(point.x, point.y);
  });
  pad.addEventListener("pointermove", (event) => {
    if (!drawing) return;
    const point = pos(event);
    padCtx.lineWidth = 2.6;
    padCtx.lineCap = "round";
    padCtx.strokeStyle = "#1e1a16";
    padCtx.lineTo(point.x, point.y);
    padCtx.stroke();
  });
  pad.addEventListener("pointerup", () => {
    drawing = false;
  });
  document.querySelector("#pad-clear")?.addEventListener("click", () => {
    padCtx.clearRect(0, 0, pad.width, pad.height);
  });
  document.querySelector("#pad-type")?.addEventListener("click", typeName);
  document.querySelector("#pad-reuse")?.addEventListener("click", () => {
    if (lastImage) paintImage(lastImage);
  });
  document.querySelector("#pad-cancel")?.addEventListener("click", () => dialog.close());
  document.querySelector("#pad-apply")?.addEventListener("click", applyPad);
}

function openPad(id) {
  activeId = id;
  if (!pad || !padCtx || !dialog) return;
  padCtx.clearRect(0, 0, pad.width, pad.height);
  const existing = images.get(id);
  if (existing) paintImage(existing);
  const reuse = document.querySelector("#pad-reuse");
  if (reuse) reuse.hidden = !lastImage;
  dialog.showModal();
}

function typeName() {
  if (!pad || !padCtx) return;
  const name = document.querySelector("#pad-typed")?.value.trim() ?? "";
  if (!name) return;
  padCtx.clearRect(0, 0, pad.width, pad.height);
  padCtx.fillStyle = "#1e1a16";
  padCtx.textBaseline = "middle";
  let size = 64;
  do {
    padCtx.font = `${size}px "Segoe Script", "Snell Roundhand", cursive`;
    if (padCtx.measureText(name).width < pad.width - 48) break;
    size -= 4;
  } while (size > 20);
  padCtx.fillText(name, 24, pad.height / 2);
}

function paintImage(src) {
  if (!pad || !padCtx) return;
  const img = new Image();
  img.onload = () => {
    padCtx.clearRect(0, 0, pad.width, pad.height);
    padCtx.drawImage(img, 0, 0, pad.width, pad.height);
  };
  img.src = src;
}

function applyPad() {
  if (!pad || !padCtx || !activeId) return;
  if (blank(pad)) {
    setError("Draw or type a signature first.");
    return;
  }
  const url = pad.toDataURL("image/png");
  images.set(activeId, url);
  lastImage = url;
  const button = document.querySelector(`[data-field="${activeId}"]`);
  const img = button?.querySelector("img");
  const caption = button?.querySelector("span");
  if (img) {
    img.src = url;
    img.hidden = false;
  }
  if (caption) caption.textContent = "Change";
  dialog?.close();
  setError("");
}

function blank(canvas) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return true;
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < pixels.length; i += 16) {
    if ((pixels[i] ?? 0) !== 0) return false;
  }
  return true;
}

async function submit() {
  const error = document.querySelector("#sign-error");
  if (!document.querySelector("#consent")?.checked) {
    setError("Confirm that you agree to sign electronically.");
    return;
  }
  const values = (data.fields ?? []).map((field) => {
    if (field.type === "signature" || field.type === "initials") {
      return { fieldId: field.id, image: images.get(field.id) ?? "", text: "" };
    }
    const input = document.querySelector(`#f-${CSS.escape(field.id)}`);
    if (field.type === "checkbox") {
      return { fieldId: field.id, text: input?.checked ? "yes" : "no", image: "" };
    }
    return { fieldId: field.id, text: input?.value ?? "", image: "" };
  });
  const button = document.querySelector("#submit-sign");
  if (button) button.disabled = true;
  const response = await fetch(location.pathname, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ consent: true, values }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    setError(body.error ?? "Could not submit.");
    if (button) button.disabled = false;
    return;
  }
  if (error) error.hidden = true;
  location.reload();
}

function setError(message) {
  const error = document.querySelector("#sign-error");
  if (!error) return;
  error.hidden = !message;
  error.textContent = message;
}
