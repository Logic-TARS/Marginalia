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

const material = {
  id: 'visual-highlight',
  book_id: book.id,
  book_title: '一本用于验证创作工作台素材书名能够自然换行而不会挤进复选框窄列的超长中文书名',
  chapter: '关于文字布局与长内容呈现的章节',
  cfi: 'epubcfi(/6/4!/4/2/2)',
  highlight_text: '第一段摘录需要保留原始换行，并在内容列中自然折行。\n\n第二段包含无空格长英文串ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ。',
  note: '这是一段很长的个人感悟，用来确认创作工作台不会把文字挤进二十六像素的复选框列，而是能够在真正的内容列里连续自然地换行并完整显示。\n下一段感悟也应保留换行。',
  tags: ['这是一个用于验证标签自动换行能力的超长中文标签', 'UnbrokenTagABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  progress_percent: 67,
  status: 'raw',
  synced: false,
};

async function seedMaterial(page) {
  await page.evaluate(item => new Promise((resolve, reject) => {
    const request = indexedDB.open('marginalia', 5);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('highlights', 'readwrite');
      transaction.objectStore('highlights').put(item);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  }), material);
}

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
      await seedMaterial(page);
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
      const materialCard = page.locator('.material-card');
      await expect(materialCard).toHaveCount(1);
      await expect(materialCard.locator('.material-check span')).toHaveText(material.book_title);
      const materialLayout = await materialCard.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const checkboxRect = element.querySelector('input').getBoundingClientRect();
        const content = [
          element.querySelector('.material-check span'),
          element.querySelector('.material-quote'),
          element.querySelector('.material-note'),
          element.querySelector('.note-item-tags'),
          element.querySelector('.note-item-meta'),
        ].map(child => {
          const childRect = child.getBoundingClientRect();
          return {
            left: childRect.left,
            right: childRect.right,
            clientWidth: child.clientWidth,
            scrollWidth: child.scrollWidth,
          };
        });
        return {
          left: rect.left,
          right: rect.right,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          checkboxRight: checkboxRect.right,
          content,
        };
      });
      const [bookTitle, ...materialContent] = materialLayout.content;
      expect(bookTitle.right - bookTitle.left).toBeGreaterThan(26);
      expect(bookTitle.left).toBeGreaterThan(materialLayout.checkboxRight);
      for (const item of materialContent) {
        expect(item.left).toBeGreaterThanOrEqual(bookTitle.left - 1);
      }
      for (const item of materialLayout.content) {
        expect(item.right).toBeLessThanOrEqual(materialLayout.right + 1);
        expect(item.scrollWidth).toBeLessThanOrEqual(item.clientWidth + 1);
      }
      expect(materialLayout.scrollWidth).toBeLessThanOrEqual(materialLayout.clientWidth + 1);

      await materialCard.locator('.material-quote').click();
      await expect(page.locator('#selected-material-detail')).toContainText(material.chapter);
      const detailOverflow = await page.locator('#selected-material-detail').evaluate(element => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        blockquoteWhiteSpace: getComputedStyle(element.querySelector('blockquote')).whiteSpace,
      }));
      expect(detailOverflow.scrollWidth).toBeLessThanOrEqual(detailOverflow.clientWidth + 1);
      expect(detailOverflow.blockquoteWhiteSpace).toBe('pre-wrap');

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
