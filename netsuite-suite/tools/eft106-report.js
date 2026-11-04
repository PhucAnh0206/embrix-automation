// EFT-106 escalation documents from the latest results (no history, business wording):
//   eft-106\EFT-107-client-issues.csv, EFT-108-process-results.csv, EFT-109-integration-evidence.csv
// Inputs: the client CSV (latest result per case), eft-106\results.json (written by tests\coopeg\tickets\eft-106 specs).
//   node test-cases\netsuite\tools\eft106-report.js
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..');
const OUT = path.join(DIR, 'eft-106');

const parse = t => { const rows = []; let r = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { r.push(f); f = ''; } else if (c === '\r') { } else if (c === '\n') { r.push(f); rows.push(r); r = []; f = ''; } else f += c; } if (f || r.length) { r.push(f); rows.push(r); } return rows.filter(x => x.length > 1); };
const csv = list => list.map(x => x.map(v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(',')).join('\r\n') + '\r\n';

const suite = parse(fs.readFileSync(path.join(DIR, 'NetSuite_Regression_TestSuite - NetSuite_Regression_TestSuit.csv'), 'utf8'));
const H = suite[0];
const C = Object.fromEntries(suite.slice(1).map(r => [r[0], { title: r[H.indexOf('Test Case')], actual: r[H.indexOf('Actual Result(s)')], status: r[H.indexOf('Status')] }]));
const R = fs.existsSync(path.join(OUT, 'results.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'results.json'), 'utf8')) : {};
const res = id => R[id] ?? { verdict: 'Not tested', result: 'Not run yet.' };
// Evidence of a check: its request / answer file and its screenshots (evidence\<check>-*.png).
const EV = fs.existsSync(path.join(OUT, 'evidence')) ? fs.readdirSync(path.join(OUT, 'evidence')) : [];
const evidence = id => [`eft-106/evidence/${id}.json`, ...EV.filter(f => f.startsWith(`${id}-`) && f.endsWith('.png')).map(f => `eft-106/evidence/${f}`)].join('\n');
const NEEDS = {
  ont: 'A free test ONT to repeat the full network cycle (connection, suspension, reconnection, disconnection) on a QA contract: NOKIA now configures the test ONT ALCLB3D94488, but it is in use on test contract 798696. Nothing to fix in Embrix.',
  tv: 'A new Internet + TV contract (plan BDL_INT_200MBPS_TV; MOTV logs the viewer in with the contract number, so no TV box is needed), now that the TV request carries the customer e-mail and phone. It needs a free test ONT. If MOTV still answers code 24, Coope: the rights of the MOTV user of the test environment.',
  voip: 'Coope: allow the test environment (50.16.147.102) to reach voip.coopeguanacaste.cr on port 443, and a free test number from the PortaOne number inventory. Then a phone order is repeated.',
  coopeweb: '',
};

// ---- EFT-107: the 5 client issues ----
// Columns and result wording as EFT-106 asks: Confirmed / Not reproduced / Expected behavior; root cause (environment
// configuration, code, data or integration), fix approach, effort, and the client information needed to reproduce.
const CLIENT_INFO = 'The client\'s account, order number, request and date / time of the test, to confirm it is the same case.';
// steps: how the team reproduces the issue on the screens. result / also: a written result and a second check's evidence
// where the recorded check alone no longer tells the whole story (#4: second ONT, 26 Oct).
const I = [
  { n: '1', issue: 'The provisioning order is not created with the order number sent in the request.', id: 'EFT107-I1', how: 'New contract sent the way Coopeweb sends it; order read back.',
    steps: '1. Coopeweb sends a new contract request with its own order number (e.g. QA-ANH-NS-R2-10251606-E107-O).\n2. In Embrix, open the new customer > Orders and open the order.\n3. Compare the order number with the one sent.\nExpected: the order has the same number Coopeweb sent.' },
  { n: '2', issue: 'The initial subscription is still being created.', id: 'EFT107-I2', how: 'Same new contract: subscriptions read right after creation.',
    steps: '1. Coopeweb sends a new contract request.\n2. Before the contract is provisioned, open the customer > Subscription.\nExpected: no subscription yet; it is created only when the contract is provisioned.' },
  { n: '3', issue: 'The account is created with initial services already active.', id: 'EFT107-I3', how: 'Same new contract: services read right after creation.',
    steps: '1. Coopeweb sends a new contract request.\n2. Before the contract is provisioned, open the customer > Services.\nExpected: no active service yet; services become active only when the contract is provisioned.' },
  { n: '4', issue: 'Provisioning fails because of an error when creating the order.', id: 'EFT107-I4', also: 'EFT108-PROVISIONING', how: 'Every NOKIA answer to this environment\'s provisioning orders, with both test ONTs.',
    steps: '1. Coopeweb sends a new contract request.\n2. Order Management > open the contract\'s provisioning order > enter the test ONT serial and model on the Internet service > create the order.\n3. Open the customer > Customer Activity and check the NOKIA steps in order: location lookup (GET_LOCATION_DATA), free position (GET_SPACE_DATA), configuration (CREATE_PROVISIONING_ORDER).\n4. Open the order and check its status.\nExpected: every NOKIA step answers successfully and the order ends COMPLETED.',
    validation: 'Confirmed (test environment cause, now resolved)',
    result: 'Reproduced, in two stages. With the first test ONT (ALCLB3D9363D, shared with the CoopeG Sandbox), NOKIA refused the location lookup, so nothing else could be sent. With the second test ONT (ALCLB3D94488, 26 Oct, contracts QA-ANH-NS-R2-10261514-E108 and QA-ANH-NS-R2-10261545-E108), NOKIA finds the ONT and proposes position 8 (OLT-STC01, 1-1-1-1-8) as free, then refuses to configure the ONT there: "Could not configure ISAM ONT on 1-1-1-1-8 ... Unable to create object" (NOKIA rolled back). The order ends PROVISIONING_ERROR and Embrix reports the failure to Coopeweb. Resolved in the environment: since 31 Oct NOKIA configures the test ONT ALCLB3D94488 on OLT-STC01 (operative status ENABLED, test contract 798696), so the provisioning order is created and completed.',
    confirmed: { cause: 'Integration / test data (NOKIA test system): this environment and the Demo Sandbox use the same NOKIA test system, which still held the test ONT\'s position, and the test environment lacked 7 OLT templates that production has. No Embrix code change.',
      fix: 'Done in the environment: the position was freed in NOKIA and the OLT templates were copied from production (31 Oct). Keep one environment provisioning with a test ONT at a time.', effort: 'No development.' } },
  { n: '5', issue: 'Invoices are not being sent to NetSuite.', id: 'EFT107-I5', how: 'New invoice on a contract registered in NetSuite (Bills > Manual Billing), then looked up in the NetSuite sandbox.',
    steps: '1. On a contract registered in NetSuite (e.g. 208886), go to Bills > Manual Billing and create an invoice.\n2. In Bills, check the invoice\'s Finance Sync Status and Finance Version (the NetSuite invoice number).\n3. Search that number in NetSuite.\nExpected: status SUCCESS, a NetSuite number (FA...), and the invoice found once in NetSuite with the same amount.\nVariation: on a contract not registered in NetSuite, the invoice shows ERROR with NetSuite\'s "contract not found" message (expected behavior).',
    note: 'Expected behavior for contracts not registered in NetSuite: NetSuite refuses their invoices ("contract not found") and Embrix shows the message on the invoice.' },
];
const v107 = (x, v) => x.validation ? x.validation : v === 'Pass' ? (x.note ? 'Not reproduced (and Expected behavior for contracts not registered in NetSuite)' : 'Not reproduced')
  : v === 'Fail' ? 'Confirmed' : v;
fs.writeFileSync(path.join(OUT, 'EFT-107-client-issues.csv'), csv([
  ['#', 'Client-reported issue', 'Validation result', 'What we checked', 'Steps to reproduce', 'Result', 'Evidence', 'Root cause', 'Fix approach', 'Estimated effort', 'Client information needed'],
  ...I.map(x => {
    const v = res(x.id).verdict, c = v === 'Fail' ? x.confirmed : undefined;
    return [x.n, x.issue, v107(x, v), x.how, x.steps, (x.result ?? res(x.id).result) + (x.note ? ` ${x.note}` : ''), [evidence(x.id), ...(x.also ? [evidence(x.also)] : [])].join('\n'),
      c?.cause ?? (v === 'Fail' ? 'Pending investigation' : 'Not applicable (not reproduced on the current build)'), c?.fix ?? '', c?.effort ?? '', v === 'Pass' && !x.note ? '' : CLIENT_INFO];
  }),
]));

// ---- EFT-108: the 9 business processes ----
const P = [
  { p: 'Provisioning', cases: [], checks: ['EFT108-PROVISIONING'], blockedBy: NEEDS.ont,
    tested: 'New contract provisioned through Order Management with this environment\'s own ONT; NOKIA, and MOTV / PortaOne when TV / phone are ordered, judged on their own answers (built, waiting for the ONT). Earlier attempts with the shared ONT: EFT-107 issue 4.' },
  { p: 'Billing', cases: ['REG-001', 'REG-003', 'INV-001', 'INV-002', 'INV-003', 'INV-010', 'MAP-001', 'MAP-002', 'MAP-003', 'MAP-004', 'MAP-008', 'MAP-009', 'MAP-012', 'MAP-013'],
    tested: 'Monthly and manual invoices: amounts, taxes and exemptions, Hacienda stamp, departments and dates in NetSuite.' },
  { p: 'Disconnection and reconnection', cases: ['REG-002', 'SUS-001'], checks: ['EFT107-I4'], partial: 'The suspension and reconnection orders to the network (NOKIA) are not proven: ' + NEEDS.ont,
    tested: 'Collection reminder, suspension on the 21st, notice to Coopeweb, payment and automatic reconnection; manual suspension and resume.' },
  { p: 'Credit notes', cases: ['CRN-001', 'CRN-002', 'CRN-003', 'CRN-004', 'CRN-005', 'CRN-006', 'CRN-007', 'CRN-008', 'CRN-011', 'ENG-006-01', 'ADJ-001', 'ADJ-002', 'INV-018'],
    tested: 'Whole-invoice and line credits, with and without tax, intercompany, bulk upload, debit notes, credits from Coopeweb, undo of an invoice.' },
  { p: 'Contract creation', cases: ['CRM-001', 'CRM-003', 'CRM-004'], checks: ['EFT107-I1', 'EFT107-I2', 'EFT107-I3'],
    tested: 'New contracts from Coopeweb: order number kept, no subscription or active service before provisioning, payment term NET 18.' },
  { p: 'Plan changes', cases: ['CHG-001'], tested: 'TV added to an Internet plan in the middle of the month.' },
  { p: 'Terminations', cases: ['CAN-001', 'CAN-002'], partial: 'The disconnection order to the network (NOKIA) is not proven: ' + NEEDS.ont,
    tested: 'Cancellation in the middle of the month and cancellation notice from collections.' },
  { p: 'Relocations', cases: [], outOfScope: 'Out of scope for the NetSuite environment (confirmed 28 Oct), as in the CoopeG Sandbox release of 26 October.',
    tested: 'Not tested: out of scope.' },
  { p: 'Payments', cases: ['PAY-001', 'AR-001', 'AR-002', 'AR-006', 'PAY-002..005'],
    tested: 'Full payment from NetSuite, due-date extension, grace period; partial / over / group payments and arrangements.' },
];
// Process → its screenshot pack in eft108-processes.spec.ts (EFT108-<pack>-*.png).
const PACK = { 'Billing': 'BILLING', 'Disconnection and reconnection': 'DISCONNECTION', 'Credit notes': 'CREDIT-NOTES', 'Contract creation': 'CONTRACT-CREATION', 'Plan changes': 'PLAN-CHANGES', 'Payments': 'PAYMENTS' };
const rows108 = P.map(x => {
  const cs = x.cases.map(id => ({ id, ...(C[id] ?? { title: '?', actual: 'not found in the suite', status: '?' }) }));
  const ck = (x.checks ?? []).map(id => ({ id, ...res(id) }));
  const fails = [...cs.filter(c => c.status === 'Fail'), ...ck.filter(c => c.verdict === 'Fail' && !x.partial && !x.blockedBy)];
  const waiting = cs.filter(c => /Waiting|Need confirmation/.test(c.status));
  let status = 'Pass';
  if (x.outOfScope) status = 'Out of scope';
  else if (x.notTested) status = 'Not tested';
  else if (x.blockedBy && ck.some(c => c.verdict !== 'Pass')) status = 'Blocked';
  else if (fails.length) status = 'Fail';
  else if (waiting.length || (x.partial && ck.some(c => c.verdict !== 'Pass'))) status = 'Partly done';
  const results = [...cs.map(c => `${c.id} ${c.title}: ${c.status}`), ...ck.map(c => `${c.id}: ${c.verdict}`)].join('\n');
  const open = [
    ...waiting.map(c => `${c.id}: ${c.actual.split(/Waiting for/)[1] ? 'waiting for' + c.actual.split(/Waiting for/)[1] : c.actual}`),
    ...(x.partial && ck.some(c => c.verdict !== 'Pass') ? [x.partial] : []),
    ...(x.blockedBy && ck.some(c => c.verdict !== 'Pass') ? [x.blockedBy] : []),
    ...(x.notTested ? [x.notTested] : []),
    ...(x.outOfScope ? [x.outOfScope] : []),
  ].join('\n');
  // Screenshots of the process's documents (eft108-processes.spec.ts) and of its checks.
  const ev = [`EFT108-${PACK[x.p]}`, ...(x.checks ?? [])]
    .flatMap(id => EV.filter(f => f.startsWith(`${id}-`) && f.endsWith('.png')).map(f => `eft-106/evidence/${f}`));
  return [x.p, status, x.tested, results, open, ev.join('\n')];
});
fs.writeFileSync(path.join(OUT, 'EFT-108-process-results.csv'), csv([['Business process', 'Status', 'What was tested', 'Cases and results', 'Open points', 'Evidence'], ...rows108]));

// ---- EFT-109: the 5 integrations ----
const G = [
  ['NetSuite', 'EFT109-NETSUITE', 'Invoices and credit notes sent by Embrix and NetSuite\'s answers; the latest ones looked up in the NetSuite sandbox.', '', { status: 'Pass',
    result: 'Every stamped invoice and credit note of a contract registered in NetSuite is sent once and accepted; NetSuite\'s number (FA… / NC…) is kept on the Embrix document. A refused document keeps NetSuite\'s reason on the Bills / Credit Notes screen and can be sent again (e.g. contract not registered in NetSuite, accounting period not open). Latest: invoice FA586485 and credit memo NC1094 found once in the NetSuite sandbox with the same amounts.' }],
  ['CoopeWeb', 'EFT109-COOPEWEB', 'Requests Coopeweb sends to Embrix (contracts, adjustments, payments, due dates, grace periods, invoice inquiry with PDF) and Embrix\'s messages to Coopeweb (work orders, provisioning confirmation, cancellation notice, SMS).', NEEDS.coopeweb, { status: 'Pass',
    result: 'CoopeWeb → Embrix works: contracts and orders, credits, payments, due-date extensions, grace periods and invoice inquiries with PDF are answered (e.g. order ORD-3002 on 244764, 2 Nov). Embrix → CoopeWeb: provisioning confirmations and work-order updates are answered (order 7130091 on 798698: "Datos de aprovisionamiento manual registrados correctamente"; the earlier HTTP 401 answers are fixed). Cancellation notices and SMS are issued in test mode and not delivered, as on the CoopeG Sandbox.' }],
  ['NOKIA', 'EFT109-NOKIA', 'Every NOKIA answer to this environment\'s provisioning, suspension, reconnection and disconnection orders.', NEEDS.ont, { status: 'Partly done',
    result: 'Provisioning works: NOKIA locates the test ONT ALCLB3D94488, finds the space and configures it on OLT-STC01 (operative status ENABLED) for test contract 798696 (31 Oct). The earlier refusals came from the test environment\'s NOKIA data (a position still held, missing OLT templates), fixed on 31 Oct (EFT-107 issue 4). Suspension, reconnection and disconnection have not yet been shown on a contract connected in NOKIA: the QA contracts were activated without NOKIA, so those orders are not sent for them.' }],
  ['PortaOne', 'EFT109-PORTAONE', 'Phone (VoIP) orders sent to PortaOne from this environment.', NEEDS.voip, { status: 'Blocked',
    result: 'The test environment cannot reach PortaOne: sign-ins time out ("connect timed out", 4 of the last 6), so no phone line has been created. Coope\'s firewall lets only production in.' }],
  ['MOTV', 'EFT109-MOTV', 'TV orders sent to MOTV from this environment.', NEEDS.tv, { status: 'Fail',
    result: 'MOTV answers and the test user signs in, but every TV customer sent from this environment carried "--email--" and "--number--" instead of the customer e-mail and phone, and MOTV refused it (code 104 "Email --email-- is not valid email" on 798698; code 24 on 798659, 798661, 798696 and 798700). The e-mail and phone are now sent, as on the CoopeG Sandbox; a new TV order has not run since.' }],
];
fs.writeFileSync(path.join(OUT, 'EFT-109-integration-evidence.csv'), csv([
  ['Integration', 'Status', 'What was checked', 'Result', 'Evidence', 'Needed to complete'],
  ...G.map(([n, id, how, need, o]) => [n, o?.status ?? res(id).verdict, how, o?.result ?? res(id).result, evidence(id), (o?.status ?? res(id).verdict) === 'Pass' ? '' : need]),
]));

const count = rows => rows.reduce((m, r) => (m[r] = (m[r] || 0) + 1, m), {});
console.log('EFT-107', JSON.stringify(count(I.map(x => v107(x, res(x.id).verdict)))));
console.log('EFT-108', JSON.stringify(count(rows108.map(r => r[1]))));
console.log('EFT-109', JSON.stringify(count(G.map(g => g[4]?.status ?? res(g[1]).verdict))));
