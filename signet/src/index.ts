import { PDFDocument } from "pdf-lib";
import {
  b64urlEncode,
  newCsrf,
  openSession,
  passwordMatches,
  readCookie,
  type Session,
  safeEqual,
  sealSession,
  sessionCookie,
} from "./auth";
import {
  addSigner,
  clientDetail,
  type DocumentRow,
  deleteDocument,
  deleteSigner,
  type FieldRow,
  getDocument,
  insertDocument,
  listAudit,
  listDocuments,
  listFields,
  listSigners,
  listValues,
  markCompleted,
  markSent,
  markViewed,
  markVoid,
  nextSignerIndex,
  nowIso,
  replaceFields,
  type SignerRow,
  saveSubmission,
  updateDraft,
} from "./data";
import { documentPage, documentsPage, formatWhen, loginPage, messagePage, signPage } from "./html";
import {
  appOrigin,
  type Env,
  HttpError,
  html,
  json,
  matchPath,
  noticeOf,
  passwordOf,
  pdfResponse,
  readBody,
  redirect,
  sameOrigin,
  wantsJson,
} from "./http";
import { sendSigningMail } from "./mail";
import { isPdf, type Placement, stampPdf } from "./stamp";
import {
  cleanLine,
  decodePngDataUrl,
  parseFields,
  parseValues,
  signerMaySign,
  submissionError,
  validEmail,
  waitingFor,
} from "./validate";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      if (error instanceof HttpError) {
        if (wantsJson(request)) return json({ error: error.message }, error.status);
        const authed = (await quietSession(request, env)) !== null;
        return html(messagePage("Signet", error.message, authed), error.status);
      }
      console.error(error);
      return html(messagePage("Signet", "Something went wrong.", false), 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "GET" && path === "/health") {
    return json({ ok: true, version: "0.1.0" });
  }
  if (path === "/") return home(request, env);
  if (path === "/login" && request.method === "POST") return login(request, env);
  if (path === "/logout" && request.method === "POST") return logout(request);
  if (path === "/documents" && request.method === "GET") return documents(request, env, url);
  if (path === "/documents" && request.method === "POST") return createDocument(request, env);

  const file = matchPath(path, "/documents/:id/file.pdf");
  if (file && request.method === "GET") return adminPdf(request, env, file.id ?? "", "original");
  const done = matchPath(path, "/documents/:id/completed.pdf");
  if (done && request.method === "GET") return adminPdf(request, env, done.id ?? "", "completed");

  const doc = matchPath(path, "/documents/:id");
  if (doc?.id) {
    if (request.method === "GET") return showDocument(request, env, url, doc.id);
    if (request.method === "POST") return saveDetails(request, env, doc.id);
  }
  const signers = matchPath(path, "/documents/:id/signers");
  if (signers?.id && request.method === "POST") return createSigner(request, env, signers.id);
  const removeSigner = matchPath(path, "/documents/:id/signers/:signerId/delete");
  if (removeSigner?.id && removeSigner.signerId && request.method === "POST") {
    return removeSignerRoute(request, env, removeSigner.id, removeSigner.signerId);
  }
  const fields = matchPath(path, "/documents/:id/fields");
  if (fields?.id && request.method === "POST") return saveFields(request, env, fields.id);
  const send = matchPath(path, "/documents/:id/send");
  if (send?.id && request.method === "POST") return sendDocument(request, env, send.id);
  const voided = matchPath(path, "/documents/:id/void");
  if (voided?.id && request.method === "POST") return voidDocument(request, env, voided.id);
  const deleted = matchPath(path, "/documents/:id/delete");
  if (deleted?.id && request.method === "POST") return removeDraft(request, env, deleted.id);
  const complete = matchPath(path, "/documents/:id/complete");
  if (complete?.id && request.method === "POST") return rebuild(request, env, complete.id);

  const signedFile = matchPath(path, "/s/:token/file.pdf");
  if (signedFile?.token && request.method === "GET")
    return signerPdf(env, signedFile.token, "original");
  const signedDone = matchPath(path, "/s/:token/completed.pdf");
  if (signedDone?.token && request.method === "GET")
    return signerPdf(env, signedDone.token, "completed");
  const signing = matchPath(path, "/s/:token");
  if (signing?.token && request.method === "GET") return showSigning(request, env, signing.token);
  if (signing?.token && request.method === "POST")
    return submitSigning(request, env, signing.token);

  const authed = (await quietSession(request, env)) !== null;
  return html(messagePage("Not found", "That page does not exist.", authed), 404);
}

