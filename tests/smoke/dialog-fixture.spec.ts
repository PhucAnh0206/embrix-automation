import { test, expect } from '../../fixtures/page-factory';

/**
 * Guards the native-dialog contract in the shared `page` fixture.
 *
 * WHY THIS EXISTS. Attaching a `dialog` listener disables Playwright's
 * auto-dismiss, so the collector has to settle every dialog itself. If it ever
 * stopped dismissing by default, every `confirm()` in the ~90-test suite would
 * silently flip from Cancel to OK — tests would start confirming destructive
 * actions they used to cancel, and nothing would look broken until data went
 * missing. This test pins that default.
 *
 * Runs against `about:blank` with injected markup, so it needs no app, no auth
 * and no environment. It belongs in the smoke project for exactly that reason.
 */

const MARKUP = `
  <button id="fire-alert"
    onclick="window.alert('Missing saved card token. Please add a card first.')">alert</button>
  <button id="fire-confirm"
    onclick="document.getElementById('out').textContent = String(window.confirm('Delete this card?'))">confirm</button>
  <div id="out">none</div>
`;

test.describe('shared page fixture — native dialog capture', () => {
  test('records alert() messages and still dismisses them', async ({ page, dialogs }) => {
    await page.goto('about:blank');
    await page.setContent(MARKUP);

    await page.click('#fire-alert');

    expect(dialogs.records).toHaveLength(1);
    expect(dialogs.records[0].type).toBe('alert');
    expect(dialogs.records[0].action).toBe('dismiss');
    expect(dialogs.sawMessage('missing saved card token')).toBe(true);
    expect(dialogs.sawMessage(/add a card first/i)).toBe(true);
    expect(dialogs.find('please add a card')).toContain('Missing saved card token');
  });

  test('confirm() defaults to Cancel — the pre-collector behaviour', async ({ page, dialogs }) => {
    await page.goto('about:blank');
    await page.setContent(MARKUP);

    await page.click('#fire-confirm');

    // false = Cancel. This is the load-bearing assertion: Playwright's own
    // auto-handler dismissed, so anything else here is a silent behaviour change
    // across every existing test.
    await expect(page.locator('#out')).toHaveText('false');
    expect(dialogs.records[0].action).toBe('dismiss');
  });

  test('acceptNext() opts a single dialog into OK', async ({ page, dialogs }) => {
    await page.goto('about:blank');
    await page.setContent(MARKUP);

    dialogs.acceptNext();
    await page.click('#fire-confirm');
    await expect(page.locator('#out')).toHaveText('true');

    // One-shot only — the next one falls back to dismiss.
    await page.click('#fire-confirm');
    await expect(page.locator('#out')).toHaveText('false');

    expect(dialogs.records.map((r) => r.action)).toEqual(['accept', 'dismiss']);
  });

  test('reset() clears what was recorded', async ({ page, dialogs }) => {
    await page.goto('about:blank');
    await page.setContent(MARKUP);

    await page.click('#fire-alert');
    expect(dialogs.messages).toHaveLength(1);

    dialogs.reset();
    expect(dialogs.messages).toHaveLength(0);
  });
});
