/**
 * TC-03 — The customer always has one main contact, and the receipt and the e-mail name that person (JEPYP-316).
 * Runs after TC-02. Business-confirmed 2026-10-13; behaviour as delivered in JEPYP-316 round 2 (2026-10-14).
 *
 *   Scenario: the main contact is used on the receipt and in the e-mail
 *     Given a customer registered with two contacts
 *     Then the first contact entered is the main contact: listed first, tagged "Primary contact" / "Contacto
 *          principal", its Delete disabled
 *     When the customer tops up   Then the receipt and the e-mail name it as "Nombre Primer Apellido Segundo Apellido"
 *   Scenario: the clerk changes the main contact and deletes the former one in the same save
 *     When the clerk presses "Make primary contact" on the second contact, deletes the former main contact, Modify
 *     Then only the second contact is left, tagged main, and the next receipt and e-mail name it
 *   Scenario: the clerk marks another contact as main (former one kept), pressing Modify twice quickly
 *     Then both contacts are still there (saved once), the marked one is first and tagged, documents name it
 *
 * MUTATING, own data only (customerId QA316-MC-*): 3 accounts, orders with M-QA meters, 3 top-ups (mail to the QA
 * mailbox). No clock move, no billing. Needs DB access (contacts, the stored e-mail) - BLOCKED without DB_*.
 *   npx playwright test --project=jasec-regression --grep "@tc-03"
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../../fixtures/jasec-fixtures';
import { DbHelper, hasDbConfig } from '../../../helpers/db.helper';
import { blockedIf } from '../../../helpers/blocked.helper';
import {
  MARIA, JORGE, PEDRO, type Contact, fullName, fullNameRe, graphqlLogin, createAccountWithContacts, contactsOf,
  orderTopUpAndMail, readNewestReceipt, openContactTab, readContactCards, makePrimary, deleteContactCard, saveContacts,
  type SelfcareFixtures,
} from '../../../helpers/customer-contact.helper';
import type { Page } from '@playwright/test';
import type { TestLogger } from '../../../helpers/test-logger';

const RUN = Date.now().toString(36).toUpperCase();
const ARTIFACTS = path.join(process.cwd(), 'output', 'artifacts', 'tc-03-main-contact');

// This case does not own the clock: never let the jasec fixture rewind it.
test.use({ ccpBaseline: null });

test.describe('TC-03 — Main contact management', {
  tag: ['@jasec', '@tc-03'],
}, () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async () => {
    if (blockedIf(!hasDbConfig(), 'TC-03 needs DB access (contacts, the stored top-up e-mail)')) return;
    if (blockedIf(!(await graphqlLogin()), 'GraphQL login failed')) return;
    fs.mkdirSync(ARTIFACTS, { recursive: true });
  });

  /** Top up, then: the receipt and the e-mail greeting both name `main` in full. */
  async function documentsName(fx: SelfcareFixtures & { page: Page; testLogger: TestLogger }, db: DbHelper, acct: string, tag: string, main: Contact) {
    const mail = await orderTopUpAndMail(db, acct, tag);
    const receipt = await readNewestReceipt(fx.page, fx, acct, ARTIFACTS);
    fx.testLogger.data('Receipt / e-mail', { acct, receipt, mail });
    expect.soft(receipt.name, `receipt "Nombre del Cliente" = ${fullName(main)}`).toMatch(fullNameRe(main));
    expect.soft(mail.mailStatus, 'top-up e-mail recorded').not.toMatch(/^<no /);
    expect.soft(mail.greeting, `e-mail greeting = Estimado(a) ${fullName(main)}`).toMatch(fullNameRe(main));
  }

  test('the first contact entered is the main contact, and the documents name it', { tag: ['@tc-03'] }, async ({
    page, testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage, selfcareTopupPage,
  }) => {
    test.setTimeout(600_000);
    const fx = { page, testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage, selfcareTopupPage };
    const db = new DbHelper(testLogger);
    await db.connect();
    try {
      // Given a customer registered with two contacts, María first
      const acct = await createAccountWithContacts(`QA316-MC-${RUN}-TWO`, [MARIA, JORGE]);
      // Then María is the main contact: listed first, tagged, cannot be deleted
      await openContactTab(page, acct);
      const cards = await readContactCards(page);
      testLogger.data('Contact cards', { acct, cards, contacts: await contactsOf(db, acct) });
      expect(cards.map(c => c.firstName), 'both contacts shown, main first').toEqual([MARIA.firstName, JORGE.firstName]);
      expect.soft(cards[0].primaryTag, 'first card tagged as main').toBe(true);
      expect.soft(cards[1].primaryTag, 'second card not tagged').toBe(false);
      expect.soft(cards[0].deleteEnabled, 'the main contact cannot be deleted').toBe(false);
      expect.soft(cards[1].canMakePrimary, 'the other contact offers "Make primary contact"').toBe(true);
      // When the customer tops up, Then the documents name María
      await documentsName(fx, db, acct, 'MCTWO', MARIA);
    } finally {
      await db.disconnect();
    }
  });

  test('the clerk changes the main contact and deletes the former one in the same save', { tag: ['@tc-03'] }, async ({
    page, testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage, selfcareTopupPage,
  }) => {
    test.setTimeout(600_000);
    const fx = { page, testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage, selfcareTopupPage };
    const db = new DbHelper(testLogger);
    await db.connect();
    try {
      // Given María (main) and Pedro
      const acct = await createAccountWithContacts(`QA316-MC-${RUN}-CHG`, [MARIA, PEDRO]);
      await openContactTab(page, acct);
      // When the clerk marks Pedro as main, deletes María, and saves
      await makePrimary(page, PEDRO.firstName);
      const afterMark = await readContactCards(page);
      expect.soft(afterMark.find(c => c.firstName === MARIA.firstName)?.deleteEnabled, 'former main can be deleted once another is marked').toBe(true);
      await deleteContactCard(page, MARIA.firstName);
      const toast = await saveContacts(page);
      await page.screenshot({ path: path.join(ARTIFACTS, `${acct}-after-change.png`), fullPage: true });
      // Then only Pedro is left, tagged main
      await openContactTab(page, acct);
      const cards = await readContactCards(page);
      testLogger.data('After the change', { acct, toast, cards, contacts: await contactsOf(db, acct) });
      expect(cards.map(c => c.firstName), 'María deleted, Pedro kept').toEqual([PEDRO.firstName]);
      expect.soft(cards[0].primaryTag, 'Pedro is tagged as main').toBe(true);
      // And the next receipt and e-mail name Pedro
      await documentsName(fx, db, acct, 'MCCHG', PEDRO);
    } finally {
      await db.disconnect();
    }
  });

  test('the clerk marks another contact as main, Modify pressed twice quickly', { tag: ['@tc-03'] }, async ({
    page, testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage, selfcareTopupPage,
  }) => {
    test.setTimeout(600_000);
    const fx = { page, testLogger, selfcareLoginPage, selfcareAccountSearchPage, selfcareActivityPage, selfcareTopupPage };
    const db = new DbHelper(testLogger);
    await db.connect();
    try {
      // Given María (main) and Jorge
      const acct = await createAccountWithContacts(`QA316-MC-${RUN}-MRK`, [MARIA, JORGE]);
      await openContactTab(page, acct);
      // When the clerk marks Jorge as main and presses Modify twice quickly
      await makePrimary(page, JORGE.firstName);
      const toast = await saveContacts(page, { twice: true });
      // Then both contacts are still there (saved once), Jorge first and tagged
      await openContactTab(page, acct);
      const cards = await readContactCards(page);
      const contacts = await contactsOf(db, acct);
      testLogger.data('After marking Jorge', { acct, toast, cards, contacts });
      expect(contacts.length, 'still two contacts (the double save applied once)').toBe(2);
      expect(cards.map(c => c.firstName), 'Jorge listed first now').toEqual([JORGE.firstName, MARIA.firstName]);
      expect.soft(cards[0].primaryTag, 'Jorge tagged as main').toBe(true);
      expect.soft(cards[1].primaryTag, 'María no longer tagged').toBe(false);
      // And the documents name Jorge
      await documentsName(fx, db, acct, 'MCMRK', JORGE);
    } finally {
      await db.disconnect();
    }
  });
});