async function home(request: Request, env: Env): Promise<Response> {
  if (await quietSession(request, env)) return redirect("/documents");
  try {
    passwordOf(env);
  } catch (error) {
    if (error instanceof HttpError) return html(loginPage(error.message), error.status);
    throw error;
  }
  return html(loginPage(null));
}

async function login(request: Request, env: Env): Promise<Response> {
  assertOrigin(request);
  const secret = passwordOf(env);
  const data = await request.formData();
  const given = String(data.get("password") ?? "");
  if (!(await passwordMatches(secret, given))) {
    return html(loginPage("That password is not right."), 401);
  }
  const csrf = newCsrf();
  const token = await sealSession(secret, csrf);
  const secure = new URL(request.url).protocol === "https:";
  return redirect("/documents", { "set-cookie": sessionCookie(token, secure) });
}

async function logout(request: Request): Promise<Response> {
  assertOrigin(request);
  const secure = new URL(request.url).protocol === "https:";
  return redirect("/", { "set-cookie": sessionCookie("gone", secure, 0) });
}

async function documents(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  const rows = await listDocuments(env.DB);
  return html(documentsPage({ rows, csrf: session.csrf, notice: noticeOf(url), error: null }));
}

async function createDocument(request: Request, env: Env): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  const data = await form(request, session);
  const file = data.get("file");
  if (typeof file !== "object" || file === null)
    throw new HttpError(400, "Choose a PDF to upload.");
  if (file.size > 15 * 1024 * 1024) throw new HttpError(413, "PDFs must be 15 MB or smaller.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isPdf(bytes)) throw new HttpError(400, "That file is not a PDF.");
  let pageCount = 0;
  try {
    const pdf = await PDFDocument.load(bytes);
    pageCount = pdf.getPageCount();
  } catch {
    throw new HttpError(400, "That PDF could not be read. It may be encrypted or damaged.");
  }
  if (pageCount < 1) throw new HttpError(400, "That PDF has no pages.");
  const id = rid("doc");
  const key = `originals/${id}.pdf`;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const created = nowIso();
  await insertDocument(
    env.DB,
    {
      id,
      title: titleFrom(file.name),
      status: "draft",
      order_mode: "parallel",
      message: "",
      original_key: key,
      completed_key: null,
      page_count: pageCount,
      created_at: created,
      sent_at: null,
      completed_at: null,
      voided_at: null,
    },
    rid("aud"),
  );
  return redirect(`/documents/${id}?notice=created`);
}

async function showDocument(request: Request, env: Env, url: URL, id: string): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  const loaded = await load(env, id);
  if (!loaded) return html(messagePage("Not found", "That document does not exist.", true), 404);
  return html(renderDoc(loaded, session.csrf, appOrigin(request, env), noticeOf(url), null));
}

async function saveDetails(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  const data = await form(request, session);
  const title = cleanLine(String(data.get("title") ?? ""), 200);
  const message = String(data.get("message") ?? "")
    .trim()
    .slice(0, 2000);
  const order = data.get("order_mode") === "sequential" ? "sequential" : "parallel";
  if (!title) return docError(env, id, session, request, "Give the document a title.");
  const saved = await updateDraft(env.DB, id, title, message, order);
  if (!saved)
    return docError(
      env,
      id,
      session,
      request,
      "Details can only change while the document is a draft.",
    );
  return redirect(`/documents/${id}?notice=saved`);
}

