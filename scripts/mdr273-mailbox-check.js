/**
 * JEPYP-273 — confirm MDR rejection notifications actually ARRIVED.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE SHELL VERIFIER
 *
 * mdr273-notify-verify.sh (on the control server) proves the notification was
 * created and rendered correctly. It cannot prove the email was delivered:
 * `email_notification.status = SUCCESS` only means SMTP ACCEPTED the handoff.
 * On this tenant that is not a safe assumption — JEPYP-230 measured ~5% of sends
 * landing FAILED, and INVOICE_READY (the type carrying attachments) failed at
 * 6.4%. So delivery needs checking against the mailbox itself.
 *
 * It lives in this repo rather than on the control server because it needs the
 * IMAP password, which should not sit on a shared host.
 *
 * Usage:  node scripts/mdr273-mailbox-check.js [hoursBack]
 *         node scripts/mdr273-mailbox-check.js --files a.csv,b.csv
 *
 * The default mode reads the expected list from the database, which needs the AWS
 * VPN. The --files mode needs only IMAP, so it still works when the VPN is down —
 * paste the filenames the server verifier printed. The VPN dropped twice during
 * the JEPYP-273 run, so this is not a hypothetical convenience.
 *
 * Cross-checks every MDRFILE- notification written in the window against the
 * mailbox, matching on the filename recorded in cdr_load_statistics. Filenames
 * are matched in BOTH raw and HTML-escaped form: the template escapes fileName
 * on purpose (it is attacker-influenced SFTP input), so a name containing < > &
 * appears as &lt; &gt; &amp; in the delivered body.
 */
const path = require('path');
const REPO = path.join(__dirname, '..');
require(path.join(REPO, 'node_modules/dotenv')).config({ path: path.join(REPO, '.env') });
const { Pool } = require(path.join(REPO, 'node_modules/pg'));
const { ImapFlow } = require(path.join(REPO, 'node_modules/imapflow'));
const { simpleParser } = require(path.join(REPO, 'node_modules/mailparser'));

const HOURS = Number(process.argv[2] ?? 24);
const SUBJECT_HINT = 'MDR';

const clean = (s) =>
  (s || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The template escapes these three, so a delivered body will not contain raw < > &. */
const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const FILES_ARG = process.argv.find((a) => a.startsWith('--files'));

(async () => {
  let pool = null;
  let expected;

  if (FILES_ARG) {
    // Offline mode: no DB, no VPN. The caller supplies the filenames.
    const list = (FILES_ARG.includes('=') ? FILES_ARG.split('=')[1] : process.argv[process.argv.indexOf(FILES_ARG) + 1] || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length) { console.error('--files needs a comma-separated list of filenames'); process.exit(2); }
    expected = list.map((f) => ({ id: '(not read)', statusmessage: '(not read)', filename: f }));
    console.log(`Offline mode: checking ${expected.length} filename(s) against the mailbox (no DB)\n`);
  } else {
    pool = new Pool({
      host: process.env.DB_HOST, port: 5432, database: process.env.DB_NAME,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 25000,
    });
    // Every MDR notification written in the window, with the filename it should name.
    const res = await pool.query(
      `SELECT n.id, n.status, n.email, s.filename, s.statusmessage
         FROM core_engine.email_notification n
         JOIN core_mediation.cdr_load_statistics s ON n.entityid = 'MDRFILE-' || s.id
        WHERE n.entityid LIKE 'MDRFILE-%'
          AND n.createddate >= now() - ($1 || ' hours')::interval
        ORDER BY n.id`,
      [String(HOURS)],
    ).catch((err) => {
      console.error(`Cannot reach the database (${err.message}).`);
      console.error('If the VPN is down, re-run in offline mode with the filenames the');
      console.error('server verifier printed:  node scripts/mdr273-mailbox-check.js --files a.csv,b.csv');
      process.exit(1);
    });
    expected = res.rows;
    console.log(`DB: ${expected.length} MDR notification(s) written in the last ${HOURS}h`);
    if (!expected.length) {
      console.log('Nothing to check. Produce a failure and trigger the notifier first.');
      await pool.end();
      return;
    }
  }

  const client = new ImapFlow({
    host: process.env.NOTIFY_IMAP_HOST,
    port: Number(process.env.NOTIFY_IMAP_PORT ?? 993),
    secure: true,
    auth: { user: process.env.NOTIFY_IMAP_USER, pass: process.env.NOTIFY_IMAP_PASSWORD },
    logger: false,
  });
  await client.connect();

  // IMAP SINCE is DATE-granular, so it returns whole days regardless of the hour.
  // Over-fetching then filtering in memory is correct; narrowing by subject keeps
  // the fetch small.
  const since = new Date(Date.now() - (HOURS + 24) * 3600 * 1000);
  const bodies = [];
  for (const folder of (process.env.NOTIFY_SEARCH_FOLDERS ?? 'INBOX').split(',').map((f) => f.trim())) {
    let lock;
    try { lock = await client.getMailboxLock(folder); } catch { continue; }
    try {
      const uids = (await client.search({ since, header: { subject: SUBJECT_HINT } }, { uid: true })) || [];
      for (const uid of [...uids].reverse()) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        if (!/MDR/i.test(parsed.subject || '')) continue;
        bodies.push({
          folder,
          date: parsed.date,
          subject: parsed.subject,
          to: parsed.to?.text || '',
          text: clean(parsed.html || parsed.text || ''),
        });
      }
    } finally { lock.release(); }
  }
  console.log(`Mailbox: ${bodies.length} MDR email(s) found\n`);

  let delivered = 0;
  const missing = [];
  for (const e of expected) {
    const hit = bodies.find(
      (b) => b.text.includes(e.filename) || b.text.includes(escapeHtml(e.filename)),
    );
    if (hit) {
      delivered++;
      console.log(`  DELIVERED  ${e.id}  ${String(e.statusmessage).padEnd(46)} ${e.filename}`);
    } else {
      missing.push(e);
      console.log(`  *MISSING*  ${e.id}  ${String(e.statusmessage).padEnd(46)} ${e.filename}`);
    }
  }

  console.log(`\n${delivered}/${expected.length} confirmed delivered`);
  if (missing.length) {
    console.log(
      `\n${missing.length} notification(s) are recorded as sent but were NOT found in the mailbox.\n` +
      `status=SUCCESS only means SMTP accepted the handoff, so this is exactly the\n` +
      `gap this script exists to catch. Check Spam, then treat as a delivery defect.`,
    );
  }
  const subjects = [...new Set(bodies.map((b) => b.subject))];
  if (subjects.length) console.log(`\nsubject(s) seen: ${subjects.join(' | ')}`);

  await client.logout();
  if (pool) await pool.end();
  process.exit(missing.length ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
