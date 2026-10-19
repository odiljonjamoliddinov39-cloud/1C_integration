/**
 * The text of a letter (or another free-form document) as the page that is printed to the PDF Didox takes:
 * a number and date line, the two companies, the subject, the text, and a signature line.
 */
import type { Party } from "./outgoing.js";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const day = (iso: string) => iso.split("-").reverse().join(".");

export interface LetterInput {
  number: string;
  /** YYYY-MM-DD. */
  date: string;
  subject: string;
  text: string;
  signer?: string | undefined;
}

export function letterHtml(input: LetterInput, from: Party, to: Party): string {
  const paragraphs = input.text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 20mm 18mm; }
  body { font-family: "Times New Roman", serif; font-size: 13pt; line-height: 1.4; color: #000; }
  .meta { display: flex; justify-content: space-between; margin-bottom: 14pt; }
  .to { margin-left: 50%; margin-bottom: 18pt; }
  h1 { font-size: 14pt; text-align: center; margin: 14pt 0; }
  p { margin: 0 0 8pt; text-align: justify; text-indent: 1.2cm; }
  .sign { margin-top: 28pt; display: flex; justify-content: space-between; }
  small { color: #333; }
</style></head><body>
  <div class="meta"><div><b>${escapeHtml(from.name)}</b><br><small>INN ${escapeHtml(from.tin)}</small></div>
  <div>№ ${escapeHtml(input.number)}<br>${escapeHtml(day(input.date))}</div></div>
  <div class="to">${escapeHtml(to.name)}<br><small>INN ${escapeHtml(to.tin)}</small></div>
  <h1>${escapeHtml(input.subject)}</h1>
  ${paragraphs}
  <div class="sign"><span>________________</span><span>${escapeHtml(input.signer || from.director || "")}</span></div>
</body></html>`;
}
