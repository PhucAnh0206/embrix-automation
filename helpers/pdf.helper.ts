// pdf-parse (current npm version) exports a class-based API, not a callable
// default. Construct with { data: Buffer }, then call getText().
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require('pdf-parse');

/** Structural verdict on a PDF buffer, before any text extraction. */
export interface PdfSummary {
  bytes: number;
  /** Starts with the %PDF magic. */
  isPdf: boolean;
  /** Ends with the %%EOF trailer, i.e. the render completed. */
  hasEof: boolean;
  /** A real document rather than a truncated render. */
  valid: boolean;
  /** Human-readable verdict for a report cell. */
  verdict: string;
}

/**
 * Judge a PDF buffer without parsing it.
 *
 * A valid JASEC invoice is ~100 KB. A ~15-byte file that starts `%PDF-1.4` and
 * has no `%%EOF` is the XSL stylesheet aborting mid-render — the empty-table-body
 * defect fixed in `jasec_invoice_v3.xsl` (RUNBOOK-QA-all-events.md §4). That is a
 * renderer bug, NOT a stamping consequence: stamping is disabled on jasec-dev
 * (`ccp_properties.pacEnabled = false`) and PDFs generate fine.
 */
export function describePdf(data: Buffer): PdfSummary {
  const bytes = data.length;
  const isPdf = data.slice(0, 8).toString('latin1').startsWith('%PDF');
  const hasEof = data.slice(-2048).toString('latin1').includes('%%EOF');
  const valid = isPdf && hasEof && bytes >= 1024;

  let verdict: string;
  if (!isPdf) verdict = 'not a PDF';
  else if (bytes < 1024) verdict = `STUB — ${bytes} bytes, render aborted`;
  else if (!hasEof) verdict = `${bytes} bytes but no %%EOF — truncated`;
  else verdict = `valid PDF, ${bytes} bytes`;

  return { bytes, isPdf, hasEof, valid, verdict };
}

/** Extract text from a PDF already in memory. */
export async function extractPdfText(data: Buffer): Promise<string> {
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  await parser.destroy?.();

  // Newer pdf-parse returns { text } (single string) or { pages: [{ text }] }
  // depending on version. Handle both shapes.
  let text: string;
  if (typeof result?.text === 'string') text = result.text;
  else if (Array.isArray(result?.pages)) {
    text = result.pages.map((p: { text?: string }) => p.text ?? '').join('\n');
  } else text = String(result ?? '');

  // Collapse runs of spaces but keep line structure — the invoice layout puts
  // each labelled field on its own line, which `pdfField` relies on.
  return text.replace(/[^\S\n]+/g, ' ');
}

export async function fetchAndExtractPdfText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`PDF fetch failed: ${res.status} ${res.statusText} — ${url}`);
  }
  return extractPdfText(Buffer.from(await res.arrayBuffer()));
}

/**
 * Read a labelled value out of extracted invoice text.
 *
 * The layout is `Label: value`, but a value that failed to render leaves the
 * label with nothing after it — which is exactly the `Dias facturados:` and
 * `Lectura anterior (kWh):` defects. Returns '' in that case rather than
 * swallowing the next line, so an empty field reports as empty.
 *
 * Accent-insensitive on the label: the extracted text has no accents
 * (`Dias facturados`, `Ubicacion`) even though the template writes them, so
 * searching for the accented form silently misses.
 */
export function pdfField(text: string, label: string): string {
  const norm = (s: string) => s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();

  const target = norm(label).replace(/:$/, '');
  for (const line of text.split('\n')) {
    const flat = norm(line);
    if (!flat.startsWith(target)) continue;
    const rest = line.slice(line.toLowerCase().indexOf(':') + 1);
    // Only treat it as a hit when the label is followed by a colon on this line.
    if (!line.includes(':')) continue;
    return rest.trim();
  }
  return '';
}