async function createSigner(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  const data = await form(request, session);
  const doc = await getDocument(env.DB, id);
  if (!doc) throw new HttpError(404, "That document does not exist.");
  if (doc.status !== "draft")
    return docError(env, id, session, request, "Signers can only change on a draft.");
  const name = cleanLine(String(data.get("name") ?? ""), 120);
  const email = cleanLine(String(data.get("email") ?? ""), 200).toLowerCase();
  if (!name || !validEmail(email))
    return docError(env, id, session, request, "Enter the signer's name and email.");
  const existing = await listSigners(env.DB, id);
  if (existing.length >= 20)
    return docError(env, id, session, request, "A document can have at most 20 signers.");
  if (existing.some((signer) => signer.email.toLowerCase() === email)) {
    return docError(env, id, session, request, "That email is already a signer.");
  }
  const at = nowIso();
  await addSigner(
    env.DB,
    {
      id: rid("sig"),
      document_id: id,
      name,
      email,
      token: newToken(),
      status: "pending",
      order_index: await nextSignerIndex(env.DB, id),
      signed_at: null,
      viewed_at: null,
    },
    rid("aud"),
    at,
  );
  return redirect(`/documents/${id}?notice=signer`);
}

async function removeSignerRoute(
  request: Request,
  env: Env,
  id: string,
  signerId: string,
): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  await form(request, session);
  const doc = await getDocument(env.DB, id);
  if (doc?.status !== "draft") {
    return docError(env, id, session, request, "Signers can only change on a draft.");
  }
  const signers = await listSigners(env.DB, id);
  const signer = signers.find((item) => item.id === signerId);
  if (!signer) return docError(env, id, session, request, "That signer is not on this document.");
  await deleteSigner(env.DB, id, signerId, rid("aud"), nowIso(), signer.email);
  return redirect(`/documents/${id}?notice=removed`);
}

async function saveFields(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  const body = await jsonBody(request, session);
  const doc = await getDocument(env.DB, id);
  if (!doc) return json({ error: "That document does not exist." }, 404);
  if (doc.status !== "draft") return json({ error: "Fields can only change on a draft." }, 400);
  const raw = body && typeof body === "object" ? (body as { fields?: unknown }).fields : null;
  const signers = await listSigners(env.DB, id);
  const parsed = parseFields(raw, doc.page_count, new Set(signers.map((signer) => signer.id)));
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  await replaceFields(env.DB, id, parsed.value);
  return json({ ok: true });
}

async function sendDocument(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  await form(request, session);
  const loaded = await load(env, id);
  if (!loaded) throw new HttpError(404, "That document does not exist.");
  if (loaded.doc.status !== "draft") {
    return docError(env, id, session, request, "This document was already sent.");
  }
  if (loaded.signers.length === 0)
    return docError(env, id, session, request, "Add at least one signer.");
  if (loaded.fields.length === 0)
    return docError(env, id, session, request, "Place at least one field.");
  const missing = loaded.signers.find(
    (signer) => !loaded.fields.some((field) => field.signer_id === signer.id),
  );
  if (missing) {
    return docError(env, id, session, request, `${missing.name} has no fields yet.`);
  }
  const at = nowIso();
  const sent = await markSent(env.DB, id, at, rid("aud"));
  if (!sent) return docError(env, id, session, request, "This document was already sent.");
  const notice = await mailSigners(env, request, loaded.doc, loaded.signers);
  return redirect(`/documents/${id}?notice=${notice}`);
}

async function voidDocument(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  await form(request, session);
  const ok = await markVoid(env.DB, id, nowIso(), rid("aud"));
  if (!ok) return docError(env, id, session, request, "This document can no longer be voided.");
  return redirect(`/documents/${id}?notice=void`);
}

async function removeDraft(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  await form(request, session);
  const doc = await getDocument(env.DB, id);
  if (doc?.status !== "draft") {
    return docError(env, id, session, request, "Only a draft can be deleted.");
  }
  await deleteDocument(env.DB, id);
  await env.FILES.delete(doc.original_key);
  return redirect("/documents");
}

async function rebuild(request: Request, env: Env, id: string): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  await form(request, session);
  const result = await tryComplete(env, id);
  const notice = result === "completed" ? "completed" : "complete-failed";
  return redirect(`/documents/${id}?notice=${notice}`);
}

async function adminPdf(
  request: Request,
  env: Env,
  id: string,
  which: "original" | "completed",
): Promise<Response> {
  const session = await requireUser(request, env);
  if (session instanceof Response) return session;
  const doc = await getDocument(env.DB, id);
  if (!doc) return html(messagePage("Not found", "That document does not exist.", true), 404);
  const key = which === "original" ? doc.original_key : doc.completed_key;
  if (!key) return html(messagePage("Not ready", "The signed PDF is not ready yet.", true), 404);
  const bytes = await fileBytes(env.FILES, key);
  if (!bytes) return html(messagePage("Not found", "That file is missing.", true), 404);
  const name = which === "original" ? `${doc.title}.pdf` : `${doc.title}-signed.pdf`;
  return pdfResponse(bytes, name);
}

