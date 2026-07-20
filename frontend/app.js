/**
 * Marginalia — Core Application Logic
 * Handles: IndexedDB, epub.js reader, highlights, notes, sync, PWA
 */
(function () {
  'use strict';

  // ==================== CONSTANTS ====================
  const DB_NAME = 'marginalia';
  const DB_VERSION = 4;
  const API_BASE = '';  // same origin — works locally and remotely

  // ==================== STATE ====================
  let db = null;
  let currentBook = null;       // epub.js Book instance
  let currentRendition = null;  // epub.js Rendition instance
  let currentBookMeta = null;   // our DB book record
  let currentBookUrl = null;    // blob URL for current EPUB (for cleanup)
  let currentChapter = '';
  let currentCfi = '';
  let pendingSelection = null;  // { cfiRange, text } from last selection
  let selectedMaterialId = null;
  let selectedMaterialIds = new Set();
  let currentDraftId = null;
  let locationsReadyPromise = null;
  let locationsReadyBook = null;
  let progressJumpToken = 0;
  let layoutRefreshToken = 0;
  let isLayoutRefreshing = false;
  let pageNavigationInProgress = false;
  let pageNavigationToken = 0;
  const PAGE_NAVIGATION_COOLDOWN = 180;
  let wheelGestureTimer = null;
  let wheelAccumulatedDelta = 0;
  let wheelGestureLocked = false;
  let wheelFlipInProgress = false;
  let fontZoomLockUntil = 0;
  const WHEEL_DELTA_THRESHOLD = 60;
  const WHEEL_IDLE_MS = 420;
  let currentFontSize = 100;  // percentage, 100 = default
  const FONT_SIZE_STEP = 5;   // percent per scroll
  const FONT_SIZE_MIN = 60;
  const FONT_SIZE_MAX = 200;
  let searchResultsList = [];
  let searchHighlightKeys = [];
  let aiMessages = [];
  let aiRequestInFlight = false;

  // ==================== DOM REFS ====================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    app: $('#app'),
    libraryView: $('#library-view'),
    readerView: $('#reader-view'),
    readerMain: $('.reader-main'),
    bookList: $('#book-list'),
    emptyLibrary: $('#empty-library'),
    fileInput: $('#file-input'),
    epubContainer: $('#epub-container'),
    notesPanel: $('#notes-panel'),
    bookmarksList: $('#bookmarks-list'),
    bookmarksCount: $('#bookmarks-count'),
    notesList: $('#notes-list'),
    notesCount: $('#notes-count'),
    toolbarBookTitle: $('#toolbar-book-title'),
    toolbarChapter: $('#toolbar-chapter'),
    progressSlider: $('#progress-slider'),
    progressText: $('#progress-text'),
    pageText: $('#page-text'),
    btnBack: $('#btn-back'),
    btnToggleAi: $('#btn-toggle-ai'),
    btnCloseAi: $('#btn-close-ai'),
    aiPanel: $('#ai-panel'),
    aiMessages: $('#ai-messages'),
    aiForm: $('#ai-form'),
    aiQuestionInput: $('#ai-question-input'),
    btnSendAi: $('#btn-send-ai'),
    btnAddBookmark: $('#btn-add-bookmark'),
    btnToggleNotes: $('#btn-toggle-notes'),
    btnToggleSearch: $('#btn-toggle-search'),
    toolbarSearch: $('#toolbar-search'),
    searchInput: $('#search-input'),
    btnSearch: $('#btn-search'),
    btnSearchClose: $('#btn-search-close'),
    searchPanel: $('#search-panel'),
    searchResults: $('#search-results'),
    searchCount: $('#search-count'),
    btnSync: $('#btn-sync'),
    syncBadge: $('#sync-badge'),
    selectionToolbar: $('#selection-toolbar'),
    noteModal: $('#note-modal'),
    notePreviewText: $('#note-preview-text'),
    noteTextarea: $('#note-textarea'),
    tagInput: $('#tag-input'),
    btnSaveNote: $('#btn-save-note'),
    btnDeleteNote: $('#btn-delete-note'),
    btnCloseModal: $('#btn-close-modal'),
    toast: $('#toast'),
    btnNavPrev: $('#btn-nav-prev'),
    btnNavNext: $('#btn-nav-next'),
    readerLoading: $('#reader-loading'),
    readerLoadingMessage: $('#reader-loading-message'),
    readerLoadingDetail: $('#reader-loading-detail'),
    readerLoadingProgress: $('#reader-loading-progress'),
    readerLoadingProgressBar: $('#reader-loading-progress-bar'),
    readerLoadingProgressText: $('#reader-loading-progress-text'),
    btnNavLibrary: $('#btn-nav-library'),
    btnNavRead: $('#btn-nav-read'),
    btnNavCreate: $('#btn-nav-create'),
    btnLibraryCreate: $('#btn-library-create'),
    creationView: $('#creation-view'),
    btnRefreshMaterials: $('#btn-refresh-materials'),
    btnExportBook: $('#btn-export-book'),
    materialBookFilter: $('#material-book-filter'),
    materialTagFilter: $('#material-tag-filter'),
    materialsList: $('#materials-list'),
    selectedMaterialCount: $('#selected-material-count'),
    selectedMaterialDetail: $('#selected-material-detail'),
    reflectionEditor: $('#reflection-editor'),
    btnSaveReflection: $('#btn-save-reflection'),
    btnDeleteReflection: $('#btn-delete-reflection'),
    draftTopic: $('#draft-topic'),
    draftInstruction: $('#draft-instruction'),
    btnGenerateVideo: $('#btn-generate-video'),
    btnGenerateArticle: $('#btn-generate-article'),
    draftList: $('#draft-list'),
    draftEditor: $('#draft-editor'),
    draftTitleEditor: $('#draft-title-editor'),
    draftContentEditor: $('#draft-content-editor'),
    btnSaveDraft: $('#btn-save-draft'),
    btnExportDraft: $('#btn-export-draft'),
  };

  // ==================== INDEXEDDB ====================
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;

        // Books store
        if (!d.objectStoreNames.contains('books')) {
          const booksStore = d.createObjectStore('books', { keyPath: 'id' });
          booksStore.createIndex('by_title', 'book_title', { unique: false });
        }

        // Highlights store
        if (!d.objectStoreNames.contains('highlights')) {
          const hStore = d.createObjectStore('highlights', { keyPath: 'id' });
          hStore.createIndex('by_book', 'book_id', { unique: false });
          hStore.createIndex('by_synced', 'synced', { unique: false });
        }

        if (!d.objectStoreNames.contains('deleted_highlights')) {
          d.createObjectStore('deleted_highlights', { keyPath: 'id' });
        }

        if (!d.objectStoreNames.contains('bookmarks')) {
          const bStore = d.createObjectStore('bookmarks', { keyPath: 'id' });
          bStore.createIndex('by_book', 'book_id', { unique: false });
        }
      };
      req.onsuccess = (e) => {
        db = e.target.result;
        resolve(db);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbPut(storeName, obj) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.put(obj);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbHasStore(storeName) {
    return db && db.objectStoreNames && db.objectStoreNames.contains(storeName);
  }

  async function dbGetAllSafe(storeName) {
    if (!dbHasStore(storeName)) return [];
    return dbGetAll(storeName);
  }

  function dbGet(storeName, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbGetByIndex(storeName, indexName, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const req = index.getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  function dbDelete(storeName, id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // ==================== UUID ====================
  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
  }

  // ==================== TOAST ====================
  let toastTimer = null;
  function showToast(msg, type = 'info') {
    const t = dom.toast;
    t.textContent = msg;
    t.className = 'toast ' + type;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  function setReaderLoading(message, detail = '') {
    if (!dom.readerLoading) return;
    dom.readerLoadingMessage.textContent = message;
    dom.readerLoadingDetail.textContent = detail;
    dom.readerLoadingDetail.hidden = !detail;
    dom.readerLoading.hidden = false;
  }

  function hideReaderLoading() {
    if (!dom.readerLoading) return;
    dom.readerLoading.hidden = true;
  }

  function setLoadingProgress(percent) {
    if (!dom.readerLoadingProgress) return;
    const pct = Math.round(percent);
    dom.readerLoadingProgress.hidden = false;
    dom.readerLoadingProgressBar.style.width = pct + '%';
    dom.readerLoadingProgressText.textContent = pct + '%';
  }

  // ==================== VIEW SWITCHING ====================

  async function saveCurrentProgress() {
    if (!currentBookMeta || !currentCfi) return;
    currentBookMeta.last_cfi = currentCfi;
    await dbPut('books', currentBookMeta);
  }

  async function showLibrary() {
    // Flush progress to IndexedDB before clearing state
    await saveCurrentProgress();

    // Destroy epub.js resources BEFORE nulling references
    if (currentRendition) {
      try { currentRendition.destroy(); } catch (_e) { /* already destroyed */ }
      currentRendition = null;
    }
    if (currentBook) {
      try { currentBook.destroy(); } catch (_e) { /* already destroyed */ }
      currentBook = null;
    }

    // Clear the epub container iframe from DOM
    dom.epubContainer.innerHTML = '';
    dom.epubContainer.style.display = '';

    // Reset all reader state
    currentCfi = '';
    currentChapter = '';
    pendingSelection = null;
    selectedMaterialId = null;
    selectedMaterialIds.clear();
    currentDraftId = null;
    progressJumpToken = 0;
    _boundIframeDocument = null;
    locationsReadyPromise = null;
    locationsReadyBook = null;

    dom.libraryView.classList.add('active');
    dom.readerView.classList.remove('active');
    dom.creationView.classList.remove('active');
    setActiveNav('library');
    hideReaderLoading();
    hideSelectionToolbar();
    if (currentBookUrl) {
      URL.revokeObjectURL(currentBookUrl);
      currentBookUrl = null;
    }
    currentBookMeta = null;
    renderLibrary();
  }

  function showReader() {
    dom.libraryView.classList.remove('active');
    dom.readerView.classList.add('active');
    dom.creationView.classList.remove('active');
    setActiveNav('read');
  }

  async function showCreation() {
    dom.libraryView.classList.remove('active');
    dom.readerView.classList.remove('active');
    dom.creationView.classList.add('active');
    setActiveNav('create');
    await renderCreationWorkspace();
  }

  function setActiveNav(target) {
    dom.btnNavLibrary.classList.toggle('active', target === 'library');
    dom.btnNavRead.classList.toggle('active', target === 'read');
    dom.btnNavCreate.classList.toggle('active', target === 'create');
  }

  // ==================== LIBRARY ====================
  async function renderLibrary() {
    await mergeDuplicateBooks();

    // Fetch both local (IndexedDB) and server books
    const localBooks = await dbGetAll('books');
    const serverBooks = await fetchServerBooks(localBooks);
    const serverBookIds = new Set(serverBooks.map(book => book.id));
    const visibleLocalBooks = localBooks.filter(book => !serverBookIds.has(book.id));

    const allBooks = [...serverBooks, ...visibleLocalBooks];
    // Sort: server books first, then by last opened
    allBooks.sort((a, b) => {
      if (a._source !== b._source) return a._source === 'server' ? -1 : 1;
      return (b.last_opened || 0) - (a.last_opened || 0);
    });

    if (allBooks.length === 0) {
      dom.emptyLibrary.hidden = false;
      dom.bookList.querySelectorAll('.book-card').forEach(c => c.remove());
      return;
    }

    dom.emptyLibrary.hidden = true;
    dom.bookList.innerHTML = '';

    for (const book of allBooks) {
      const card = document.createElement('div');
      card.className = 'book-card';
      const isServer = book._source === 'server';
      card.dataset.bookId = book.id;
      if (isServer) card.dataset.serverBook = 'true';

      const highlightCount = await getBookHighlightCount(book.id);

      card.innerHTML = `
        <div class="book-card-cover">${isServer ? '📡' : '📖'}</div>
        <div class="book-card-info">
          <div class="book-card-title">${escapeHTML(book.book_title || '未命名书籍')}</div>
          <div class="book-card-author">${escapeHTML(book.book_author || '未知作者')}</div>
          <div class="book-card-meta">
            <span>✏️ ${highlightCount} 条划线</span>
            <span>${isServer ? '服务器' : formatRelativeDate(book.last_opened)}</span>
          </div>
          <div class="book-card-progress">
            <div class="book-card-progress-bar" style="width:${book.progress_percent || 0}%"></div>
          </div>
        </div>
        ${isServer ? '' : '<button class="book-card-delete" data-action="delete" title="删除">🗑</button>'}
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="delete"]')) return;
        openBook(book);
      });

      const deleteBtn = card.querySelector('.book-card-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`确定删除《${book.book_title}》及其所有划线笔记吗？`)) {
            await deleteBook(book.id);
            renderLibrary();
            showToast('已删除', 'info');
          }
        });
      }

      dom.bookList.appendChild(card);
    }
  }

  async function fetchServerBooks(existingBooks) {
    try {
      const resp = await fetch(API_BASE + '/api/books');
      if (!resp.ok) return [];
      const data = await resp.json();
      const existing = existingBooks || await dbGetAll('books');

      return (data.books || []).map(b => {
        // Find existing IndexedDB record for this server book (for progress tracking)
        const existingBook = existing.find(
          eb => eb.filename === b.filename && eb.file_blob === null
        );
        return {
          id: existingBook ? existingBook.id : uuid(),
          book_title: b.title,
          book_author: b.author,
          filename: b.filename,
          file_blob: null,  // server book — load from URL
          last_opened: existingBook ? existingBook.last_opened : 0,
          progress_percent: existingBook ? existingBook.progress_percent : 0,
          last_cfi: existingBook ? existingBook.last_cfi : '',
          imported_at: existingBook ? existingBook.imported_at : Date.now(),
          _source: 'server',
        };
      });
    } catch (e) {
      console.warn('Failed to fetch server books:', e);
      return [];
    }
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatRelativeDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    const days = Math.floor(diff / 86400000);
    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return `${days} 天前`;
    if (days < 30) return `${Math.floor(days / 7)} 周前`;
    return d.toLocaleDateString('zh-CN');
  }

  async function getBookHighlightCount(bookId) {
    const highlights = await dbGetByIndex('highlights', 'by_book', bookId);
    return highlights.length;
  }

  async function deleteBook(bookId) {
    // Delete book record
    await dbDelete('books', bookId);
    // Delete associated highlights
    const highlights = await dbGetByIndex('highlights', 'by_book', bookId);
    for (const h of highlights) {
      await queueHighlightDelete(h);
      await dbDelete('highlights', h.id);
    }
    if (dbHasStore('bookmarks')) {
      const bookmarks = await dbGetByIndex('bookmarks', 'by_book', bookId);
      for (const bookmark of bookmarks) {
        await dbDelete('bookmarks', bookmark.id);
      }
    }
  }

  function normalizeBookText(value) {
    return String(value || '')
      .replace(/\.epub$/i, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  function getBookDedupeKey(book) {
    if (book.filename && !book.file_blob) {
      return 'server:' + normalizeBookText(book.filename);
    }

    const title = normalizeBookText(book.book_title);
    const author = normalizeBookText(book.book_author);
    if (!title) return '';
    return author ? `local:${title}|${author}` : `local:${title}`;
  }

  async function mergeDuplicateBooks() {
    const books = await dbGetAll('books');
    const groups = new Map();

    for (const book of books) {
      const key = getBookDedupeKey(book);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(book);
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      await mergeBookGroup(group);
    }
  }

  async function mergeBookGroup(books) {
    const highlightCounts = new Map();
    for (const book of books) {
      highlightCounts.set(book.id, await getBookHighlightCount(book.id));
    }

    const main = [...books].sort((a, b) => {
      const aServer = a.filename && !a.file_blob ? 1 : 0;
      const bServer = b.filename && !b.file_blob ? 1 : 0;
      if (aServer !== bServer) return bServer - aServer;
      const openedDiff = (b.last_opened || 0) - (a.last_opened || 0);
      if (openedDiff !== 0) return openedDiff;
      return (highlightCounts.get(b.id) || 0) - (highlightCounts.get(a.id) || 0);
    })[0];

    const merged = { ...main };
    for (const book of books) {
      if ((book.last_opened || 0) > (merged.last_opened || 0)) {
        merged.last_opened = book.last_opened;
      }
      if ((book.imported_at || Infinity) < (merged.imported_at || Infinity)) {
        merged.imported_at = book.imported_at;
      }
      if ((book.progress_percent || 0) > (merged.progress_percent || 0)) {
        merged.progress_percent = book.progress_percent;
        if (book.last_cfi) merged.last_cfi = book.last_cfi;
      } else if (!merged.last_cfi && book.last_cfi) {
        merged.last_cfi = book.last_cfi;
      }
      if (!merged.book_title && book.book_title) merged.book_title = book.book_title;
      if (!merged.book_author && book.book_author) merged.book_author = book.book_author;
    }

    await dbPut('books', merged);

    for (const book of books) {
      if (book.id === main.id) continue;
      const highlights = await dbGetByIndex('highlights', 'by_book', book.id);
      for (const highlight of highlights) {
        await dbPut('highlights', {
          ...highlight,
          book_id: main.id,
          book_title: merged.book_title || highlight.book_title,
          book_author: merged.book_author || highlight.book_author,
        });
      }
      await dbDelete('books', book.id);
    }
  }

  // ==================== BOOK IMPORT ====================
  function handleFileImport(file) {
    if (!file || !file.name.endsWith('.epub')) {
      showToast('请选择 .epub 文件', 'error');
      return;
    }

    const reader = new FileReader();
    showReader();
    setReaderLoading('正在导入书籍...', '正在读取并解析 EPUB 文件');
    reader.onload = async (e) => {
      try {
        const blob = new Blob([e.target.result], { type: 'application/epub+zip' });
        const bookMeta = await extractBookMeta(blob);
        const candidate = {
          book_title: bookMeta.title || file.name.replace(/\.epub$/i, ''),
          book_author: bookMeta.author || '',
        };
        const candidateKey = getBookDedupeKey(candidate);
        const existingBooks = await dbGetAll('books');
        const existingBook = existingBooks.find(book => getBookDedupeKey(book) === candidateKey);

        if (existingBook) {
          existingBook.last_opened = Date.now();
          await dbPut('books', existingBook);
          await mergeDuplicateBooks();
          await renderLibrary();
          showToast(`《${existingBook.book_title}》已在书库中`, 'info');
          await openBook(existingBook);
          return;
        }

        const bookRecord = {
          id: uuid(),
          book_title: candidate.book_title,
          book_author: candidate.book_author,
          file_blob: e.target.result,
          imported_at: Date.now(),
          last_opened: Date.now(),
          progress_percent: 0,
        };

        await dbPut('books', bookRecord);
        await renderLibrary();
        showToast(`已导入《${bookRecord.book_title}》`, 'success');

        // Auto-open the book
        await openBook(bookRecord);
      } catch (err) {
        hideReaderLoading();
        console.error('Import failed:', err);
        showToast('导入失败，请检查 EPUB 文件', 'error');
      }
    };
    reader.onerror = () => {
      hideReaderLoading();
      showToast('读取文件失败', 'error');
    };
    reader.readAsArrayBuffer(file);
  }

  function extractBookMeta(blob) {
    return new Promise((resolve) => {
      const meta = { title: '', author: '' };
      try {
        const url = URL.createObjectURL(blob);
        const book = ePub(url);
        book.loaded.metadata.then((md) => {
          meta.title = md.title || '';
          meta.author = md.creator || '';
          URL.revokeObjectURL(url);
          resolve(meta);
        }).catch(() => {
          URL.revokeObjectURL(url);
          resolve(meta);
        });

        // Timeout: if metadata doesn't load within 5s, resolve with empty
        setTimeout(() => {
          URL.revokeObjectURL(url);
          resolve(meta);
        }, 5000);
      } catch (e) {
        resolve(meta);
      }
    });
  }

  // ==================== READER ====================
  async function openBook(bookMeta) {
    currentBookMeta = bookMeta;
    aiMessages = [];
    renderAiMessages();
    showReader();
    setReaderLoading('正在打开书籍...', '远程书籍可能需要多等几秒');

    // Update toolbar
    dom.toolbarBookTitle.textContent = bookMeta.book_title;
    dom.toolbarChapter.textContent = '加载中…';

    // Update last opened
    bookMeta.last_opened = Date.now();
    await dbPut('books', bookMeta);

    // Render notes for this book
    await renderNotes();
    updateSyncBadge();

    // Initialize epub.js
    try {
      if (currentBookUrl) URL.revokeObjectURL(currentBookUrl);
      currentBookUrl = null;

      let book;
      if (bookMeta.filename && !bookMeta.file_blob) {
        // Server-side book — load from API URL directly (no blob needed)
        book = ePub(API_BASE + '/api/books/' + encodeURIComponent(bookMeta.filename));
      } else {
        // Local book — create blob URL from IndexedDB ArrayBuffer
        const blob = new Blob([bookMeta.file_blob], { type: 'application/epub+zip' });
        const url = URL.createObjectURL(blob);
        currentBookUrl = url;
        book = ePub(url);
      }
      currentBook = book;
      locationsReadyPromise = null;
      locationsReadyBook = null;
      setLoadingProgress(10);

      const rendition = book.renderTo(dom.epubContainer, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'paginated',
      });
      currentRendition = rendition;
      _boundIframeDocument = null;

      // Track chapter/location changes
      rendition.on('relocated', (location) => {
        handleLocationChange(location);
        clearSearchHighlights();
        setupIframeNavigation();  // re-attach if iframe was recreated
        restoreHighlights();      // re-apply highlights on new page
      });

      rendition.on('rendered', () => {
        setupIframeNavigation();
      });

      // Setup highlight selection handling
      setupSelectionHandling(rendition);

      // Restore saved CFI or start from beginning
      const startCfi = bookMeta.last_cfi || undefined;
      const displayed = rendition.display(startCfi);
      setLoadingProgress(30);
      displayed.then(() => {
        updateProgressUI();
        setupIframeNavigation();
        // Restore visual highlights from IndexedDB
        restoreHighlights();
        setLoadingProgress(60);
        // Generate locations with progress tracking
        return warmLocationsWithProgress(book);
      }).then(() => {
        setLoadingProgress(100);
        setTimeout(() => {
          hideReaderLoading();
        }, 300);
      }).catch(err => {
        hideReaderLoading();
        console.error('Display failed:', err);
        showToast('页面加载失败，请重试', 'error');
      });

      // Load bookmarks/navigation for chapter titles
      book.loaded.navigation.then((nav) => {
        // nav.toc gives us chapter structure
        if (nav.toc && nav.toc.length > 0) {
          currentBook._toc = nav.toc;
        }
      });

      dom.epubContainer.style.display = '';
    } catch (err) {
      hideReaderLoading();
      console.error('Failed to open book:', err);
      showToast('打开书籍失败: ' + err.message, 'error');
    }
  }

  function percentageFromCfi(cfi) {
    if (!cfi || !currentRendition || !currentRendition.book || !currentRendition.book.locations) return null;
    try {
      const locations = currentRendition.book.locations;
      if (typeof locations.percentageFromCfi === 'function') {
        return locations.percentageFromCfi(cfi);
      }
    } catch (_e) { /* ignore */ }
    return null;
  }

  function handleLocationChange(location) {
    // TEMPORARY DIAGNOSTIC PROBE — remove in Todo 4
    const __probe = window.location.search.includes('__probe=boundary') || window.__PROBE_BOUNDARY;
    if (__probe && location && location.start) {
      const dumps = window.__probeDump || (window.__probeDump = []);
      const captureDump = (delay) => {
        setTimeout(() => {
          try {
            const iframe = document.querySelector('#epub-container iframe');
            const view = iframe ? iframe.contentDocument.querySelector('.epub-view') : null;
            const containerRect = document.querySelector('#epub-container').getBoundingClientRect();
            const viewRect = view ? view.getBoundingClientRect() : { left: 0 };
            dumps.push({
              delay: delay,
              cfi: location.start.cfi,
              href: location.start.href,
              displayedPage: location.start.displayed ? location.start.displayed.page : null,
              displayedTotal: location.start.displayed ? location.start.displayed.total : null,
              containerLeft: containerRect.left,
              viewLeft: viewRect.left,
              iframeScrollLeft: iframe ? iframe.contentWindow.scrollX : null,
              timestamp: Date.now(),
            });
            if (dumps.length >= 3) {
              window.dispatchEvent(new CustomEvent('probe:dump', { detail: dumps }));
            }
          } catch (e) { /* ignore probe errors */ }
        }, delay);
      };
      requestAnimationFrame(() => { captureDump(0); captureDump(100); captureDump(300); });
    }
    // END TEMPORARY DIAGNOSTIC PROBE

    if (!location || !location.start) return;
    currentCfi = location.start.cfi;
    let percent = location.start.percentage;
    if (percent == null) {
      percent = percentageFromCfi(currentCfi);
    }
    if (percent == null) return;
    const pct = Math.round(percent * 100);

    // Update progress UI
    dom.progressSlider.value = pct;
    dom.progressText.textContent = pct + '%';
    updatePageUI();

    // Save progress to DB
    if (currentBookMeta && !isLayoutRefreshing) {
      currentBookMeta.progress_percent = pct;
      currentBookMeta.last_cfi = currentCfi;
      dbPut('books', currentBookMeta).catch(() => {});
    }

    // Try to get chapter title from TOC
    updateChapterLabel(location);
  }

  function updateChapterLabel(location) {
    if (!currentBook || !currentBook._toc) {
      // Fallback: just show progress
      if (location && location.start) {
        let fallbackPct = location.start.percentage;
        if (fallbackPct == null) fallbackPct = percentageFromCfi(location.start.cfi);
        dom.toolbarChapter.textContent = `进度 ${Math.round((fallbackPct ?? 0) * 100)}%`;
      }
      return;
    }

    // Find the closest TOC entry
    const toc = currentBook._toc;
    let chapterTitle = '';
    // Flatten TOC and find matching href
    const flattenTOC = (items, prefix = '') => {
      for (const item of items) {
        const label = prefix ? `${prefix} › ${item.label}` : item.label;
        if (item.href && location.start.href && item.href.includes(location.start.href.split('#')[0])) {
          chapterTitle = item.label;
          return;
        }
        if (item.subitems) flattenTOC(item.subitems, item.label);
      }
    };
    flattenTOC(toc);
    dom.toolbarChapter.textContent = chapterTitle || '正文';
    currentChapter = chapterTitle || '正文';
  }

  function updateProgressUI() {
    if (!currentRendition || !currentRendition.location || !currentRendition.location.start) return;
    let percent = currentRendition.location.start.percentage;
    if (percent == null) {
      percent = percentageFromCfi(currentRendition.location.start.cfi);
    }
    if (percent == null) return;
    const pct = Math.round(percent * 100);
    dom.progressSlider.value = pct;
    dom.progressText.textContent = pct + '%';
    updatePageUI();
  }

  function refreshReaderLayout() {
    if (!currentRendition || !dom.epubContainer) return;
    const refreshToken = ++layoutRefreshToken;
    const navigationToken = pageNavigationToken;
    const anchorCfi = getCurrentAnchorCfi();
    isLayoutRefreshing = true;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        try {
          if (refreshToken !== layoutRefreshToken || !currentRendition) return;
          const rect = dom.epubContainer.getBoundingClientRect();
          if (typeof currentRendition.resize === 'function' && rect.width > 0 && rect.height > 0) {
            currentRendition.resize(rect.width, rect.height);
          }
          restoreLayoutAnchor(anchorCfi, refreshToken, navigationToken);
          updateProgressUI();
        } catch (err) {
          console.warn('Reader layout refresh failed:', err);
        } finally {
          window.setTimeout(() => {
            if (refreshToken === layoutRefreshToken) {
              isLayoutRefreshing = false;
            }
          }, 500);
        }
      });
    });
  }

  function getCurrentAnchorCfi() {
    try {
      const loc = currentRendition && typeof currentRendition.currentLocation === 'function'
        ? currentRendition.currentLocation()
        : null;
      return (loc && loc.start && loc.start.cfi) || currentCfi || '';
    } catch (_err) {
      return currentCfi || '';
    }
  }

  function restoreLayoutAnchor(anchorCfi, refreshToken, navigationToken) {
    if (!anchorCfi || !currentRendition || typeof currentRendition.display !== 'function') return;
    window.setTimeout(() => {
      if (refreshToken !== layoutRefreshToken || !currentRendition) return;
      if (navigationToken !== pageNavigationToken) return;
      const currentAnchor = getCurrentAnchorCfi();
      if (currentAnchor && currentAnchor === anchorCfi) return;
      Promise.resolve(currentRendition.display(anchorCfi))
        .then(() => {
          if (refreshToken === layoutRefreshToken && navigationToken === pageNavigationToken) {
            currentCfi = anchorCfi;
            if (currentBookMeta) currentBookMeta.last_cfi = anchorCfi;
            updateProgressUI();
          }
        })
        .catch(err => console.warn('Reader anchor restore failed:', err));
    }, 80);
  }

  function getLocationCount(locations) {
    if (!locations) return 0;
    return typeof locations.length === 'function'
      ? locations.length()
      : (locations.length || 0);
  }

  function getCurrentPageInfo() {
    if (!currentRendition || !currentRendition.book || !currentRendition.book.locations) return null;
    const locations = currentRendition.book.locations;
    const totalPages = getLocationCount(locations);
    if (!totalPages) return null;
    const cfi = getCurrentAnchorCfi();
    if (!cfi || typeof locations.locationFromCfi !== 'function') return null;
    try {
      const location = locations.locationFromCfi(cfi);
      if (typeof location !== 'number' || location < 0) return null;
      return {
        currentPage: Math.min(totalPages, location + 1),
        totalPages,
      };
    } catch (_err) {
      return null;
    }
  }

  function updatePageUI() {
    if (!dom.pageText) return;
    const pageInfo = getCurrentPageInfo();
    dom.pageText.textContent = pageInfo
      ? `第 ${pageInfo.currentPage} / ${pageInfo.totalPages} 页`
      : '页码计算中...';
  }

  function isEditableTarget(target) {
    if (!target) return false;
    const tagName = target.tagName ? target.tagName.toLowerCase() : '';
    return target.isContentEditable
      || tagName === 'input'
      || tagName === 'textarea'
      || tagName === 'select';
  }

  function setPageNavigationDisabled(disabled) {
    if (dom.btnNavPrev) dom.btnNavPrev.disabled = disabled;
    if (dom.btnNavNext) dom.btnNavNext.disabled = disabled;
  }

  function navigatePage(direction, source) {
    if (!currentRendition || pageNavigationInProgress || isLayoutRefreshing) return Promise.resolve(false);
    if (direction !== 'next' && direction !== 'prev') return Promise.resolve(false);

    pageNavigationInProgress = true;
    pageNavigationToken += 1;
    setPageNavigationDisabled(true);

    let navigation;
    try {
      navigation = direction === 'next'
        ? currentRendition.next()
        : currentRendition.prev();
    } catch (err) {
      console.warn('Page navigation failed:', source, err);
      pageNavigationInProgress = false;
      setPageNavigationDisabled(false);
      return Promise.resolve(false);
    }

    return Promise.resolve(navigation)
      .then(() => true)
      .catch((err) => {
        console.warn('Page navigation failed:', source, err);
        return false;
      })
      .finally(() => {
        window.setTimeout(() => {
          pageNavigationInProgress = false;
          setPageNavigationDisabled(false);
        }, PAGE_NAVIGATION_COOLDOWN);
      });
  }

  function warmLocationsWithProgress(book) {
    if (!book || !book.locations) return Promise.resolve();
    if (locationsReadyBook === book && locationsReadyPromise) return locationsReadyPromise;
    if (getLocationCount(book.locations) > 0) {
      locationsReadyBook = book;
      locationsReadyPromise = Promise.resolve();
      setLoadingProgress(100);
      updatePageUI();
      return locationsReadyPromise;
    }

    locationsReadyBook = book;
    // Show progress animation during synchronous generation
    let fakeProgress = 60;
    const progressInterval = setInterval(() => {
      fakeProgress += Math.random() * 3;
      if (fakeProgress >= 95) fakeProgress = 95;
      setLoadingProgress(fakeProgress);
    }, 150);

    locationsReadyPromise = book.locations.generate(1000)
      .then(() => {
        clearInterval(progressInterval);
        setLoadingProgress(100);
        updatePageUI();
      })
      .catch((err) => {
        clearInterval(progressInterval);
        locationsReadyBook = null;
        locationsReadyPromise = null;
        throw err;
      });

    return locationsReadyPromise;
  }

  async function jumpToProgress(percent) {
    if (!currentRendition || !currentRendition.book || !currentRendition.book.locations) return;
    const jumpToken = ++progressJumpToken;
    const previousValue = dom.progressSlider.value;

    try {
      const locations = currentRendition.book.locations;
      dom.progressSlider.disabled = true;
      dom.progressText.textContent = getLocationCount(locations) > 0 ? '跳转中...' : '定位中...';
      setReaderLoading('正在跳转...', '正在定位目标位置');
      await warmLocationsWithProgress(currentRendition.book);
      if (jumpToken !== progressJumpToken) return;

      const cfiResult = locations.cfiFromPercentage(percent);
      const cfi = cfiResult && typeof cfiResult.then === 'function'
        ? await cfiResult
        : cfiResult;
      if (jumpToken !== progressJumpToken) return;

      if (cfi) {
        await currentRendition.display(cfi);
        if (jumpToken === progressJumpToken) updateProgressUI();
      } else {
        showToast('暂时无法跳转到该位置', 'warning');
        updateProgressUI();
      }
    } catch (err) {
      console.warn('Progress jump failed:', err);
      dom.progressSlider.value = previousValue;
      showToast('进度跳转失败', 'error');
      updateProgressUI();
    } finally {
      if (jumpToken === progressJumpToken) {
        dom.progressSlider.disabled = false;
        hideReaderLoading();
      }
    }
  }

  // ==================== IFRAME NAVIGATION ====================
  // epub.js renders inside an iframe — all interaction must go through the iframe's document
  let _boundIframeDocument = null;

  function setupIframeNavigation() {
    const iframe = dom.epubContainer.querySelector('iframe');
    if (!iframe || !iframe.contentDocument || _boundIframeDocument === iframe.contentDocument) return;
    _boundIframeDocument = iframe.contentDocument;
    const doc = iframe.contentDocument;

    // Keyboard: arrow keys for page turning
    doc.addEventListener('keydown', (e) => {
      if (!currentRendition) return;
      if (e.repeat || isEditableTarget(e.target)) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        navigatePage('next', 'iframe-keyboard');
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        navigatePage('prev', 'iframe-keyboard');
      }
    });

    // Wheel page flip on iframe (with Ctrl+wheel font zoom)
    doc.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        handleFontZoom(e);
      } else {
        handleWheelPageFlip(e);
      }
      e.stopPropagation();
    }, { passive: false });

    // Native selection detection (bypass epub.js's unreliable 'selected' event)
    doc.addEventListener('mouseup', () => {
      setTimeout(() => {
        const sel = doc.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = sel.toString().trim();
        if (!text || text.length < 2) return;

        // Use current page CFI as location reference
        const loc = currentRendition.currentLocation();
        const cfi = loc && loc.start ? loc.start.cfi : '';

        pendingSelection = { cfi, text };
        positionSelectionToolbar(sel, iframe);
        dom.selectionToolbar.hidden = false;
      }, 50); // short delay to let the selection settle
    });

    // Hide toolbar when clicking empty space (no selection after click)
    doc.addEventListener('click', () => {
      setTimeout(() => {
        const sel = doc.getSelection();
        if (!hasSelectionText(sel)) {
          clearSelection(sel);
          hideSelectionToolbar();
        }
      }, 200);
    });
  }

  // ==================== WHEEL PAGE FLIP ====================
  function resetWheelGesture() {
    wheelAccumulatedDelta = 0;
    wheelGestureLocked = false;
    wheelFlipInProgress = false;
  }

  function scheduleWheelGestureReset() {
    if (wheelGestureTimer) clearTimeout(wheelGestureTimer);
    wheelGestureTimer = setTimeout(() => {
      wheelGestureTimer = null;
      if (!wheelFlipInProgress) resetWheelGesture();
    }, WHEEL_IDLE_MS);
  }

  function handleWheelPageFlip(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!currentRendition || isLayoutRefreshing) return;
    if (Date.now() < fontZoomLockUntil) return;

    const delta = event.deltaY || event.detail || 0;
    if (!delta) return;

    const direction = delta > 0 ? 1 : -1;
    if (wheelAccumulatedDelta && Math.sign(wheelAccumulatedDelta) !== direction && !wheelGestureLocked) {
      wheelAccumulatedDelta = 0;
    }
    wheelAccumulatedDelta += delta;
    scheduleWheelGestureReset();

    if (wheelGestureLocked || wheelFlipInProgress || Math.abs(wheelAccumulatedDelta) < WHEEL_DELTA_THRESHOLD) return;

    wheelGestureLocked = true;
    wheelFlipInProgress = true;
    navigatePage(wheelAccumulatedDelta > 0 ? 'next' : 'prev', 'wheel')
      .finally(() => {
        wheelFlipInProgress = false;
      });
  }

  // ==================== SEARCH ====================
  function toggleSearchPanel() {
    const isVisible = !dom.searchPanel.hidden;
    dom.searchPanel.hidden = isVisible;
    dom.toolbarSearch.hidden = isVisible;
    dom.btnSearchClose.hidden = isVisible;
    if (!isVisible) {
      dom.searchInput.focus();
    } else {
      clearSearchResults();
    }
  }

  async function performSearch(query) {
    if (!query || query.length < 2) {
      dom.searchResults.innerHTML = '<div class="empty-search">至少输入 2 个字符</div>';
      dom.searchCount.textContent = '0 条';
      return;
    }

    dom.searchResults.innerHTML = '<div class="empty-search">搜索中…</div>';
    dom.searchCount.textContent = '搜索中…';

    try {
      clearSearchHighlights();

      const results = await currentBook.find(query);
      searchResultsList = results || [];

      if (searchResultsList.length === 0) {
        dom.searchResults.innerHTML = '<div class="empty-search">没有找到匹配的内容</div>';
        dom.searchCount.textContent = '0 条';
        return;
      }

      dom.searchCount.textContent = searchResultsList.length + ' 条';
      renderSearchResults(query);
      highlightSearchMatches(query);
    } catch (err) {
      console.error('Search failed:', err);
      dom.searchResults.innerHTML = '<div class="empty-search">搜索失败，请重试</div>';
      dom.searchCount.textContent = '0 条';
    }
  }

  function renderSearchResults(query) {
    dom.searchResults.innerHTML = '';
    const maxResults = 100;
    const displayResults = searchResultsList.slice(0, maxResults);

    for (const result of displayResults) {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      const excerpt = (result.excerpt || '').replace(/\n/g, ' ').trim();
      item.innerHTML = `
        <div class="search-result-excerpt">${escapeHTML(excerpt)}</div>
        <div class="search-result-meta">点击跳转</div>
      `;
      item.addEventListener('click', () => {
        currentRendition.display(result.cfi);
        if (window.innerWidth <= 768) {
          dom.notesPanel.classList.remove('open');
        }
      });
      dom.searchResults.appendChild(item);
    }

    if (searchResultsList.length > maxResults) {
      const more = document.createElement('div');
      more.className = 'search-result-more';
      more.textContent = `仅显示前 ${maxResults} 条，共 ${searchResultsList.length} 条`;
      dom.searchResults.appendChild(more);
    }
  }

  function highlightSearchMatches(query) {
    if (!currentRendition || !currentRendition.annotations) return;
    clearSearchHighlights();

    const key = 'search-highlight';
    searchHighlightKeys.push(key);

    try {
      const iframe = dom.epubContainer.querySelector('iframe');
      if (iframe && iframe.contentDocument) {
        const doc = iframe.contentDocument;
        const body = doc.body;
        if (!body) return;

        const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, null, false);
        const textNodes = [];
        let node;
        while (node = walker.nextNode()) {
          textNodes.push(node);
        }

        const regex = new RegExp(escapeRegex(query), 'gi');
        for (const textNode of textNodes) {
          const text = textNode.textContent;
          if (!regex.test(text)) continue;
          regex.lastIndex = 0;

          const fragment = doc.createDocumentFragment();
          let lastIndex = 0;
          let match;
          while ((match = regex.exec(text)) !== null) {
            if (match.index > lastIndex) {
              fragment.appendChild(doc.createTextNode(text.slice(lastIndex, match.index)));
            }
            const mark = doc.createElement('mark');
            mark.className = 'search-match';
            mark.textContent = match[0];
            fragment.appendChild(mark);
            lastIndex = regex.lastIndex;
          }
          if (lastIndex < text.length) {
            fragment.appendChild(doc.createTextNode(text.slice(lastIndex)));
          }
          textNode.parentNode.replaceChild(fragment, textNode);
        }
      }
    } catch (e) {
      console.warn('Search highlight failed:', e);
    }
  }

  function clearSearchHighlights() {
    try {
      const iframe = dom.epubContainer.querySelector('iframe');
      if (iframe && iframe.contentDocument) {
        const marks = iframe.contentDocument.querySelectorAll('mark.search-match');
        for (const mark of marks) {
          const parent = mark.parentNode;
          parent.replaceChild(document.createTextNode(mark.textContent), mark);
          parent.normalize();
        }
      }
    } catch (e) { /* ignore */ }
  }

  function clearSearchResults() {
    searchResultsList = [];
    clearSearchHighlights();
    dom.searchResults.innerHTML = '<div class="empty-search">输入关键词搜索本书内容</div>';
    dom.searchCount.textContent = '0 条';
    dom.searchInput.value = '';
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ==================== CTRL+WHEEL FONT ZOOM ====================
  function handleFontZoom(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!currentRendition || !currentRendition.themes) return;

    const delta = event.deltaY || event.detail || 0;
    if (Math.abs(delta) < 10) return;

    fontZoomLockUntil = Date.now() + WHEEL_IDLE_MS;
    resetWheelGesture();

    if (delta > 0) {
      currentFontSize = Math.max(FONT_SIZE_MIN, currentFontSize - FONT_SIZE_STEP);
    } else {
      currentFontSize = Math.min(FONT_SIZE_MAX, currentFontSize + FONT_SIZE_STEP);
    }

    currentRendition.themes.fontSize(currentFontSize + '%');
  }

  // ==================== HIGHLIGHTING / SELECTION ====================
  function setupSelectionHandling(rendition) {
    rendition.on('selected', (cfiRange, contents) => {
      const selection = rendition.getRange(cfiRange);
      if (!selection) return;

      const text = selection.toString().trim();
      if (!text || text.length < 2) {
        hideSelectionToolbar();
        return;
      }

      pendingSelection = { cfiRange, text, contents };

      // Position the floating toolbar near the selection
      positionSelectionToolbar(selection, getIframeForContents(contents) || getIframeForRange(selection));
      dom.selectionToolbar.hidden = false;
    });

    // Hide toolbar when clicking elsewhere in the book (but not right after a selection)
    rendition.on('click', () => {
      // Don't hide immediately — the 'selected' event fires before 'click',
      // so we wait a tick. If there's still no pendingSelection, it's a real click-away.
      setTimeout(() => {
        if (!pendingSelection) {
          hideSelectionToolbar();
        }
      }, 150);
    });

    // Handle clicks on the epub container outside selections
    dom.epubContainer.addEventListener('click', (e) => {
      // If clicking outside a selection, hide toolbar after a tick
      // (the 'selected' event fires after so we need a delay)
      setTimeout(() => {
        const sel = window.getSelection();
        if (!hasSelectionText(sel)) {
          clearSelection(sel);
          hideSelectionToolbar();
        }
      }, 100);
    });
  }

  function getIframeForContents(contents) {
    if (!contents || !contents.document) return null;
    return getIframeForDocument(contents.document);
  }

  function getIframeForRange(range) {
    if (!range || !range.commonAncestorContainer) return null;
    return getIframeForDocument(range.commonAncestorContainer.ownerDocument);
  }

  function getIframeForDocument(doc) {
    if (!doc) return null;
    const iframes = dom.epubContainer.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        if (iframe.contentDocument === doc) return iframe;
      } catch (_err) {
        // Cross-origin frames are not expected here, but skip them if present.
      }
    }
    return null;
  }

  function hasSelectionText(selection) {
    return !!(selection && !selection.isCollapsed && selection.toString().trim());
  }

  function clearSelection(selection) {
    if (selection && typeof selection.removeAllRanges === 'function') {
      selection.removeAllRanges();
    }
  }

  function positionSelectionToolbar(selection, iframe) {
    const range = typeof selection.getRangeAt === 'function'
      ? (selection.rangeCount ? selection.getRangeAt(0) : null)
      : selection;
    if (!range) return;

    const rect = range.getBoundingClientRect();
    const frameRect = iframe ? iframe.getBoundingClientRect() : null;
    const toolbar = dom.selectionToolbar;
    const wasHidden = toolbar.hidden;

    if (wasHidden) {
      toolbar.hidden = false;
      toolbar.style.visibility = 'hidden';
    }

    const viewportTop = rect.top + (frameRect ? frameRect.top : 0);
    const viewportBottom = rect.bottom + (frameRect ? frameRect.top : 0);
    const viewportLeft = rect.left + (frameRect ? frameRect.left : 0);

    let top = viewportTop - toolbar.offsetHeight - 8;
    let left = viewportLeft + (rect.width / 2) - (toolbar.offsetWidth / 2);

    // Keep within viewport
    if (top < 0) top = viewportBottom + 8;
    if (left < 8) left = 8;
    if (left + toolbar.offsetWidth > window.innerWidth - 8) {
      left = window.innerWidth - toolbar.offsetWidth - 8;
    }

    toolbar.style.top = top + 'px';
    toolbar.style.left = left + 'px';
    toolbar.style.visibility = '';
  }

  function hideSelectionToolbar() {
    dom.selectionToolbar.hidden = true;
    pendingSelection = null;
  }

  // ==================== APPLY HIGHLIGHT ====================
  async function applyHighlight(color, extraFields) {
    if (!pendingSelection || !currentRendition) return null;

    const { cfiRange, cfi, text } = pendingSelection;
    const rangeCfi = cfiRange || cfi; // epub.js uses cfiRange, native uses cfi

    try {
      // Apply visual highlight in the iframe — prefer DOM wrap for reliability
      const iframe = dom.epubContainer.querySelector('iframe');
      if (iframe && iframe.contentDocument) {
        const sel = iframe.contentDocument.getSelection();
        if (sel && !sel.isCollapsed) {
          try {
            const range = sel.getRangeAt(0);
            const span = iframe.contentDocument.createElement('span');
            span.className = 'marginalia-hl';
            span.style.cssText = getHighlightStyle(color);
            range.surroundContents(span);
          } catch (_e) {
            // Selection crosses element boundaries, try epub.js annotations
            if (rangeCfi) {
              try {
                applyAnnotationHighlight(rangeCfi, color);
              } catch (_e2) { /* ignore */ }
            }
          }
          sel.removeAllRanges();
        } else if (rangeCfi) {
          // No live selection but we have a CFI — use epub.js annotations
          try {
            applyAnnotationHighlight(rangeCfi, color);
          } catch (_e) { /* ignore */ }
        }
      }

      // Get the actual selected text (from iframe if not already available)
      let highlightText = text;
      if (!highlightText) {
        const iframe2 = dom.epubContainer.querySelector('iframe');
        if (iframe2 && iframe2.contentDocument) {
          const sel2 = iframe2.contentDocument.getSelection();
          if (sel2) highlightText = sel2.toString().trim();
        }
      }

      // Save to IndexedDB
      const highlightId = uuid();
      const highlight = {
        id: highlightId,
        book_id: currentBookMeta.id,
        book_title: currentBookMeta.book_title,
        book_author: currentBookMeta.book_author,
        chapter: currentChapter,
        cfi: rangeCfi || '',
        highlight_text: highlightText || '',
        note: (extraFields && extraFields.note) || '',
        tags: (extraFields && extraFields.tags) || [],
        color: color,
        created_at: new Date().toISOString(),
        progress_percent: currentBookMeta.progress_percent || 0,
        synced: false,
        synced_at: null,
        server_id: null,
        status: (extraFields && extraFields.note) ? 'reflected' : 'raw',
      };

      await dbPut('highlights', highlight);
      await renderNotes();
      updateSyncBadge();
      hideSelectionToolbar();
      return highlightId;

    } catch (err) {
      console.error('Highlight failed:', err);
      showToast('高亮失败', 'error');
      hideSelectionToolbar();
      return null;
    }
  }

  function getHighlightStyle(color) {
    const colors = {
      yellow: 'background-color: rgba(255, 235, 59, 0.45)',
      green: 'background-color: rgba(76, 175, 80, 0.35)',
      blue: 'background-color: rgba(33, 150, 243, 0.35)',
      pink: 'background-color: rgba(233, 30, 99, 0.3)',
    };
    const background = colors[color] || colors.yellow;
    return [
      background,
      'color: inherit',
      '-webkit-text-fill-color: currentColor',
      'text-shadow: none',
      'opacity: 1',
      'border-radius: 2px',
      'padding: 0 1px',
      'box-decoration-break: clone',
      '-webkit-box-decoration-break: clone',
    ].join('; ');
  }

  function getAnnotationHighlightStyle(color) {
    const colors = {
      yellow: 'rgb(255, 235, 59)',
      green: 'rgb(76, 175, 80)',
      blue: 'rgb(33, 150, 243)',
      pink: 'rgb(233, 30, 99)',
    };
    return {
      fill: colors[color] || colors.yellow,
      'fill-opacity': '0.18',
      stroke: 'none',
      'pointer-events': 'none',
    };
  }

  function applyAnnotationHighlight(cfi, color, data) {
    if (!currentRendition || !cfi) return;
    try {
      currentRendition.annotations.remove(cfi, 'highlight');
    } catch (_err) {
      // The annotation may not exist yet.
    }
    currentRendition.annotations.highlight(
      cfi,
      data || {},
      null,
      'marginalia-hl-annotation',
      getAnnotationHighlightStyle(color)
    );
  }

  // ==================== NOTE EDITOR ====================
  let editingHighlightId = null;

  function openNoteEditor(highlightId) {
    const h = dbGet('highlights', highlightId);
    h.then((highlight) => {
      if (!highlight) return;
      editingHighlightId = highlightId;
      dom.notePreviewText.textContent = highlight.highlight_text;
      dom.noteTextarea.value = highlight.note || '';
      dom.tagInput.value = (highlight.tags || []).join(', ');
      dom.btnDeleteNote.hidden = false;
      dom.noteModal.hidden = false;
    });
  }

  function openNewNoteEditor() {
    if (!pendingSelection) {
      showToast('请先选中一段文字', 'info');
      return;
    }
    editingHighlightId = null;
    dom.notePreviewText.textContent = pendingSelection.text;
    dom.noteTextarea.value = '';
    dom.tagInput.value = '';
    dom.btnDeleteNote.hidden = true;
    dom.noteModal.hidden = false;
  }

  async function saveNote() {
    const noteText = dom.noteTextarea.value.trim();
    const tagStr = dom.tagInput.value.trim();
    const tags = tagStr ? tagStr.split(/[,，]/).map(t => t.trim()).filter(Boolean) : [];

    if (editingHighlightId) {
      // Editing existing highlight
      const h = await dbGet('highlights', editingHighlightId);
      if (h) {
        h.note = noteText;
        h.tags = tags;
        h.synced = false;
        h.updated_at = new Date().toISOString();
        h.status = noteText ? 'reflected' : 'raw';
        await dbPut('highlights', h);
      }
    } else {
      // New highlight + note (selected text without prior highlight)
      if (!pendingSelection) return;
      const highlightId = await applyHighlight('yellow', {
        note: noteText,
        tags: tags,
      });
      if (highlightId) {
        const h = await dbGet('highlights', highlightId);
        if (h) {
          h.synced = false;
          h.updated_at = new Date().toISOString();
          await dbPut('highlights', h);
        }
      }
    }

    closeNoteEditor();
    await renderNotes();
    updateSyncBadge();
    showToast('笔记已保存', 'success');
  }

  async function deleteNoteHighlight() {
    if (!editingHighlightId) return;
    if (!confirm('确定删除这条划线/笔记吗？')) return;
    await deleteHighlightById(editingHighlightId);
  }

  async function deleteHighlightById(highlightId) {
    if (!highlightId) return;

    const h = await dbGet('highlights', highlightId);
    if (!h) return;

    if (h && currentRendition) {
      // Remove visual highlight from iframe DOM
      try {
        const iframe = dom.epubContainer.querySelector('iframe');
        if (iframe && iframe.contentDocument) {
          const spans = iframe.contentDocument.querySelectorAll('span.marginalia-hl');
          for (const span of spans) {
            if (span.textContent.trim() === h.highlight_text.trim()) {
              span.replaceWith(...span.childNodes);
              break;
            }
          }
        }
      } catch (e) { /* ignore */ }

      // Also try epub.js annotations remove (legacy highlights)
      try {
        currentRendition.annotations.remove(h.cfi, 'highlight');
      } catch (e) { /* ignore */ }
    }

    await queueHighlightDelete(h);
    await dbDelete('highlights', highlightId);
    selectedMaterialIds.delete(highlightId);
    if (selectedMaterialId === highlightId) {
      clearSelectedMaterial();
    }
    if (editingHighlightId === highlightId) {
      closeNoteEditor();
    }
    await renderNotes();
    await renderMaterials();
    updateSyncBadge();
    showToast('已删除', 'info');
  }

  function closeNoteEditor() {
    dom.noteModal.hidden = true;
    editingHighlightId = null;
  }

  // ==================== BOOKMARKS ====================
  async function addBookmark() {
    if (!currentBookMeta || !currentRendition) return;
    const cfi = getCurrentAnchorCfi();
    if (!cfi) {
      showToast('当前位置暂时无法添加书签', 'warning');
      return;
    }

    const progress = currentBookMeta.progress_percent || parseInt(dom.progressSlider.value || '0', 10) || 0;
    const chapter = currentChapter || dom.toolbarChapter.textContent || '正文';
    const now = Date.now();
    const bookmark = {
      id: uuid(),
      book_id: currentBookMeta.id,
      book_title: currentBookMeta.book_title,
      book_author: currentBookMeta.book_author,
      chapter,
      cfi,
      progress_percent: progress,
      label: `${chapter} · ${progress}%`,
      created_at: new Date(now).toISOString(),
    };

    await dbPut('bookmarks', bookmark);
    await renderBookmarks();
    showToast('书签已添加', 'success');
  }

  async function renderBookmarks() {
    if (!dom.bookmarksList || !dom.bookmarksCount) return;
    if (!currentBookMeta || !dbHasStore('bookmarks')) {
      dom.bookmarksCount.textContent = '0';
      dom.bookmarksList.innerHTML = '<div class="empty-bookmarks">打开书籍后可添加书签</div>';
      return;
    }

    const bookmarks = await dbGetByIndex('bookmarks', 'by_book', currentBookMeta.id);
    bookmarks.sort((a, b) => (a.progress_percent || 0) - (b.progress_percent || 0));
    dom.bookmarksCount.textContent = String(bookmarks.length);

    if (bookmarks.length === 0) {
      dom.bookmarksList.innerHTML = '<div class="empty-bookmarks">还没有书签</div>';
      return;
    }

    dom.bookmarksList.innerHTML = '';
    for (const bookmark of bookmarks) {
      const item = document.createElement('div');
      item.className = 'bookmark-item';
      item.dataset.bookmarkId = bookmark.id;
      const createdAt = new Date(bookmark.created_at).getTime();
      const createdText = Number.isNaN(createdAt) ? '' : formatRelativeDate(createdAt);
      item.innerHTML = `
        <button class="bookmark-main" type="button">
          <span class="bookmark-title">${escapeHTML(bookmark.chapter || bookmark.label || '书签')}</span>
          <span class="bookmark-meta">${bookmark.progress_percent || 0}% ${createdText ? '· ' + createdText : ''}</span>
        </button>
        <button class="bookmark-delete" type="button" title="删除书签" aria-label="删除书签">×</button>
      `;
      item.querySelector('.bookmark-main').addEventListener('click', () => gotoBookmark(bookmark));
      item.querySelector('.bookmark-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteBookmarkById(bookmark.id);
      });
      dom.bookmarksList.appendChild(item);
    }
  }

  async function gotoBookmark(bookmark) {
    if (!currentRendition || !bookmark || !bookmark.cfi) return;
    try {
      await currentRendition.display(bookmark.cfi);
      if (window.innerWidth <= 768) {
        dom.notesPanel.classList.remove('open');
      }
    } catch (err) {
      console.warn('Failed to navigate to bookmark:', err);
      showToast('无法定位到该书签', 'warning');
    }
  }

  async function deleteBookmarkById(bookmarkId) {
    if (!bookmarkId) return;
    await dbDelete('bookmarks', bookmarkId);
    await renderBookmarks();
    showToast('书签已删除', 'info');
  }

  // ==================== NOTES PANEL ====================
  async function renderNotes() {
    if (!currentBookMeta) return;
    await renderBookmarks();

    const highlights = await dbGetByIndex('highlights', 'by_book', currentBookMeta.id);
    // Sort by progress (reading order)
    highlights.sort((a, b) => a.progress_percent - b.progress_percent);

    dom.notesCount.textContent = highlights.length + ' 条';

    if (highlights.length === 0) {
      dom.notesList.innerHTML = `
        <div class="empty-notes">
          <p>选中文字开始划线</p>
          <p class="empty-hint">划线后可以添加笔记和标签</p>
        </div>`;
      return;
    }

    dom.notesList.innerHTML = '';

    for (const h of highlights) {
      const item = document.createElement('div');
      item.className = `note-item highlight-${h.color || 'yellow'}`;
      item.dataset.highlightId = h.id;

      const tagsHTML = (h.tags || []).map(t =>
        `<span class="note-item-tag">${escapeHTML(t)}</span>`
      ).join('');
      const noteSummary = h.note ? '有感悟' : '未写感悟';
      const syncText = h.synced ? '已同步' : '未同步';
      const createdText = formatRelativeDate(new Date(h.created_at).getTime());

      item.innerHTML = `
        <button class="note-item-toggle" type="button" aria-expanded="false">
          <span class="note-item-caret" aria-hidden="true"></span>
          <span class="note-item-summary">${escapeHTML(h.highlight_text || '')}</span>
          <span class="note-item-status">${noteSummary}</span>
        </button>
        <div class="note-item-detail" hidden>
          <div class="note-item-text">${escapeHTML(h.highlight_text || '')}</div>
          <div class="note-item-note ${h.note ? 'has-note' : ''}">${escapeHTML(h.note || '还没有感悟')}</div>
          <div class="note-item-tags">${tagsHTML}</div>
          <div class="note-item-meta">
            ${createdText}
            ${syncText}
          </div>
          <div class="note-item-actions">
            <button class="btn btn-secondary btn-sm" data-action="goto" type="button">定位原文</button>
            <button class="btn btn-primary btn-sm" data-action="edit" type="button">编辑感悟</button>
            <button class="btn btn-danger btn-sm" data-action="delete" type="button">删除划线</button>
          </div>
        </div>
      `;

      const toggle = item.querySelector('.note-item-toggle');
      const detail = item.querySelector('.note-item-detail');
      toggle.addEventListener('click', () => {
        const expanded = toggle.getAttribute('aria-expanded') === 'true';
        toggle.setAttribute('aria-expanded', String(!expanded));
        detail.hidden = expanded;
        item.classList.toggle('expanded', !expanded);
      });

      item.querySelector('[data-action="goto"]').addEventListener('click', async () => {
        if (!currentRendition || !h.cfi) return;
        try {
          // Try to navigate to the highlight's location
          await currentRendition.display(h.cfi);
          // After navigation, briefly flash the highlight
          setTimeout(() => {
            try {
              applyAnnotationHighlight(h.cfi, h.color || 'yellow', { flash: true });
              // Remove the flash highlight after 2 seconds
              setTimeout(() => {
                try { currentRendition.annotations.remove(h.cfi, 'highlight'); } catch (_e) {}
              }, 2000);
            } catch (_e) {}
          }, 500);
        } catch (err) {
          console.warn('Failed to navigate to highlight:', err);
          // Fallback: try using book.locations if available
          if (currentBook && currentBook.locations) {
            const pct = h.progress_percent / 100;
            if (pct > 0) {
              currentRendition.display(currentBook.locations.cfiFromPercentage(pct));
            }
          }
          showToast('无法定位到该位置', 'warning');
        }
        if (window.innerWidth <= 768) {
          dom.notesPanel.classList.remove('open');
        }
      });

      item.querySelector('[data-action="edit"]').addEventListener('click', () => {
        openNoteEditor(h.id);
      });

      item.querySelector('[data-action="delete"]').addEventListener('click', async () => {
        if (!confirm('确定删除这条划线/笔记吗？')) return;
        await deleteHighlightById(h.id);
      });

      dom.notesList.appendChild(item);
    }
  }

  // ==================== RESTORE HIGHLIGHTS ====================
  function restoreHighlights() {
    if (!currentRendition || !currentBookMeta) return;

    // Get highlights for this book
    dbGetByIndex('highlights', 'by_book', currentBookMeta.id).then((highlights) => {
      if (!highlights || highlights.length === 0) return;

      // Apply epub.js annotations for each highlight
      for (const h of highlights) {
        if (!h.cfi) continue;
        try {
          applyAnnotationHighlight(h.cfi, h.color || 'yellow');
        } catch (e) {
          // CFI might be invalid or on a different page — skip silently
        }
      }
    }).catch(() => {});
  }

  function toggleNotesPanel() {
    if (window.innerWidth <= 768) {
      dom.notesPanel.classList.toggle('open');
    } else {
      const shouldCollapse = !dom.notesPanel.classList.contains('collapsed');
      dom.notesPanel.classList.toggle('collapsed', shouldCollapse);
      dom.readerMain.classList.toggle('notes-collapsed', shouldCollapse);
    }
    refreshReaderLayout();
  }

  function toggleAiPanel(forceOpen) {
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : dom.aiPanel.classList.contains('collapsed');
    dom.aiPanel.classList.toggle('collapsed', !shouldOpen);
    dom.readerMain.classList.toggle('ai-collapsed', !shouldOpen);
    refreshReaderLayout();
    if (shouldOpen) {
      renderAiMessages();
      setTimeout(() => dom.aiQuestionInput.focus(), 0);
    }
  }

  function renderAiMessages() {
    if (aiMessages.length === 0) {
      dom.aiMessages.innerHTML = '<div class="ai-empty">问一个和这本书有关的问题。</div>';
      return;
    }
    dom.aiMessages.innerHTML = aiMessages.map(msg => (
      `<div class="ai-message ${msg.role}">${escapeHTML(msg.content)}</div>`
    )).join('');
    dom.aiMessages.scrollTop = dom.aiMessages.scrollHeight;
  }

  function addAiMessage(role, content) {
    aiMessages.push({ role, content });
    renderAiMessages();
  }

  async function collectBookQaContext(question) {
    const highlights = currentBookMeta
      ? await dbGetByIndex('highlights', 'by_book', currentBookMeta.id)
      : [];
    highlights.sort((a, b) => (a.progress_percent || 0) - (b.progress_percent || 0));
    return {
      question,
      book_title: currentBookMeta ? currentBookMeta.book_title || '' : '',
      book_author: currentBookMeta ? currentBookMeta.book_author || '' : '',
      chapter: currentChapter || '',
      progress_percent: currentBookMeta ? currentBookMeta.progress_percent || 0 : 0,
      highlights: highlights.map(h => ({
        highlight_text: h.highlight_text || '',
        note: h.note || '',
        tags: h.tags || [],
        chapter: h.chapter || '',
        progress_percent: h.progress_percent || 0,
      })),
    };
  }

  async function askBookQuestion(question) {
    const trimmed = question.trim();
    if (!trimmed) return;
    if (!currentBookMeta) {
      showToast('请先打开一本书', 'info');
      return;
    }
    if (aiRequestInFlight) return;

    toggleAiPanel(true);
    addAiMessage('user', trimmed);
    dom.aiQuestionInput.value = '';
    aiRequestInFlight = true;
    dom.btnSendAi.disabled = true;
    addAiMessage('assistant', '正在思考...');

    try {
      const payload = await collectBookQaContext(trimmed);
      const resp = await fetch(API_BASE + '/api/books/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const error = await resp.json().catch(() => ({}));
        throw new Error(error.detail || `Server responded with ${resp.status}`);
      }
      const data = await resp.json();
      aiMessages.pop();
      addAiMessage('assistant', data.answer || '没有返回回答。');
    } catch (err) {
      console.error('Book Q&A failed:', err);
      aiMessages.pop();
      addAiMessage('error', '问答失败：' + err.message);
    } finally {
      aiRequestInFlight = false;
      dom.btnSendAi.disabled = false;
    }
  }

  // ==================== SYNC ====================
  async function queueHighlightDelete(highlight) {
    if (!highlight || (!highlight.synced && !highlight.server_id)) return;
    if (!dbHasStore('deleted_highlights')) return;
    await dbPut('deleted_highlights', {
      id: highlight.id,
      client_id: highlight.id,
      server_id: highlight.server_id || '',
      book_title: highlight.book_title || '',
      cfi: highlight.cfi || '',
      highlight_text: highlight.highlight_text || '',
      created_at: highlight.created_at || '',
      deleted_at: new Date().toISOString(),
    });
  }

  async function updateSyncBadge() {
    try {
      const unsynced = await dbGetByIndex('highlights', 'by_synced', false);
      const pendingDeletes = await dbGetAllSafe('deleted_highlights');
      const count = unsynced.length + pendingDeletes.length;

      const badge = dom.syncBadge;
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.hidden = false;
      } else {
        badge.hidden = true;
        badge.textContent = '0';
      }
    } catch (err) {
      console.warn('Failed to update sync badge:', err);
      dom.syncBadge.hidden = true;
      dom.syncBadge.textContent = '0';
    } finally {
      dom.btnSync.disabled = false;
    }
  }

  async function syncToBackend() {
    if (dom.btnSync.classList.contains('syncing')) return;

    const unsynced = await dbGetByIndex('highlights', 'by_synced', false);
    const pendingDeletes = await dbGetAllSafe('deleted_highlights');
    if (unsynced.length === 0 && pendingDeletes.length === 0) {
      showToast('没有需要同步的数据', 'info');
      return;
    }

    dom.btnSync.classList.add('syncing');
    dom.btnSync.disabled = true;
    dom.btnSync.querySelector('.sync-label').textContent = '同步中…';

    try {
      let deleteFailures = 0;
      for (const item of pendingDeletes) {
        try {
          const identifier = encodeURIComponent(item.server_id || item.client_id || item.id);
          const resp = await fetch(API_BASE + '/api/highlights/' + identifier, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(item),
          });
          if (resp.ok || resp.status === 404) {
            await dbDelete('deleted_highlights', item.id);
          }
          // Other errors: keep in queue for retry next sync
        } catch (err) {
          deleteFailures++;
          console.warn('Delete failed for', item.id, err);
        }
      }

      let syncedCount = 0;
      if (unsynced.length > 0) {
        const payload = {
          highlights: unsynced.map(h => ({
            id: h.id,
            client_id: h.id,
            book_title: h.book_title,
            book_author: h.book_author,
            chapter: h.chapter,
            cfi: h.cfi,
            highlight_text: h.highlight_text,
            note: h.note,
            tags: h.tags,
            color: h.color,
            created_at: h.created_at,
            progress_percent: h.progress_percent,
            status: h.status || (h.note ? 'reflected' : 'raw'),
          })),
        };

        const resp = await fetch(API_BASE + '/api/highlights', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!resp.ok) {
          throw new Error(`Server responded with ${resp.status}`);
        }

        const result = await resp.json();
        const itemsByClient = new Map((result.items || []).map(item => [item.client_id, item]));

        // Mark all as synced
        for (let i = 0; i < unsynced.length; i += 1) {
          const h = unsynced[i];
          const item = itemsByClient.get(h.id) || { id: result.ids && result.ids[i] };
          h.synced = true;
          h.synced_at = new Date().toISOString();
          h.server_id = item.id || h.server_id || null;
          await dbPut('highlights', h);
        }
        syncedCount = result.received || unsynced.length;
      }

      await renderNotes();
      updateSyncBadge();
      const deletedSuccess = pendingDeletes.length - deleteFailures;
      showToast(`已同步 ${syncedCount} 条划线，删除 ${deletedSuccess}/${pendingDeletes.length} 条`, deleteFailures > 0 ? 'warning' : 'success');
    } catch (err) {
      console.error('Sync failed:', err);
      showToast('同步失败，请检查后端是否运行', 'error');
    } finally {
      dom.btnSync.classList.remove('syncing');
      dom.btnSync.disabled = false;
      dom.btnSync.querySelector('.sync-label').textContent = '同步';
    }
  }

  // ==================== CREATION WORKSPACE ====================
  async function renderCreationWorkspace() {
    await renderMaterials();
    await renderDrafts();
  }

  async function getFilteredLocalMaterials() {
    const bookFilter = dom.materialBookFilter.value.trim();
    const tagFilter = dom.materialTagFilter.value.trim();
    let materials = await dbGetAll('highlights');
    if (bookFilter) {
      materials = materials.filter(h => (h.book_title || '').includes(bookFilter));
    }
    if (tagFilter) {
      materials = materials.filter(h => (h.tags || []).some(t => t.includes(tagFilter)));
    }
    materials.sort((a, b) => {
      const bookCompare = (a.book_title || '').localeCompare(b.book_title || '', 'zh-CN');
      if (bookCompare !== 0) return bookCompare;
      return (a.progress_percent || 0) - (b.progress_percent || 0);
    });
    return materials;
  }

  async function renderMaterials() {
    const materials = await getFilteredLocalMaterials();
    dom.materialsList.innerHTML = '';

    if (materials.length === 0) {
      dom.materialsList.innerHTML = '<div class="empty-notes">还没有素材。先去阅读页划线并保存感悟。</div>';
      updateSelectedMaterialCount();
      return;
    }

    for (const h of materials) {
      const item = document.createElement('div');
      item.className = `material-card highlight-${h.color || 'yellow'}`;
      if (selectedMaterialIds.has(h.id)) item.classList.add('selected');
      item.dataset.highlightId = h.id;
      const tags = (h.tags || []).map(t => `<span class="note-item-tag">${escapeHTML(t)}</span>`).join('');
      item.innerHTML = `
        <label class="material-check">
          <input type="checkbox" ${selectedMaterialIds.has(h.id) ? 'checked' : ''}>
          <span>${escapeHTML(h.book_title || '未命名书籍')}</span>
        </label>
        <div class="material-quote">${escapeHTML(h.highlight_text || '')}</div>
        <div class="material-note ${h.note ? 'has-note' : ''}">${escapeHTML(h.note || '还没有感悟')}</div>
        <div class="note-item-tags">${tags}</div>
        <div class="note-item-meta">${h.progress_percent || 0}% · ${h.status || 'raw'} · ${h.synced ? '已同步' : '未同步'}</div>
      `;

      item.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) {
          selectedMaterialIds.add(h.id);
        } else {
          selectedMaterialIds.delete(h.id);
        }
        updateSelectedMaterialCount();
        item.classList.toggle('selected', e.target.checked);
      });
      item.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        openMaterialForReflection(h.id);
      });
      dom.materialsList.appendChild(item);
    }
    updateSelectedMaterialCount();
  }

  async function openMaterialForReflection(highlightId) {
    const h = await dbGet('highlights', highlightId);
    if (!h) return;
    selectedMaterialId = highlightId;
    dom.selectedMaterialDetail.innerHTML = `
      <div class="selected-quote">
        <div class="note-item-meta">${escapeHTML(h.book_title || '')} · ${escapeHTML(h.chapter || '')} · ${h.progress_percent || 0}%</div>
        <blockquote>${escapeHTML(h.highlight_text || '')}</blockquote>
      </div>
    `;
    dom.reflectionEditor.value = h.note || '';
    dom.btnSaveReflection.disabled = false;
    dom.btnDeleteReflection.disabled = !h.note;
  }

  function updateSelectedMaterialCount() {
    dom.selectedMaterialCount.textContent = `${selectedMaterialIds.size} 条已选`;
  }

  function clearSelectedMaterial() {
    selectedMaterialId = null;
    dom.selectedMaterialDetail.innerHTML = '<p class="empty-hint">从左侧选择一条素材后编辑感悟；勾选多条素材后可生成内容。</p>';
    dom.reflectionEditor.value = '';
    dom.btnSaveReflection.disabled = true;
    dom.btnDeleteReflection.disabled = true;
  }

  async function saveCurrentReflection() {
    if (!selectedMaterialId) return;
    const h = await dbGet('highlights', selectedMaterialId);
    if (!h) return;
    h.note = dom.reflectionEditor.value.trim();
    h.status = h.note ? 'reflected' : 'raw';
    h.updated_at = new Date().toISOString();
    h.synced = false;
    await dbPut('highlights', h);
    await renderMaterials();
    dom.btnDeleteReflection.disabled = !h.note;
    updateSyncBadge();
    showToast('感悟已保存', 'success');
  }

  async function deleteCurrentReflection() {
    if (!selectedMaterialId) return;
    const h = await dbGet('highlights', selectedMaterialId);
    if (!h || !h.note) return;
    if (!confirm('确定删除这条感悟吗？划线和标签会保留。')) return;

    h.note = '';
    h.status = 'raw';
    h.updated_at = new Date().toISOString();
    h.synced = false;
    await dbPut('highlights', h);
    dom.reflectionEditor.value = '';
    dom.btnDeleteReflection.disabled = true;
    await renderMaterials();
    await renderNotes();
    updateSyncBadge();
    showToast('感悟已删除', 'info');
  }

  async function generateDraft(target) {
    if (selectedMaterialIds.size === 0) {
      showToast('请先勾选素材', 'info');
      return;
    }

    await syncToBackend();
    const payload = {
      target,
      highlight_ids: Array.from(selectedMaterialIds),
      topic: dom.draftTopic.value.trim(),
      tone: '',
      extra_instruction: dom.draftInstruction.value.trim(),
    };

    const button = target === 'video' ? dom.btnGenerateVideo : dom.btnGenerateArticle;
    button.disabled = true;
    button.textContent = '生成中...';
    try {
      const resp = await fetch(API_BASE + '/api/drafts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const error = await resp.json().catch(() => ({}));
        throw new Error(error.detail || `Server responded with ${resp.status}`);
      }
      const draft = await resp.json();
      await renderDrafts();
      openDraftEditor(draft);
      showToast('稿件已生成', 'success');
    } catch (err) {
      console.error('Draft generation failed:', err);
      showToast('生成失败：' + err.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = target === 'video' ? '生成视频号稿' : '生成公众号稿';
    }
  }

  async function renderDrafts() {
    try {
      const resp = await fetch(API_BASE + '/api/drafts');
      if (!resp.ok) return;
      const data = await resp.json();
      const drafts = data.drafts || [];
      dom.draftList.innerHTML = '';
      if (drafts.length === 0) {
        dom.draftList.innerHTML = '<div class="empty-notes">还没有生成稿件</div>';
        return;
      }
      for (const draft of drafts) {
        const item = document.createElement('div');
        item.className = 'draft-card';
        item.innerHTML = `
          <div class="draft-card-title">${escapeHTML(draft.title || '未命名稿件')}</div>
          <div class="note-item-meta">${draft.target === 'video' ? '视频号' : '公众号'} · ${draft.exported_to_obsidian ? '已导出' : '未导出'}</div>
        `;
        item.addEventListener('click', () => openDraftEditor(draft));
        dom.draftList.appendChild(item);
      }
    } catch (e) {
      console.warn('Failed to fetch drafts:', e);
    }
  }

  function openDraftEditor(draft) {
    currentDraftId = draft.id;
    dom.draftEditor.hidden = false;
    dom.draftTitleEditor.value = draft.title || '';
    dom.draftContentEditor.value = draft.content || '';
  }

  async function saveCurrentDraft() {
    if (!currentDraftId) return;
    const resp = await fetch(API_BASE + '/api/drafts/' + encodeURIComponent(currentDraftId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: dom.draftTitleEditor.value.trim() || '未命名稿件',
        content: dom.draftContentEditor.value,
      }),
    });
    if (!resp.ok) {
      showToast('草稿保存失败', 'error');
      return;
    }
    const draft = await resp.json();
    openDraftEditor(draft);
    await renderDrafts();
    showToast('草稿已保存', 'success');
  }

  async function exportCurrentDraft() {
    if (!currentDraftId) return;
    await exportToObsidian({ kind: 'draft', draft_id: currentDraftId });
    await renderDrafts();
  }

  async function exportCurrentBook() {
    const materials = await getFilteredLocalMaterials();
    const selected = selectedMaterialId ? await dbGet('highlights', selectedMaterialId) : materials[0];
    const bookTitle = selected ? selected.book_title : dom.materialBookFilter.value.trim();
    if (!bookTitle) {
      showToast('请先选择一本书或输入书名筛选', 'info');
      return;
    }
    await syncToBackend();
    await exportToObsidian({ kind: 'book', book_title: bookTitle });
  }

  async function exportToObsidian(payload) {
    try {
      const resp = await fetch(API_BASE + '/api/obsidian/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const error = await resp.json().catch(() => ({}));
        throw new Error(error.detail || `Server responded with ${resp.status}`);
      }
      const data = await resp.json();
      showToast('已导出到 ' + data.path, 'success');
    } catch (err) {
      console.error('Obsidian export failed:', err);
      showToast('导出失败：' + err.message, 'error');
    }
  }

  // ==================== PWA ====================
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('sw.js')
      .then((reg) => {
        console.log('Service Worker registered:', reg.scope);
      })
      .catch((err) => {
        console.warn('Service Worker registration failed:', err);
      });
  }

  // ==================== EVENT BINDINGS ====================
  function bindEvents() {
    dom.btnNavLibrary.addEventListener('click', showLibrary);
    dom.btnNavRead.addEventListener('click', () => {
      if (currentBookMeta && currentRendition) {
        showReader();
      } else {
        showLibrary();
        showToast('请先从书库打开一本书', 'info');
      }
    });
    dom.btnNavCreate.addEventListener('click', showCreation);
    dom.btnLibraryCreate.addEventListener('click', showCreation);

    // File import
    dom.fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFileImport(file);
      dom.fileInput.value = '';
    });

    // Back to library
    dom.btnBack.addEventListener('click', showLibrary);

    // AI book Q&A
    dom.btnToggleAi.addEventListener('click', () => toggleAiPanel());
    dom.btnCloseAi.addEventListener('click', () => toggleAiPanel(false));
    dom.aiForm.addEventListener('submit', (e) => {
      e.preventDefault();
      askBookQuestion(dom.aiQuestionInput.value);
    });
    dom.aiPanel.querySelectorAll('[data-ai-question]').forEach(btn => {
      btn.addEventListener('click', () => askBookQuestion(btn.dataset.aiQuestion || ''));
    });

    // Toggle notes panel
    dom.btnAddBookmark.addEventListener('click', addBookmark);
    dom.btnToggleNotes.addEventListener('click', toggleNotesPanel);

    // Search
    dom.btnToggleSearch.addEventListener('click', toggleSearchPanel);
    dom.btnSearch.addEventListener('click', () => {
      const query = dom.searchInput.value.trim();
      if (query) performSearch(query);
    });
    dom.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const query = dom.searchInput.value.trim();
        if (query) performSearch(query);
      }
    });
    dom.btnSearchClose.addEventListener('click', toggleSearchPanel);

    // Progress slider
    dom.progressSlider.addEventListener('input', () => {
      const pct = parseInt(dom.progressSlider.value);
      dom.progressText.textContent = pct + '%';
    });
    dom.progressSlider.addEventListener('change', () => {
      if (!currentRendition) return;
      const pct = parseInt(dom.progressSlider.value) / 100;
      jumpToProgress(pct);
    });

    // Sync button
    dom.btnSync.addEventListener('click', syncToBackend);

    // Creation workspace
    dom.btnRefreshMaterials.addEventListener('click', renderCreationWorkspace);
    dom.materialBookFilter.addEventListener('input', renderMaterials);
    dom.materialTagFilter.addEventListener('input', renderMaterials);
    dom.btnSaveReflection.addEventListener('click', saveCurrentReflection);
    dom.btnDeleteReflection.addEventListener('click', deleteCurrentReflection);
    dom.btnGenerateVideo.addEventListener('click', () => generateDraft('video'));
    dom.btnGenerateArticle.addEventListener('click', () => generateDraft('article'));
    dom.btnSaveDraft.addEventListener('click', saveCurrentDraft);
    dom.btnExportDraft.addEventListener('click', exportCurrentDraft);
    dom.btnExportBook.addEventListener('click', exportCurrentBook);

    // Highlight color buttons
    dom.selectionToolbar.querySelectorAll('.btn-highlight').forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.dataset.color;
        applyHighlight(color);
      });
    });

    // Add note button (from selection toolbar)
    dom.selectionToolbar.querySelector('#btn-add-note').addEventListener('click', () => {
      openNewNoteEditor();
    });

    // Note modal
    dom.btnSaveNote.addEventListener('click', saveNote);
    dom.btnDeleteNote.addEventListener('click', deleteNoteHighlight);
    dom.btnCloseModal.addEventListener('click', closeNoteEditor);
    dom.noteModal.addEventListener('click', (e) => {
      if (e.target === dom.noteModal) closeNoteEditor();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Escape to close modals/toolbars
      if (e.key === 'Escape') {
        if (!dom.noteModal.hidden) {
          closeNoteEditor();
        } else {
          hideSelectionToolbar();
        }
        return;
      }
      // Arrow keys: page navigation (only when reader is active)
      if (dom.readerView.classList.contains('active') && currentRendition && !e.repeat && !isEditableTarget(e.target)) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          navigatePage('next', 'document-keyboard');
          return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          navigatePage('prev', 'document-keyboard');
          return;
        }
      }
      // Ctrl+S for sync
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (!dom.readerView.classList.contains('active')) return;
        syncToBackend();
      }
    });

    // Page navigation buttons
    dom.btnNavPrev.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigatePage('prev', 'button');
    });
    dom.btnNavNext.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigatePage('next', 'button');
    });

    // Online/offline
    window.addEventListener('online', () => showToast('网络已恢复', 'success'));
    window.addEventListener('offline', () => showToast('已离线 — 数据保存在本地', 'info'));
    window.addEventListener('resize', refreshReaderLayout);
  }

  // ==================== INIT ====================
  async function init() {
    try {
      await openDB();
      console.log('IndexedDB initialized');
    } catch (err) {
      console.error('Failed to open IndexedDB:', err);
      showToast('本地存储初始化失败', 'error');
      return;
    }

    bindEvents();
    registerSW();
    await renderLibrary();
    await updateSyncBadge();

    console.log('Marginalia ready 📖');
  }

  // Start the app
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
