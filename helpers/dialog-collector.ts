import { Dialog, Page } from '@playwright/test';

/**
 * DialogCollector — makes the app's native dialogs visible to automation.
 *
 * THE PROBLEM IT SOLVES. Playwright auto-dismisses `alert()`, `confirm()` and
 * `prompt()` only while NO listener is attached to the page. Until now no test in
 * this repo attached one, so every native validation message the app raises was
 * discarded before any test could see it. Two consequences:
 *
 *   1. A message the app shows the user cannot be asserted.
 *   2. Worse — a test can pass THROUGH a blocked action. The click raises a
 *      dialog, Playwright dismisses it, the action never happens, and the test
 *      carries on and passes. That is exactly how Selfcare's "Missing saved card
 *      token. Please add a card first." warning was misread as a silent failure.
 *
 * THE BEHAVIOUR CONTRACT. Attaching a listener turns the auto-dismiss off, so
 * this collector MUST settle every dialog itself — and it defaults to
 * `dismiss()`, which is precisely what Playwright's auto-handler did. For
 * `confirm()` that means Cancel, same as before. So no existing test changes
 * behaviour: the only difference is that the message is now recorded.
 *
 * ONE LISTENER PER PAGE. Playwright fires listeners in registration order, and a
 * second `accept()`/`dismiss()` on an already-settled dialog throws. Since the
 * `page` fixture registers this collector first, a test that attached its own
 * handler would find the dialog already gone and throw. So tests must NOT attach
 * their own — use `acceptNext()` when a dialog needs accepting instead.
 */

export interface DialogRecord {
  /** 'alert' | 'confirm' | 'prompt' | 'beforeunload' */
  type: string;
  message: string;
  /** What the collector did with it. */
  action: 'accept' | 'dismiss';
}

export class DialogCollector {
  readonly records: DialogRecord[] = [];

  /**
   * Queued one-shot actions. Empty means dismiss, which is the pre-existing
   * default — never change that, or currently-green tests silently start
   * confirming actions they used to cancel.
   */
  private queued: Array<'accept' | 'dismiss'> = [];

  /**
   * Accept (OK) the next `count` dialogs instead of dismissing them.
   *
   * Call it BEFORE the click that raises the dialog — dialogs are handled
   * synchronously by the browser and there is no chance to react afterwards.
   */
  acceptNext(count = 1): void {
    for (let i = 0; i < count; i++) this.queued.push('accept');
  }

  /** Messages seen so far, oldest first. */
  get messages(): string[] {
    return this.records.map((r) => r.message);
  }

  /** Did any dialog message match? Substring (case-insensitive) or regex. */
  sawMessage(match: string | RegExp): boolean {
    return this.find(match) !== undefined;
  }

  /** First matching message, or undefined. Substring or regex. */
  find(match: string | RegExp): string | undefined {
    return this.records.find((r) =>
      typeof match === 'string'
        ? r.message.toLowerCase().includes(match.toLowerCase())
        : match.test(r.message),
    )?.message;
  }

  /** Forget everything — useful between test steps that each expect a dialog. */
  reset(): void {
    this.records.length = 0;
    this.queued.length = 0;
  }

  /** Wired to `page.on('dialog')` by the `page` fixture. */
  async handle(dialog: Dialog): Promise<void> {
    const action = this.queued.shift() ?? 'dismiss';
    const message = dialog.message();
    this.records.push({ type: dialog.type(), message, action });
    console.log(`[dialog] ${dialog.type()}: "${message}" -> ${action}`);
    // Swallow failures: a dialog on a page that is already closing cannot be
    // settled, and throwing here would surface as an unhandled rejection inside
    // an event handler rather than as a useful test failure.
    try {
      await (action === 'accept' ? dialog.accept() : dialog.dismiss());
    } catch {
      /* page gone — nothing to settle */
    }
  }
}

/**
 * Page -> collector, so the `dialogs` fixture can hand back the same instance
 * the `page` fixture attached. A WeakMap rather than a property on Page keeps
 * the Page type clean and lets the entry be collected with the page.
 */
const collectors = new WeakMap<Page, DialogCollector>();

/**
 * Attach the collector to a page. Idempotent — calling twice returns the
 * existing collector rather than adding a second listener, which would
 * double-settle every dialog.
 */
export function attachDialogCollector(page: Page): DialogCollector {
  const existing = collectors.get(page);
  if (existing) return existing;

  const collector = new DialogCollector();
  collectors.set(page, collector);
  // Not awaited: Playwright's 'dialog' event is not awaited by the emitter, and
  // handle() settles the dialog itself.
  page.on('dialog', (d) => void collector.handle(d));
  return collector;
}

/** The collector for a page, creating and attaching one if needed. */
export function getDialogCollector(page: Page): DialogCollector {
  return collectors.get(page) ?? attachDialogCollector(page);
}
