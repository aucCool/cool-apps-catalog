const data = JSON.parse(document.querySelector("#doc-data")?.textContent ?? "{}");
const stage = document.querySelector("#stage");
const status = document.querySelector("#stage-status");
const panel = document.querySelector("#field-panel");
const fields = Array.isArray(data.fields) ? data.fields : [];
let selected = null;

const sizes = {
  signature: { w: 0.28, h: 0.08 },
  initials: { w: 0.12, h: 0.06 },
  text: { w: 0.28, h: 0.045 },
  date: { w: 0.18, h: 0.045 },
  checkbox: { w: 0.06, h: 0.06 },
};

init().catch((error) => {
  if (status) status.textContent = "This PDF could not be shown.";
  console.error(error);
});

async function init() {
  if (!stage || !data.fileUrl) return;
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
    wrap.dataset.page = String(pageNumber);
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
    wrap.append(canvas, overlay);
    stage.append(wrap);
    const context = canvas.getContext("2d");
    if (!context) continue;
    context.scale(ratio, ratio);
    await page.render({ canvasContext: context, viewport }).promise;
    if (!data.readonly) {
      overlay.addEventListener("click", (event) => {
        if (event.target !== overlay) return;
        addField(pageNumber, event, overlay);
      });
    }
  }
  renderFields();
  renderPanel();
  if (status)
    status.textContent = data.readonly
      ? "Sent documents keep their fields where you placed them."
      : "";
  document.querySelector("#save-fields")?.addEventListener("click", saveFields);
  window.addEventListener("keydown", (event) => {
    if (data.readonly || !selected) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
      return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeField(selected);
    }
  });
}

function addField(page, event, overlay) {
  const type = document.querySelector("#field-type")?.value ?? "signature";
  const signerId = document.querySelector("#field-signer")?.value ?? "";
  if (!signerId) return;
  const size = sizes[type] ?? sizes.signature;
  const point = fraction(event, overlay);
  fields.push({
    id: crypto.randomUUID(),
    signerId,
    type,
    page,
    x: clamp(point.x - size.w / 2, 0, 1 - size.w),
    y: clamp(point.y - size.h / 2, 0, 1 - size.h),
    w: size.w,
    h: size.h,
    required: true,
    label: "",
  });
  selected = fields.at(-1)?.id ?? null;
  renderFields();
  renderPanel();
}

function renderFields() {
  for (const overlay of document.querySelectorAll(".overlay")) overlay.replaceChildren();
  for (const field of fields) {
    const overlay = document.querySelector(`.page[data-page="${field.page}"] .overlay`);
    if (!overlay) continue;
    const signer = (data.signers ?? []).find((item) => item.id === field.signerId);
    const el = document.createElement("div");
    el.className = `field${field.id === selected ? " selected" : ""}`;
    el.dataset.id = field.id;
    el.style.setProperty("--c", signer?.color ?? "#8f2d2a");
    place(el, field);
    const label = document.createElement("span");
    label.className = "field-name";
    label.textContent = fieldLabel(field, signer?.name);
    el.append(label);
    if (!data.readonly) {
      const handle = document.createElement("button");
      handle.type = "button";
      handle.className = "resize";
      handle.dataset.resize = "true";
      handle.setAttribute("aria-label", "Resize field");
      el.append(handle);
      el.addEventListener("pointerdown", (event) => startDrag(event, el, field));
    }
    overlay.append(el);
  }
}

function renderPanel() {
  if (!panel) return;
  const field = fields.find((item) => item.id === selected);
  if (!field || data.readonly) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  panel.hidden = false;
  panel.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = "Selected field";
  const label = document.createElement("label");
  label.textContent = "Label";
  const input = document.createElement("input");
  input.value = field.label ?? "";
  input.maxLength = 80;
  input.addEventListener("input", () => {
    field.label = input.value;
    const caption = document.querySelector(`.field[data-id="${field.id}"] .field-name`);
    const signer = (data.signers ?? []).find((item) => item.id === field.signerId);
    if (caption) caption.textContent = fieldLabel(field, signer?.name);
  });
  label.append(input);
  const required = document.createElement("label");
  required.className = "check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = field.required !== false;
  box.addEventListener("change", () => {
    field.required = box.checked;
  });
  required.append(box, document.createTextNode(" Required"));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove field";
  remove.addEventListener("click", () => removeField(field.id));
  panel.append(title, label, required, remove);
}

function startDrag(event, el, field) {
  if (data.readonly) return;
  event.preventDefault();
  event.stopPropagation();
  selected = field.id;
  const page = el.closest(".page");
  if (!page) return;
  const point = fraction(event, page);
  const mode =
    event.target instanceof HTMLElement && event.target.dataset.resize ? "resize" : "move";
  const drag = { mode, x: point.x, y: point.y, field: { ...field } };
  el.setPointerCapture(event.pointerId);
  const move = (ev) => {
    const next = fraction(ev, page);
    if (drag.mode === "resize") {
      field.w = clamp(drag.field.w + next.x - drag.x, 0.03, 1 - field.x);
      field.h = clamp(drag.field.h + next.y - drag.y, 0.02, 1 - field.y);
    } else {
      field.x = clamp(drag.field.x + next.x - drag.x, 0, 1 - field.w);
      field.y = clamp(drag.field.y + next.y - drag.y, 0, 1 - field.h);
    }
    place(el, field);
  };
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    renderFields();
    renderPanel();
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  renderPanel();
}

async function saveFields() {
  const note = document.querySelector("#save-status");
  const csrf = document.querySelector('meta[name="csrf"]')?.content ?? "";
  if (note) note.textContent = "Saving…";
  const response = await fetch(`${location.pathname.replace(/\/$/, "")}/fields`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-csrf": csrf },
    body: JSON.stringify({ fields }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (note) note.textContent = body.error ?? "Could not save fields.";
    return;
  }
  if (note) note.textContent = "Fields saved.";
}

function removeField(id) {
  const index = fields.findIndex((field) => field.id === id);
  if (index >= 0) fields.splice(index, 1);
  selected = null;
  renderFields();
  renderPanel();
}

function fieldLabel(field, name) {
  const kind = field.type === "signature" ? "Sign" : field.type;
  return field.label || `${kind}${name ? ` · ${name}` : ""}`;
}

function place(el, field) {
  el.style.left = `${field.x * 100}%`;
  el.style.top = `${field.y * 100}%`;
  el.style.width = `${field.w * 100}%`;
  el.style.height = `${field.h * 100}%`;
}

function fraction(event, el) {
  const rect = el.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
