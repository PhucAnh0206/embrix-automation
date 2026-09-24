import { test } from '@playwright/test';
test.setTimeout(600_000);
test('measure Core UI load cost', async ({ page }) => {
  let bytes = 0, reqs = 0;
  page.on('response', async (r) => {
    reqs++;
    const l = r.headers()['content-length'];
    if (l) bytes += Number(l);
  });
  const url = process.env.EMBRIX_BASE_URL ?? '/';
  let t = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 300_000 });
  console.log(`PROBE domcontentloaded: ${((Date.now()-t)/1000).toFixed(1)}s`);
  t = Date.now();
  await page.waitForLoadState('load', { timeout: 300_000 }).catch(() => console.log('PROBE load: TIMED OUT'));
  console.log(`PROBE load (after dcl): ${((Date.now()-t)/1000).toFixed(1)}s`);
  t = Date.now();
  await page.waitForLoadState('networkidle', { timeout: 300_000 }).catch(() => console.log('PROBE networkidle: TIMED OUT'));
  console.log(`PROBE networkidle (after load): ${((Date.now()-t)/1000).toFixed(1)}s`);
  console.log(`PROBE responses=${reqs} declared-bytes=${(bytes/1024/1024).toFixed(1)}MB`);
});
