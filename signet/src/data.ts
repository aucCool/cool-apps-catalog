import type { FieldInput, FieldType } from "./validate";

export type DocumentStatus = "draft" | "sent" | "completed" | "void";
export type OrderMode = "parallel" | "sequential";

export type DocumentRow = {
  id: string;
  title: string;
  status: DocumentStatus;
  order_mode: OrderMode;
  message: string;
  original_key: string;
  completed_key: string | null;
  page_count: number;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  voided_at: string | null;
};

export type DocumentSummary = DocumentRow & { signer_count: number; signed_count: number };

export type SignerRow = {
  id: string;
  document_id: string;
  name: string;
  email: string;
  token: string;
  status: "pending" | "signed";
  order_index: number;
  signed_at: string | null;
  viewed_at: string | null;
};

export type FieldRow = {
  id: string;
  document_id: string;
  signer_id: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: number;
  label: string;
};

export type AuditRow = {
  id: string;
  document_id: string;
  at: string;
  actor: string;
  event: string;
  detail: string;
};

export type ValueRow = {
  field_id: string;
  signer_id: string;
  text_value: string | null;
  image_key: string | null;
  created_at: string;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export async function listDocuments(db: D1Database): Promise<DocumentSummary[]> {
  const result = await db
    .prepare(
      `select d.*,
        (select count(*) from signers s where s.document_id = d.id) as signer_count,
        (select count(*) from signers s where s.document_id = d.id and s.status = 'signed') as signed_count
      from documents d
      order by d.created_at desc`,
    )
    .all<DocumentSummary>();
  return result.results;
}

export async function getDocument(db: D1Database, id: string): Promise<DocumentRow | null> {
  return db.prepare("select * from documents where id = ?").bind(id).first<DocumentRow>();
}

export async function listSigners(db: D1Database, documentId: string): Promise<SignerRow[]> {
  const result = await db
    .prepare("select * from signers where document_id = ? order by order_index, email")
    .bind(documentId)
    .all<SignerRow>();
  return result.results;
}

export async function listFields(db: D1Database, documentId: string): Promise<FieldRow[]> {
  const result = await db
    .prepare("select * from fields where document_id = ? order by page, y, x")
    .bind(documentId)
    .all<FieldRow>();
  return result.results;
}

export async function listAudit(db: D1Database, documentId: string): Promise<AuditRow[]> {
  const result = await db
    .prepare("select * from audit_events where document_id = ? order by at")
    .bind(documentId)
    .all<AuditRow>();
  return result.results;
}

export async function listValues(db: D1Database, documentId: string): Promise<ValueRow[]> {
  const result = await db
    .prepare(
      `select v.* from field_values v
       join fields f on f.id = v.field_id
       where f.document_id = ?`,
    )
    .bind(documentId)
    .all<ValueRow>();
  return result.results;
}

export async function insertDocument(
  db: D1Database,
  doc: DocumentRow,
  auditId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `insert into documents
          (id, title, status, order_mode, message, original_key, completed_key, page_count, created_at)
         values (?, ?, 'draft', 'parallel', '', ?, null, ?, ?)`,
      )
      .bind(doc.id, doc.title, doc.original_key, doc.page_count, doc.created_at),
    db
      .prepare(
        `insert into audit_events (id, document_id, at, actor, event, detail)
         values (?, ?, ?, 'you', 'created', ?)`,
      )
      .bind(auditId, doc.id, doc.created_at, `${doc.page_count} pages`),
  ]);
}