async function showSigning(request: Request, env: Env, token: string): Promise<Response> {
  const found = await findSigning(env, token);
  if (!found) return html(messagePage("Not found", "This signing link is not valid.", false), 404);
  const { doc, signer, signers } = found;
  if (doc.status === "void") {
    return html(
      signView(doc, "This document was voided. You do not need to sign it.", "preview", ""),
    );
  }
  if (signer.status === "signed") {
    const ready = doc.status === "completed";
    const allSigned = signers.every((person) => person.status === "signed");
    const banner = ready
      ? "You signed this document. The signed PDF is ready."
      : allSigned
        ? "You signed. The final PDF is still being prepared."
        : "You signed. Waiting for the other people.";
    return html(
      signView(
        doc,
        banner,
        "done",
        ready ? `/s/${token}/completed.pdf` : `/s/${token}/file.pdf`,
        ready ? `/s/${token}/completed.pdf` : null,
      ),
    );
  }
  if (doc.status !== "sent") {
    return html(messagePage("Not ready", "This document is not open for signing.", false), 409);
  }
  const ahead = doc.order_mode === "sequential" ? waitingFor(signers, signer.id) : null;
  if (ahead) {
    return html(
      signView(doc, `Waiting for ${ahead} to sign first.`, "preview", `/s/${token}/file.pdf`),
    );
  }
  await markViewed(
    env.DB,
    doc.id,
    signer.id,
    signer.name,
    nowIso(),
    rid("aud"),
    clientDetail(request),
  );
  const fields = (await listFields(env.DB, doc.id)).filter(
    (field) => field.signer_id === signer.id,
  );
  return html(
    signPage({
      title: doc.title,
      message: doc.message,
      banner: "Fill your fields, then submit. You only need to do this once.",
      mode: "sign",
      fileUrl: `/s/${token}/file.pdf`,
      downloadUrl: null,
      fields: fields.map(toSignField),
    }),
  );
}

async function submitSigning(request: Request, env: Env, token: string): Promise<Response> {
  assertOrigin(request);
  const found = await findSigning(env, token);
  if (!found) return json({ error: "This signing link is not valid." }, 404);
  const { doc, signer, signers } = found;
  if (doc.status !== "sent" || signer.status !== "pending") {
    return json({ error: "This document is not waiting for your signature." }, 409);
  }
  if (!signerMaySign(doc.order_mode, signers, signer.id)) {
    return json({ error: "Someone else needs to sign before you." }, 409);
  }
  const text = await readBody(request, 4_000_000);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "The request was not valid JSON." }, 400);
  }
  const record =
    body && typeof body === "object" ? (body as { consent?: unknown; values?: unknown }) : {};
  if (record.consent !== true) {
    return json({ error: "Confirm that you agree to sign electronically." }, 400);
  }
  const parsed = parseValues(record.values);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const mine = (await listFields(env.DB, doc.id)).filter((field) => field.signer_id === signer.id);
  const problem = submissionError(
    mine.map((field) => ({ id: field.id, type: field.type, required: field.required === 1 })),
    parsed.value,
  );
  if (problem) return json({ error: problem }, 400);
  const byId = new Map(parsed.value.map((value) => [value.fieldId, value]));
  const stored: { fieldId: string; text: string | null; imageKey: string | null }[] = [];
  for (const field of mine) {
    const value = byId.get(field.id);
    if (!value) continue;
    if (field.type === "signature" || field.type === "initials") {
      if (!value.image) continue;
      const png = decodePngDataUrl(value.image);
      if (!png) return json({ error: "A signature must be a PNG." }, 400);
      const key = `images/${field.id}.png`;
      await env.FILES.put(key, png, { httpMetadata: { contentType: "image/png" } });
      stored.push({ fieldId: field.id, text: null, imageKey: key });
    } else {
      const textValue =
        field.type === "checkbox" ? (value.text === "yes" ? "yes" : "no") : value.text.trim();
      if (!textValue) continue;
      stored.push({ fieldId: field.id, text: textValue, imageKey: null });
    }
  }
  const at = nowIso();
  try {
    await saveSubmission(
      env.DB,
      doc.id,
      signer.id,
      signer.name,
      at,
      rid("aud"),
      `consent accepted; ${clientDetail(request)}`,
      stored,
    );
  } catch {
    return json({ error: "This link was already used." }, 409);
  }
  const result = await tryComplete(env, doc.id);
  return json({ ok: true, completed: result === "completed" });
}

