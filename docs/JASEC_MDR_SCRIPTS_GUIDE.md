# JASEC — How to Run the MDR Reading & Rating Scripts

The companion to `JASEC_TEST_GUIDE.md`. That one covers the **Playwright** tests
(account creation, top-up, notifications). This one covers the **shell scripts**,
which are the other half of the ticket.

You do **not** need the repo, Node, or Playwright for anything in this guide.
Everything here runs on a shared server that already has the scripts on it. You
connect to it and type a command.

---

## 0. Read this first — what these scripts actually do

JASEC is prepaid electricity. Meters send their readings to Embrix in text files
called **MDR files**. Embrix then has to do two separate jobs with each file:

1. **Check the file is well-formed** — right name, right header, right trailer,
   the totals inside match. A bad file must be rejected with a specific reason.
2. **Rate it** — turn the kWh into money using the JASEC tariff (energy blocks,
   public-lighting charge, ICB and IVA taxes), then subtract it from the
   customer's prepaid balance.

The scripts test both. They build an MDR file, drop it where Embrix picks it up,
wait, then look in the database to see whether Embrix did the right thing.

**Two rules before you touch anything:**

- **These environments are shared.** Someone else may be mid-run. Two people
  running MDR scripts at the same time will interfere — see §8.
- **Never point anything at production.** Only `dev` and `preprod` appear in this
  guide, and that is deliberate.

---

## 1. What you need before you start

| | |
|---|---|
| **VPN** | You must be on the company VPN. Nothing below resolves without it. |
| **SSH access** | A key for the control server. Ask Anh or the DevOps contact — you cannot create this yourself. |
| **A terminal** | PowerShell on Windows is fine. Git Bash, macOS Terminal, anything. |

That is the whole list. No install step.

---

## 2. Connect to the control server

The server is `3.213.63.13`, and you log in as the user `ubuntu`.

Test it directly first:

    ssh -i C:\path\to\your-key ubuntu@3.213.63.13

If you get a prompt like `ubuntu@ip-10-0-...:~$`, you are in. Type `exit` to leave.

**Make it easier.** Add this to `~/.ssh/config` (on Windows that is
`C:\Users\<you>\.ssh\config` — create the file if it does not exist):

    Host embrix-dev
        HostName 3.213.63.13
        User ubuntu
        IdentityFile C:\path\to\your-key

Now you can just type:

    ssh embrix-dev

The rest of this guide assumes you did that.

**If it hangs or says "connection refused"** — check the VPN first. That is the
cause about nine times in ten.

---

## 3. The one concept that matters: the folder IS the environment

There is one server, but **two separate copies** of everything on it — one per
environment:

| Environment | Folder on the server |
|---|---|
| **dev** | `/jasec-energy/data/jasec/usage/energy` |
| **preprod** | `/jasec-energy/data/jasec-preprod/usage/energy` |

There is no `--env` flag and no setting to change. **Whichever folder you `cd`
into is the environment you are testing.** The scripts read the database
address, the tenant and the file drop-point from a config file sitting in that
folder.

So the first line of every session is one of these:

    cd /jasec-energy/data/jasec/usage/energy            # dev

    cd /jasec-energy/data/jasec-preprod/usage/energy    # preprod

Get this wrong and you will test the wrong environment while believing you did
not. If you are ever unsure which one you are in:

    pwd

---

## 4. Before a run — two quick checks

**a) Which suspension flow is this tenant on?** JASEC has an agreed change to how
prepaid suspension works ("Option B") that is not live yet. This tells you which
one you are testing, so the notification expectations make sense:

    bash suspension-mode.sh

You want to see `suspension mode: OPTION_A`. If it prints a big banner saying the
mode CHANGED, stop and ask — the expected results may have moved.

**b) Can this environment rate at all?** If the Revenue Hub config is missing,
every rating test will fail for a reason that has nothing to do with the test.
Check before spending an hour:

    psql "$(grep '^PG_DB_URL=' properties.config | cut -d= -f2-)" -c "select (select count(*) from core_config.config_legal_entity_list) as legal_entity, (select count(*) from core_config.config_calendar_periods) as calendar_periods"

