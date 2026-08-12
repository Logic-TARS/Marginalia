import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceWorkerSource = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

test.describe('service worker cache policy', () => {
  test('keeps EPUB files in a stable cache across app-shell upgrades', () => {
    expect(serviceWorkerSource).toContain("const APP_CACHE_NAME = 'marginalia-app-v34'");
    expect(serviceWorkerSource).toContain("'app.js?v=33'");
    expect(serviceWorkerSource).toContain("'style.css?v=31'");
    expect(serviceWorkerSource).toContain("const EPUB_CACHE_NAME = 'marginalia-epub-v1'");
    expect(serviceWorkerSource).toContain('migrateLegacyEpubEntries');
    expect(serviceWorkerSource).toContain('cacheFirst(event.request, EPUB_CACHE_NAME, true)');
    expect(serviceWorkerSource).not.toMatch(/key\s*!==\s*APP_CACHE_NAME\)\.map\(.*caches\.delete/);
  });
});
