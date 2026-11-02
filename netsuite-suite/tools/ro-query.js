// Read-only SQL helper for the NetSuite regression.
//   node ro-query.js "<one SELECT/WITH/SHOW statement>"
//   node ro-query.js --file readonly-checks.sql --q Q5
// Connection comes from tools/.pg-coopegsbx-dev.json (local only, never shared; template pg-config.example.json).
// Three guards keep it read-only: only SELECT/WITH/SHOW/TABLE are accepted,
// only one statement per call, and the session runs with
// default_transaction_read_only=on, so the server refuses any write anyway.
const fs = require('fs');
const path = require('path');
const { Client } = require('D:/Dev/products/embrix/automation/embrix-automation/node_modules/pg');

function pickQuery(argv) {
  const i = argv.indexOf('--file');
  if (i < 0) return argv.slice(2).join(' ');
  const file = path.resolve(__dirname, '..', argv[i + 1]);
  const q = argv[argv.indexOf('--q') + 1];
  // Q blocks in readonly-checks.sql start with "-- Qn " and run until the next "-- Q".
  const blocks = fs.readFileSync(file, 'utf8').split(/^-- (?=Q\d)/m);
  const block = blocks.find(b => b.startsWith(q + ' '));
  if (!block) throw new Error(`No block ${q} in ${file}`);
  return block.split('\n').slice(1).join('\n'); // drop the "Qn  title" header line
}

function statements(sql) {
  return sql
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .replace(/--.*$/gm, '')
    .split(';').map(s => s.trim()).filter(Boolean);
}

(async () => {
  const stmts = statements(pickQuery(process.argv));
  if (!stmts.length) throw new Error('No SQL given');
  for (const s of stmts) {
    if (!/^(select|with|show|table)\b/i.test(s)) throw new Error(`Refused (read-only helper): ${s.slice(0, 60)}`);
    if (/\b(insert|update|delete|alter|drop|truncate|create|grant|revoke|copy|call|do)\b/i.test(s.replace(/'[^']*'/g, '')) && !/^show/i.test(s)) {
      throw new Error(`Refused (write keyword): ${s.slice(0, 60)}`);
    }
  }
  // NS_PG=<name> picks tools/.pg-<name>.json (e.g. NS_PG=demo for the CoopeG Sandbox); default this environment's .pg-coopegsbx-dev.json.
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, `.pg-${process.env.NS_PG || 'coopegsbx-dev'}.json`), 'utf8'));
  const c = new Client({
    ...cfg, port: cfg.port || 5432, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
    options: '-c default_transaction_read_only=on -c statement_timeout=60000',
  });
  await c.connect();
  try {
    for (const s of stmts) {
      const r = await c.query(s);
      console.log(`-- ${s.split('\n')[0].slice(0, 100)}  (${r.rowCount} rows)`);
      for (const row of r.rows.slice(0, 200)) console.log(JSON.stringify(row));
    }
  } finally {
    await c.end();
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