async function signerPdf(
  env: Env,
  token: string,
  which: "original" | "completed",
): Promise<Response> {
  const found = await findSigning(env, token);
  if (!found) return html(messagePage("Not found", "This signing link is not valid.", false), 404);
  if (found.doc.status === "void") {
    return html(messagePage("Voided", "This document was voided.", false), 410);
  }
  if (which === "completed") {
    if (found.signer.status !== "signed" || !found.doc.completed_key) {
      return html(messagePage("Not ready", "The signed PDF is not ready yet.", false), 404);
    }
    const bytes = await fileBytes(env.FILES, found.doc.completed_key);
    if (!bytes) return html(messagePage("Not found", "That file is missing.", false), 404);
    return pdfResponse(bytes, `${found.doc.title}-signed.pdf`);
  }
  const bytes = await fileBytes(env.FILES, found.doc.original_key);
  if (!bytes) return html(messagePage("Not found", "That file is missing.", false), 404);
  return pdfResponse(bytes, `${found.doc.title}.pdf`);
}

async function tryComplete(env: Env, id: string): Promise<"pending" | "completed" | "failed"> {
  const doc = await getDocument(env.DB, id);
  if (!doc || doc.status === "void") return "failed";
  if (doc.completed_key) return "completed";
  const signers = await listSigners(env.DB, id);
  if (signers.length === 0 || signers.some((signer) => signer.status !== "signed"))
    return "pending";
  try {
    const original = await fileBytes(env.FILES, doc.original_key);
    if (!original) return "failed";
    const fields = await listFields(env.DB, id);
    const values = new Map((await listValues(env.DB, id)).map((value) => [value.field_id, value]));
    const placements: Placement[] = [];
    for (const field of fields) {
      const value = values.get(field.id);
      if (!value) continue;
      const box = { page: field.page, x: field.x, y: field.y, w: field.w, h: field.h };
      if (field.type === "signature" || field.type === "initials") {
        if (!value.image_key) continue;
        const png = await fileBytes(env.FILES, value.image_key);
        if (!png) return "failed";
        placements.push({ kind: "image", ...box, png });
      } else if (field.type === "checkbox") {
        if (value.text_value === "yes") placements.push({ kind: "check", ...box });
      } else if (value.text_value) {
        placements.push({ kind: "text", ...box, text: value.text_value });
      }
    }
    const events = await listAudit(env.DB, id);
    const completedAt = nowIso();
    const stamped = await stampPdf(original, placements, {
      title: doc.title,
      id: doc.id,
      completedAt: formatWhen(completedAt),
      signers: signers.map((signer) => ({
        name: signer.name,
        email: signer.email,
        signedAt: signer.signed_at ? formatWhen(signer.signed_at) : null,
      })),
      events: events.map((event) => ({
        at: formatWhen(event.at),
        actor: event.actor,
        event: event.event,
        detail: event.detail,
      })),
    });
    const key = `completed/${doc.id}.pdf`;
    await env.FILES.put(key, stamped, { httpMetadata: { contentType: "application/pdf" } });
    await markCompleted(env.DB, doc.id, key, completedAt, rid("aud"));
    return "completed";
  } catch (error) {
    console.error(error);
    return "failed";
  }
}

