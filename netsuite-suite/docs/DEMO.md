# NetSuite demo for business stakeholders

A live demo of what the Embrix ↔ NetSuite integration does, shown in a real browser on the NetSuite test environment (coopegsbx2) and Coope's NetSuite test sandbox: about 15 minutes for all six flows, longer with questions. Everything runs by itself: a green bar at the top of the screen says what is happening at each step, so the audience can follow without knowing the system.

## What the audience will see

| Demo | Business question it answers | What happens on screen | Takes |
|---|---|---|---|
| **1. An invoice goes to NetSuite** | "When we bill a customer, does NetSuite get the invoice?" | An agent bills Internet (10,000 + IVA + levies) on the customer's Manual Billing screen. The invoice appears on the customer's Bills screen with **Finance Sync Status: SUCCESS** and NetSuite's own invoice number (FA…). Then NetSuite opens and the same invoice is found there, with the same customer and total | ~2 min |
| **2. An agent extends a due date** | "If a customer needs more time, can we give it?" | On Bills, the agent picks the invoice, chooses **Extend Due Date**, sets a date 15 days later with a note, and submits. The invoice shows the new due date | ~1 min |
| **3. A payment comes from NetSuite** | "When Coope collects in NetSuite, does Embrix know?" | NetSuite sends the payment to Embrix (the same message NetSuite sends in real life). The invoice on Bills turns **CLOSED** with nothing left to pay | ~1 min |
| **4. Voiding an invoice already in NetSuite** | "What if an invoice was a mistake?" | A new invoice is created and reaches NetSuite. The agent chooses **Undo** on Bills. A credit note for the full amount (taxes included) is created, stamped by Hacienda and sent to NetSuite; the invoice is closed. NetSuite shows the credit memo applied to the invoice | ~3 min |
| **5. The monthly billing run** | "Does the monthly billing still work, and do those invoices reach NetSuite?" | A Coope test contract has a month waiting to be billed. The operator opens **Operations Hub > Jobs Management > Daily**, picks the billing day, **Create Job Schedule** and **Process**; the job cards run. The month's invoice appears on the contract's Bills with **SUCCESS** and its NetSuite number, and is found in NetSuite | ~6 min |
| **6. A new contract arrives from CoopeWeb** | "When CoopeWeb sells a contract, is it set up for NetSuite?" | CoopeWeb sends a new Internet contract. **Account Info** shows the NetSuite customer number (Party Id); the **order** keeps CoopeWeb's order number and waits for the technician; **Services** shows nothing active, so nothing is billed yet | ~2 min |

Each demo can be run on its own, in any order, as often as needed. Demos 2 and 3 continue with demo 1's invoice while it is still open; if there is none, or demo 3 has already paid it, they first create a fresh invoice behind the scenes. Demo 5 bills the contract's next waiting month each time it runs. When one demo is chosen, PowerShell lists the others as "skipped": that is expected.

## Key messages for the audience
- Embrix stays the billing system and the only issuer of Hacienda documents. **Every stamped invoice and credit note goes to NetSuite once**, automatically, as soon as Hacienda accepts it, whether it comes from the monthly billing run or from an agent.
- NetSuite's number (FA… for invoices, NC… for credit notes) is kept on the Embrix document, and the Bills / Credit Notes screens show whether NetSuite accepted it. If NetSuite refuses a document, the screen shows NetSuite's reason and the agent can send it again.
- New contracts from CoopeWeb carry the NetSuite customer number, so their invoices go to the right NetSuite customer. Billing starts only when the service is connected.
- **Payments, due-date extensions and grace periods come from NetSuite** to Embrix. Embrix applies payments with its usual rules and reconnects a cut service.
- A stamped invoice is never deleted: it is **voided with a full credit note**, in Hacienda and in NetSuite.
- Customer data, debit notes and payments are not sent from Embrix to NetSuite.

## Before the demo (presenter, once)
- A Windows laptop prepared by QA, with the automation installed (see `NEXT-RUN.md` §10) and its settings file `.env.coopegsbx2` filled in.
- **VPN:** only demo 5 needs it (dev/preprod VPN on). Demos 1–4 and 6 run without it.
- Tell the team chat when the demo runs. Demo 5 runs a real monthly billing day: it moves the environment's date to that day and back, and bills every account due that day, not only the demo contract.
- Do a dry run the day before: NetSuite must accept documents at the dates used (Coope's NetSuite administrator opens the accounting periods).

## Run it
1. Open **Windows PowerShell** (for demo 5, connect the VPN first).
2. Go to the automation folder and start the menu:
   ```powershell
   cd D:\Dev\products\Embrix\automation\embrix-automation
   .\scripts\netsuite\ns-demo.ps1
   ```
3. Type a number (1 to 6) or **A** for all six, and press Enter. A browser window opens by itself; let it run and talk over the green captions. Do not click in the browser while it runs.
4. "Demo finished." appears in PowerShell at the end.

Shortcuts: `.\scripts\netsuite\ns-demo.ps1 all` (all six, no menu) · `.\scripts\netsuite\ns-demo.ps1 5` (one demo) · add `-Slow` for slower clicks and longer captions on a big screen.

## If something goes wrong
| You see | Meaning | What to do |
|---|---|---|
| "Another run is in progress" | A test run is still going on this laptop | Wait for it to finish, then start again |
| "Could not clear the old schedule … (is the VPN on?)" | Demo 5 needs the VPN | Connect the VPN and run demo 5 again |
| The NetSuite status stays ERROR with "No valid, open, tax period" | NetSuite's accounting period for that date is closed | Ask Coope's NetSuite administrator to open it; show the other demos meanwhile |
| The demo stops with a red message in PowerShell | A step did not give the expected result | Screenshots are in `output\test-results\`; QA can explain it. The other demos can still be run one by one |
| A NetSuite login page asks for a verification code | NetSuite wants a new sign-in | Type the code from the shared test account's e-mail in the browser; the demo continues |

## What the demo changes
- Demos 1–4: only the team's test customer 208886 (new invoices, one due-date change, one payment, one voided invoice). The environment's date is not moved.
- Demo 5: one monthly invoice on Coope's test contract 798166, plus the invoices of any other account due that day; the date is put back afterwards.
- Demo 6: one new test contract, not connected (nothing billed).
- NetSuite is only looked at, never edited.
