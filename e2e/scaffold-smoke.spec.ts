import { test, expect } from '@playwright/test';

test('demo storybook renders a story and the Greenroom Review panel', async ({ page }) => {
  await page.goto('/?path=/story/components-button--primary');

  const preview = page.frameLocator('#storybook-preview-iframe');
  await expect(preview.getByRole('button', { name: 'Save changes' })).toBeVisible();

  const reviewTab = page.getByRole('tab', { name: 'Review' });
  await expect(reviewTab).toBeVisible();
  await reviewTab.click();
  await expect(
    page.getByText('Greenroom review panel — threads and per-story status land here.'),
  ).toBeVisible();

  await page.screenshot({ path: 'e2e/.artifacts/scaffold-smoke.png', fullPage: true });
});