async function mailSigners(
  env: Env,
  request: Request,
  doc: DocumentRow,
  signers: SignerRow[],
): Promise<"sent" | "mailed" | "mail-failed"> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return "sent";
  const sender = env.SENDER_NAME || "Signet";
  const origin = appOrigin(request, env);
  let mailed = false;
  let failed = false;
  for (const signer of signers) {
    const url = `${origin}/s/${signer.token}`;
    const note = doc.message ? `${doc.message}\n\n` : "";
    try {
      const ok = await sendSigningMail(env, {
        to: signer.email,
        subject: `Please sign ${doc.title}`,
        text: `${sender} asked you to sign "${doc.title}".\n\n${note}Open this link to review and sign:\n${url}\n\nIf you were not expecting this, you can ignore it.`,
      });
      if (ok) mailed = true;
      else failed = true;
    } catch {
      failed = true;
    }
  }
  if (failed) return "mail-failed";
  return mailed ? "mailed" : "sent";
}

function signView(
  doc: DocumentRow,
  banner: string,
  mode: "preview" | "done",
  fileUrl: string,
  downloadUrl: string | null = null,
): string {
  return signPage({
    title: doc.title,
    message: doc.message,
    banner,
    mode,
    fileUrl,
    downloadUrl,
    fields: [],
  });
}

function toSignField(field: FieldRow) {
  return {
    id: field.id,
    type: field.type,
    page: field.page,
    x: field.x,
    y: field.y,
    w: field.w,
    h: field.h,
    required: field.required === 1,
    label: field.label,
  };
}

async function findSigning(env: Env, token: string) {
  const signer = await env.DB.prepare("select * from signers where token = ?")
    .bind(token)
    .first<SignerRow>();
  if (!signer) return null;
  const doc = await getDocument(env.DB, signer.document_id);
  if (!doc) return null;
  const signers = await listSigners(env.DB, doc.id);
  return { doc, signer, signers };
}

async function load(env: Env, id: string) {
  const doc = await getDocument(env.DB, id);
  if (!doc) return null;
  const [signers, fields, events] = await Promise.all([
    listSigners(env.DB, id),
    listFields(env.DB, id),
    listAudit(env.DB, id),
  ]);
  return { doc, signers, fields, events };
}

function renderDoc(
  loaded: NonNullable<Awaited<ReturnType<typeof load>>>,
  csrf: string,
  origin: string,
  notice: string | null,
  error: string | null,
): string {
  return documentPage({ ...loaded, csrf, origin, notice, error });
}

async function docError(env: Env, id: string, session: Session, request: Request, error: string) {
  const loaded = await load(env, id);
  if (!loaded) throw new HttpError(404, "That document does not exist.");
  return html(renderDoc(loaded, session.csrf, appOrigin(request, env), null, error), 400);
}

async function fileBytes(bucket: R2Bucket, key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  return new Uint8Array(await object.arrayBuffer());
}

function titleFrom(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "Document";
  return cleanLine(base.replace(/\.pdf$/i, "").replace(/[_-]+/g, " "), 200) || "Document";
}

function rid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

function assertOrigin(request: Request): void {
  if (!sameOrigin(request)) throw new HttpError(403, "That request came from another site.");
}

async function form(request: Request, session: Session): Promise<FormData> {
  assertOrigin(request);
  const data = await request.formData();
  const csrf = String(data.get("csrf") ?? "");
  if (!safeEqual(csrf, session.csrf)) {
    throw new HttpError(403, "That form expired. Reload the page and try again.");
  }
  return data;
}

async function jsonBody(request: Request, session: Session): Promise<unknown> {
  assertOrigin(request);
  const csrf = request.headers.get("x-csrf") ?? "";
  if (!safeEqual(csrf, session.csrf)) {
    throw new HttpError(403, "That form expired. Reload the page and try again.");
  }
  const text = await readBody(request, 4_000_000);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "The request was not valid JSON.");
  }
}

async function requireUser(request: Request, env: Env): Promise<Session | Response> {
  const secret = passwordOf(env);
  const token = readCookie(request.headers.get("cookie"), "signet");
  const session = token ? await openSession(secret, token) : null;
  if (!session) {
    if (wantsJson(request)) return json({ error: "Sign in again." }, 401);
    return redirect("/");
  }
  return session;
}

async function quietSession(request: Request, env: Env): Promise<Session | null> {
  const secret = env.ADMIN_PASSWORD;
  if (!secret || secret.length < 8) return null;
  const token = readCookie(request.headers.get("cookie"), "signet");
  if (!token) return null;
  return openSession(secret, token);
}
