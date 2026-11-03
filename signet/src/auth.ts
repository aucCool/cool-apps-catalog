const encoder = new TextEncoder();
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;

export type Session = { exp: number; csrf: string };

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function b64urlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length === right.length ? 0 : 1;
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function passwordMatches(expected: string, given: string): Promise<boolean> {
  const key = await hmacKey("signet-password");
  const a = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(expected)));
  const b = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(given)));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function newCsrf(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

export async function sealSession(secret: string, csrf: string, now = Date.now()): Promise<string> {
  const body = b64urlEncode(encoder.encode(JSON.stringify({ exp: now + SESSION_MS, csrf })));
  const key = await hmacKey(secret);
  const sig = b64urlEncode(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))),
  );
  return `${body}.${sig}`;
}

export async function openSession(
  secret: string,
  token: string,
  now = Date.now(),
): Promise<Session | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = b64urlDecode(token.slice(dot + 1));
  const payload = b64urlDecode(body);
  if (!sig || !payload) return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(body));
  if (!ok) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as Partial<Session>;
    if (typeof parsed.exp !== "number" || typeof parsed.csrf !== "string") return null;
    if (parsed.exp < now) return null;
    return { exp: parsed.exp, csrf: parsed.csrf };
  } catch {
    return null;
  }
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

export function sessionCookie(token: string, secure: boolean, maxAge = SESSION_MS / 1000): string {
  const parts = [`signet=${token}`, "HttpOnly", "SameSite=Strict", "Path=/", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