Both numbers must be **greater than zero**. If either is `0`, the rating tests
(§6) cannot pass — they will report BLOCKED. Raise it with the team rather than
filing test failures.

---

## 5. Group A — MDR file validation (11 cases)

These prove Embrix rejects malformed files with the correct error, and accepts
good ones. Most of them need no meter and no customer — they fail at the file
level before Embrix ever looks up an account.

**Run all 11:**

    cd /jasec-energy/data/jasec/usage/energy
    ./run-all-mdr.sh

**Run just a few** — the numbers are the case numbers:

    ./run-all-mdr.sh 01 03 05

**Run exactly one:**

    ./run-mdr-03.sh

Takes about 10 minutes for all 11. It prints each case as it goes, then a summary
table at the end saying PASS or FAIL per case.

What the cases cover, roughly:

| Script | Checks |
|---|---|
| `run-mdr-01.sh` | a **good** file is accepted and actually rated |
| `run-mdr-02.sh` | the same filename twice is rejected as a duplicate |
| `run-mdr-03.sh` | a file whose header is not `HDR` is rejected |
| `run-mdr-04.sh` | a file whose trailer is not `TRL` is rejected |
| `run-mdr-05.sh` | trailer kWh totals that disagree with the rows are rejected |
| `run-mdr-06.sh` | trailer record counts that disagree are rejected |
| `run-mdr-07.sh` | a malformed data row is rejected and leaves nothing behind |
| `run-mdr-08.sh` | a duplicate reading is not charged twice |
| `run-mdr-09.sh` | a file mixing a real and a fake meter is handled correctly |
| `run-mdr-10.sh` | re-sending an old reading does not re-charge |
| `run-mdr-11.sh` | a row missing its reading timestamp is rejected |

Cases 01, 08, 09 and 10 are the ones that need a working meter and working
rating. If those four fail while the other seven pass, re-read §4b — that is
almost always the cause.

---

## 6. Group B — Tarification / rating (11 cases)

These are the money ones. They send a known number of kWh and check Embrix
charged the exact right amount: the right tariff block, the right public-lighting
charge, the right ICB and IVA taxes.

**You must supply a meter.** Do not skip this — the script has an old built-in
default that no longer works, and using it produces confusing failures.

### 6.1 Get a usable meter

Ask the server which meters can actually rate right now:

    cd /jasec-energy/data/jasec/usage/energy
    source ./env-profile.sh && resolve_active_meter prepaid

It prints something like:

    meter: 00210017284 (auto-resolved: ACTIVE service unit, prepaid)

That checks three things for you: the meter exists, its service is switched on,
and it has a live price attached. Copy the number.

**A note on "clean" meters.** These tests measure totals that build up over a
month. A meter that has already been used in another test carries those totals,
which makes correct results look wrong. For a trustworthy run, use a meter
created fresh by the account-creation test (`JASEC_TEST_GUIDE.md` §5.2,
`jasec-regression`), which prints its meter number at the end. The resolver above
is fine for a quick check, not for reporting a defect.

### 6.2 Run a case

    cd /jasec-energy/data/jasec/usage/energy/calc
    METER=00210017284 ./run-mdr-tarif.sh TC02

The `METER=...` part goes **in front of** the command, on the same line.

Valid case names: `TC02 TC03 TC04 TC05 TC06 TC07 TC08 TC09 TCB1 TCB2 TCB3`.

Each takes about 4 minutes. The script prints a line per event showing what was
expected and what Embrix actually produced, then `PASS` or `FAIL`.

---

## 7. Group C — MDR error notifications (dev only)

When Embrix rejects an MDR file it is supposed to email the administrator. These
check that happens, and that many failures at once get batched into one email
instead of flooding the inbox.

**Dev only.** Preprod has no notification recipient configured, so there is
nothing to check there.

You need a password for this one — the same Core UI password used by the
automated tests. Ask Anh, then:

    cd /jasec-energy/data/jasec/usage/energy
    EMBRIX_PASSWORD='<the password>' ./mdr273-notify-verify.sh

