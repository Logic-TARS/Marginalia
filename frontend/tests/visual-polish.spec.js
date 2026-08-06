import { test, expect } from '@playwright/test';

const book = {
  id: 'visual-book',
  title: '在安静的书斋里阅读一段很长的中文书名',
  author: '边注者',
  filename: 'visual-book.epub',
  original_filename: 'visual-book.epub',
  content_hash: 'visual-polish-hash',
  knowledge_book_id: 'visual-knowledge',
  knowledge_status: 'ready',
  knowledge_error: '',
  state_revision: 0,
};

async function mockShellApi(page) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/books' && request.method() === 'GET') {
      await route.fulfill({ json: { books: [book] } });
      return;
    }
    if (pathname === `/api/books/${book.id}/sync`) {
      await route.fulfill({ json: {
        book_id: book.id,
        revision: 0,
        progress: null,
        bookmarks: [],
        highlights: [],
      } });
      return;
    }
    if (pathname === '/api/drafts') {
      await route.fulfill({ json: { drafts: [], count: 0 } });
      return;
    }
    if (pathname === '/api/tts/voices') {
      await route.fulfill({ json: { enabled: false, voices: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { detail: 'not mocked' } });
  });
}

async function expectNoHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(metrics.root).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport + 1);
}

test.describe('visual polish structure', () => {
  test.use({ serviceWorkers: 'block' });

  test('keeps the polished library and studio structured across target widths', async ({ page }) => {
    await mockShellApi(page);
    for (const width of [360, 390, 768, 1000, 1440]) {
      await page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
      await page.goto('/index.html');
      await expect(page.locator('.book-card')).toHaveCount(1);
      await expect(page.locator('.book-card-cover-initial')).toHaveText('在');
      await expect(page.locator('.book-source-badge')).toHaveText('云端书库');
      await expect(page.locator('.book-ai-badge')).toHaveAttribute('data-state', 'ready');
      await expect(page.locator('.book-card-progress')).toHaveAttribute('role', 'progressbar');
      await expectNoHorizontalOverflow(page);

      const card = page.locator('.book-card');
      await expect(card).toHaveAttribute('role', 'button');
      await expect(card).toHaveAttribute('tabindex', '0');
      const cover = await page.locator('.book-card-cover').boundingBox();
      expect(cover).not.toBeNull();
      expect(cover.height).toBeGreaterThan(80);

      await page.locator('#btn-library-create').click();
      await expect(page.locator('#creation-view')).toHaveClass(/active/);
      await expect(page.locator('.creation-step')).toHaveCount(4);
      await expect(page.locator('.workspace-pane')).toHaveCount(3);
      await expectNoHorizontalOverflow(page);
      const panes = await page.locator('.workspace-pane').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { left: rect.left, right: rect.right, radius: parseFloat(style.borderRadius) };
      }));
      for (const pane of panes) {
        expect(pane.left).toBeGreaterThanOrEqual(0);
        expect(pane.right).toBeLessThanOrEqual(width + 1);
        expect(pane.radius).toBeGreaterThanOrEqual(8);
      }
    }
  });
});
