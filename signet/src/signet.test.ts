import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { openSession, passwordMatches, safeEqual, sealSession } from "./auth";
import { fitRect, isPdf, pdfRect, stampPdf, winAnsi } from "./stamp";
import {
  decodePngDataUrl,
  parseFields,
  signerMaySign,
  submissionError,
  waitingFor,
} from "./validate";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("password and session round-trip", async () => {
  expect(await passwordMatches("correct horse", "correct horse")).toBe(true);
  expect(await passwordMatches("correct horse", "wrong horse")).toBe(false);
  expect(safeEqual("abc", "abc")).toBe(true);
  expect(safeEqual("abc", "abd")).toBe(false);
  const token = await sealSession("secret", "csrf-token", 1_000);
  expect(await openSession("secret", token, 1_000)).toEqual({
    exp: 1_000 + 86_400_000 * 14,
    csrf: "csrf-token",
  });
  expect(await openSession("other", token, 1_000)).toBeNull();
  expect(await openSession("secret", token, 1_000 + 86_400_000 * 20)).toBeNull();
});

test("field boxes stay on the page and map into PDF space", () => {
  const signers = new Set(["signer-1"]);
  const ok = parseFields(
    [
      {
        id: "11111111-1111-4111-8111-111111111111",
        signerId: "signer-1",
        type: "text",
        page: 1,
        x: 0.1,
        y: 0.2,
        w: 0.3,
        h: 0.05,
        required: true,
        label: "Name",
      },
    ],
    2,
    signers,
  );
  expect(ok.ok).toBe(true);
  const outside = parseFields(
    [
      {
        id: "11111111-1111-4111-8111-111111111111",
        signerId: "signer-1",
        type: "text",
        page: 3,
        x: 0.1,
        y: 0.2,
        w: 0.3,
        h: 0.05,
      },
    ],
    2,
    signers,
  );
  expect(outside.ok).toBe(false);
  const box = pdfRect(612, 792, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
  expect(box.x).toBeCloseTo(61.2);
  expect(box.y).toBeCloseTo(633.6);
  expect(box.width).toBeCloseTo(122.4);
  expect(box.height).toBeCloseTo(79.2);
  const fitted = fitRect({ x: 0, y: 0, width: 100, height: 40 }, { width: 200, height: 40 });
  expect(fitted.width).toBeCloseTo(96);
  expect(fitted.height).toBeCloseTo(19.2);
});

test("submission requires a signature and sequential signers wait", () => {
  const fields = [
    { id: "11111111-1111-4111-8111-111111111111", type: "signature" as const, required: true },
  ];
  expect(submissionError(fields, [{ fieldId: fields[0]?.id ?? "", text: "", image: "" }])).toBe(
    "Add your signature before sending.",
  );
  expect(
    submissionError(fields, [{ fieldId: fields[0]?.id ?? "", text: "", image: PNG }]),
  ).toBeNull();
  expect(decodePngDataUrl(PNG)?.[0]).toBe(0x89);
  expect(decodePngDataUrl("data:image/png;base64,aaaa")).toBeNull();
  const signers = [
    { id: "a", name: "Ada", status: "pending", order_index: 0 },
    { id: "b", name: "Bea", status: "pending", order_index: 1 },
  ];
  expect(signerMaySign("sequential", signers, "b")).toBe(false);
  expect(waitingFor(signers, "b")).toBe("Ada");
  expect(signerMaySign("sequential", [{ ...signers[0], status: "signed" }, signers[1]], "b")).toBe(
    true,
  );
  expect(signerMaySign("parallel", signers, "b")).toBe(true);
});

test("stamped PDF keeps the original page and adds a certificate", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const original = await doc.save();
  expect(isPdf(original)).toBe(true);
  const png = decodePngDataUrl(PNG);
  if (!png) throw new Error("png");
  const stamped = await stampPdf(
    original,
    [
      { kind: "text", page: 1, x: 0.1, y: 0.1, w: 0.4, h: 0.05, text: "Hello signer" },
      { kind: "image", page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.08, png },
      { kind: "check", page: 1, x: 0.1, y: 0.3, w: 0.05, h: 0.05 },
    ],
    {
      title: "Acme order",
      id: "doc_123",
      completedAt: "2026-11-02 12:00 UTC",
      signers: [{ name: "Ada", email: "ada@example.com", signedAt: "2026-11-02 12:00 UTC" }],
      events: [
        { at: "2026-11-02 12:00 UTC", actor: "Ada", event: "signed", detail: "consent accepted" },
      ],
    },
  );
  const out = await PDFDocument.load(stamped);
  expect(out.getPageCount()).toBe(2);
  expect(winAnsi("Ada’s signature")).toBe("Ada's signature");
});
