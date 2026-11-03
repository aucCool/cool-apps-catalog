import type { AuditRow, DocumentRow, DocumentSummary, FieldRow, SignerRow } from "./data";
import type { FieldType } from "./validate";

const COLORS = ["#8f2d2a", "#1f4e79", "#1f6b45", "#8a5a12", "#5c3d7a", "#0f6e6e"];

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function jsonScript(id: string, value: unknown): string {
  const json = JSON.stringify(value).replaceAll("<", "\\u003c");
  return `<script type="application/json" id="${escapeHtml(id)}">${json}</script>`;
}

function layout(input: {
  title: string;
  body: string;
  csrf?: string;
  authed?: boolean;
  scripts?: string[];
}): string {
  const csrf = input.csrf ? `<meta name="csrf" content="${escapeHtml(input.csrf)}">` : "";
  const nav = input.authed
    ? `<header class="bar">
        <a class="brand" href="/documents">Signet</a>
        <nav>
          <a href="/documents">Documents</a>
          <form method="post" action="/logout"><button type="submit">Log out</button></form>
        </nav>
      </header>`
    : `<header class="bar"><span class="brand">Signet</span></header>`;
  const scripts = (input.scripts ?? [])
    .map((src) => `<script type="module" src="${src}"></script>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  ${csrf}
  <title>${escapeHtml(input.title)}</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  ${nav}
  <main>${input.body}</main>
  ${scripts}
</body>
</html>`;
}

function banner(notice: string | null, error: string | null): string {
  const parts: string[] = [];
  if (error) parts.push(`<p class="banner bad" role="alert">${escapeHtml(error)}</p>`);
  if (notice) parts.push(`<p class="banner good" role="status">${escapeHtml(notice)}</p>`);
  return parts.join("");
}

export function loginPage(error: string | null): string {
  const alert = error ? `<p class="banner bad" role="alert">${escapeHtml(error)}</p>` : "";
  return layout({
    title: "Sign in · Signet",
    body: `<section class="narrow card">
      <p class="eyebrow">Document signing</p>
      <h1>Sign in</h1>
      <p class="lede">Upload a PDF, place the fields, and send each person a link to sign.</p>
      ${alert}
      <form method="post" action="/login" class="stack">
        <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
        <button class="primary" type="submit">Sign in</button>
      </form>
    </section>`,
  });
}

export function messagePage(title: string, message: string, authed: boolean): string {
  return layout({
    title: `${title} · Signet`,
    authed,
    body: `<section class="narrow card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></section>`,
  });
}

export function documentsPage(input: {
  rows: DocumentSummary[];
  csrf: string;
  notice: string | null;
  error: string | null;
}): string {
  const cards =
    input.rows.length === 0
      ? `<p class="empty">No documents yet. Upload a PDF to start one.</p>`
      : `<ul class="cards">${input.rows.map((row) => documentCard(row)).join("")}</ul>`;
  return layout({
    title: "Documents · Signet",
    authed: true,
    csrf: input.csrf,
    scripts: ["/ui.js"],
    body: `<section class="wide">
      ${banner(input.notice, input.error)}
      <div class="split">
        <div>
          <h1>Documents</h1>
          <p class="lede">Each document is one PDF and the people who need to sign it.</p>
        </div>
        <form method="post" action="/documents" enctype="multipart/form-data" class="card stack">
          <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
          <h2>New document</h2>
          <label>PDF <input type="file" name="file" accept="application/pdf,.pdf" required></label>
          <button class="primary" type="submit">Upload</button>
        </form>
      </div>
      ${cards}
    </section>`,
  });
}

function documentCard(row: DocumentSummary): string {
  const progress =
    row.signer_count === 0 ? "No signers yet" : `${row.signed_count} of ${row.signer_count} signed`;
  return `<li class="card link-card">
    <a href="/documents/${escapeHtml(row.id)}">
      <span class="pill ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span>
      <strong>${escapeHtml(row.title)}</strong>
      <span class="meta">${escapeHtml(progress)} · ${escapeHtml(formatWhen(row.created_at))}</span>
    </a>
  </li>`;
}

export function documentPage(input: {
  doc: DocumentRow;
  signers: SignerRow[];
  fields: FieldRow[];
  events: AuditRow[];
  csrf: string;
  origin: string;
  notice: string | null;
  error: string | null;
}): string {
  const draft = input.doc.status === "draft";
  const payload = {
    fileUrl: `/documents/${input.doc.id}/file.pdf`,
    readonly: !draft,
    signers: input.signers.map((signer, index) => ({
      id: signer.id,
      name: signer.name,
      color: COLORS[index % COLORS.length],
    })),
    fields: input.fields.map((field) => ({
      id: field.id,
      signerId: field.signer_id,
      type: field.type,
      page: field.page,
      x: field.x,
      y: field.y,
      w: field.w,
      h: field.h,
      required: field.required === 1,
      label: field.label,
    })),
  };
  return layout({
    title: `${input.doc.title} · Signet`,
    authed: true,
    csrf: input.csrf,
    scripts: ["/ui.js", "/editor.js"],
    body: `<section class="wide">
      ${banner(input.notice, input.error)}
      <div class="doc-head">
        <div>
          <p class="eyebrow">${escapeHtml(input.doc.status)}</p>
          <h1>${escapeHtml(input.doc.title)}</h1>
        </div>
        ${downloadLinks(input.doc)}
      </div>
      <div class="doc-layout">
        <aside class="stack">
          ${settingsForm(input)}
          ${signersBlock(input)}
          ${draft ? fieldTools(input.signers) : ""}
          ${actions(input)}
          ${linksBlock(input)}
          ${auditBlock(input.events)}
        </aside>
        <div>
          <p id="stage-status" class="meta">Opening the PDF…</p>
          <div id="stage" class="stage"></div>
          <div id="field-panel" class="card stack" hidden></div>
        </div>
      </div>
      ${jsonScript("doc-data", payload)}
    </section>`,
  });
}

function downloadLinks(doc: DocumentRow): string {
  const original = `<a class="button" href="/documents/${escapeHtml(doc.id)}/file.pdf">Original PDF</a>`;
  const done = doc.completed_key
    ? `<a class="button primary" href="/documents/${escapeHtml(doc.id)}/completed.pdf">Signed PDF</a>`
    : "";
  return `<div class="row">${original}${done}</div>`;
}

function settingsForm(input: { doc: DocumentRow; csrf: string }): string {
  if (input.doc.status !== "draft") {
    return `<section class="card stack">
      <h2>Details</h2>
      <p>${escapeHtml(input.doc.message || "No note for signers.")}</p>
      <p class="meta">${input.doc.order_mode === "sequential" ? "Signers go in order." : "Anyone can sign at the same time."}</p>
    </section>`;
  }
  const parallel = input.doc.order_mode === "parallel" ? "checked" : "";
  const sequential = input.doc.order_mode === "sequential" ? "checked" : "";
  return `<form method="post" action="/documents/${escapeHtml(input.doc.id)}" class="card stack">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
    <h2>Details</h2>
    <label>Title <input name="title" required maxlength="200" value="${escapeHtml(input.doc.title)}"></label>
    <label>Note for signers <textarea name="message" maxlength="2000" rows="3">${escapeHtml(input.doc.message)}</textarea></label>
    <fieldset>
      <legend>Order</legend>
      <label class="check"><input type="radio" name="order_mode" value="parallel" ${parallel}> Anyone can sign at the same time</label>
      <label class="check"><input type="radio" name="order_mode" value="sequential" ${sequential}> Signers go in the order listed</label>
    </fieldset>
    <button type="submit">Save details</button>
  </form>`;
}

function signersBlock(input: { doc: DocumentRow; signers: SignerRow[]; csrf: string }): string {
  const items = input.signers
    .map((signer, index) => {
      const remove =
        input.doc.status === "draft"
          ? `<form method="post" action="/documents/${escapeHtml(input.doc.id)}/signers/${escapeHtml(signer.id)}/delete">
              <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
              <button type="submit">Remove</button>
            </form>`
          : `<span class="pill ${escapeHtml(signer.status)}">${escapeHtml(signer.status)}</span>`;
      return `<li class="signer">
        <span class="swatch signer-${index % COLORS.length}"></span>
        <span><strong>${escapeHtml(signer.name)}</strong><span class="meta">${escapeHtml(signer.email)}</span></span>
        ${remove}
      </li>`;
    })
    .join("");
  const form =
    input.doc.status === "draft"
      ? `<form method="post" action="/documents/${escapeHtml(input.doc.id)}/signers" class="stack">
          <input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
          <label>Name <input name="name" required maxlength="120"></label>
          <label>Email <input name="email" type="email" required maxlength="200"></label>
          <button type="submit">Add signer</button>
        </form>`
      : "";
  return `<section class="card stack">
    <h2>Signers</h2>
    ${items ? `<ul class="signers">${items}</ul>` : `<p class="meta">Add the people who need to sign.</p>`}
    ${form}
  </section>`;
}

function fieldTools(signers: SignerRow[]): string {
  if (signers.length === 0) {
    return `<section class="card"><h2>Fields</h2><p class="meta">Add a signer before placing fields.</p></section>`;
  }
  const options = signers
    .map((signer) => `<option value="${escapeHtml(signer.id)}">${escapeHtml(signer.name)}</option>`)
    .join("");
  const types: [FieldType, string][] = [
    ["signature", "Signature"],
    ["initials", "Initials"],
    ["text", "Text"],
    ["date", "Date"],
    ["checkbox", "Checkbox"],
  ];
  return `<section class="card stack">
    <h2>Fields</h2>
    <label>Type <select id="field-type">${types.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
    <label>Who fills it <select id="field-signer">${options}</select></label>
    <p class="meta">Click the page to drop a field. Drag it to move it, and drag the corner to resize.</p>
    <button type="button" id="save-fields" class="primary">Save fields</button>
    <p id="save-status" class="meta" role="status"></p>
  </section>`;
}

function actions(input: {
  doc: DocumentRow;
  signers: SignerRow[];
  fields: FieldRow[];
  csrf: string;
}): string {
  const id = escapeHtml(input.doc.id);
  const csrf = escapeHtml(input.csrf);
  if (input.doc.status === "draft") {
    return `<section class="card stack">
      <h2>Send</h2>
      <form method="post" action="/documents/${id}/send">
        <input type="hidden" name="csrf" value="${csrf}">
        <button class="primary" type="submit">Create signing links</button>
      </form>
      <form method="post" action="/documents/${id}/delete" class="inline-confirm">
        <input type="hidden" name="csrf" value="${csrf}">
        <button type="submit">Delete draft</button>
      </form>
    </section>`;
  }
  const retry =
    input.doc.status === "sent" &&
    input.signers.length > 0 &&
    input.signers.every((signer) => signer.status === "signed") &&
    !input.doc.completed_key
      ? `<form method="post" action="/documents/${id}/complete">
          <input type="hidden" name="csrf" value="${csrf}">
          <button class="primary" type="submit">Build signed PDF</button>
        </form>`
      : "";
  if (input.doc.status === "completed" || input.doc.status === "void") {
    return retry;
  }
  return `<section class="card stack">
    <h2>Close</h2>
    ${retry}
    <form method="post" action="/documents/${id}/void">
      <input type="hidden" name="csrf" value="${csrf}">
      <button type="submit">Void document</button>
    </form>
    <p class="meta">Voiding stops every signing link. Signed fields already stored stay in the audit.</p>
  </section>`;
}

function linksBlock(input: { doc: DocumentRow; signers: SignerRow[]; origin: string }): string {
  if (input.doc.status === "draft" || input.signers.length === 0) return "";
  const items = input.signers
    .map((signer) => {
      const url = `${input.origin}/s/${signer.token}`;
      return `<li>
        <strong>${escapeHtml(signer.name)}</strong>
        <span class="pill ${escapeHtml(signer.status)}">${escapeHtml(signer.status)}</span>
        <code>${escapeHtml(url)}</code>
        <button type="button" data-copy="${escapeHtml(url)}">Copy link</button>
      </li>`;
    })
    .join("");
  return `<section class="card stack"><h2>Signing links</h2><ul class="links">${items}</ul></section>`;
}

function auditBlock(events: AuditRow[]): string {
  if (events.length === 0) return "";
  const items = events
    .map(
      (event) =>
        `<li><span class="meta">${escapeHtml(formatWhen(event.at))}</span> ${escapeHtml(event.actor)} ${escapeHtml(event.event.replaceAll("_", " "))}${event.detail ? ` <span class="meta">${escapeHtml(event.detail)}</span>` : ""}</li>`,
    )
    .join("");
  return `<section class="card stack"><h2>Audit</h2><ul class="audit">${items}</ul></section>`;
}

export type SignField = {
  id: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  label: string;
};

export function signPage(input: {
  title: string;
  message: string;
  banner: string;
  mode: "sign" | "preview" | "done";
  fileUrl: string;
  downloadUrl: string | null;
  fields: SignField[];
}): string {
  const download = input.downloadUrl
    ? `<a class="button primary" href="${escapeHtml(input.downloadUrl)}">Download signed PDF</a>`
    : input.fileUrl
      ? `<a class="button" href="${escapeHtml(input.fileUrl)}">Download PDF</a>`
      : "";
  const consent =
    input.mode === "sign"
      ? `<div class="card stack sign-actions">
          <label class="check"><input type="checkbox" id="consent"> I agree to sign this document electronically</label>
          <button type="button" class="primary" id="submit-sign">Submit signature</button>
          <p id="sign-error" class="banner bad" role="alert" hidden></p>
        </div>`
      : "";
  const note = input.message ? `<p>${escapeHtml(input.message)}</p>` : "";
  return layout({
    title: `${input.title} · Sign`,
    scripts: ["/sign.js"],
    body: `<section class="wide">
      <div class="doc-head">
        <div>
          <p class="eyebrow">Please review</p>
          <h1>${escapeHtml(input.title)}</h1>
          ${note}
          <p class="banner" role="status">${escapeHtml(input.banner)}</p>
        </div>
        ${download}
      </div>
      <p id="stage-status" class="meta">Opening the PDF…</p>
      <div id="stage" class="stage"></div>
      ${consent}
      <dialog id="pad-dialog">
        <h2>Your signature</h2>
        <canvas id="pad" width="640" height="220"></canvas>
        <label>Or type your name <input id="pad-typed" autocomplete="name" maxlength="80"></label>
        <div class="row">
          <button type="button" id="pad-type">Use typed name</button>
          <button type="button" id="pad-reuse" hidden>Reuse signature</button>
          <button type="button" id="pad-clear">Clear</button>
          <button type="button" id="pad-apply" class="primary">Apply</button>
          <button type="button" id="pad-cancel">Cancel</button>
        </div>
      </dialog>
      ${jsonScript("sign-data", { mode: input.mode, fileUrl: input.fileUrl, fields: input.fields })}
    </section>`,
  });
}