It prints a list of checks and ends with either
`ALL SERVER-SIDE CHECKS PASS` or the specific check that failed.

---

## 8. Reading the result — PASS, FAIL, or BLOCKED

This distinction matters more than the count, and it is the thing most worth
getting right before telling anyone "the tests failed".

| Verdict | Meaning |
|---|---|
| **PASS** | Embrix did the right thing. |
| **FAIL** | Embrix did the **wrong** thing. This is a real defect — report it. |
| **BLOCKED** | Embrix never got the chance to answer. The test proved **nothing**. Not a defect. |

A blocked case is not a failing case. Reporting one as a defect sends someone
chasing a bug that does not exist.

Here is how to tell which you have:

| What you see | It means | Verdict |
|---|---|---|
| `UNKNOWN_ERROR` and `sellingcompany` in the message | Revenue Hub config missing — see §4b | BLOCKED |
| `CANNOT_PROCESS_FUTURE_TRANSACTIONS` | the reading is dated later than the system clock | BLOCKED |
| `NO_SERVICE_FOR_THE_PROVISIONING_ID` | that meter's service is switched off | BLOCKED |
| `MDR did not reach PROCESSED` | the file was never picked up — see §9 | BLOCKED |
| `*** ABORT: meter ... is not in service` | the meter did not exist yet at the system clock's date | BLOCKED |
| An amount that differs from expected | Embrix charged the wrong money | **FAIL** |

---

## 9. Where the evidence goes

Every run saves its files on the server so you can look again later, or attach
them to a ticket.

| Environment | Folder |
|---|---|
| dev | `qc_evidence_<today>/` inside the dev folder |
| preprod | `qc_evidence_preprod_<today>/` inside the preprod folder |

`run-all-mdr.sh` also writes a `regression_<timestamp>/` folder with one log per
case.

To list today's evidence:

    ls -la qc_evidence_$(date +%Y%m%d)/

To copy a file back to your own machine, run this **from your machine**, not from
the server:

    scp embrix-dev:/jasec-energy/data/jasec/usage/energy/qc_evidence_20260826/TARIF-TC02.tar.gz .

---

## 10. Common problems

**"MDR did not reach PROCESSED" / nothing seems to happen.**
A background job picks up dropped files roughly once a minute and handles about
one file per pass. If several files are queued — because someone else is running
tests, or you started two scripts — yours waits its turn. Wait a few minutes and
look again. This is also why two people should not run MDR scripts at the same
time.

**Everything rating-related fails at once.**
Almost always the Revenue Hub config from §4b. Check it before assuming the
product broke.

**"permission denied" or the command is not found.**
You are probably in the wrong folder. Run `pwd` and compare against §3.

**It worked yesterday and fails today with a date error.**
These environments run on a **frozen clock** that testers move around, so "today"
on the server is not today in real life. The MDR scripts date their readings from
that frozen clock automatically, so this should not happen — but if you see
`CANNOT_PROCESS_FUTURE_TRANSACTIONS`, that is what it is. Ask rather than guess.

**I am not sure whether I broke something or found something.**
Use §8. If the verdict is BLOCKED, you found an environment problem, not a bug.

---

## 11. Things not to do

- **Do not** edit the scripts on the server. They are copies — the originals live
  in `Regression testing/_scripts/` on Anh's machine and the next deploy
  overwrites anything you change, silently.
- **Do not** run two MDR scripts at the same time, or run one while someone else
  is testing. They share one file queue.
- **Do not** point anything at production.
- **Do not** report a BLOCKED case as a defect. Re-read §8 first.

---

## 12. Where to go next

- **Playwright tests** (account creation, top-up, notifications) —
  `JASEC_TEST_GUIDE.md`.
- **Running the whole ticket end to end**, in the right order, so the blocks do
  not interfere — `Regression testing/EPDP-348_JASEC-Test/RUNBOOK-full-regression.md`.
  Read that before attempting a full sweep; the order is not cosmetic.
