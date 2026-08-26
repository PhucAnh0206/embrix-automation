import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { TestLogger } from './test-logger';

/**
 * EmailHelper — IMAP client for asserting Embrix notification emails.
 *
 * Reads a real mailbox rather than a mail catcher on purpose: the JEPYP-230
 * notification work was blocked for a week by a transport defect (no STARTTLS,
 * JavaMail pinned to TLSv1), and a catcher that bypasses the tenant's real SMTP
 * server would have reported green the whole time. Slower, but it tests the
 * thing that actually broke.
 *
 * Matching strategy: emails are located by a caller-supplied predicate over the
 * parsed body, NOT by subject alone. Every notification spec creates a fresh
 * account, so matching on the account id in the body guarantees we never assert
 * against a stale message from a previous run — the single most common way
 * email automation quietly lies to you.
 *
 * Requires NOTIFY_IMAP_* in .env (see .env.example).
 */

// ── Formatting / parsing utilities ──────────────────────────────────────

/** Divisor used by Embrix for `Saldo kWh Aproximados` (confirmed by dev, JEPYP-49). */
export const KWH_DIVISOR = 123.067;

/**
 * Expected `Saldo kWh Aproximados` for a given CRC balance.
 *
 * Uses the absolute value because JASEC stores credit as a NEGATIVE balance
 * while the email renders it unsigned. Once the sign-convention defect on
 * JEPYP-49 is fixed, revisit this — a debt balance must render 0 kWh, not
 * floor(debt / divisor).
 */
export function expectedKwh(crcBalance: number): number {
  return Math.floor(Math.abs(crcBalance) / KWH_DIVISOR);
}

/** Format a number the way the email renders currency: `₡5.000,00`. */
export function formatCRC(amount: number): string {
  const [whole, decimals] = Math.abs(amount).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `₡${grouped},${decimals}`;
}

/**
 * Normalise a value before comparison: collapse whitespace (incl. non-breaking
 * spaces, which email clients sprinkle liberally) and unify the colón sign —
 * ₡ (U+20A1) and ¢ (U+00A2) are used interchangeably across the specs.
 */
export function normalizeValue(value: string): string {
  return value
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/[\u20a1\u00a2]/g, '\u20a1')
    // The live template renders "₡ 5.000,00" (space after the symbol) while
    // formatCRC produces "₡5.000,00". Confirmed against the real JEPYP-49
    // emails on ACT-100525 / ACT-100527. Treat the two as equal rather than
    // baking the spacing into every expected value, so a template tweak to
    // the spacing does not fail the amount checks.
    .replace(/\u20a1\s+/g, '\u20a1')
    .trim();
}

/** Loose equality on two rendered values. */
export function valuesMatch(actual: string, expected: string): boolean {
  return normalizeValue(actual) === normalizeValue(expected);
}

/**
 * Named HTML entities that appear in the Spanish templates.
 *
 * Scoped to Latin-1 plus common punctuation rather than the full HTML5 set —
 * Spanish is the only language in scope for JASEC. Unknown entities are left
 * untouched, so a missing one surfaces as a literal `&foo;` in a failing
 * assertion instead of silently corrupting the text.
 *
 * Case matters: `&Oacute;` and `&oacute;` are different characters.
 */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü',
  agrave: 'à', egrave: 'è', ecirc: 'ê', ccedil: 'ç', Ccedil: 'Ç',
  iquest: '¿', iexcl: '¡', ordf: 'ª', ordm: 'º', deg: '°',
  laquo: '«', raquo: '»', middot: '·', sect: '§', para: '¶',
  hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  cent: '¢', curren: '¤', euro: '€', pound: '£', yen: '¥',
  copy: '©', reg: '®', trade: '™', times: '×', divide: '÷',
};

/**
 * Decode HTML entities in a single left-to-right pass.
 *
 * Single-pass matters: decoding `&amp;` in a pass separate from the named
 * entities would turn `&amp;lt;` into `<` rather than the literal `&lt;`.
 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => NAMED_ENTITIES[name] ?? whole);
}

/**
 * Flatten HTML into line-oriented text.
 *
 * Deliberately structure-agnostic — it does not assume the template uses a
 * <table>, so a template rewrite that swaps tables for divs won't break every
 * assertion. Block-level closing tags become newlines; everything else is
 * stripped and entity-decoded.
 */
