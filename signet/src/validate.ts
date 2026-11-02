export const FIELD_TYPES = ["signature", "initials", "text", "date", "checkbox"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FieldInput = {
  id: string;
  signerId: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  required: boolean;
  label: string;
};

export type ValueInput = {
  fieldId: string;
  text: string;
  image: string;
};

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function cleanLine(value: string, max: number): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, max);
}

export function validEmail(value: string): boolean {
  return value.length <= 200 && EMAIL.test(value);
}

export function parseFields(
  input: unknown,
  pageCount: number,
  signerIds: ReadonlySet<string>,
): Parsed<FieldInput[]> {
  if (!Array.isArray(input)) return { ok: false, error: "Fields must be a list." };
  if (input.length > 200) return { ok: false, error: "A document can have at most 200 fields." };
  const seen = new Set<string>();
  const fields: FieldInput[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") return { ok: false, error: "A field is missing." };
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!UUID.test(id)) return { ok: false, error: "A field id is not valid." };
    if (seen.has(id)) return { ok: false, error: "A field is listed twice." };
    seen.add(id);
    const signerId = typeof raw.signerId === "string" ? raw.signerId : "";
    if (!signerIds.has(signerId)) {
      return { ok: false, error: "A field is assigned to someone who is not a signer." };
    }
    const type = typeof raw.type === "string" ? raw.type : "";
    if (!FIELD_TYPES.includes(type as FieldType)) {
      return { ok: false, error: "A field type is not supported." };
    }
    const box = readBox(raw.page, raw.x, raw.y, raw.w, raw.h, pageCount);
    if (!box) return { ok: false, error: "A field sits outside the page." };
    const label = typeof raw.label === "string" ? cleanLine(raw.label, 80) : "";
    fields.push({
      id,
      signerId,
      type: type as FieldType,
      ...box,
      required: raw.required !== false,
      label,
    });
  }
  return { ok: true, value: fields };
}

function readBox(
  page: unknown,
  x: unknown,
  y: unknown,
  w: unknown,
  h: unknown,
  pageCount: number,
): { page: number; x: number; y: number; w: number; h: number } | null {
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > pageCount)
    return null;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number"
  ) {
    return null;
  }
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w < 0.02 || h < 0.015 || w > 1 || h > 1) return null;
  if (x < 0 || y < 0 || x + w > 1.001 || y + h > 1.001) return null;
  return { page, x, y, w, h };
}

export function parseValues(input: unknown): Parsed<ValueInput[]> {
  if (!Array.isArray(input)) return { ok: false, error: "Enter a value for each field." };
  if (input.length > 200) return { ok: false, error: "Too many values." };
  const values: ValueInput[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") return { ok: false, error: "A value is missing." };
    const raw = item as Record<string, unknown>;
    const fieldId = typeof raw.fieldId === "string" ? raw.fieldId : "";
    if (!UUID.test(fieldId)) return { ok: false, error: "A value does not match a field." };
    const text = typeof raw.text === "string" ? raw.text.slice(0, 500) : "";
    const image = typeof raw.image === "string" ? raw.image : "";
    if (image.length > 600_000) return { ok: false, error: "A signature image is too large." };
    values.push({ fieldId, text, image });
  }
  return { ok: true, value: values };
}

export function submissionError(
  fields: { id: string; type: FieldType; required: boolean }[],
  values: ValueInput[],
): string | null {
  const byId = new Map(values.map((value) => [value.fieldId, value]));
  const known = new Set(fields.map((field) => field.id));
  for (const value of values) {
    if (!known.has(value.fieldId)) return "A value does not match a field on this document.";
  }
  for (const field of fields) {
    const value = byId.get(field.id);
    if (!field.required) continue;
    if (!value) return "Fill every required field.";
    if (field.type === "signature" || field.type === "initials") {
      if (!value.image) return "Add your signature before sending.";
    } else if (field.type === "checkbox") {
      if (value.text !== "yes") return "Tick every required box.";
    } else if (!value.text.trim()) {
      return "Fill every required field.";
    }
  }
  return null;
}

export type SignerGate = { id: string; name: string; status: string; order_index: number };

export function signerMaySign(
  orderMode: "parallel" | "sequential",
  signers: SignerGate[],
  signerId: string,
): boolean {
  if (orderMode !== "sequential") return true;
  const me = signers.find((signer) => signer.id === signerId);
  if (!me) return false;
  return signers.every(
    (signer) => signer.order_index >= me.order_index || signer.status === "signed",
  );
}

export function waitingFor(signers: SignerGate[], signerId: string): string | null {
  const me = signers.find((signer) => signer.id === signerId);
  if (!me) return null;
  const earlier = signers
    .filter((signer) => signer.order_index < me.order_index && signer.status !== "signed")
    .sort((a, b) => a.order_index - b.order_index);
  return earlier[0]?.name ?? null;
}

export function decodePngDataUrl(dataUrl: string): Uint8Array | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match?.[1]) return null;
  let binary: string;
  try {
    binary = atob(match[1]);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e) return null;
  return bytes;
}
