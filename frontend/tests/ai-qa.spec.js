import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'multichapter.epub');

function canonicalBook(id, knowledgeId) {
  return {
    id,
    title: 'Multichapter Test Fixture',
    author: 'Test Fixture Generator',
    filename: `${id}.epub`,
    original_filename: 'multichapter.epub',
    content_hash: `${id}-hash`,
    knowledge_book_id: knowledgeId,
    knowledge_status: 'ready',
    knowledge_error: '',
  };
}

async function seedLibrary(page, { book, highlights = [], bookmarks = [] }) {
  await page.evaluate(({ book, highlights, bookmarks }) => new Promise((resolve, reject) => {
    const request = indexedDB.open('marginalia', 5);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(['books', 'highlights', 'bookmarks'], 'readwrite');
      transaction.objectStore('books').put(book);
      highlights.forEach(item => transaction.objectStore('highlights').put(item));
      bookmarks.forEach(item => transaction.objectStore('bookmarks').put(item));
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  }), { book, highlights, bookmarks });
}

test.describe('AI book Q&A', () => {
  test.use({ serviceWorkers: 'block' });

  test('auto-indexes, streams a grounded answer, persists the session and jumps to a citation', async ({ page }) => {
    test.setTimeout(60_000);
    let conversations = [];
    let messages = [];

    await page.route('**/api/books', async route => {
      await route.fulfill({ json: { books: [] } });
    });
    await page.route('**/api/books/upload', route => route.fulfill({
      status: 202,
      json: { created: true, book: canonicalBook('server-book-1', 'book-1') },
    }));

    await page.route('**/api/knowledge/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const pathname = url.pathname;
      const method = request.method();

      if (pathname === '/api/knowledge/books/upload' && method === 'POST') {
        await route.fulfill({
          status: 202,
          json: {
            id: 'book-1',
            title: 'multichapter',
            status: 'ready',
            error_message: '',
          },
        });
        return;
      }
      if (pathname === '/api/knowledge/books/book-1' && method === 'GET') {
        await route.fulfill({
          json: {
            id: 'book-1',
            title: 'multichapter',
            status: 'ready',
            error_message: '',
          },
        });
        return;
      }
      if (pathname === '/api/knowledge/books/book-1/conversations' && method === 'GET') {
        await route.fulfill({ json: { conversations, count: conversations.length } });
        return;
      }
      if (pathname === '/api/knowledge/books/book-1/conversations' && method === 'POST') {
        const conversation = {
          id: 'conversation-1',
          book_id: 'book-1',
          title: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        conversations = [conversation];
        await route.fulfill({ status: 201, json: conversation });
        return;
      }
      if (pathname === '/api/knowledge/conversations/conversation-1/messages' && method === 'GET') {
        await route.fulfill({ json: { messages, count: messages.length } });
        return;
      }
      if (pathname.endsWith('/messages/stream') && method === 'POST') {
        const citation = {
          label: 'B1',
          source_type: 'book',
          source_id: 'chunk-2',
          chapter: 'Chapter 2',
          href: 'chapter-2.xhtml',
          cfi: '',
          quote: 'Chapter 2',
          anchor_text: 'Chapter 2',
        };
        messages = [
          {
            id: 'user-1',
            role: 'user',
            content: '第二章是什么？',
            status: 'completed',
            citations: [],
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '第二章讨论了测试内容。[B1]',
            status: 'completed',
            citations: [citation],
          },
        ];
        conversations = [{ ...conversations[0], title: '第二章是什么？' }];
        const body = [
          'event: start\ndata: {"user_message_id":"user-1","assistant_message_id":"assistant-1"}\n\n',
          'event: delta\ndata: {"text":"第二章讨论了测试内容。"}\n\n',
          'event: delta\ndata: {"text":"[B1]"}\n\n',
          `event: citations\ndata: ${JSON.stringify({ items: [citation] })}\n\n`,
          `event: done\ndata: ${JSON.stringify({ assistant_message: messages[1] })}\n\n`,
        ].join('');
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body,
        });
        return;
      }

      await route.fulfill({ status: 404, json: { detail: 'not mocked' } });
    });

    await page.goto('/index.html');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('#toolbar-book-title')).toContainText(/multichapter/i, {
      timeout: 20_000,
    });
    await expect(page.locator('#ai-index-status')).toContainText('索引已就绪', {
      timeout: 10_000,
    });

    await page.click('#btn-reader-tools');
    await page.click('#btn-toggle-ai');
    await page.fill('#ai-question-input', '第二章是什么？');
    await page.click('#btn-send-ai');

    await expect(page.locator('.ai-message.assistant')).toContainText('第二章讨论了测试内容');
    const citationButton = page.locator('.ai-citation');
    await expect(citationButton).toContainText('Chapter 2');
    await expect(page.locator('#ai-conversation-select')).toContainText('第二章是什么？');

    await citationButton.click();
    await expect(page.locator('#toolbar-chapter')).toContainText('Chapter 2', {
      timeout: 10_000,
    });
  });

  test('offers an explicit backend cleanup choice when deleting an indexed book', async ({ page }) => {
    let backendDeletes = 0;
    await page.route('**/api/books', route => route.fulfill({ json: { books: [] } }));
    await page.route('**/api/books/upload', route => route.fulfill({
      status: 202,
      json: { created: true, book: canonicalBook('server-book-delete', 'book-delete') },
    }));
    await page.route('**/api/books/server-book-delete', route => {
      backendDeletes += 1;
      return route.fulfill({ json: { deleted: true, id: 'server-book-delete' } });
    });
    await page.route('**/api/knowledge/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/knowledge/books/upload') {
        await route.fulfill({ status: 202, json: { id: 'book-delete', status: 'ready' } });
      } else if (pathname === '/api/knowledge/books/book-delete' && request.method() === 'GET') {
        await route.fulfill({ json: { id: 'book-delete', status: 'ready' } });
      } else if (pathname === '/api/knowledge/books/book-delete' && request.method() === 'DELETE') {
        backendDeletes += 1;
        await route.fulfill({ json: { deleted: true, id: 'book-delete' } });
      } else if (pathname.endsWith('/conversations')) {
        await route.fulfill({ json: { conversations: [], count: 0 } });
      } else {
        await route.fulfill({ status: 404, json: { detail: 'not mocked' } });
      }
    });

    await page.goto('/index.html');
    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('#ai-index-status')).toContainText('索引已就绪');
    await page.click('#btn-back');
    await page.click('.book-card-delete');
    await expect(page.locator('#book-delete-modal')).toBeVisible();
    await page.click('#btn-delete-all-book-data');
    await expect(page.locator('.book-card')).toHaveCount(0);
    expect(backendDeletes).toBe(1);
  });

  test('re-imports a missing server EPUB in place and preserves local reading data', async ({ page }) => {
    test.setTimeout(60_000);
    let uploads = 0;
    let fromServerRequests = 0;

    await page.route('**/api/books', route => route.fulfill({ json: { books: [] } }));
    await page.route('**/api/books/upload', route => {
      uploads += 1;
      return route.fulfill({
        status: 202,
        json: {
          created: true,
          book: canonicalBook('recovered-server', 'recovered-knowledge'),
        },
      });
    });
    const serverState = {
      book_id: 'recovered-server',
      revision: 0,
      progress: null,
      bookmarks: [],
      highlights: [],
    };
    await page.route('**/api/books/recovered-server/sync', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        for (const operation of body.operations || []) {
          serverState.revision += 1;
          if (operation.type === 'progress.set') {
            serverState.progress = {
              cfi: operation.payload.cfi || '',
              progress_percent: operation.payload.progress_percent || 0,
              last_opened: operation.payload.last_opened || 0,
            };
          } else if (operation.type === 'bookmark.upsert') {
            serverState.bookmarks.push({
              id: operation.entity_id,
              ...operation.payload,
            });
          } else if (operation.type === 'highlight.upsert') {
            serverState.highlights.push({
              id: `server-${operation.entity_id}`,
              client_id: operation.entity_id,
              ...operation.payload,
            });
          }
        }
      }
      await route.fulfill({ json: serverState });
    });
    await page.route('**/api/knowledge/**', async route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/knowledge/books/from-server') {
        fromServerRequests += 1;
        await route.fulfill({
          status: 404,
          json: { detail: { code: 'book_not_found', message: 'Book not found' } },
        });
      } else if (pathname === '/api/knowledge/books/recovered-knowledge') {
        await route.fulfill({
          json: { id: 'recovered-knowledge', status: 'ready', error_message: '' },
        });
      } else if (pathname.endsWith('/conversations')) {
        await route.fulfill({ json: { conversations: [], count: 0 } });
      } else {
        await route.fulfill({ status: 404, json: { detail: 'not mocked' } });
      }
    });

    await page.goto('/index.html');
    await seedLibrary(page, {
      book: {
        id: 'stale-local-book',
        book_title: 'Multichapter Test Fixture',
        book_author: 'Test Fixture Generator',
        filename: 'missing.epub',
        file_blob: null,
        imported_at: 1,
        last_opened: 2,
        progress_percent: 42,
        last_cfi: 'epubcfi(/6/4!/4/2/2)',
        knowledge_book_id: 'missing-knowledge',
        knowledge_status: 'failed',
        knowledge_error: 'Book not found',
      },
      highlights: [{
        id: 'kept-highlight',
        book_id: 'stale-local-book',
        book_title: 'Multichapter Test Fixture',
        highlight_text: 'Keep this quote',
        note: 'Keep this note',
        tags: ['kept'],
        synced: false,
      }],
      bookmarks: [{
        id: 'kept-bookmark',
        book_id: 'stale-local-book',
        cfi: 'epubcfi(/6/4!/4/2/2)',
        chapter: 'Chapter 1',
      }],
    });
    await page.reload();

    await page.setInputFiles('#file-input', FIXTURE);
    await expect(page.locator('#ai-index-status')).toContainText('索引已就绪', {
      timeout: 20_000,
    });

    const restored = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('marginalia', 5);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['books', 'highlights', 'bookmarks'], 'readonly');
        const bookRequest = transaction.objectStore('books').get('recovered-server');
        const highlightsRequest = transaction.objectStore('highlights').getAll();
        const bookmarksRequest = transaction.objectStore('bookmarks').getAll();
        transaction.oncomplete = () => resolve({
          book: {
            id: bookRequest.result.id,
            progress_percent: bookRequest.result.progress_percent,
            last_cfi: bookRequest.result.last_cfi,
            knowledge_book_id: bookRequest.result.knowledge_book_id,
            knowledge_status: bookRequest.result.knowledge_status,
            file_blob_bytes: bookRequest.result.file_blob.byteLength,
          },
          highlights: highlightsRequest.result,
          bookmarks: bookmarksRequest.result,
        });
        transaction.onerror = () => reject(transaction.error);
      };
    }));

    expect(restored.book).toMatchObject({
      id: 'recovered-server',
      progress_percent: 42,
      last_cfi: 'epubcfi(/6/4!/4/2/2)',
      knowledge_book_id: 'recovered-knowledge',
      knowledge_status: 'ready',
    });
    expect(restored.book.file_blob_bytes).toBeGreaterThan(0);
    expect(restored.highlights).toHaveLength(1);
    expect(restored.highlights[0].book_id).toBe('recovered-server');
    expect(restored.highlights[0].note).toBe('Keep this note');
    expect(restored.bookmarks).toHaveLength(1);
    expect(restored.bookmarks[0].book_id).toBe('recovered-server');
    expect(uploads).toBe(1);
    expect(fromServerRequests).toBe(0);
  });

  test('turns a missing knowledge record into a clear re-import prompt', async ({ page }) => {
    await page.route('**/api/books', route => route.fulfill({ json: { books: [] } }));
    await page.route('**/api/knowledge/**', route => route.fulfill({
      status: 404,
      json: { detail: 'Book not found' },
    }));
    await page.route('**/api/books/missing.epub', route => route.fulfill({ status: 404 }));

    await page.goto('/index.html');
    await seedLibrary(page, {
      book: {
        id: 'missing-source-book',
        book_title: 'Missing Source',
        book_author: 'Tester',
        filename: 'missing.epub',
        file_blob: null,
        imported_at: 1,
        last_opened: 2,
        progress_percent: 20,
        knowledge_book_id: 'missing-knowledge',
        knowledge_status: 'ready',
        knowledge_error: '',
      },
    });
    await page.reload();
    await page.click('.book-card');

    await expect(page.locator('#ai-index-status')).toContainText(
      '源文件已不在服务器，请重新导入原 EPUB'
    );
    await page.click('#btn-reader-tools');
    await page.click('#btn-toggle-ai');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.click('#btn-retry-ai-index');
    const chooser = await chooserPromise;
    expect(chooser).toBeTruthy();
  });
});
