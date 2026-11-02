// Shared helpers for the coopegsbx2 NetSuite tools: GraphQL, CCP clock window (always restored), DB client, NetSuite call printout.
// The DB config is tools/.pg-coopegsbx-dev.json (git-ignored, VPN on). Writes go through db() only in the tools that say so.
const fs = require('fs');
const path = require('path');
const { Client } = require('D:/Dev/products/Embrix/automation/embrix-automation/node_modules/pg');

const GQL = 'https://service-transactional.coopegsbx2.embrix.org/graphql';
const CRM = 'https://crm-gateway.coopegsbx2.embrix.org';
// The date every tool puts the clock back to: NS_BASELINE (the date the clock showed before the run), default 2027-01-01.
const BASELINE = process.env.NS_BASELINE || '2027-01-01';

async function gql(query, variables) {
  const r = await fetch(GQL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { throw new Error(`GraphQL HTTP ${r.status}: ${t.slice(0, 200)}`); }
  if (j.errors?.length) throw new Error(j.errors.map(e => e.message).join('; '));
  return j.data;
}
const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clock = async () => (await gql('{ getCcpDateTime(dummy:"x") { ccpTime } }')).getCcpDateTime.ccpTime;
const setClock = async d => { await gql(`mutation { setCcpTime(input:{ccpTime:"${d}"}) { ccpTime } }`); return clock(); };

/** Runs fn with the CCP clock at date, then puts the clock back to what it was (tenant-wide setting). */
async function atDate(date, fn) {
  const base = await clock();
  console.log(`clock ${base} → ${await setClock(date)}`);
  try { return await fn(); } finally { console.log(`clock restored ${await setClock(base)}`); }
}

/** DB client (read + write). Close it with c.end(). */
async function db() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '.pg-coopegsbx-dev.json'), 'utf8'));
  const c = new Client({ ...cfg, port: cfg.port || 5432, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await c.connect();
  return c;
}

const invoices = async acc => (await gql(`{ searchInvoiceUnits(page:1,size:100,filter:{accountId:"${acc}"}) { id invoiceDate dueDate total due status billUnitId } }`)).searchInvoiceUnits ?? [];
const notes = async acc => (await gql(`{ searchNotesUnits(page:1,size:200,filter:{accountId:"${acc}",startDate:"2000-01-01",endDate:"2099-12-31"}) { id invoiceId total reasonDescription folioStatus financeSyncStatus financeErrorMessage status } }`)).searchNotesUnits ?? [];
const orders = async acc => (await gql(`{ searchOrders(page:1,size:20,filter:{accountId:"${acc}"}) { id type status effectiveDate } }`)).searchOrders ?? [];
const activities = async acc => (await gql(`{ searchActivities(page:1,size:100,filter:{accountId:"${acc}"}) { id apiName entityId activityDate request response } }`)).searchActivities ?? [];

/** One line per NetSuite call: customer, type, memo, due, lines (item:taxCode amount tax), applies, answer. Never prints credentials. */
function nsCall(a) {
  let h = '';
  try {
    const r = JSON.parse(a.request); const m = r.invoice || r.creditMemo;
    if (m) h = [`entity ${JSON.stringify(m.entity)}`, m.tipoFactura && `tipo ${m.tipoFactura}`, m.memo && `memo "${m.memo}"`, m.fechaVencimiento && `due ${m.fechaVencimiento}`,
      `dept ${m.department} class ${m.class} loc ${m.location}`, m.motivoAnulacion && `reason "${m.motivoAnulacion}"`, m.applys && `applys ${JSON.stringify(m.applys)}`,
      `items ${(m.items || []).map(t => `${t.item}:tc${t.taxCode} ${t.amount} tax ${t.taxAmount}`).join(' | ')}`].filter(Boolean).join(' ');
  } catch { /* not a NetSuite payload */ }
  return `${a.id} ${a.apiName} ${a.entityId} ${h} → ${String(a.response).slice(0, 160)}`;
}

/** Waits up to ms for check() to return something truthy. */
async function waitFor(check, ms = 180_000, every = 10_000) {
  for (let t = 0; t <= ms; t += every) { const v = await check(); if (v) return v; await sleep(every); }
  return undefined;
}

const qaOnly = acc => { if (!/^QA-ANH-NS-/.test(acc || '')) throw new Error(`QA test contracts only (QA-ANH-NS-…): ${acc}`); };

module.exports = { GQL, CRM, BASELINE, gql, post, sleep, clock, setClock, atDate, db, invoices, notes, orders, activities, nsCall, waitFor, qaOnly };
