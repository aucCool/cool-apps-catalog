import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";

export type Box = { x: number; y: number; width: number; height: number };

export type Placement =
  | { kind: "text"; page: number; x: number; y: number; w: number; h: number; text: string }
  | { kind: "image"; page: number; x: number; y: number; w: number; h: number; png: Uint8Array }
  | { kind: "check"; page: number; x: number; y: number; w: number; h: number };

export type Certificate = {
  title: string;
  id: string;
  completedAt: string;
  signers: { name: string; email: string; signedAt: string | null }[];
  events: { at: string; actor: string; event: string; detail: string }[];
};

export function pdfRect(
  pageWidth: number,
  pageHeight: number,
  field: { x: number; y: number; w: number; h: number },
): Box {
  const width = field.w * pageWidth;
  const height = field.h * pageHeight;
  return {
    x: field.x * pageWidth,
    y: pageHeight - (field.y + field.h) * pageHeight,
    width,
    height,
  };
}

export function fitRect(box: Box, image: { width: number; height: number }, pad = 2): Box {
  const maxW = Math.max(1, box.width - pad * 2);
  const maxH = Math.max(1, box.height - pad * 2);
  const scale = Math.min(maxW / Math.max(image.width, 1), maxH / Math.max(image.height, 1));
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

export function winAnsi(text: string): string {
  const mapped = text
    .replaceAll("\u2019", "'")
    .replaceAll("\u2018", "'")
    .replaceAll("\u201c", '"')
    .replaceAll("\u201d", '"')
    .replaceAll("\u2013", "-")
    .replaceAll("\u2014", "-")
    .replaceAll("\u2026", "...");
  let ascii = "";
  for (const char of mapped) {
    const code = char.codePointAt(0) ?? 0;
    ascii += code <= 0xff ? char : "?";
  }
  return ascii;
}

export async function stampPdf(
  original: Uint8Array,
  placements: Placement[],
  certificate: Certificate,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.1, 0.08);

  for (const placement of placements) {
    const page = doc.getPage(placement.page - 1);
    if (!page) continue;
    const box = pdfRect(page.getWidth(), page.getHeight(), placement);
    if (placement.kind === "image") {
      const image = await doc.embedPng(placement.png);
      const fitted = fitRect(box, image);
      page.drawImage(image, fitted);
    } else if (placement.kind === "check") {
      drawCheck(page, box);
    } else if (placement.text.trim()) {
      const fontSize = Math.max(8, Math.min(16, box.height * 0.55));
      const maxChars = Math.max(1, Math.floor((box.width - 4) / (fontSize * 0.5)));
      const shown = winAnsi(placement.text.trim()).slice(0, maxChars);
      page.drawText(shown, {
        x: box.x + 2,
        y: box.y + Math.max(2, (box.height - fontSize) / 2),
        size: fontSize,
        font,
        color: ink,
      });
    }
  }

  drawCertificate(doc, font, bold, certificate);
  return doc.save();
}

function drawCheck(page: PDFPage, box: Box): void {
  const color = rgb(0.12, 0.1, 0.08);
  const thickness = Math.max(1.25, Math.min(box.width, box.height) * 0.08);
  page.drawLine({
    start: { x: box.x + box.width * 0.18, y: box.y + box.height * 0.48 },
    end: { x: box.x + box.width * 0.4, y: box.y + box.height * 0.22 },
    thickness,
    color,
  });
  page.drawLine({
    start: { x: box.x + box.width * 0.4, y: box.y + box.height * 0.22 },
    end: { x: box.x + box.width * 0.82, y: box.y + box.height * 0.78 },
    thickness,
    color,
  });
}

function drawCertificate(
  doc: PDFDocument,
  font: PDFFont,
  bold: PDFFont,
  certificate: Certificate,
): void {
  let page = doc.addPage();
  let y = page.getHeight() - 56;
  const seal = rgb(0.56, 0.18, 0.16);
  page.drawRectangle({
    x: 0,
    y: page.getHeight() - 36,
    width: page.getWidth(),
    height: 36,
    color: seal,
  });
  page.drawText("SIGNET", {
    x: 48,
    y: page.getHeight() - 24,
    size: 12,
    font: bold,
    color: rgb(1, 1, 1),
  });

  const write = (text: string, size = 11, face: PDFFont = font) => {
    const lines = wrap(winAnsi(text), size > 14 ? 64 : 92);
    for (const line of lines.length > 0 ? lines : [""]) {
      if (y < 48) {
        page = doc.addPage();
        y = page.getHeight() - 56;
      }
      page.drawText(line, { x: 48, y, size, font: face, color: rgb(0.12, 0.1, 0.08) });
      y -= size + 5;
    }
  };

  write("Certificate of completion", 18, bold);
  y -= 6;
  write(certificate.title, 14, bold);
  write(`Document ${certificate.id}`);
  write(`Completed ${certificate.completedAt}`);
  y -= 8;
  write("Signers", 13, bold);
  for (const signer of certificate.signers) {
    const when = signer.signedAt ?? "not signed";
    write(`${signer.name} <${signer.email}> — ${when}`);
  }
  y -= 8;
  write("Audit", 13, bold);
  for (const event of certificate.events) {
    const detail = event.detail ? ` (${event.detail})` : "";
    write(`${event.at}  ${event.actor}  ${event.event}${detail}`);
  }
  y -= 8;
  write(
    "Signet stamped this file after each required signer submitted their fields. It records that event. It does not prove a person's legal identity.",
  );
}

function wrap(text: string, max: number): string[] {
  if (!text) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const piece = word.length > max ? word.slice(0, max) : word;
    const next = line ? `${line} ${piece}` : piece;
    if (next.length > max && line) {
      lines.push(line);
      line = piece;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function isPdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  return head.includes("%PDF-");
}