export function htmlToText(html: string): string {
  const withBreaks = html
    // Comments FIRST. A comment containing '>' (e.g. "currencyBal > 0") would
    // otherwise terminate the tag-stripping regex early and spill the rest of
    // the comment into the visible text — which reads exactly like a template
    // rendering bug. The Jasec templates carry long developer comments, so this
    // is not hypothetical.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|td|th|li|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeEntities(withBreaks)
    // Collapse runs of horizontal whitespace (incl. NBSP) but keep newlines.
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Collect every <img src="..."> in the raw HTML. */
export function extractImageSrcs(html: string): string[] {
  const srcs: string[] = [];
  const re = /<\s*img[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) srcs.push(match[1]);
  return srcs;
}

// ── Parsed email ────────────────────────────────────────────────────────

/** One attachment, kept in memory so PDF assertions need no temp files. */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export class ParsedEmail {
  constructor(
    readonly subject: string,
    readonly from: string,
    readonly to: string,
    readonly receivedAt: Date,
    readonly html: string,
    readonly text: string,
    readonly imageSrcs: string[],
    /**
     * Attachments, when the source provided them. Empty for DB-sourced emails —
     * `email_notification.content` stores only the body, so the invoice PDF is
     * reachable ONLY over IMAP. It is not in the database either: both
     * `invoice_unit.filepath` and `invoice_unit.invoicebase64pdf` are NULL on
     * every invoice on this tenant.
     */
    readonly attachments: EmailAttachment[] = [],
  ) { }

  /** First attachment whose filename or content type looks like a PDF. */
  pdfAttachment(): EmailAttachment | null {
    return this.attachments.find(
      (a) => a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename),
    ) ?? null;
  }

  /**
   * Read a labelled value, e.g. field('Número de Servicio') → 'ACT-100527'.
   *
   * Handles both `Label: value` on one line and the label/value-in-separate-
   * table-cells case, where flattening puts them on consecutive lines.
   *
   * Caveat: if a value is split across multiple source lines (not just visually
   * wrapped by the client) only the first line is returned. Not observed on any
   * current template, but check here first if a long value asserts short.
   */
  field(label: string): string {
    const lines = this.text.split('\n');
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^\\s*${escaped}\\s*:?\\s*(.*)$`, 'i');

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(re);
      if (!match) continue;
      if (match[1]?.trim()) return match[1].trim();
      const next = lines.slice(i + 1).find((l) => l.trim().length > 0)?.trim() ?? '';
      // An EMPTY value cell is dropped by the flattening, so the next line is
      // the FOLLOWING LABEL. Returning it would report `ID Transacción` as
      // "Descripción:" — a confusing actual that hides the real finding, which
      // is that the field rendered blank. Treat a trailing colon as a label.
      return /:$/.test(next) ? '' : next;
    }
    return '';
  }

  /** First line beginning with `prefix` — for unlabelled lines like the greeting. */
  lineStartingWith(prefix: string): string {
    const needle = normalizeValue(prefix).toLowerCase();
    const line = this.text
      .split('\n')
      .find((l) => normalizeValue(l).toLowerCase().startsWith(needle));
    return line?.trim() ?? '';
  }

  /** Whole-body substring check, whitespace-insensitive. */
  contains(needle: string): boolean {
    return normalizeValue(this.text).toLowerCase().includes(normalizeValue(needle).toLowerCase());
  }

  /** True when the template still has unrendered Thymeleaf placeholders. */
  hasUnresolvedTokens(): boolean {
    return /\$\{[^}]*\}/.test(this.text);
  }
}

// ── IMAP helper ─────────────────────────────────────────────────────────

export interface WaitForEmailOptions {
  /** Only consider messages whose parsed form satisfies this. */
  match: (email: ParsedEmail) => boolean;
  /** Ignore anything delivered before this instant. Defaults to helper construction time. */
  since?: Date;
  /** Give up after this long. Default NOTIFY_WAIT_TIMEOUT_MS or 180s. */
  timeoutMs?: number;
  /** Gap between polls. Default NOTIFY_POLL_INTERVAL_MS or 5s. */
  pollIntervalMs?: number;
  /** Human-readable description used in the timeout error. */
  description?: string;
  /**
   * Narrow the IMAP SEARCH server-side to messages whose subject contains this.
   *
   * Strongly recommended on this tenant. SINCE has DATE granularity, so without a
   * second criterion the server returns every message from the whole day, and a
   * staged billing run puts hundreds there. Each has to be fetched and parsed
   * client-side at ~0.45s, so an unnarrowed pass can outlast the timeout. Filtering
   * on the subject turns hundreds of candidates into a handful.
   */
  subjectContains?: string;
}

export class EmailHelper {
  private client: ImapFlow | null = null;
  private logger?: TestLogger;
  private readonly folders: string[];

  constructor(logger?: TestLogger) {
    this.logger = logger;
    this.folders = (process.env.NOTIFY_SEARCH_FOLDERS ?? 'INBOX')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);
  }

  /** The address notifications are expected to arrive at. */
  static recipient(): string {
    const to = process.env.NOTIFY_EMAIL_TO ?? process.env.NOTIFY_IMAP_USER;
    if (!to) {
      throw new Error(
        'EmailHelper: NOTIFY_EMAIL_TO (or NOTIFY_IMAP_USER) not set. ' +
        'Copy the NOTIFY_* block from .env.example into .env.',
      );
    }
    return to;
  }

  private config() {
    const host = process.env.NOTIFY_IMAP_HOST;
    const user = process.env.NOTIFY_IMAP_USER;
    const pass = process.env.NOTIFY_IMAP_PASSWORD;
    const port = Number(process.env.NOTIFY_IMAP_PORT ?? '993');

    if (!host || !user || !pass) {
      throw new Error(
        'EmailHelper: missing NOTIFY_IMAP_HOST / NOTIFY_IMAP_USER / ' +
        'NOTIFY_IMAP_PASSWORD in env. See the NOTIFY_* block in .env.example.',
      );
    }
    return { host, port, secure: true, auth: { user, pass }, logger: false as const };
  }

  /** Open the IMAP connection. Safe to call repeatedly. */
  async connect(): Promise<void> {
    if (this.client) return;
    const client = new ImapFlow(this.config());
    await client.connect();
    this.client = client;
    this.logger?.data('IMAP connected', {
      host: process.env.NOTIFY_IMAP_HOST,
      folders: this.folders,
    });
  }

  /** Close the connection. Called from the fixture teardown. */
  async disconnect(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // Connection may already be gone — nothing useful to do here.
    }
    this.client = null;
  }

  private requireClient(): ImapFlow {
    if (!this.client) throw new Error('EmailHelper: not connected. Call connect() first.');
    return this.client;
  }

  /**
   * Turn a raw RFC822 source into a ParsedEmail.
   *
   * Shared by `scanFolder` and `searchEmails`. Each used to carry its own copy of
   * this construction, so every field added to ParsedEmail had to be wired up
   * twice — and the `searchEmails` copy had already drifted, losing the null
   * guards the other one has.
   */
  private async toParsedEmail(source: Buffer): Promise<ParsedEmail> {
    const parsed = await simpleParser(source);
    return new ParsedEmail(
      parsed.subject ?? '',
      parsed.from?.text ?? '',
      Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : (parsed.to?.text ?? ''),
      parsed.date ?? new Date(),
      parsed.html || parsed.textAsHtml || '',
      htmlToText(parsed.html || parsed.textAsHtml || parsed.text || ''),
      extractImageSrcs(parsed.html || ''),
      (parsed.attachments ?? []).map((a) => ({
        filename: a.filename ?? '(unnamed)',
        contentType: a.contentType ?? 'application/octet-stream',
        content: a.content as Buffer,
      })),
    );
  }

  /**
   * Scan one folder for the newest message satisfying `match`.
   *
   * `deadline` IS LOAD-BEARING, not a nicety. IMAP SINCE has DATE granularity, so
   * a `since` of "ten minutes ago" still returns every message from that whole
   * day — and a busy run day is hundreds (one staged billing run alone produced
   * 206 notifications). Each one costs a fetchOne plus a simpleParser, ~0.45s, so a
   * single pass can run for six minutes. The caller checked its timeout only
   * BETWEEN passes, so a 3-minute budget could not interrupt one, the surrounding
   * Playwright test hit its own 10-minute timeout first, and the fixtures were torn
   * down underneath the in-flight scan — which surfaced as "Connection not
   * available" and then a use-after-close on the DB pool. Observed on 2026-08-13.
   *
   * Checking the deadline per message makes the caller's timeout real.
   */
  private async scanFolder(
    folder: string,
    since: Date,
    match: (email: ParsedEmail) => boolean,
    deadline?: number,
    subjectContains?: string,
  ): Promise<ParsedEmail | null> {
    const client = this.requireClient();
    let found: ParsedEmail | null = null;
    let examined = 0;

    let lock;
    try {
      lock = await client.getMailboxLock(folder);
    } catch (err) {
      this.logger?.log(`IMAP: folder "${folder}" unavailable (${String(err)}) — skipping`);
      return null;
    }

    try {
      // Subject goes into the SERVER-side search so the candidate set is small
      // before any fetching happens — see subjectContains on WaitForEmailOptions.
      const criteria: Record<string, unknown> = { since };
      if (subjectContains) criteria.subject = subjectContains;
      const uids = await client.search(criteria as never, { uid: true });
      if (!uids || uids.length === 0) return null;

      // Newest first so a re-run picks the latest matching message, and so that
      // giving up on the deadline still covers the most likely candidates.
      for (const uid of [...uids].reverse()) {
        if (deadline !== undefined && Date.now() > deadline) {
          this.logger?.log(
            `IMAP: deadline reached after examining ${examined}/${uids.length} message(s) ` +
            `in "${folder}" — giving up this pass rather than overrunning the caller.`,
          );
          break;
        }
        examined += 1;
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message || !message.source) continue;

        const email = await this.toParsedEmail(message.source);

        if (match(email)) {
          found = email;
          // Mark seen so the mailbox doesn't accumulate unread noise.
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => { });
          break;
        }
      }
    } finally {
      lock.release();
    }

    return found;
  }

  /**
   * Collect ALL matching emails across the configured folders, newest first.
   *
   * `waitForEmail` returns the first match and stops, which is right when you
   * triggered an event and are waiting for it. This is for asserting against mail
   * that already exists — e.g. reading invoice PDF attachments from a billing run
   * that has already happened, with no staging and no waiting.
   */
  async searchEmails(options: {
    match: (email: ParsedEmail) => boolean;
    since?: Date;
    limit?: number;
  }): Promise<ParsedEmail[]> {
    const client = this.requireClient();
    const since = options.since ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const limit = options.limit ?? 20;
    const out: ParsedEmail[] = [];

    for (const folder of this.folders) {
      if (out.length >= limit) break;
      let lock;
      try {
        lock = await client.getMailboxLock(folder);
      } catch (err) {
        this.logger?.log(`IMAP: folder "${folder}" unavailable (${String(err)}) — skipping`);
        continue;
      }
      try {
        // `search` and `fetchOne` return `false` (not null) when imapflow has
        // nothing — `?.` does NOT narrow that away, so check it explicitly or the
        // spread below would throw on a `false`.
        const uids = await client.search({ since }, { uid: true });
        if (!uids || uids.length === 0) continue;
        for (const uid of [...uids].reverse()) {
          if (out.length >= limit) break;
          const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!message || !message.source) continue;
          const email = await this.toParsedEmail(message.source);
          if (options.match(email)) out.push(email);
        }
      } finally {
        lock.release();
      }
    }
    return out;
  }

  /**
   * Poll the configured folders until a matching email arrives.
   *
   * Also searches Spam when NOTIFY_SEARCH_FOLDERS lists it — a policy change
   * that reroutes JASEC mail to Spam otherwise looks identical to a delivery
   * failure, which would send you chasing the wrong defect.
   */
  async waitForEmail(options: WaitForEmailOptions): Promise<{ email: ParsedEmail; waitedMs: number }> {
    const since = options.since ?? new Date();
    const timeoutMs = options.timeoutMs ?? Number(process.env.NOTIFY_WAIT_TIMEOUT_MS ?? '180000');
    const pollIntervalMs = options.pollIntervalMs ?? Number(process.env.NOTIFY_POLL_INTERVAL_MS ?? '5000');
    const description = options.description ?? 'notification email';

    await this.connect();
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      for (const folder of this.folders) {
        const email = await this.scanFolder(
          folder, since, options.match, startedAt + timeoutMs, options.subjectContains,
        );
        if (email) {
          const waitedMs = Date.now() - startedAt;
          this.logger?.data('Email received', {
            folder,
            subject: email.subject,
            from: email.from,
            waitedMs,
          });
          return { email, waitedMs };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `EmailHelper: timed out after ${timeoutMs}ms waiting for ${description}. ` +
      `Searched folders [${this.folders.join(', ')}] for messages since ${since.toISOString()}. ` +
      `Check: (a) the account's contact email is ${EmailHelper.recipient()}, ` +
      `(b) the template row is seeded for this event type + account category — ` +
      `Embrix silently skips the send when it is not, ` +
      `(c) the tenant SMTP config is reachable.`,
    );
  }
}
