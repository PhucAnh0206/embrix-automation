// pdf-parse (current npm version) exports a class-based API, not a callable
// default. Construct with { data: Buffer }, then call getText().
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PDFParse } = require('pdf-parse');

export async function fetchAndExtractPdfText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`PDF fetch failed: ${res.status} ${res.statusText} — ${url}`);
  }
  const data = Buffer.from(await res.arrayBuffer());
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  await parser.destroy?.();

  // Newer pdf-parse returns { text } (single string) or { pages: [{ text }] }
  // depending on version. Handle both shapes.
  if (typeof result?.text === 'string') return result.text;
  if (Array.isArray(result?.pages)) {
    return result.pages.map((p: { text?: string }) => p.text ?? '').join('\n');
  }
  return String(result ?? '');
}