export async function updateDraft(
  db: D1Database,
  id: string,
  title: string,
  message: string,
  orderMode: OrderMode,
): Promise<boolean> {
  const result = await db
    .prepare(
      `update documents set title = ?, message = ?, order_mode = ?
       where id = ? and status = 'draft'`,
    )
    .bind(title, message, orderMode, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function nextSignerIndex(db: D1Database, documentId: string): Promise<number> {
  const row = await db
    .prepare("select coalesce(max(order_index), -1) + 1 as n from signers where document_id = ?")
    .bind(documentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function addSigner(
  db: D1Database,
  signer: SignerRow,
  auditId: string,
  at: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `insert into signers
          (id, document_id, name, email, token, status, order_index)
         values (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(
        signer.id,
        signer.document_id,
        signer.name,
        signer.email,
        signer.token,
        signer.order_index,
      ),
    db
      .prepare(
        `insert into audit_events (id, document_id, at, actor, event, detail)
         values (?, ?, ?, 'you', 'signer_added', ?)`,
      )
      .bind(auditId, signer.document_id, at, signer.email),
  ]);
}

export async function deleteSigner(
  db: D1Database,
  documentId: string,
  signerId: string,
  auditId: string,
  at: string,
  email: string,
): Promise<void> {
  await db.batch([
    db.prepare("delete from fields where signer_id = ?").bind(signerId),
    db.prepare("delete from signers where id = ? and document_id = ?").bind(signerId, documentId),
    db
      .prepare(
        `insert into audit_events (id, document_id, at, actor, event, detail)
         values (?, ?, ?, 'you', 'signer_removed', ?)`,
      )
      .bind(auditId, documentId, at, email),
  ]);
}

export async function replaceFields(
  db: D1Database,
  documentId: string,
  fields: FieldInput[],
): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare("delete from fields where document_id = ?").bind(documentId),
  ];
  for (const field of fields) {
    statements.push(
      db
        .prepare(
          `insert into fields
            (id, document_id, signer_id, type, page, x, y, w, h, required, label)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          field.id,
          documentId,
          field.signerId,
          field.type,
          field.page,
          field.x,
          field.y,
          field.w,
          field.h,
          field.required ? 1 : 0,
          field.label,
        ),
    );
  }
  await db.batch(statements);
}

export async function markSent(
  db: D1Database,
  id: string,
  at: string,
  auditId: string,
): Promise<boolean> {
  const updated = await db
    .prepare("update documents set status = 'sent', sent_at = ? where id = ? and status = 'draft'")
    .bind(at, id)
    .run();
  if ((updated.meta.changes ?? 0) < 1) return false;
  await db
    .prepare(
      `insert into audit_events (id, document_id, at, actor, event, detail)
       values (?, ?, ?, 'you', 'sent', '')`,
    )
    .bind(auditId, id, at)
    .run();
  return true;
}

export async function markVoid(
  db: D1Database,
  id: string,
  at: string,
  auditId: string,
): Promise<boolean> {
  const updated = await db
    .prepare(
      `update documents set status = 'void', voided_at = ?
       where id = ? and status in ('draft', 'sent')`,
    )
    .bind(at, id)
    .run();
  if ((updated.meta.changes ?? 0) < 1) return false;
  await db
    .prepare(
      `insert into audit_events (id, document_id, at, actor, event, detail)
       values (?, ?, ?, 'you', 'voided', '')`,
    )
    .bind(auditId, id, at)
    .run();
  return true;
}

export async function deleteDocument(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        "delete from field_values where field_id in (select id from fields where document_id = ?)",
      )
      .bind(id),
    db.prepare("delete from fields where document_id = ?").bind(id),
    db.prepare("delete from signers where document_id = ?").bind(id),
    db.prepare("delete from audit_events where document_id = ?").bind(id),
    db.prepare("delete from documents where id = ? and status = 'draft'").bind(id),
  ]);
}

export async function markViewed(
  db: D1Database,
  documentId: string,
  signerId: string,
  actor: string,
  at: string,
  auditId: string,
  detail: string,
): Promise<void> {
  const updated = await db
    .prepare("update signers set viewed_at = ? where id = ? and viewed_at is null")
    .bind(at, signerId)
    .run();
  if ((updated.meta.changes ?? 0) < 1) return;
  await db
    .prepare(
      `insert into audit_events (id, document_id, at, actor, event, detail)
       values (?, ?, ?, ?, 'viewed', ?)`,
    )
    .bind(auditId, documentId, at, actor, detail)
    .run();
}

export async function saveSubmission(
  db: D1Database,
  documentId: string,
  signerId: string,
  actor: string,
  at: string,
  auditId: string,
  detail: string,
  values: { fieldId: string; text: string | null; imageKey: string | null }[],
): Promise<void> {
  const statements: D1PreparedStatement[] = values.map((value) =>
    db
      .prepare(
        `insert into field_values (field_id, signer_id, text_value, image_key, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .bind(value.fieldId, signerId, value.text, value.imageKey, at),
  );
  statements.push(
    db
      .prepare(
        "update signers set status = 'signed', signed_at = ? where id = ? and status = 'pending'",
      )
      .bind(at, signerId),
    db
      .prepare(
        `insert into audit_events (id, document_id, at, actor, event, detail)
         values (?, ?, ?, ?, 'signed', ?)`,
      )
      .bind(auditId, documentId, at, actor, detail),
  );
  await db.batch(statements);
}

export async function markCompleted(
  db: D1Database,
  id: string,
  key: string,
  at: string,
  auditId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `update documents set status = 'completed', completed_key = ?, completed_at = ?
         where id = ? and completed_key is null`,
      )
      .bind(key, at, id),
    db
      .prepare(
        `insert into audit_events (id, document_id, at, actor, event, detail)
         values (?, ?, ?, 'signet', 'completed', '')`,
      )
      .bind(auditId, id, at),
  ]);
}

export function clientDetail(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const ua = (request.headers.get("user-agent") ?? "").slice(0, 180);
  return [ip ? `ip ${ip}` : "", ua ? `ua ${ua}` : ""].filter(Boolean).join("; ");
}
