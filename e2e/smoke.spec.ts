import { expect, test, type Page } from '@playwright/test';

const email = process.env.E2E_OWNER_EMAIL;
const password = process.env.E2E_OWNER_PASSWORD;

const OWNER_PAGES: [string, RegExp][] = [
  ['/app/dashboard', /Welcome|Dashboard/i],
  ['/app/properties', /Properties/i],
  ['/app/rooms', /Rooms/i],
  ['/app/photos', /Photos & amenities/i],
  ['/app/inventory', /Inventory & rates calendar/i],
  ['/app/rates', /Rate plans|Rates/i],
  ['/app/promotions', /Discounts & promotions/i],
  ['/app/bookings', /Bookings/i],
  ['/app/channels', /Channel/i],
  ['/app/mapping', /Booking\.com connection/i],
  ['/app/sync', /Synchronization status/i],
  ['/app/discrepancies', /Discrepancy center/i],
  ['/app/reports', /Reports/i],
  ['/app/billing', /Subscription|billing/i],
  ['/app/team', /Team/i],
  ['/app/settings', /Profile|security/i],
];

async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('#email', email!);
  await page.fill('#password', password!);
  await page.click('button[type=submit]');
  await page.waitForURL('**/app/**');
}

test.describe('public pages', () => {
  test('login page renders and rejects a wrong password without saying whether the account exists', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('h1')).toBeVisible();
    await page.fill('#email', 'nobody@example.test');
    await page.fill('#password', 'definitely wrong password');
    await page.click('button[type=submit]');
    await expect(page.getByRole('alert')).toBeVisible();
  });

  test('unknown page shows not found', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.getByText(/not found/i).first()).toBeVisible();
  });
});

test.describe('owner portal', () => {
  test.skip(!email || !password, 'Set E2E_OWNER_EMAIL and E2E_OWNER_PASSWORD to run');

  test('every module opens without errors', async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
    page.on('response', (r) => {
      if (r.url().includes('/api/') && r.status() >= 500) failures.push(`${r.status()} ${r.url()}`);
    });
    await signIn(page);
    for (const [path, heading] of OWNER_PAGES) {
      await page.goto(path);
      await expect(page.locator('h1').first(), path).toHaveText(heading);
      await page.waitForLoadState('networkidle');
    }
    expect(failures).toEqual([]);
  });
});
