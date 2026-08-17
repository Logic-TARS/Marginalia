/**
 * Marginalia — Core Application Logic
 * Handles: IndexedDB, epub.js reader, highlights, notes, sync, PWA
 */
(function () {
  'use strict';

  // ==================== CONSTANTS ====================
  const DB_NAME = 'marginalia';
  const DB_VERSION = 5;
  const API_BASE = '';  // same origin — works locally and remotely
  const API_TIMEOUT_MS = 5000;
  const READER_SYNC_TIMEOUT_MS = 3000;
  const EPUB_DOWNLOAD_TIMEOUT_MS = 60000;
  const EPUB_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
  // Keep in sync with the backend default MAX_EPUB_UPLOAD_MB (config.py).
  const EPUB_MAX_UPLOAD_MB = 90;
  const MOBILE_LAYOUT_QUERY = '(max-width: 900px)';
  const READER_CHROME_INITIAL_HIDE_MS = 2400;
  const READER_CHROME_AUTO_HIDE_MS = 3600;
  const READER_CHROME_AUTO_HIDE_KEY = 'marginalia.readerChromeAutoHide';
  const READER_TYPOGRAPHY_KEY = 'marginalia.readerTypography';
  const READER_FONT_FAMILIES = new Set(['original', 'serif', 'sans', 'kai']);
  const READER_FONT_STACKS = {
    serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, Georgia, serif',
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    kai: '"Kaiti SC", STKaiti, KaiTi, "楷体", serif',
  };
  const TTS_POSITION_KEY = 'marginalia.tts.position';
  const TTS_POLL_INTERVAL_MS = 1000;
  const TTS_CONTENT_BLOCK_SELECTOR = 'h1, h2, h3, h4, p, li, blockquote, figcaption';
  const TTS_FOLLOW_CLASS = 'marginalia-tts-follow';
  const TTS_FOLLOW_UNDERLINE_CLASS = 'marginalia-tts-follow-underline';
  const VIEW_ROUTES = {
    home: '#/',
    reader: '#/reader',
    creation: '#/creation',
  };
  const READER_DOUBLE_TAP_MAX_MS = 650;
  const READER_DOUBLE_TAP_MAX_DISTANCE = 72;
  const READER_TAP_MAX_MOVE = 28;
  const READER_TAP_MAX_DURATION = 500;
  const MOBILE_PAGE_TAP_ZONE_RATIO = 0.32;
  const MOBILE_PAGE_TAP_DEDUPE_MS = 650;
  const SWIPE_INTENT_THRESHOLD = 12;
  const SWIPE_DIRECTION_RATIO = 1.15;
  const SWIPE_MAX_DURATION = 1000;
  const SWIPE_FAST_VELOCITY = 0.35;
  const SWIPE_LONG_PRESS_MS = 600;
  const GESTURE_DEBUG_ENABLED = new URLSearchParams(window.location.search).has('gestureDebug');
  const mobileLayoutMedia = window.matchMedia(MOBILE_LAYOUT_QUERY);

  // ==================== STATE ====================
  let db = null;
  let currentBook = null;       // epub.js Book instance
  let currentRendition = null;  // epub.js Rendition instance
  let currentBookMeta = null;   // our DB book record
  let currentBookUrl = null;    // blob URL for current EPUB (for cleanup)
  let currentChapter = '';
  let currentChapterId = '';
  let currentCfi = '';
  let pendingSelection = null;  // { cfiRange, text } from last selection
  let selectedMaterialId = null;
  let selectedMaterialIds = new Set();
  let currentDraftId = null;
  let locationsReadyPromise = null;
  let locationsReadyBook = null;
  let lastPageInfo = null;
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
  let currentReaderFontFamily = 'original';
  const FONT_SIZE_STEP = 5;   // percent per scroll
  const FONT_SIZE_MIN = 60;
  const FONT_SIZE_MAX = 200;
  let searchResultsList = [];
  let searchHighlightKeys = [];
  let searchToken = 0;            // bumped to cancel an in-flight book search
  let searchDebounceTimer = null;
  let aiMessages = [];
  let aiConversations = [];
  let currentAiConversationId = null;
  let aiRequestInFlight = false;
  let aiIndexPollTimer = null;
  let pendingBookDelete = null;
  let lastDialogTrigger = null;
  const knowledgeUploadsInFlight = new Set();
  let readerSyncTimer = null;
  const serverMigrationsInFlight = new Set();
  let operationBookId = null;
  let operationHideTimer = null;
  let selectionSettleTimer = null;
  let selectionInteractionUntil = 0;
  let readerChromeVisible = true;
  let readerChromeAutoHideEnabled = true;
  let readerChromeHideTimer = null;
  let readerChromeHoverCloseTimer = null;
  let readerNavigatorHoverCloseTimer = null;
  let readerNotesHoverCloseTimer = null;
  let readerIframeObserver = null;
  let currentView = 'home';
  let ttsTask = null;
  let ttsChapterId = '';
  let ttsSegmentIndex = 0;
  let ttsPollTimer = null;
  let ttsWantsPlay = false;
  let ttsIsPlaying = false;
  let ttsPlaybackStarting = false;
  let ttsRestoredPosition = null;
  let ttsLastSavedAt = 0;
  let ttsFollowCfi = '';
  let ttsFollowCueKey = '';
  let ttsFollowUpdateToken = 0;
  let ttsFollowNavigationInProgress = false;
  let ttsFollowPendingNavigation = null;
  let ttsFollowNavigationWorker = null;
  let ttsFollowDocumentCache = null;
  let ttsNavigationNoticeAt = 0;

  // ==================== DOM REFS ====================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    app: $('#app'),
    libraryView: $('#library-view'),
    readerView: $('#reader-view'),
    readerToolbar: $('.reader-toolbar'),
    readerMain: $('.reader-main'),
    readerNavigator: $('#reader-navigator'),
    tocList: $('#toc-list'),
    btnToggleNavigator: $('#btn-toggle-navigator'),
    btnCloseNavigator: $('#btn-close-navigator'),
    btnRevealNavigator: $('#btn-reveal-navigator'),
    bookList: $('#book-list'),
    emptyLibrary: $('#empty-library'),
    fileInput: $('#file-input'),
    operationStatus: $('#operation-status'),
    operationStatusMessage: $('#operation-status-message'),
    operationStatusDetail: $('#operation-status-detail'),
    operationStatusProgress: $('#operation-status-progress'),
    operationStatusProgressBar: $('#operation-status-progress-bar'),
    btnOperationRetry: $('#btn-operation-retry'),
    btnOperationClose: $('#btn-operation-close'),
    epubContainer: $('#epub-container'),
    notesPanel: $('#notes-panel'),
    btnCloseNotesPanel: $('#btn-close-notes-panel'),
    btnRevealNotes: $('#btn-reveal-notes'),
    readerPanelBackdrop: $('#reader-panel-backdrop'),
    bookmarksList: $('#bookmarks-list'),
    bookmarksCount: $('#bookmarks-count'),
    notesList: $('#notes-list'),
    notesCount: $('#notes-count'),
    toolbarBookTitle: $('#toolbar-book-title'),
    toolbarChapter: $('#toolbar-chapter'),
    progressText: $('#progress-text'),
    pageText: $('#page-text'),
    btnBack: $('#btn-back'),
    btnToggleAi: $('#btn-toggle-ai'),
    btnReaderTools: $('#btn-reader-tools'),
    btnRevealReaderChrome: $('#btn-reveal-reader-chrome'),
    readerToolPanel: $('#reader-tool-panel'),
    btnCloseAi: $('#btn-close-ai'),
    aiPanel: $('#ai-panel'),
    aiMessages: $('#ai-messages'),
    aiForm: $('#ai-form'),
    aiQuestionInput: $('#ai-question-input'),
    btnSendAi: $('#btn-send-ai'),
    aiIndexStatus: $('#ai-index-status'),
    aiConversationSelect: $('#ai-conversation-select'),
    btnNewAiConversation: $('#btn-new-ai-conversation'),
    btnDeleteAiConversation: $('#btn-delete-ai-conversation'),
    btnRetryAiIndex: $('#btn-retry-ai-index'),
    btnAddBookmark: $('#btn-add-bookmark'),
    btnToggleNotes: $('#btn-toggle-notes'),
    btnToggleSearch: $('#btn-toggle-search'),
    btnToggleTts: $('#btn-toggle-tts'),
    btnToggleReaderAutoHide: $('#btn-toggle-reader-auto-hide'),
    readerFontFamily: $('#reader-font-family'),
    readerFontSize: $('#reader-font-size'),
    readerFontSizeValue: $('#reader-font-size-value'),
    btnReaderFontDecrease: $('#btn-reader-font-decrease'),
    btnReaderFontReset: $('#btn-reader-font-reset'),
    btnReaderFontIncrease: $('#btn-reader-font-increase'),
    ttsPanel: $('#tts-panel'),
    ttsStatus: $('#tts-status'),
    ttsVoice: $('#tts-voice'),
    ttsRate: $('#tts-rate'),
    ttsContinuous: $('#tts-continuous'),
    ttsAudio: $('#tts-audio'),
    ttsProgress: $('#tts-progress'),
    ttsTime: $('#tts-time'),
    ttsSegmentLabel: $('#tts-segment-label'),
    btnCloseTts: $('#btn-close-tts'),
    btnTtsStart: $('#btn-tts-start'),
    btnTtsPrev: $('#btn-tts-prev'),
    btnTtsPlay: $('#btn-tts-play'),
    btnTtsPause: $('#btn-tts-pause'),
    btnTtsNext: $('#btn-tts-next'),
    toolbarSearch: $('#toolbar-search'),
    searchInput: $('#search-input'),
    btnSearch: $('#btn-search'),
    btnSearchClose: $('#btn-search-close'),
    btnCloseSearchPanel: $('#btn-close-search-panel'),
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
    readerLoading: $('#reader-loading'),
    readerLoadingMessage: $('#reader-loading-message'),
    readerLoadingDetail: $('#reader-loading-detail'),
    readerLoadingProgress: $('#reader-loading-progress'),
    readerLoadingProgressBar: $('#reader-loading-progress-bar'),
    readerLoadingProgressText: $('#reader-loading-progress-text'),
    btnLibraryCreate: $('#btn-library-create'),
    creationView: $('#creation-view'),
    btnCreationBack: $('#btn-creation-back'),
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
    bookDeleteModal: $('#book-delete-modal'),
    bookDeleteMessage: $('#book-delete-message'),
    btnCancelBookDelete: $('#btn-cancel-book-delete'),
    btnDeleteLocalBook: $('#btn-delete-local-book'),
    btnDeleteAllBookData: $('#btn-delete-all-book-data'),
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

        if (!d.objectStoreNames.contains('sync_queue')) {
          const syncStore = d.createObjectStore('sync_queue', { keyPath: 'id' });
          syncStore.createIndex('by_book', 'book_id', { unique: false });
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

  async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('请求超时，请检查网络后重试');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function setOperationStatus({
    bookId = null,
    message,
    detail = '',
    progress = null,
    tone = 'info',
    retry = false,
    autoHideMs = 0,
  }) {
    if (!dom.operationStatus) return;
    operationBookId = bookId;
    dom.operationStatusMessage.textContent = message;
    dom.operationStatusDetail.textContent = detail;
    dom.operationStatusDetail.hidden = !detail;
    dom.operationStatus.dataset.tone = tone;
    dom.btnOperationRetry.hidden = !retry;
    if (progress === null || !Number.isFinite(progress)) {
      dom.operationStatusProgress.hidden = true;
      dom.operationStatusProgress.removeAttribute('aria-valuenow');
    } else {
      const percent = Math.max(0, Math.min(100, Math.round(progress)));
      dom.operationStatusProgress.hidden = false;
      dom.operationStatusProgress.setAttribute('aria-valuenow', String(percent));
      dom.operationStatusProgressBar.style.width = percent + '%';
    }
    dom.operationStatus.hidden = false;
    if (operationHideTimer) clearTimeout(operationHideTimer);
    if (autoHideMs > 0) {
      operationHideTimer = setTimeout(() => hideOperationStatus(bookId), autoHideMs);
    }
  }

  function hideOperationStatus(bookId = null) {
    if (!dom.operationStatus || (bookId && operationBookId !== bookId)) return;
    dom.operationStatus.hidden = true;
    operationBookId = null;
    if (operationHideTimer) clearTimeout(operationHideTimer);
    operationHideTimer = null;
  }

  function isServerBookRecord(book) {
    return Boolean(book && (book.server_book_id || book.source === 'server' || book._source === 'server'));
  }

  function hasFreshLocalEpub(book) {
    if (!book || !book.file_blob) return false;
    if (!isServerBookRecord(book)) return true;
    return !book.content_hash ||
      !book.cached_content_hash ||
      book.cached_content_hash === book.content_hash;
  }

  function formatEpubAvailability(book) {
    if (!isServerBookRecord(book)) return '本机书籍';
    return hasFreshLocalEpub(book) ? '已保存到本机' : '需要联网打开';
  }

  function getTransferState(book) {
    if (book.transfer_status) return book.transfer_status;
    if (isServerBookRecord(book)) return 'synced';
    return book.file_blob ? 'local_only' : 'failed';
  }

  function formatTransferStatus(book) {
    const status = getTransferState(book);
    const progress = Math.max(0, Math.min(100, Math.round(book.transfer_progress || 0)));
    const labels = {
      reading: '正在读取文件',
      parsing: '正在解析 EPUB',
      local_ready: '本机可阅读，等待上传',
      local_only: '仅保存在此设备',
      uploading: `上传服务器 ${progress}%`,
      verifying: '服务器正在校验',
      synced: '已保存到服务器',
      failed: '上传失败，仅保存在此设备',
    };
    return labels[status] || labels.local_only;
  }

  function updateBookTransferUI(book) {
    if (!book || !dom.bookList) return;
    const escapedId = window.CSS && CSS.escape ? CSS.escape(String(book.id)) : String(book.id);
    const card = dom.bookList.querySelector(`.book-card[data-book-id="${escapedId}"]`);
    if (!card) return;
    const status = getTransferState(book);
    const label = card.querySelector('.book-transfer-label');
    const row = card.querySelector('.book-transfer-status');
    const progress = card.querySelector('.book-transfer-progress');
    const progressBar = progress && progress.querySelector('span');
    const retry = card.querySelector('.book-transfer-retry');
    if (label) label.textContent = formatTransferStatus(book);
    if (row) row.dataset.state = status;
    if (progress) progress.hidden = status !== 'uploading';
    if (progressBar) progressBar.style.width = Math.max(0, Math.min(100, book.transfer_progress || 0)) + '%';
    if (retry) retry.hidden = status !== 'failed' && status !== 'local_only';
  }

  async function setBookTransferState(book, status, progress = null, error = '') {
    if (!book) return;
    book.transfer_status = status;
    if (progress !== null) book.transfer_progress = Math.max(0, Math.min(100, progress));
    book.transfer_error = error || '';
    await dbPut('books', book);
    updateBookTransferUI(book);
  }

  async function queueReaderSync(bookId, type, entityId = '', payload = {}) {
    if (!bookId || !dbHasStore('sync_queue')) return;
    const key = `${type}:${bookId}:${entityId || 'state'}`;
    await dbPut('sync_queue', {
      id: key,
      op_id: uuid(),
      book_id: bookId,
      type,
      entity_id: entityId,
      payload,
      queued_at: Date.now(),
    });
    updateSyncBadge();
    scheduleReaderSync(bookId);
  }

  function scheduleReaderSync(bookId) {
    if (!bookId || !navigator.onLine) return;
    if (readerSyncTimer) clearTimeout(readerSyncTimer);
    readerSyncTimer = setTimeout(() => {
      readerSyncTimer = null;
      syncBookState(bookId).catch(() => {});
    }, 1500);
  }

  function setReaderLoading(message, detail = '') {
    if (!dom.readerLoading) return;
    if (!dom.readerLoading.isConnected && dom.epubContainer) {
      dom.epubContainer.appendChild(dom.readerLoading);
    }
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
    if (currentBookMeta.server_book_id || currentBookMeta.source === 'server') {
      await queueReaderSync(currentBookMeta.id, 'progress.set', '', {
        cfi: currentBookMeta.last_cfi || '',
        progress_percent: currentBookMeta.progress_percent || 0,
        last_opened: currentBookMeta.last_opened || Date.now(),
      });
    }
  }

  function writeViewHistory(view, mode = 'push', extraState = {}) {
    if (mode === 'none') return;
    const state = {
      ...(history.state || {}),
      marginaliaView: view,
      ...extraState,
    };
    const route = VIEW_ROUTES[view] || VIEW_ROUTES.home;
    if (mode === 'replace' || history.state?.marginaliaView === view) {
      history.replaceState(state, '', route);
    } else {
      history.pushState(state, '', route);
    }
  }

  function returnToHome() {
    if (history.state?.marginaliaView === 'reader' || history.state?.marginaliaView === 'creation') {
      history.back();
      return;
    }
    showHome({ historyMode: 'replace' });
  }

  async function showHome({ historyMode = 'push' } = {}) {
    // Flush progress to IndexedDB before clearing state
    await saveCurrentProgress();
    stopTtsForChapter({ resetTask: true });

    // Destroy epub.js resources BEFORE nulling references
    if (currentRendition) {
      try { currentRendition.destroy(); } catch (_e) { /* already destroyed */ }
      currentRendition = null;
    }
    if (currentBook) {
      try { currentBook.destroy(); } catch (_e) { /* already destroyed */ }
      currentBook = null;
    }

    // Clear epub.js resources without deleting the persistent loading overlay.
    Array.from(dom.epubContainer.children).forEach((child) => {
      if (child !== dom.readerLoading) child.remove();
    });
    dom.epubContainer.style.display = '';

    // Reset all reader state
    currentCfi = '';
    currentChapter = '';
    currentChapterId = '';
    pendingSelection = null;
    selectedMaterialId = null;
    selectedMaterialIds.clear();
    currentDraftId = null;
    _boundIframeDocuments = new WeakSet();
    locationsReadyPromise = null;
    locationsReadyBook = null;

    dom.libraryView.classList.add('active');
    dom.readerView.classList.remove('active');
    dom.creationView.classList.remove('active');
    document.body.classList.remove('reader-active');
    resetReaderChrome();
    closeMobileReaderPanels();
    syncReaderPanelBackdrop();
    setReaderToolsOpen(false);
    dom.ttsPanel.hidden = true;
    syncReaderToolStates();
    hideReaderLoading();
    hideSelectionToolbar();
    if (currentBookUrl) {
      URL.revokeObjectURL(currentBookUrl);
      currentBookUrl = null;
    }
    currentBookMeta = null;
    currentView = 'home';
    writeViewHistory('home', historyMode, { bookId: '' });
    renderLibrary();
  }

  function showReader({ historyMode = 'push', bookId = '' } = {}) {
    dom.libraryView.classList.remove('active');
    dom.readerView.classList.add('active');
    dom.creationView.classList.remove('active');
    document.body.classList.add('reader-active');
    setReaderChromeVisible(isMobileLayout());
    currentView = 'reader';
    writeViewHistory('reader', historyMode, { bookId: bookId || currentBookMeta?.id || '' });
    syncReaderToolStates();
    syncReaderPanelBackdrop();
    if (currentRendition && isMobileLayout()) scheduleReaderChromeHide(READER_CHROME_INITIAL_HIDE_MS);
  }

  async function showCreation({ historyMode = 'push' } = {}) {
    dom.libraryView.classList.remove('active');
    dom.readerView.classList.remove('active');
    dom.creationView.classList.add('active');
    document.body.classList.remove('reader-active');
    resetReaderChrome();
    closeMobileReaderPanels();
    syncReaderPanelBackdrop();
    currentView = 'creation';
    writeViewHistory('creation', historyMode, { bookId: '' });
    await renderCreationWorkspace();
  }

  async function restoreViewFromHistory() {
    const state = history.state || {};
    if (state.marginaliaView === 'creation' && window.location.hash === VIEW_ROUTES.creation) {
      await showCreation({ historyMode: 'none' });
      return;
    }
    if (state.marginaliaView === 'reader' && state.bookId && window.location.hash === VIEW_ROUTES.reader) {
      const book = await dbGet('books', state.bookId);
      if (book) {
        await openBook(book, { historyMode: 'none' });
        return;
      }
    }
    currentView = 'home';
    writeViewHistory('home', 'replace', { bookId: '' });
  }

  async function handleHistoryNavigation(event) {
    const target = event.state?.marginaliaView || 'home';
    if (target === 'creation') {
      await showCreation({ historyMode: 'none' });
      return;
    }
    if (target === 'reader' && event.state?.bookId) {
      if (currentView === 'reader' && currentBookMeta?.id === event.state.bookId && currentRendition) {
        showReader({ historyMode: 'none', bookId: event.state.bookId });
        return;
      }
      const book = await dbGet('books', event.state.bookId);
      if (book) {
        await openBook(book, { historyMode: 'none' });
        return;
      }
    }
    await showHome({ historyMode: target === 'home' ? 'none' : 'replace' });
  }

  function safeFocus(el) {
    if (el && typeof el.focus === 'function') {
      setTimeout(() => el.focus(), 0);
    }
  }

  function rememberDialogTrigger() {
    const active = document.activeElement;
    lastDialogTrigger = active instanceof HTMLElement ? active : null;
  }

  function restoreDialogTrigger() {
    const target = lastDialogTrigger && document.contains(lastDialogTrigger)
      ? lastDialogTrigger
      : null;
    lastDialogTrigger = null;
    safeFocus(target);
  }

  function isMobileLayout() {
    return mobileLayoutMedia.matches;
  }

  function cancelReaderChromeHide() {
    if (readerChromeHideTimer) {
      clearTimeout(readerChromeHideTimer);
      readerChromeHideTimer = null;
    }
  }

  function hasOpenReaderSurface() {
    return !dom.readerToolPanel.hidden ||
      (isMobileLayout() && !dom.readerNavigator.classList.contains('collapsed')) ||
      !dom.aiPanel.classList.contains('collapsed') ||
      !dom.notesPanel.classList.contains('collapsed') ||
      !dom.searchPanel.hidden ||
      !dom.ttsPanel.hidden ||
      !dom.noteModal.hidden ||
      !dom.bookDeleteModal.hidden ||
      !dom.readerLoading.hidden;
  }

  function canAutoHideReaderChrome() {
    return readerChromeAutoHideEnabled &&
      dom.readerView.classList.contains('active') &&
      Boolean(currentRendition) &&
      !hasOpenReaderSurface();
  }

  function setChromeElementHidden(element, hidden) {
    if (!element) return;
    if (hidden) {
      element.setAttribute('aria-hidden', 'true');
      element.inert = true;
    } else {
      element.removeAttribute('aria-hidden');
      element.inert = false;
    }
  }

  function setReaderChromeVisible(visible, { autoHide = false, force = false } = {}) {
    const readerIsActive = dom.readerView.classList.contains('active');
    const shouldShow = !readerIsActive ? true : Boolean(visible);
    if (!shouldShow && !force && hasOpenReaderSurface()) return false;

    cancelReaderChromeHide();
    if (!shouldShow && !dom.readerToolPanel.hidden) {
      setReaderToolsOpen(false, { skipChromeSchedule: true });
    }

    readerChromeVisible = shouldShow;
    dom.readerView.classList.toggle('reader-chrome-hidden', !shouldShow);
    document.body.classList.toggle('reader-chrome-hidden', !shouldShow && readerIsActive);
    setChromeElementHidden(dom.readerToolbar, !shouldShow);

    if (shouldShow && autoHide) scheduleReaderChromeHide();
    return true;
  }

  function scheduleReaderChromeHide(delay = READER_CHROME_AUTO_HIDE_MS) {
    cancelReaderChromeHide();
    if (!isMobileLayout()) return;
    if (!canAutoHideReaderChrome()) return;
    readerChromeHideTimer = setTimeout(() => {
      readerChromeHideTimer = null;
      setReaderChromeVisible(false);
    }, delay);
  }

  function cancelReaderChromeHoverClose() {
    if (!readerChromeHoverCloseTimer) return;
    clearTimeout(readerChromeHoverCloseTimer);
    readerChromeHoverCloseTimer = null;
  }

  function openReaderChromeOnHover() {
    if (isMobileLayout()) return;
    cancelReaderChromeHoverClose();
    setReaderChromeVisible(true);
  }

  function scheduleReaderChromeHoverClose() {
    if (isMobileLayout()) return;
    cancelReaderChromeHoverClose();
    readerChromeHoverCloseTimer = setTimeout(() => {
      readerChromeHoverCloseTimer = null;
      setReaderChromeVisible(false);
    }, 160);
  }

  function revealReaderChromeTemporarily() {
    cancelReaderChromeHoverClose();
    setReaderChromeVisible(true);
    if (isMobileLayout()) scheduleReaderChromeHide();
  }

  function toggleReaderChromeFromContent() {
    if (!readerChromeAutoHideEnabled) return;
    if (!dom.readerView.classList.contains('active') || hasOpenReaderSurface()) return;
    if (pendingSelection || !dom.selectionToolbar.hidden) return;
    setReaderChromeVisible(!readerChromeVisible, { autoHide: !readerChromeVisible });
  }

  function updateReaderChromeAutoHideUI() {
    if (!dom.btnToggleReaderAutoHide) return;
    dom.btnToggleReaderAutoHide.setAttribute('aria-pressed', String(readerChromeAutoHideEnabled));
    dom.btnToggleReaderAutoHide.textContent = readerChromeAutoHideEnabled
      ? '自动收起：开'
      : '自动收起：关';
  }

  function loadReaderChromeAutoHidePreference() {
    try {
      readerChromeAutoHideEnabled = localStorage.getItem(READER_CHROME_AUTO_HIDE_KEY) !== 'false';
    } catch (_err) {
      readerChromeAutoHideEnabled = true;
    }
    updateReaderChromeAutoHideUI();
  }

  function setReaderChromeAutoHideEnabled(enabled, { persist = true, notify = true } = {}) {
    readerChromeAutoHideEnabled = Boolean(enabled);
    if (persist) {
      try {
        localStorage.setItem(READER_CHROME_AUTO_HIDE_KEY, String(readerChromeAutoHideEnabled));
      } catch (_err) {
        // The preference remains active for this session if storage is blocked.
      }
    }
    updateReaderChromeAutoHideUI();
    if (readerChromeAutoHideEnabled) {
      if (isMobileLayout()) scheduleReaderChromeHide();
      else setReaderChromeVisible(false);
    } else {
      cancelReaderChromeHide();
      setReaderChromeVisible(true);
    }
    if (notify) {
      showToast(readerChromeAutoHideEnabled ? '已开启阅读栏自动收起' : '已关闭阅读栏自动收起', 'info');
    }
  }

  function normalizeReaderFontSize(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 100;
    const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, parsed));
    return Math.round(clamped / FONT_SIZE_STEP) * FONT_SIZE_STEP;
  }

  function updateReaderTypographyUI() {
    if (dom.readerFontFamily) dom.readerFontFamily.value = currentReaderFontFamily;
    if (dom.readerFontSize) dom.readerFontSize.value = String(currentFontSize);
    if (dom.readerFontSizeValue) dom.readerFontSizeValue.value = `${currentFontSize}%`;
    if (dom.btnReaderFontDecrease) dom.btnReaderFontDecrease.disabled = currentFontSize <= FONT_SIZE_MIN;
    if (dom.btnReaderFontIncrease) dom.btnReaderFontIncrease.disabled = currentFontSize >= FONT_SIZE_MAX;
  }

  function persistReaderTypographyPreference() {
    try {
      localStorage.setItem(READER_TYPOGRAPHY_KEY, JSON.stringify({
        fontFamily: currentReaderFontFamily,
        fontSize: currentFontSize,
      }));
    } catch (_err) {
      // The preference remains active for this session if storage is blocked.
    }
  }

  function loadReaderTypographyPreference() {
    currentReaderFontFamily = 'original';
    currentFontSize = 100;
    try {
      const saved = JSON.parse(localStorage.getItem(READER_TYPOGRAPHY_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        if (READER_FONT_FAMILIES.has(saved.fontFamily)) {
          currentReaderFontFamily = saved.fontFamily;
        }
        currentFontSize = normalizeReaderFontSize(saved.fontSize);
      }
    } catch (_err) {
      currentReaderFontFamily = 'original';
      currentFontSize = 100;
    }
    updateReaderTypographyUI();
  }

  function applyReaderTypographyToDocument(doc) {
    if (!doc || !doc.head || !doc.documentElement) return;
    const styleId = 'marginalia-reader-typography-style';
    const existingStyle = doc.getElementById(styleId);
    if (currentReaderFontFamily === 'original') {
      doc.documentElement.removeAttribute('data-marginalia-reader-font');
      if (existingStyle) existingStyle.remove();
      return;
    }

    const fontStack = READER_FONT_STACKS[currentReaderFontFamily];
    if (!fontStack) return;
    doc.documentElement.setAttribute('data-marginalia-reader-font', currentReaderFontFamily);
    const style = existingStyle || doc.createElement('style');
    style.id = styleId;
    style.textContent = `body, body * { font-family: ${fontStack} !important; }`;
    if (!existingStyle) doc.head.appendChild(style);
  }

  function applyReaderTypography({ refresh = true } = {}) {
    const anchorCfi = getCurrentAnchorCfi();
    if (currentRendition && currentRendition.themes) {
      currentRendition.themes.fontSize(`${currentFontSize}%`);
    }
    for (const iframe of findReaderIframes()) {
      try {
        applyReaderTypographyToDocument(iframe.contentDocument);
      } catch (_err) {
        // Ignore inaccessible or not-yet-ready rendition frames.
      }
    }
    if (refresh && currentRendition) {
      refreshReaderLayout({ anchorCfi });
    }
  }

  function setReaderFontSize(value, { persist = true } = {}) {
    currentFontSize = normalizeReaderFontSize(value);
    updateReaderTypographyUI();
    if (persist) persistReaderTypographyPreference();
    applyReaderTypography();
  }

  function setReaderFontFamily(value, { persist = true } = {}) {
    currentReaderFontFamily = READER_FONT_FAMILIES.has(value) ? value : 'original';
    updateReaderTypographyUI();
    if (persist) persistReaderTypographyPreference();
    applyReaderTypography();
  }

  function resetReaderChrome() {
    cancelReaderChromeHide();
    readerChromeVisible = true;
    dom.readerView.classList.remove('reader-chrome-hidden');
    document.body.classList.remove('reader-chrome-hidden');
    setChromeElementHidden(dom.readerToolbar, false);
  }

  function syncReaderToolStates() {
    if (dom.btnReaderTools) {
      dom.btnReaderTools.setAttribute('aria-expanded', String(!dom.readerToolPanel.hidden));
    }
    if (dom.btnToggleNavigator) {
      dom.btnToggleNavigator.setAttribute('aria-expanded', String(!dom.readerNavigator.classList.contains('collapsed')));
    }
    if (dom.btnToggleAi) {
      dom.btnToggleAi.setAttribute('aria-expanded', String(!dom.aiPanel.classList.contains('collapsed')));
    }
    if (dom.btnToggleNotes) {
      dom.btnToggleNotes.setAttribute('aria-expanded', String(!dom.notesPanel.classList.contains('collapsed')));
    }
    if (dom.btnToggleSearch) {
      dom.btnToggleSearch.setAttribute('aria-expanded', String(!dom.searchPanel.hidden));
    }
    if (dom.btnToggleTts) {
      dom.btnToggleTts.setAttribute('aria-expanded', String(!dom.ttsPanel.hidden));
    }
  }

  function syncReaderPanelBackdrop() {
    const hasOpenPanel = isMobileLayout() && dom.readerView.classList.contains('active') && (
      !dom.readerNavigator.classList.contains('collapsed') ||
      !dom.aiPanel.classList.contains('collapsed') ||
      !dom.notesPanel.classList.contains('collapsed') ||
      !dom.searchPanel.hidden ||
      !dom.ttsPanel.hidden
    );
    dom.readerPanelBackdrop.hidden = !hasOpenPanel;
    document.body.classList.toggle('reader-panel-open', hasOpenPanel);
  }

  function closeOtherMobileReaderPanels(except) {
    if (!isMobileLayout()) return;
    if (except !== 'navigator') {
      dom.readerNavigator.classList.remove('open');
      dom.readerNavigator.classList.add('collapsed');
      dom.readerNavigator.setAttribute('aria-hidden', 'true');
      dom.readerView.classList.remove('navigator-open');
    }
    if (except !== 'ai') {
      dom.aiPanel.classList.add('collapsed');
      dom.readerMain.classList.add('ai-collapsed');
    }
    if (except !== 'notes') {
      dom.notesPanel.classList.remove('open');
      dom.notesPanel.classList.add('collapsed');
      dom.readerMain.classList.add('notes-collapsed');
      dom.readerView.classList.remove('notes-open');
    }
    if (except !== 'search') {
      dom.searchPanel.hidden = true;
      dom.toolbarSearch.hidden = true;
      dom.btnSearchClose.hidden = true;
    }
    if (except !== 'tts') {
      dom.ttsPanel.hidden = true;
    }
  }

  function closeMobileReaderPanels({ restoreFocus = false } = {}) {
    if (!isMobileLayout()) return false;
    const hadOpenPanel = !dom.readerNavigator.classList.contains('collapsed') ||
      !dom.aiPanel.classList.contains('collapsed') ||
      !dom.notesPanel.classList.contains('collapsed') ||
      !dom.searchPanel.hidden ||
      !dom.ttsPanel.hidden;
    closeOtherMobileReaderPanels('');
    setReaderToolsOpen(false);
    syncReaderToolStates();
    syncReaderPanelBackdrop();
    if (hadOpenPanel) {
      refreshReaderLayout();
      if (restoreFocus) safeFocus(dom.btnReaderTools);
    }
    return hadOpenPanel;
  }

  function setReaderNavigatorOpen(open, { restoreFocus = false } = {}) {
    const shouldOpen = Boolean(open);
    if (shouldOpen) {
      if (isMobileLayout()) {
        setReaderChromeVisible(true);
        cancelReaderChromeHide();
      }
      closeOtherMobileReaderPanels('navigator');
      if (isMobileLayout()) {
        setReaderToolsOpen(false, { skipChromeSchedule: true });
      } else if (!dom.aiPanel.classList.contains('collapsed')) {
        dom.aiPanel.classList.add('collapsed');
        dom.readerMain.classList.add('ai-collapsed');
        refreshReaderLayout();
      }
    }
    dom.readerNavigator.classList.toggle('open', shouldOpen);
    dom.readerNavigator.classList.toggle('collapsed', !shouldOpen);
    dom.readerNavigator.setAttribute('aria-hidden', String(!shouldOpen));
    dom.readerView.classList.toggle('navigator-open', shouldOpen);
    syncReaderToolStates();
    syncReaderPanelBackdrop();
    if (!shouldOpen) {
      if (restoreFocus) safeFocus(dom.btnToggleNavigator);
      scheduleReaderChromeHide();
    }
  }

  function toggleReaderNavigator() {
    setReaderNavigatorOpen(dom.readerNavigator.classList.contains('collapsed'));
  }

  function cancelReaderNavigatorHoverClose() {
    if (!readerNavigatorHoverCloseTimer) return;
    clearTimeout(readerNavigatorHoverCloseTimer);
    readerNavigatorHoverCloseTimer = null;
  }

  function openReaderNavigatorOnHover() {
    if (isMobileLayout()) return;
    cancelReaderNavigatorHoverClose();
    setReaderNavigatorOpen(true);
  }

  function scheduleReaderNavigatorHoverClose() {
    if (isMobileLayout()) return;
    cancelReaderNavigatorHoverClose();
    readerNavigatorHoverCloseTimer = setTimeout(() => {
      readerNavigatorHoverCloseTimer = null;
      setReaderNavigatorOpen(false);
    }, 160);
  }

  function setReaderToolsOpen(open, { restoreFocus = false, skipChromeSchedule = false } = {}) {
    if (open) {
      setReaderChromeVisible(true);
      cancelReaderChromeHide();
    }
    dom.readerToolPanel.hidden = !open;
    syncReaderToolStates();
    if (!open && restoreFocus) {
      safeFocus(dom.btnReaderTools);
    }
    if (!open && !skipChromeSchedule) scheduleReaderChromeHide();
  }

  function toggleReaderTools() {
    setReaderToolsOpen(dom.readerToolPanel.hidden);
  }

  // ==================== LIBRARY ====================
  async function renderLibrary() {
    await mergeDuplicateBooks();

    // Always paint IndexedDB first. Network refresh and migrations run later.
    const allBooks = await dbGetAll('books');
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
      const isServer = isServerBookRecord(book);
      const transferState = getTransferState(book);
      const transferProgress = Math.max(0, Math.min(100, book.transfer_progress || 0));
      card.dataset.bookId = book.id;
      if (isServer) card.dataset.serverBook = 'true';

      const highlightCount = await getBookHighlightCount(book.id);
      const bookTitle = book.book_title || '未命名书籍';
      const titleCharacters = Array.from(bookTitle.trim());
      const coverInitial = titleCharacters[0] || 'M';
      const coverPalettes = [
        ['#315f4a', '#1d3d30', '#d9c28b'],
        ['#72513c', '#432f26', '#ead0a0'],
        ['#44566f', '#293746', '#d5c39b'],
        ['#67516f', '#3f3146', '#e2c69d'],
        ['#736638', '#463e24', '#ead59c'],
      ];
      const paletteSeed = titleCharacters.reduce((sum, character) => sum + character.codePointAt(0), 0);
      const coverPalette = coverPalettes[paletteSeed % coverPalettes.length];
      const progressPercent = Math.max(0, Math.min(100, Number(book.progress_percent || 0)));
      const lastOpened = formatRelativeDate(book.last_opened) || '尚未阅读';
      card.style.setProperty('--book-cover-start', coverPalette[0]);
      card.style.setProperty('--book-cover-end', coverPalette[1]);
      card.style.setProperty('--book-cover-ink', coverPalette[2]);
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `打开《${bookTitle}》`);

      card.innerHTML = `
        <div class="book-card-cover" aria-hidden="true">
          <span class="book-card-cover-initial">${escapeHTML(coverInitial)}</span>
          <span class="book-card-cover-mark">Marginalia</span>
        </div>
        <div class="book-card-info">
          <div class="book-card-badges">
            <span class="book-source-badge">${isServer ? '云端书库' : '本机书籍'}</span>
            <span class="book-ai-badge" data-state="${escapeHTML(book.knowledge_status || 'unregistered')}">${escapeHTML(formatKnowledgeStatus(book.knowledge_status))}</span>
          </div>
          <div class="book-card-title">${escapeHTML(bookTitle)}</div>
          <div class="book-card-author">${escapeHTML(book.book_author || '未知作者')}</div>
          <div class="book-card-meta">
            <span class="book-source-compat" aria-hidden="true">${isServer ? '服务器' : '本机'}</span>
            <span>${highlightCount} 条划线</span>
            <span>${escapeHTML(lastOpened)}</span>
            <span>${escapeHTML(formatEpubAvailability(book))}</span>
          </div>
          <div class="book-transfer-status" data-state="${escapeHTML(transferState)}">
            <span class="book-transfer-label">${escapeHTML(formatTransferStatus(book))}</span>
            <span class="book-transfer-progress" ${transferState === 'uploading' ? '' : 'hidden'}>
              <span style="width:${transferProgress}%"></span>
            </span>
            <button class="book-transfer-retry" data-action="retry-upload" type="button"
                    ${transferState === 'failed' || transferState === 'local_only' ? '' : 'hidden'}>
              重试
            </button>
          </div>
          <div class="book-progress-copy"><span>阅读进度</span><strong>${Math.round(progressPercent)}%</strong></div>
          <div class="book-card-progress" role="progressbar" aria-label="阅读进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progressPercent)}">
            <div class="book-card-progress-bar" style="width:${progressPercent}%"></div>
          </div>
        </div>
        <button class="book-card-delete" data-action="delete" title="删除《${escapeHTML(bookTitle)}》" aria-label="删除《${escapeHTML(bookTitle)}》" type="button">×</button>
      `;

      const openCard = (event) => {
        if (event && event.target.closest('[data-action]')) return;
        openBook(book);
      };
      card.addEventListener('click', openCard);
      card.addEventListener('keydown', (event) => {
        if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        openCard(event);
      });

      const deleteBtn = card.querySelector('.book-card-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          openBookDeleteDialog(book);
        });
      }

      const retryBtn = card.querySelector('[data-action="retry-upload"]');
      if (retryBtn) {
        retryBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await retryBookUpload(book);
        });
      }

      dom.bookList.appendChild(card);
    }
  }

  async function fetchServerBooks(existingBooks) {
    try {
      const resp = await fetchWithTimeout(API_BASE + '/api/books');
      if (!resp.ok) return [];
      const data = await resp.json();
      const existing = existingBooks || await dbGetAll('books');

      return Promise.all((data.books || []).map(async b => {
        // Find existing IndexedDB record for this server book (for progress tracking)
        const existingBook = existing.find(eb =>
          eb.id === b.id ||
          eb.server_book_id === b.id ||
          (eb.content_hash && eb.content_hash === b.content_hash) ||
          eb.filename === b.filename
        );
        if (existingBook && existingBook.id !== b.id) {
          await rekeyBookToServer(existingBook, b, existingBook.file_blob || null);
        }
        const localBook = existingBook && existingBook.id === b.id
          ? existingBook
          : (await dbGet('books', b.id));
        const serverHash = b.content_hash || '';
        const localBlob = localBook ? (localBook.file_blob || null) : null;
        const localCachedHash = localBook ? (localBook.cached_content_hash || '') : '';
        const cacheMatchesServer = Boolean(localBlob) && (
          !serverHash || !localCachedHash || localCachedHash === serverHash
        );
        const record = {
          id: b.id,
          server_book_id: b.id,
          source: 'server',
          book_title: b.title,
          book_author: b.author,
          filename: b.filename,
          original_filename: b.original_filename,
          content_hash: serverHash,
          file_blob: cacheMatchesServer ? localBlob : null,
          cached_content_hash: cacheMatchesServer ? (serverHash || localCachedHash) : '',
          cached_at: cacheMatchesServer ? (localBook.cached_at || Date.now()) : 0,
          last_opened: localBook ? localBook.last_opened : 0,
          progress_percent: localBook ? localBook.progress_percent : 0,
          last_cfi: localBook ? localBook.last_cfi : '',
          imported_at: localBook ? localBook.imported_at : Date.now(),
          knowledge_book_id: b.knowledge_book_id || null,
          knowledge_status: b.knowledge_status || 'unregistered',
          knowledge_error: b.knowledge_error || '',
          transfer_status: 'synced',
          transfer_progress: 100,
          transfer_error: '',
          _source: 'server',
        };
        await dbPut('books', record);
        return record;
      }));
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
    if (dbHasStore('sync_queue')) {
      const operations = await dbGetByIndex('sync_queue', 'by_book', bookId);
      for (const operation of operations) {
        await dbDelete('sync_queue', operation.id);
      }
    }
  }

  async function refreshServerLibrary() {
    if (!navigator.onLine) return [];
    const existing = await dbGetAll('books');
    const serverBooks = await fetchServerBooks(existing);
    await renderLibrary();
    return serverBooks;
  }

  function openBookDeleteDialog(book) {
    rememberDialogTrigger();
    pendingBookDelete = book;
    const isServer = book._source === 'server' || book.source === 'server' || book.server_book_id;
    dom.bookDeleteMessage.textContent = isServer
      ? `要从服务器彻底删除《${book.book_title || '未命名书籍'}》吗？所有设备上的 EPUB、进度、书签、划线、笔记和 AI 数据都会删除。`
      : `要删除《${book.book_title || '未命名书籍'}》吗？`;
    dom.btnDeleteLocalBook.hidden = isServer;
    dom.btnDeleteAllBookData.textContent = isServer ? '从所有设备删除' : '删除书籍及 AI 数据';
    dom.btnDeleteAllBookData.disabled = false;
    dom.bookDeleteModal.hidden = false;
    safeFocus(dom.btnCancelBookDelete);
  }

  function closeBookDeleteDialog() {
    pendingBookDelete = null;
    dom.btnDeleteLocalBook.hidden = false;
    dom.btnDeleteAllBookData.textContent = '删除书籍及 AI 数据';
    dom.bookDeleteModal.hidden = true;
    restoreDialogTrigger();
  }

  async function confirmBookDelete(deleteAiData) {
    const book = pendingBookDelete;
    if (!book) return;
    const serverBookId = book.server_book_id ||
      ((book._source === 'server' || book.source === 'server') ? book.id : null);
    if (serverBookId) {
      const resp = await fetch(API_BASE + '/api/books/' + encodeURIComponent(serverBookId), {
        method: 'DELETE',
      });
      if (!resp.ok && resp.status !== 404) {
        showToast('服务器书籍删除失败，请稍后重试', 'error');
        return;
      }
      await deleteBook(book.id);
      closeBookDeleteDialog();
      await renderLibrary();
      showToast('已从所有设备删除书籍及阅读数据', 'success');
      return;
    }
    if (deleteAiData && book.knowledge_book_id) {
      const resp = await fetch(
        API_BASE + '/api/knowledge/books/' + encodeURIComponent(book.knowledge_book_id),
        { method: 'DELETE' }
      );
      if (!resp.ok && resp.status !== 404) {
        showToast('后端 AI 数据删除失败，请稍后重试', 'error');
        return;
      }
    }
    await deleteBook(book.id);
    closeBookDeleteDialog();
    await renderLibrary();
    showToast(deleteAiData ? '书籍及 AI 数据已删除' : '已从本机书库移除', 'info');
  }

  function formatKnowledgeStatus(status) {
    const labels = {
      uploading: 'AI 上传中',
      pending: 'AI 排队中',
      indexing: 'AI 索引中',
      ready: 'AI 已就绪',
      failed: 'AI 索引失败',
      outdated: 'AI 待重建',
      unregistered: 'AI 未索引',
    };
    return labels[status] || 'AI 未索引';
  }

  function normalizeBookText(value) {
    return String(value || '')
      .replace(/\.epub$/i, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  async function computeContentHash(arrayBuffer) {
    // crypto.subtle is unavailable on plain-HTTP LAN origins; skip there.
    if (!crypto.subtle || !arrayBuffer) return '';
    try {
      const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    } catch (_err) {
      return '';
    }
  }

  function getBookDedupeKey(book) {
    if (book.content_hash) return 'hash:' + book.content_hash;
    if (book.server_book_id || book.source === 'server' || book._source === 'server') {
      return 'server:' + (book.server_book_id || book.id || normalizeBookText(book.filename));
    }
    if (book.filename && !book.file_blob) {
      return 'server:' + normalizeBookText(book.filename);
    }

    const title = normalizeBookText(book.book_title);
    const author = normalizeBookText(book.book_author);
    if (!title) return '';
    return author ? `local:${title}|${author}` : `local:${title}`;
  }

  function getBookMetadataKey(book) {
    const title = normalizeBookText(book.book_title);
    const author = normalizeBookText(book.book_author);
    if (!title) return '';
    return author ? `${title}|${author}` : title;
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
      const aServer = a.server_book_id || a.source === 'server' ? 1 : 0;
      const bServer = b.server_book_id || b.source === 'server' ? 1 : 0;
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
  function formatUploadError(xhr, payload) {
    const detail = payload.detail && (payload.detail.message || payload.detail);
    if (typeof detail === 'string') return detail;
    if (xhr.status === 400) return '服务器拒绝当前访问地址，请检查 ALLOWED_HOSTS 是否包含局域网 IP';
    if (xhr.status === 413) return 'EPUB 文件过大，请调高 MAX_EPUB_UPLOAD_MB 后重启服务器';
    if (xhr.status === 415) return '只支持有效的 .epub 文件';
    if (xhr.status >= 500) return `服务器暂时不可用（状态 ${xhr.status}），稍后可重试上传`;
    return `服务器响应 ${xhr.status}`;
  }

  function uploadBookToServer(arrayBuffer, filename, title = '', author = '', onProgress = null) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append(
        'file',
        new Blob([arrayBuffer], { type: 'application/epub+zip' }),
        filename || 'book.epub'
      );
      form.append('title', title || '');
      form.append('author', author || '');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', API_BASE + '/api/books/upload');
      xhr.timeout = EPUB_UPLOAD_TIMEOUT_MS;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) {
          onProgress((event.loaded / event.total) * 100);
        }
      };
      xhr.onerror = () => reject(new Error('无法连接服务器'));
      xhr.ontimeout = () => reject(new Error('上传超时，请检查网络后重试'));
      xhr.onload = () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText || '{}');
        } catch (_err) {
          // The status code below still provides a useful fallback.
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(formatUploadError(xhr, payload)));
          return;
        }
        if (!payload.book) {
          reject(new Error('服务器未返回书籍信息'));
          return;
        }
        resolve(payload.book);
      };
      xhr.send(form);
    });
  }

  async function rekeyBookToServer(localBook, serverBook, arrayBuffer = null) {
    const oldId = localBook.id;
    const existingTarget = await dbGet('books', serverBook.id);
    const merged = {
      ...(existingTarget || {}),
      ...localBook,
      id: serverBook.id,
      server_book_id: serverBook.id,
      source: 'server',
      _source: 'server',
      filename: serverBook.filename,
      original_filename: serverBook.original_filename,
      content_hash: serverBook.content_hash,
      book_title: serverBook.title || localBook.book_title,
      book_author: serverBook.author || localBook.book_author,
      file_blob: arrayBuffer || localBook.file_blob || (existingTarget && existingTarget.file_blob) || null,
      cached_content_hash: serverBook.content_hash || localBook.cached_content_hash || '',
      cached_at: Date.now(),
      knowledge_book_id: serverBook.knowledge_book_id || null,
      knowledge_status: serverBook.knowledge_status || 'unregistered',
      knowledge_error: serverBook.knowledge_error || '',
      migration_error: '',
      transfer_status: 'synced',
      transfer_progress: 100,
      transfer_error: '',
    };
    const preservedProgress = Number(localBook.transfer_preserved_progress || 0);
    if (preservedProgress > (merged.progress_percent || 0)) {
      merged.progress_percent = preservedProgress;
      merged.last_cfi = localBook.transfer_preserved_cfi || merged.last_cfi;
    }
    if (existingTarget && (existingTarget.progress_percent || 0) > (merged.progress_percent || 0)) {
      merged.progress_percent = existingTarget.progress_percent;
      merged.last_cfi = existingTarget.last_cfi || merged.last_cfi;
    }
    await dbPut('books', merged);

    const highlights = await dbGetByIndex('highlights', 'by_book', oldId);
    for (const highlight of highlights) {
      const updated = {
        ...highlight,
        book_id: serverBook.id,
        book_title: merged.book_title,
        book_author: merged.book_author,
      };
      await dbPut('highlights', updated);
      await queueReaderSync(serverBook.id, 'highlight.upsert', updated.id, updated);
    }
    if (dbHasStore('bookmarks')) {
      const bookmarks = await dbGetByIndex('bookmarks', 'by_book', oldId);
      for (const bookmark of bookmarks) {
        const updated = { ...bookmark, book_id: serverBook.id };
        await dbPut('bookmarks', updated);
        await queueReaderSync(serverBook.id, 'bookmark.upsert', updated.id, updated);
      }
    }
    await queueReaderSync(serverBook.id, 'progress.set', '', {
      cfi: merged.last_cfi || '',
      progress_percent: merged.progress_percent || 0,
      last_opened: merged.last_opened || 0,
    });
    if (oldId !== serverBook.id) await dbDelete('books', oldId);
    if (currentBookMeta && currentBookMeta.id === oldId) {
      currentBookMeta = merged;
    }
    if (operationBookId === oldId) operationBookId = serverBook.id;
    return merged;
  }

  function shouldAutoUploadLocalBook(book) {
    if (!book || !book.file_blob) return false;
    if (book.source === 'server' || book.server_book_id) return false;
    if (serverMigrationsInFlight.has(book.id)) return false;

    const status = book.transfer_status || 'local_only';
    return status === 'local_ready' || status === 'local_only';
  }

  async function migrateLocalBooksToServer() {
    if (!navigator.onLine) return;
    const books = await dbGetAll('books');
    const queue = books.filter(shouldAutoUploadLocalBook);
    // Two uploads at a time: faster library recovery without saturating the LAN.
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length) {
        const book = queue.shift();
        await uploadLocalBookInBackground(book, book.file_blob, { announce: false });
      }
    });
    await Promise.all(workers);
  }

  async function uploadLocalBookInBackground(book, arrayBuffer, { announce = true } = {}) {
    if (!book || !arrayBuffer) return null;
    if (!navigator.onLine) {
      await setBookTransferState(book, 'local_only', book.transfer_progress || 0, '当前设备离线');
      if (announce) {
        setOperationStatus({
          bookId: book.id,
          message: `《${book.book_title}》已保存在本机`,
          detail: '联网后会自动上传到服务器',
          tone: 'warning',
          retry: true,
        });
      }
      return null;
    }
    if (serverMigrationsInFlight.has(book.id)) return null;

    serverMigrationsInFlight.add(book.id);
    let lastPersistedProgress = -10;
    try {
      await setBookTransferState(book, 'uploading', 0);
      setOperationStatus({
        bookId: book.id,
        message: `正在上传《${book.book_title}》`,
        detail: '正文已经可以阅读，上传和 AI 索引会在后台继续',
        progress: 0,
      });

      const serverBook = await uploadBookToServer(
        arrayBuffer,
        book.original_filename || `${book.book_title || 'book'}.epub`,
        book.book_title,
        book.book_author,
        (progress) => {
          const rounded = Math.max(0, Math.min(100, Math.round(progress)));
          book.transfer_status = rounded >= 100 ? 'verifying' : 'uploading';
          book.transfer_progress = rounded;
          updateBookTransferUI(book);
          setOperationStatus({
            bookId: book.id,
            message: rounded >= 100
              ? `服务器正在校验《${book.book_title}》`
              : `正在上传《${book.book_title}》`,
            detail: rounded >= 100
              ? '文件已发送，正在保存并启动 AI 索引'
              : '正文已经可以阅读，上传在后台继续',
            progress: rounded,
          });
          if (rounded - lastPersistedProgress >= 10) {
            lastPersistedProgress = rounded;
            dbPut('books', book).catch(() => {});
          }
        }
      );

      const merged = await rekeyBookToServer(book, serverBook, arrayBuffer);
      await renderLibrary();
      const indexLabel = formatKnowledgeStatus(merged.knowledge_status);
      setOperationStatus({
        bookId: merged.id,
        message: `《${merged.book_title}》已保存到服务器`,
        detail: indexLabel,
        progress: 100,
        autoHideMs: merged.knowledge_status === 'ready' ? 3500 : 6000,
      });
      if (merged.knowledge_book_id) pollKnowledgeStatus(merged);
      if (announce) showToast('服务器保存完成，其他设备现在可以看到这本书', 'success');
      return merged;
    } catch (err) {
      book.migration_error = err.message;
      await setBookTransferState(book, 'failed', null, err.message);
      setOperationStatus({
        bookId: book.id,
        message: `《${book.book_title}》上传失败`,
        detail: `${err.message}；本机阅读不受影响`,
        tone: 'error',
        retry: true,
      });
      console.warn('Local book migration failed:', err);
      if (announce) showToast('上传失败，书籍已保存在本机', 'warning');
      return null;
    } finally {
      serverMigrationsInFlight.delete(book.id);
    }
  }

  async function retryBookUpload(book) {
    const latest = await dbGet('books', book.id);
    if (!latest || !latest.file_blob) {
      setOperationStatus({
        bookId: book.id,
        message: '无法重试上传',
        detail: '此设备没有原 EPUB，请重新导入文件',
        tone: 'error',
      });
      return;
    }
    await uploadLocalBookInBackground(latest, latest.file_blob);
  }

  function handleFileImport(file) {
    if (!file || !file.name.toLowerCase().endsWith('.epub')) {
      showToast('请选择 .epub 文件', 'error');
      return;
    }
    if (file.size > EPUB_MAX_UPLOAD_MB * 1024 * 1024) {
      showToast(`文件超过 ${EPUB_MAX_UPLOAD_MB}MB 上限，无法导入`, 'error');
      setOperationStatus({
        message: `${file.name} 超过大小上限`,
        detail: `当前上限 ${EPUB_MAX_UPLOAD_MB}MB，可调高服务器 MAX_EPUB_UPLOAD_MB 后重试`,
        tone: 'error',
      });
      return;
    }

    const reader = new FileReader();
    setOperationStatus({
      message: `正在读取 ${file.name}`,
      detail: '读取完成后会立即打开正文',
      progress: 0,
    });
    reader.onprogress = (event) => {
      if (!event.lengthComputable) return;
      setOperationStatus({
        message: `正在读取 ${file.name}`,
        detail: `${Math.round(event.loaded / 1024 / 1024 * 10) / 10} MB / ${Math.round(event.total / 1024 / 1024 * 10) / 10} MB`,
        progress: (event.loaded / event.total) * 35,
      });
    };
    reader.onload = async (e) => {
      try {
        const blob = new Blob([e.target.result], { type: 'application/epub+zip' });
        setOperationStatus({
          message: `正在解析 ${file.name}`,
          detail: '正在读取书名、作者和目录',
          progress: 45,
        });
        const bookMeta = await extractBookMeta(blob);
        const candidate = {
          book_title: bookMeta.title || file.name.replace(/\.epub$/i, ''),
          book_author: bookMeta.author || '',
        };
        const candidateMetadataKey = getBookMetadataKey(candidate);
        const importedFilename = normalizeBookText(file.name);
        const contentHash = await computeContentHash(e.target.result);
        const existingBooks = await dbGetAll('books');
        const existingBook = existingBooks.find(book => (
          (contentHash && (
            book.content_hash === contentHash || book.cached_content_hash === contentHash
          )) ||
          normalizeBookText(book.original_filename || book.filename) === importedFilename ||
          getBookMetadataKey(book) === candidateMetadataKey
        ));

        const localRecord = existingBook || {
          id: uuid(),
          book_title: candidate.book_title,
          book_author: candidate.book_author,
          imported_at: Date.now(),
          progress_percent: 0,
        };
        localRecord.file_blob = e.target.result;
        localRecord.original_filename = file.name;
        if (contentHash) localRecord.content_hash = contentHash;
        if (existingBook) {
          localRecord.transfer_preserved_progress = existingBook.progress_percent || 0;
          localRecord.transfer_preserved_cfi = existingBook.last_cfi || '';
        }
        localRecord.last_opened = Date.now();
        localRecord.transfer_status = 'local_ready';
        localRecord.transfer_progress = 0;
        localRecord.transfer_error = '';
        localRecord.knowledge_status = localRecord.knowledge_status || 'unregistered';
        localRecord.knowledge_error = '';
        try {
          await dbPut('books', localRecord);
        } catch (err) {
          if (!isStorageQuotaError(err)) throw err;
          // Quota exhausted: keep the import readable, just skip the shelf copy.
          console.warn('Unable to persist imported EPUB:', err);
          showToast('浏览器存储空间不足，本书不会保存到书架', 'warning');
        }
        await renderLibrary();
        setOperationStatus({
          bookId: localRecord.id,
          message: `《${localRecord.book_title}》已在本机就绪`,
          detail: '正在打开第一页；服务器上传会在后台继续',
          progress: 60,
        });
        await openBook(localRecord, { skipSync: true });
        uploadLocalBookInBackground(localRecord, e.target.result).catch(() => {});
      } catch (err) {
        console.error('Import failed:', err);
        setOperationStatus({
          message: `${file.name} 导入失败`,
          detail: err.message || '请确认文件是有效的 EPUB',
          tone: 'error',
        });
        showToast('导入失败，请检查 EPUB 文件', 'error');
      }
    };
    reader.onerror = () => {
      setOperationStatus({
        message: `${file.name} 读取失败`,
        detail: '请重新选择文件',
        tone: 'error',
      });
      showToast('读取文件失败', 'error');
    };
    reader.readAsArrayBuffer(file);
  }

  function extractBookMeta(blob) {
    return new Promise((resolve) => {
      const meta = { title: '', author: '' };
      let settled = false;
      let url = null;
      let book = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (url) URL.revokeObjectURL(url);
        if (book && typeof book.destroy === 'function') book.destroy();
        resolve(meta);
      };
      try {
        url = URL.createObjectURL(blob);
        book = ePub(url, { openAs: 'epub' });
        book.loaded.metadata.then((md) => {
          meta.title = md.title || '';
          meta.author = md.creator || '';
          finish();
        }).catch(finish);

        // Timeout: if metadata doesn't load within 5s, resolve with empty
        setTimeout(finish, 5000);
      } catch (e) {
        finish();
      }
    });
  }

  async function recoverMissingKnowledgeBook(book, { promptForFile = false } = {}) {
    if (!book) return;
    if (aiIndexPollTimer) {
      clearTimeout(aiIndexPollTimer);
      aiIndexPollTimer = null;
    }

    book.knowledge_book_id = null;
    if (book.file_blob) {
      book.knowledge_status = 'unregistered';
      book.knowledge_error = '';
    } else {
      book.knowledge_status = 'failed';
      book.knowledge_error = '源文件已不在服务器，请重新导入原 EPUB';
    }
    await dbPut('books', book);

    if (currentBookMeta && currentBookMeta.id === book.id) {
      currentBookMeta = book;
      setAiIndexState(book.knowledge_status, book.knowledge_error);
    }
    await renderLibrary();

    if (book.file_blob) {
      await ensureKnowledgeBook(book);
    } else if (promptForFile) {
      showToast('请选择原 EPUB，阅读进度和笔记会保留', 'info');
      dom.fileInput.click();
    }
  }

  async function ensureKnowledgeBook(book) {
    if (!book || book.knowledge_status === 'ready' || book.knowledge_status === 'indexing' || book.knowledge_status === 'pending') {
      if (book && book.knowledge_book_id) pollKnowledgeStatus(book);
      return;
    }
    if (knowledgeUploadsInFlight.has(book.id)) return;
    knowledgeUploadsInFlight.add(book.id);
    book.knowledge_status = 'uploading';
    book.knowledge_error = '';
    await dbPut('books', book);
    if (currentBookMeta && currentBookMeta.id === book.id) {
      setAiIndexState('uploading');
    }
    try {
      const uploadBytes = () => {
        const form = new FormData();
        form.append(
          'file',
          new Blob([book.file_blob], { type: 'application/epub+zip' }),
          `${book.book_title || 'book'}.epub`
        );
        form.append('title', book.book_title || '');
        form.append('author', book.book_author || '');
        return fetch(API_BASE + '/api/knowledge/books/upload', {
          method: 'POST',
          body: form,
        });
      };

      let resp;
      if (book.filename) {
        // The EPUB already lives on the server; register it for AI without
        // re-uploading the bytes. Fall back to a full upload if the server
        // lost the file but this device still has it.
        resp = await fetch(API_BASE + '/api/knowledge/books/from-server', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: book.filename }),
        });
        if (resp.status === 404 && book.file_blob) {
          resp = await uploadBytes();
        }
      } else {
        resp = await uploadBytes();
      }
      if (!resp.ok) {
        const error = await resp.json().catch(() => ({}));
        const detail = error.detail && (error.detail.message || error.detail);
        const requestError = new Error(
          typeof detail === 'string' ? detail : `Server responded with ${resp.status}`
        );
        requestError.status = resp.status;
        requestError.code = error.detail && error.detail.code;
        throw requestError;
      }
      const indexedBook = await resp.json();
      book.knowledge_book_id = indexedBook.id;
      book.knowledge_status = indexedBook.status;
      book.knowledge_error = indexedBook.error_message || '';
      await dbPut('books', book);
      if (currentBookMeta && currentBookMeta.id === book.id) {
        currentBookMeta = book;
        setAiIndexState(book.knowledge_status, book.knowledge_error);
      }
      pollKnowledgeStatus(book);
      renderLibrary();
    } catch (err) {
      console.error('Knowledge book upload failed:', err);
      if (err.status === 404 || err.code === 'book_not_found') {
        await recoverMissingKnowledgeBook(book);
        return;
      }
      book.knowledge_status = 'failed';
      book.knowledge_error = err.message;
      await dbPut('books', book);
      if (currentBookMeta && currentBookMeta.id === book.id) {
        setAiIndexState('failed', err.message);
      }
    } finally {
      knowledgeUploadsInFlight.delete(book.id);
    }
  }

  function pollKnowledgeStatus(book) {
    if (!book || !book.knowledge_book_id) return;
    if (aiIndexPollTimer) clearTimeout(aiIndexPollTimer);
    const poll = async () => {
      try {
        const resp = await fetch(
          API_BASE + '/api/knowledge/books/' + encodeURIComponent(book.knowledge_book_id)
        );
        if (resp.status === 404) {
          await recoverMissingKnowledgeBook(book);
          return;
        }
        if (!resp.ok) throw new Error(`Server responded with ${resp.status}`);
        const data = await resp.json();
        book.knowledge_status = data.status;
        book.knowledge_error = data.error_message || '';
        await dbPut('books', book);
        if (operationBookId === book.id) {
          if (data.status === 'pending' || data.status === 'indexing') {
            setOperationStatus({
              bookId: book.id,
              message: `《${book.book_title}》已保存到服务器`,
              detail: formatKnowledgeStatus(data.status),
            });
          } else if (data.status === 'ready') {
            setOperationStatus({
              bookId: book.id,
              message: `《${book.book_title}》已全部就绪`,
              detail: '服务器保存和 AI 索引均已完成',
              progress: 100,
              autoHideMs: 4000,
            });
          } else if (data.status === 'failed') {
            setOperationStatus({
              bookId: book.id,
              message: `《${book.book_title}》已保存，但 AI 索引失败`,
              detail: data.error_message || '可以继续阅读，并稍后重试索引',
              tone: 'warning',
            });
          }
        }
        if (currentBookMeta && currentBookMeta.id === book.id) {
          currentBookMeta = book;
          setAiIndexState(data.status, data.error_message || '');
          if (data.status === 'ready') await loadAiConversations();
        }
        if (data.status === 'pending' || data.status === 'indexing') {
          aiIndexPollTimer = setTimeout(poll, 2000);
        } else {
          renderLibrary();
        }
      } catch (err) {
        if (currentBookMeta && currentBookMeta.id === book.id) {
          setAiIndexState('failed', '无法读取索引状态');
        }
      }
    };
    poll();
  }

  // ==================== READER ====================
  function isStorageQuotaError(err) {
    return Boolean(err && (
      err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err.code === 22 ||
      err.code === 1014
    ));
  }

  async function persistServerEpub(bookMeta, arrayBuffer) {
    const cachedBook = {
      ...bookMeta,
      file_blob: arrayBuffer,
      cached_content_hash: bookMeta.content_hash || '',
      cached_at: Date.now(),
    };
    try {
      await dbPut('books', cachedBook);
      Object.assign(bookMeta, cachedBook);
      if (currentBookMeta && currentBookMeta.id === bookMeta.id) currentBookMeta = bookMeta;
      return true;
    } catch (err) {
      console.warn('Unable to persist EPUB offline copy:', err);
      const detail = isStorageQuotaError(err)
        ? '浏览器存储空间不足，下次打开可能需要重新下载'
        : '离线副本保存失败，下次打开可能需要重新下载';
      showToast(detail, 'warning');
      return false;
    }
  }

  async function downloadServerEpub(bookMeta) {
    const bookId = bookMeta.server_book_id || bookMeta.id;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EPUB_DOWNLOAD_TIMEOUT_MS);
    try {
      const resp = await fetch(
        API_BASE + '/api/books/' + encodeURIComponent(bookId) + '/file',
        { signal: controller.signal }
      );
      if (resp.status === 404) {
        const missing = new Error('服务器文件缺失，请重新导入原 EPUB');
        missing.code = 'book_not_found';
        throw missing;
      }
      if (!resp.ok) throw new Error(`服务器下载失败 (${resp.status})`);

      const total = Number(resp.headers.get('Content-Length')) || 0;
      const responseSource = resp.headers.get('X-Marginalia-Cache') || 'network';
      const loadingLabel = responseSource === 'hit' ? '正在读取 EPUB 缓存…' : '正在下载 EPUB…';
      if (!resp.body || !resp.body.getReader) {
        setReaderLoading(loadingLabel, total ? `${Math.round(total / 1024 / 1024 * 10) / 10} MB` : '远程书籍可能需要多等几秒');
        return { arrayBuffer: await resp.arrayBuffer(), source: responseSource };
      }

      const reader = resp.body.getReader();
      const chunks = [];
      let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        const detail = total
          ? `${Math.round(loaded / 1024 / 1024 * 10) / 10} MB / ${Math.round(total / 1024 / 1024 * 10) / 10} MB`
          : `已下载 ${Math.round(loaded / 1024 / 1024 * 10) / 10} MB`;
        setReaderLoading(loadingLabel, detail);
        if (total) setLoadingProgress(10 + (loaded / total) * 45);
      }
      const merged = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { arrayBuffer: merged.buffer, source: responseSource };
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('EPUB 下载超时，请检查远程网络后重试');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function openBook(bookMeta, { skipSync = false, historyMode = 'push' } = {}) {
    showReader({ historyMode, bookId: bookMeta.id });
    setReaderLoading('正在打开书籍…', '正在准备阅读器');
    setLoadingProgress(5);
    const isServerBook = Boolean(
      bookMeta.server_book_id || bookMeta.source === 'server' || bookMeta._source === 'server'
    );
    if (isServerBook && !skipSync) {
      setReaderLoading('正在同步阅读进度…', '最多等待 3 秒，超时后使用本机缓存继续打开');
      try {
        bookMeta = (await syncBookState(bookMeta, { timeoutMs: READER_SYNC_TIMEOUT_MS })) || bookMeta;
      } catch (err) {
        console.warn('Reader state refresh failed:', err);
      }
    }
    currentBookMeta = bookMeta;
    aiMessages = [];
    aiConversations = [];
    currentAiConversationId = null;
    renderAiMessages();
    renderAiConversationOptions();
    setAiIndexState(bookMeta.knowledge_status || 'unregistered', bookMeta.knowledge_error || '');
    if (isServerBook || (bookMeta.filename && !bookMeta.file_blob)) {
      ensureKnowledgeBook(bookMeta);
    }

    // Keep the book title as a readiness signal: it is set after the first
    // display and location sync complete.
    dom.toolbarBookTitle.textContent = '打开中...';
    dom.toolbarChapter.textContent = '加载中…';
    dom.tocList.innerHTML = '<div class="empty-toc">正在读取目录…</div>';

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
      if (hasFreshLocalEpub(bookMeta)) {
        setReaderLoading('正在从本机打开…', 'EPUB 已保存在此设备');
        // Imported devices keep an offline copy even though the canonical source is the server.
        const blob = new Blob([bookMeta.file_blob], { type: 'application/epub+zip' });
        const url = URL.createObjectURL(blob);
        currentBookUrl = url;
        book = ePub(url, { openAs: 'epub' });
      } else if (isServerBookRecord(bookMeta)) {
        const download = await downloadServerEpub(bookMeta);
        const arrayBuffer = download.arrayBuffer;
        await persistServerEpub(bookMeta, arrayBuffer);
        const blob = new Blob([arrayBuffer], { type: 'application/epub+zip' });
        const url = URL.createObjectURL(blob);
        currentBookUrl = url;
        book = ePub(url, { openAs: 'epub' });
      } else if (bookMeta.filename) {
        book = ePub(API_BASE + '/api/books/' + encodeURIComponent(bookMeta.filename), { openAs: 'epub' });
      } else {
        throw new Error('EPUB source is unavailable');
      }
      currentBook = book;
      locationsReadyPromise = null;
      locationsReadyBook = null;
      lastPageInfo = null;
      setLoadingProgress(10);

      const rendition = book.renderTo(dom.epubContainer, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'paginated',
      });
      if (!dom.readerLoading.isConnected) dom.epubContainer.appendChild(dom.readerLoading);
      currentRendition = rendition;
      _boundIframeDocuments = new WeakSet();
      applyReaderTypography({ refresh: false });

      // Track chapter/location changes
      rendition.on('relocated', (location) => {
        hideSelectionToolbar();
        handleLocationChange(location);
        clearSearchHighlights();
        setupIframeNavigation();  // re-attach if iframe was recreated
        restoreHighlights();      // re-apply highlights on new page
      });

      rendition.on('rendered', () => {
        setupIframeNavigation();
        ttsFollowDocumentCache = null;
        if (isTtsNavigationLocked() && !ttsFollowNavigationInProgress) {
          window.setTimeout(() => updateTtsFollowHighlight({
            force: true,
            source: 'render',
            navigation: 'none',
          }), 0);
        }
      });

      // Setup highlight selection handling
      setupSelectionHandling(rendition);

      // Restore saved CFI or start from beginning
      const startCfi = bookMeta.last_cfi || undefined;
      setLoadingProgress(65);
      await rendition.display(startCfi);
      syncReaderLocation();
      setupIframeNavigation();
      restoreHighlights();
      dom.toolbarBookTitle.textContent = bookMeta.book_title;
      setLoadingProgress(100);
      hideReaderLoading();
      scheduleReaderChromeHide(READER_CHROME_INITIAL_HIDE_MS);

      // Full-book location generation can take minutes for large EPUBs. It is
      // useful for percentages and jumps, but must never block the first page.
      dom.pageText.textContent = '正在计算页码…';
      warmLocationsWithProgress(book).catch((err) => {
        console.warn('Location generation failed:', err);
        dom.pageText.textContent = '页码暂不可用';
      });

      // Load bookmarks/navigation for chapter titles
      book.loaded.navigation.then((nav) => {
        // nav.toc gives us chapter structure
        currentBook._toc = Array.isArray(nav.toc) ? nav.toc : [];
        renderTableOfContents(currentBook._toc);
        updateTocActiveState(currentChapterId);
      }).catch((err) => {
        console.warn('EPUB navigation load failed:', err);
        renderTableOfContents([]);
      });

      dom.epubContainer.style.display = '';
    } catch (err) {
      hideReaderLoading();
      console.error('Failed to open book:', err);
      if (err.code === 'book_not_found') {
        setOperationStatus({
          bookId: bookMeta.id,
          message: '服务器中的 EPUB 文件缺失',
          detail: '请重新导入原 EPUB；书签、划线和阅读进度仍会保留',
          tone: 'error',
        });
      }
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
    if (!location || !location.start) return;
    currentCfi = location.start.cfi;
    const nextChapterId = String(location.start.href || '').split('#', 1)[0];
    if (currentChapterId && nextChapterId && currentChapterId !== nextChapterId) {
      stopTtsForChapter({ resetTask: true });
    }
    if (nextChapterId) currentChapterId = nextChapterId;
    updateChapterLabel(location);
    updateTocActiveState(location.start.href || '');
    let percent = location.start.percentage;
    if (percent == null) {
      percent = percentageFromCfi(currentCfi);
    }
    if (percent == null) return;
    const pct = Math.round(percent * 100);

    // Update progress UI
    dom.progressText.textContent = pct + '%';
    updatePageUI();

    // Save progress to DB
    if (currentBookMeta && !isLayoutRefreshing) {
      const locations = currentRendition && currentRendition.book
        ? currentRendition.book.locations
        : null;
      const hasStableBookPercentage = getLocationCount(locations) > 0;
      const storedProgress = Number(currentBookMeta.progress_percent || 0);
      const transferredProgress = Number(currentBookMeta.transfer_preserved_progress || 0);
      const protectedProgress = Math.max(storedProgress, transferredProgress);
      const isProvisionalDowngrade =
        pct < transferredProgress || (!hasStableBookPercentage && pct < protectedProgress);
      if (!isProvisionalDowngrade) {
        delete currentBookMeta.transfer_preserved_progress;
        delete currentBookMeta.transfer_preserved_cfi;
        currentBookMeta.progress_percent = pct;
        currentBookMeta.last_cfi = currentCfi;
        dbPut('books', currentBookMeta).catch(() => {});
        if (currentBookMeta.server_book_id || currentBookMeta.source === 'server') {
          queueReaderSync(currentBookMeta.id, 'progress.set', '', {
            cfi: currentCfi,
            progress_percent: pct,
            last_opened: currentBookMeta.last_opened || Date.now(),
          }).catch(() => {});
        }
      }
    }
  }

  function releaseTransferredProgressFloor() {
    if (!currentBookMeta || !currentBookMeta.transfer_preserved_progress) return;
    delete currentBookMeta.transfer_preserved_progress;
    delete currentBookMeta.transfer_preserved_cfi;
    dbPut('books', currentBookMeta).catch(() => {});
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
    dom.progressText.textContent = pct + '%';
    updatePageUI();
  }

  function syncReaderLocation() {
    if (!currentRendition || typeof currentRendition.currentLocation !== 'function') {
      updateProgressUI();
      return;
    }
    try {
      const location = currentRendition.currentLocation();
      if (location && location.start) {
        handleLocationChange(location);
        return;
      }
    } catch (_err) {
      // Fall back to progress-only sync below.
    }
    updateProgressUI();
  }

  function refreshReaderLayout({ anchorCfi: requestedAnchorCfi = '' } = {}) {
    if (!currentRendition || !dom.epubContainer) return;
    const refreshToken = ++layoutRefreshToken;
    const navigationToken = pageNavigationToken;
    const anchorCfi = requestedAnchorCfi || getCurrentAnchorCfi();
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
    try {
      const currentLoc = currentRendition && typeof currentRendition.currentLocation === 'function'
        ? currentRendition.currentLocation()
        : null;
      const displayed = currentLoc && currentLoc.start && currentLoc.start.displayed;
      if (displayed && typeof displayed.page === 'number' && typeof displayed.total === 'number') {
        lastPageInfo = {
          currentPage: displayed.page,
          totalPages: displayed.total,
        };
        return lastPageInfo;
      }
    } catch (_err) {
      // Fall back to generated locations below.
    }

    if (!currentRendition || !currentRendition.book || !currentRendition.book.locations) return null;
    const locations = currentRendition.book.locations;
    const totalPages = getLocationCount(locations);
    if (!totalPages) return null;
    const cfi = getCurrentAnchorCfi();
    if (!cfi || typeof locations.locationFromCfi !== 'function') return null;
    try {
      const location = locations.locationFromCfi(cfi);
      if (typeof location !== 'number' || location < 0) return null;
      lastPageInfo = {
        currentPage: Math.min(totalPages, location + 1),
        totalPages,
      };
      return lastPageInfo;
    } catch (_err) {
      return null;
    }
  }

  function updatePageUI() {
    if (!dom.pageText) return;
    const pageInfo = getCurrentPageInfo();
    const stablePageInfo = pageInfo || lastPageInfo;
    dom.pageText.textContent = stablePageInfo
      ? `第 ${stablePageInfo.currentPage} / ${stablePageInfo.totalPages} 页`
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

  function isTtsNavigationLocked() {
    return Boolean(ttsWantsPlay || ttsIsPlaying || ttsPlaybackStarting);
  }

  function showTtsNavigationLockedNotice() {
    const now = Date.now();
    if (now - ttsNavigationNoticeAt < 1200) return;
    ttsNavigationNoticeAt = now;
    showToast('朗读跟随中，请先暂停再翻页', 'info');
  }

  function syncReaderNavigationControls() {
    const locked = isTtsNavigationLocked();
    if (dom.readerView) {
      dom.readerView.classList.toggle('tts-navigation-locked', locked);
      dom.readerView.setAttribute('aria-busy', String(locked));
    }
  }

  function blockManualNavigationDuringTts() {
    if (!isTtsNavigationLocked()) return false;
    showTtsNavigationLockedNotice();
    syncReaderNavigationControls();
    return true;
  }

  function navigatePageWhenReady(direction, source, attempt = 0) {
    if (isLayoutRefreshing && attempt < 10) {
      return new Promise(resolve => {
        setTimeout(() => {
          resolve(navigatePageWhenReady(direction, source, attempt + 1));
        }, 100);
      });
    }
    return navigatePage(direction, source);
  }

  function navigatePage(direction, source) {
    if (blockManualNavigationDuringTts()) return Promise.resolve(false);
    if (!currentRendition || pageNavigationInProgress || isLayoutRefreshing) return Promise.resolve(false);
    if (direction !== 'next' && direction !== 'prev') return Promise.resolve(false);

    if (readerChromeVisible) {
      cancelReaderChromeHide();
      scheduleReaderChromeHide();
    }
    releaseTransferredProgressFloor();
    pageNavigationInProgress = true;
    pageNavigationToken += 1;

    let navigation;
    try {
      // Boundary guard: detect cross-section edges and use display() instead of next()/prev()
      const currentLoc = currentRendition.currentLocation();
      let spineItem = null;
      let currentSectionHref = null;

      if (currentLoc && currentLoc.start && currentLoc.start.href) {
        currentSectionHref = currentLoc.start.href.split('#')[0];
        // Find the spine item for the current section
        if (currentBook && currentBook.spine) {
          spineItem = (typeof currentBook.spine.get === 'function')
            ? currentBook.spine.get(currentSectionHref)
            : (currentBook.spine.spineItems || []).find(function(s) { return s.href === currentSectionHref; });
        }
      }

      const atForwardBoundary = currentLoc && (
        currentLoc.atEnd === true ||
        (currentLoc.start && currentLoc.start.displayed &&
         currentLoc.start.displayed.page >= currentLoc.start.displayed.total)
      );
      const atBackwardBoundary = currentLoc && (
        currentLoc.atStart === true ||
        (currentLoc.start && currentLoc.start.displayed &&
         currentLoc.start.displayed.page === 1)
      );

      if (direction === 'next' && atForwardBoundary && spineItem && spineItem.next()) {
        // Cross-section forward: display next section from start
        pageNavigationToken += 1;
        const nextSpine = spineItem.next();
        console.log('Cross-section forward:', currentSectionHref, '\u2192', nextSpine.href);
        navigation = currentRendition.display(nextSpine.href, false);
      } else if (direction === 'prev' && atBackwardBoundary && spineItem && spineItem.prev()) {
        // Cross-section backward: let epub.js move to the previous spine tail.
        pageNavigationToken += 1;
        const prevSpine = spineItem.prev();
        console.log('Cross-section backward:', currentSectionHref, '\u2192', prevSpine.href);
        navigation = currentRendition.prev();
      } else {
        // Same-section navigation: use existing next()/prev()
        navigation = direction === 'next'
          ? currentRendition.next()
          : currentRendition.prev();
      }
    } catch (err) {
      console.warn('Page navigation failed:', source, err);
      pageNavigationInProgress = false;
      return Promise.resolve(false);
    }

    return Promise.resolve(navigation)
      .then(() => {
        syncReaderLocation();
        return true;
      })
      .catch((err) => {
        console.warn('Page navigation failed:', source, err);
        return false;
      })
      .finally(() => {
        window.setTimeout(() => {
          pageNavigationInProgress = false;
        }, PAGE_NAVIGATION_COOLDOWN);
      });
  }

  function warmLocationsWithProgress(book) {
    if (!book || !book.locations) return Promise.resolve();
    if (locationsReadyBook === book && locationsReadyPromise) return locationsReadyPromise;
    if (getLocationCount(book.locations) > 0) {
      locationsReadyBook = book;
      locationsReadyPromise = Promise.resolve();
      syncReaderNavigationControls();
      updatePageUI();
      return locationsReadyPromise;
    }

    locationsReadyBook = book;
    locationsReadyPromise = book.locations.generate(1000)
      .then(() => {
        syncReaderNavigationControls();
        updatePageUI();
      })
      .catch((err) => {
        locationsReadyBook = null;
        locationsReadyPromise = null;
        throw err;
      });

    return locationsReadyPromise;
  }

  // ==================== IFRAME NAVIGATION ====================
  // epub.js renders inside an iframe — all interaction must go through the iframe's document
  let _boundIframeDocuments = new WeakSet();
  let outerSwipeFallbackBound = false;
  let lastMobilePageTapAt = 0;
  let suppressMobileClickNavigationUntil = 0;

  function getMobilePageTapDirection(clientX, viewportWidth) {
    if (!isMobileLayout() || !Number.isFinite(clientX) || viewportWidth <= 0) return null;
    if (clientX <= viewportWidth * MOBILE_PAGE_TAP_ZONE_RATIO) return 'prev';
    if (clientX >= viewportWidth * (1 - MOBILE_PAGE_TAP_ZONE_RATIO)) return 'next';
    return null;
  }

  function triggerMobilePageTap(clientX, viewportWidth, source) {
    const direction = getMobilePageTapDirection(clientX, viewportWidth);
    if (!direction) return false;

    const now = Date.now();
    if (now - lastMobilePageTapAt >= MOBILE_PAGE_TAP_DEDUPE_MS) {
      lastMobilePageTapAt = now;
      setGestureDebug(`${source} → ${direction === 'next' ? '下一页' : '上一页'}`);
      navigatePageWhenReady(direction, source);
    }
    return true;
  }

  function setGestureDebug(message) {
    if (!GESTURE_DEBUG_ENABLED) return;
    let badge = document.getElementById('gesture-debug-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'gesture-debug-badge';
      Object.assign(badge.style, {
        position: 'fixed',
        left: '8px',
        top: '8px',
        zIndex: '10000',
        maxWidth: 'calc(100vw - 16px)',
        padding: '6px 9px',
        borderRadius: '8px',
        background: 'rgba(17, 24, 39, 0.88)',
        color: '#fff',
        font: '12px/1.35 system-ui, sans-serif',
        pointerEvents: 'none',
      });
      document.body.appendChild(badge);
    }
    badge.textContent = `手势诊断：${message}`;
  }

  function findReaderIframes() {
    const iframes = Array.from(dom.epubContainer.querySelectorAll('iframe')).filter((iframe) => {
      try {
        return Boolean(iframe.contentDocument && iframe.contentDocument.body);
      } catch (_err) {
        return false;
      }
    });
    iframes.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return (bRect.width * bRect.height) - (aRect.width * aRect.height);
    });
    return iframes;
  }

  function setupOuterSwipeFallback() {
    if (outerSwipeFallbackBound || !dom.epubContainer) return;
    const viewport = dom.epubContainer.closest('.reader-viewport');
    if (!viewport) return;
    outerSwipeFallbackBound = true;

    const isIOSWebKit = /iP(?:hone|ad|od)/.test(navigator.userAgent) || (
      navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
    );
    if (isIOSWebKit || GESTURE_DEBUG_ENABLED) {
      for (const side of ['left', 'right']) {
        const zone = document.createElement('div');
        zone.className = `ios-reader-swipe-zone ios-reader-swipe-zone-${side}`;
        zone.setAttribute('aria-hidden', 'true');
        Object.assign(zone.style, {
          position: 'absolute',
          top: '0',
          bottom: '0',
          zIndex: '11',
          width: '20%',
          [side]: '3%',
          background: GESTURE_DEBUG_ENABLED ? 'rgba(47, 96, 74, 0.08)' : 'transparent',
          touchAction: 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
        });
        viewport.appendChild(zone);
      }
      setGestureDebug('iOS 外层滑动区已启用');
    }

    let start = null;
    const isReaderBodyTarget = (target) => (
      target && (
        dom.epubContainer.contains(target) ||
        (typeof target.closest === 'function' && Boolean(target.closest('.ios-reader-swipe-zone')))
      )
    );
    const hasIframeSelection = () => findReaderIframes().some((iframe) => {
      try {
        return hasSelectionText(iframe.contentDocument.getSelection());
      } catch (_err) {
        return false;
      }
    });
    const isBlocked = () => (
      hasOpenReaderSurface() ||
      Boolean(pendingSelection) ||
      !dom.selectionToolbar.hidden ||
      hasIframeSelection() ||
      Date.now() < selectionInteractionUntil
    );
    const threshold = () => Math.max(42, Math.min(72, viewport.clientWidth * 0.14));

    viewport.addEventListener('touchstart', (event) => {
      if (!isReaderBodyTarget(event.target) || event.touches.length !== 1 || isBlocked()) {
        start = null;
        return;
      }
      const touch = event.touches[0];
      start = {
        x: touch.clientX,
        y: touch.clientY,
        at: Date.now(),
        target: event.target,
        intent: null,
        triggered: false,
      };
      setGestureDebug(`outer touchstart (${Math.round(touch.clientX)}, ${Math.round(touch.clientY)})`);
    }, { passive: true, capture: true });

    viewport.addEventListener('touchmove', (event) => {
      if (!start || event.touches.length !== 1 || isBlocked()) return;
      const touch = event.touches[0];
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const elapsed = Math.max(1, Date.now() - start.at);
      if (!start.intent && elapsed >= SWIPE_LONG_PRESS_MS) {
        start = null;
        return;
      }
      if (!start.intent && Math.hypot(deltaX, deltaY) >= SWIPE_INTENT_THRESHOLD) {
        if (absX >= absY * SWIPE_DIRECTION_RATIO) start.intent = 'horizontal';
        else if (absY >= absX * SWIPE_DIRECTION_RATIO) start.intent = 'vertical';
        else start.intent = 'diagonal';
      }
      if (!start || start.intent !== 'horizontal') return;
      setGestureDebug(`outer touchmove 横向 ${Math.round(deltaX)}px`);
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const velocity = absX / elapsed;
      const minDistance = threshold();
      const fastFlick = velocity >= SWIPE_FAST_VELOCITY && absX >= minDistance * 0.65;
      if (!start.triggered && elapsed <= SWIPE_MAX_DURATION && (absX >= minDistance || fastFlick)) {
        start.triggered = true;
        setGestureDebug(`outer-swipe → ${deltaX < 0 ? '下一页' : '上一页'}`);
        navigatePageWhenReady(deltaX < 0 ? 'next' : 'prev', 'ios-outer-swipe');
      }
    }, { passive: false, capture: true });

    viewport.addEventListener('touchend', (event) => {
      if (!start) return;
      const gesture = start;
      start = null;
      if (gesture.triggered || isBlocked()) return;
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch) return;
      const deltaX = touch.clientX - gesture.x;
      const deltaY = touch.clientY - gesture.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const elapsed = Math.max(1, Date.now() - gesture.at);
      const moved = Math.hypot(deltaX, deltaY);
      const viewportRect = viewport.getBoundingClientRect();
      if (
        !gesture.intent &&
        elapsed <= READER_TAP_MAX_DURATION &&
        moved <= READER_TAP_MAX_MOVE &&
        triggerMobilePageTap(touch.clientX - viewportRect.left, viewportRect.width, 'ios-outer-tap')
      ) {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        return;
      }
      const horizontal = gesture.intent === 'horizontal' || (
        !gesture.intent && absX >= absY * SWIPE_DIRECTION_RATIO
      );
      const minDistance = threshold();
      const fastFlick = absX / elapsed >= SWIPE_FAST_VELOCITY && absX >= minDistance * 0.65;
      if (!horizontal || elapsed > SWIPE_MAX_DURATION || (absX < minDistance && !fastFlick)) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      setGestureDebug(`outer-swipe-end → ${deltaX < 0 ? '下一页' : '上一页'}`);
      navigatePageWhenReady(deltaX < 0 ? 'next' : 'prev', 'ios-outer-swipe-end');
    }, { passive: false, capture: true });

    viewport.addEventListener('touchcancel', () => {
      start = null;
    }, { passive: true, capture: true });
  }

  function observeReaderIframes() {
    if (readerIframeObserver || !dom.epubContainer) return;
    setupOuterSwipeFallback();
    const rebind = () => setTimeout(() => setupIframeNavigation(), 0);
    readerIframeObserver = new MutationObserver(rebind);
    readerIframeObserver.observe(dom.epubContainer, { childList: true, subtree: true });
    dom.epubContainer.addEventListener('load', rebind, true);
  }

  function setupIframeNavigation() {
    for (const iframe of findReaderIframes()) {
      setupIframeNavigationForFrame(iframe);
    }
  }

  function setupIframeNavigationForFrame(iframe) {
    if (!iframe || !iframe.contentDocument || _boundIframeDocuments.has(iframe.contentDocument)) return;
    _boundIframeDocuments.add(iframe.contentDocument);
    const doc = iframe.contentDocument;
    const gestureTarget = doc;
    iframe.style.touchAction = 'pan-y pinch-zoom';
    iframe.style.overscrollBehaviorX = 'contain';
    setGestureDebug('EPUB 触摸层已绑定');
    let lastChromeToggleAt = 0;
    const requestReaderChromeToggle = () => {
      const now = Date.now();
      if (now - lastChromeToggleAt < 800) return false;
      const wasVisible = readerChromeVisible;
      toggleReaderChromeFromContent();
      if (readerChromeVisible === wasVisible) return false;
      lastChromeToggleAt = now;
      return true;
    };
    const isBlockedReaderGestureTarget = (target) => (
      target && typeof target.closest === 'function' && Boolean(
        target.closest('a, button, input, textarea, select, [contenteditable="true"], [role="button"], audio, video')
      )
    );

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

    // Desktop double-click toggles the same immersive controls. Prevent the
    // second mousedown from selecting a word when it is used as the gesture.
    doc.addEventListener('mousedown', (event) => {
      if (isMobileLayout() || event.button !== 0 || event.detail !== 2) return;
      if (event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents) return;
      const blockedTarget = isBlockedReaderGestureTarget(event.target);
      if (blockedTarget || pendingSelection || hasSelectionText(doc.getSelection())) return;
      event.preventDefault();
      event.stopPropagation();
      requestReaderChromeToggle();
    });

    // Some mobile browsers expose double-tap only as dblclick inside an
    // iframe. Keep this fallback, with deduplication against touchend.
    doc.addEventListener('dblclick', (event) => {
      if (isBlockedReaderGestureTarget(event.target) || pendingSelection) return;
      if (!isMobileLayout() && hasSelectionText(doc.getSelection())) return;
      event.preventDefault();
      event.stopPropagation();
      requestReaderChromeToggle();
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

    enableIframeTextSelection(doc);

    // Horizontal swipe navigation and double-tap chrome toggling share one
    // gesture tracker so neither interferes with native text selection.
    let touchStart = null;
    let pointerStart = null;
    let lastReaderTap = null;
    let lastSwipeNavigationAt = 0;
    const getSwipeDistanceThreshold = () => {
      const width = doc.documentElement.clientWidth || iframe.clientWidth || window.innerWidth;
      return Math.max(42, Math.min(72, width * 0.14));
    };
    const isReaderGestureBlocked = () => (
      hasOpenReaderSurface() ||
      Boolean(pendingSelection) ||
      !dom.selectionToolbar.hidden ||
      hasSelectionText(doc.getSelection()) ||
      Date.now() < selectionInteractionUntil
    );
    const triggerSwipeNavigation = (deltaX, source) => {
      const now = Date.now();
      if (now - lastSwipeNavigationAt < 350) return false;
      lastSwipeNavigationAt = now;
      setGestureDebug(`${source} → ${deltaX < 0 ? '下一页' : '上一页'}`);
      navigatePageWhenReady(deltaX < 0 ? 'next' : 'prev', source);
      return true;
    };

    gestureTarget.addEventListener('touchstart', (event) => {
      if (
        event.touches.length !== 1 ||
        isEditableTarget(event.target) ||
        isBlockedReaderGestureTarget(event.target) ||
        hasOpenReaderSurface()
      ) {
        touchStart = null;
        return;
      }
      const touch = event.touches[0];
      setGestureDebug(`touchstart (${Math.round(touch.clientX)}, ${Math.round(touch.clientY)})`);
      const hadSelection = hasSelectionText(doc.getSelection());
      touchStart = {
        x: touch.clientX,
        y: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY,
        at: Date.now(),
        target: event.target,
        hadSelection,
        intent: null,
        triggered: false,
        blocked: hadSelection || Boolean(pendingSelection) || !dom.selectionToolbar.hidden,
      };
      if (hadSelection) selectionInteractionUntil = Date.now() + 1200;
    }, { passive: true, capture: true });

    gestureTarget.addEventListener('touchmove', (event) => {
      if (!touchStart || event.touches.length !== 1) {
        touchStart = null;
        lastReaderTap = null;
        return;
      }
      const touch = event.touches[0];
      const deltaX = touch.clientX - touchStart.x;
      const deltaY = touch.clientY - touchStart.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      touchStart.lastX = touch.clientX;
      touchStart.lastY = touch.clientY;

      if (touchStart.blocked || isReaderGestureBlocked()) {
        touchStart.blocked = true;
        lastReaderTap = null;
        return;
      }
      if (!touchStart.intent && Date.now() - touchStart.at >= SWIPE_LONG_PRESS_MS) {
        touchStart.blocked = true;
        lastReaderTap = null;
        return;
      }
      if (!touchStart.intent && Math.hypot(deltaX, deltaY) >= SWIPE_INTENT_THRESHOLD) {
        if (absX >= absY * SWIPE_DIRECTION_RATIO) {
          touchStart.intent = 'horizontal';
        } else if (absY >= absX * SWIPE_DIRECTION_RATIO) {
          touchStart.intent = 'vertical';
        } else {
          touchStart.intent = 'diagonal';
        }
        lastReaderTap = null;
      }
      if (touchStart.intent === 'horizontal') {
        setGestureDebug(`touchmove 横向 ${Math.round(deltaX)}px`);
        event.preventDefault();
        event.stopPropagation();
        const elapsed = Math.max(1, Date.now() - touchStart.at);
        const threshold = getSwipeDistanceThreshold();
        const velocity = absX / elapsed;
        const isFastFlick = velocity >= SWIPE_FAST_VELOCITY && absX >= threshold * 0.65;
        if (
          isMobileLayout() &&
          !touchStart.triggered &&
          elapsed <= SWIPE_MAX_DURATION &&
          (absX >= threshold || isFastFlick)
        ) {
          touchStart.triggered = triggerSwipeNavigation(deltaX, 'touch-swipe');
        }
      }
    }, { passive: false, capture: true });

    gestureTarget.addEventListener('touchend', (event) => {
      scheduleIframeSelectionCapture(doc, iframe, 90);
      if (!touchStart || event.changedTouches.length !== 1 || !currentRendition) return;
      suppressMobileClickNavigationUntil = Date.now() + MOBILE_PAGE_TAP_DEDUPE_MS;
      const start = touchStart;
      touchStart = null;
      const selection = doc.getSelection();
      const hasSelection = hasSelectionText(selection);
      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const elapsed = Math.max(1, Date.now() - start.at);
      const moved = Math.hypot(deltaX, deltaY);
      const tapTargetBlocked = isBlockedReaderGestureTarget(start.target);
      if (start.triggered) {
        lastReaderTap = null;
        return;
      }
      const canHandleReaderTap =
        !start.intent &&
        !start.blocked &&
        elapsed <= READER_TAP_MAX_DURATION &&
        moved <= READER_TAP_MAX_MOVE &&
        !tapTargetBlocked &&
        !start.hadSelection &&
        !hasSelection &&
        !pendingSelection &&
        Date.now() >= selectionInteractionUntil &&
        !hasOpenReaderSurface();

      const frameWidth = doc.documentElement.clientWidth || iframe.clientWidth || window.innerWidth;
      if (canHandleReaderTap && triggerMobilePageTap(touch.clientX, frameWidth, 'touch-tap')) {
        event.preventDefault();
        event.stopPropagation();
        lastReaderTap = null;
        return;
      }

      if (canHandleReaderTap) {
        const now = Date.now();
        const isDoubleTap = lastReaderTap &&
          now - lastReaderTap.at <= READER_DOUBLE_TAP_MAX_MS &&
          Math.hypot(touch.clientX - lastReaderTap.x, touch.clientY - lastReaderTap.y) <= READER_DOUBLE_TAP_MAX_DISTANCE;
        if (isDoubleTap) {
          lastReaderTap = null;
          requestReaderChromeToggle();
        } else {
          lastReaderTap = { x: touch.clientX, y: touch.clientY, at: now };
        }
      } else {
        lastReaderTap = null;
      }

      if (
        !isMobileLayout() ||
        start.blocked ||
        start.hadSelection ||
        hasSelection ||
        pendingSelection ||
        !dom.selectionToolbar.hidden ||
        Date.now() < selectionInteractionUntil ||
        hasOpenReaderSurface() ||
        elapsed > SWIPE_MAX_DURATION
      ) return;

      const horizontalIntent = start.intent === 'horizontal' || (
        !start.intent && absX >= absY * SWIPE_DIRECTION_RATIO
      );
      if (!horizontalIntent) return;
      const threshold = getSwipeDistanceThreshold();
      const velocity = absX / elapsed;
      const isFastFlick = velocity >= SWIPE_FAST_VELOCITY && absX >= threshold * 0.65;
      if (absX < threshold && !isFastFlick) return;

      event.preventDefault();
      event.stopPropagation();
      lastReaderTap = null;
      triggerSwipeNavigation(deltaX, 'touch-swipe');
    }, { passive: false, capture: true });
    gestureTarget.addEventListener('touchcancel', (event) => {
      const start = touchStart;
      touchStart = null;
      lastReaderTap = null;
      if (
        !start ||
        start.triggered ||
        start.blocked ||
        start.hadSelection ||
        !isMobileLayout() ||
        isReaderGestureBlocked()
      ) return;

      const touch = event.changedTouches && event.changedTouches[0];
      const endX = touch ? touch.clientX : start.lastX;
      const endY = touch ? touch.clientY : start.lastY;
      const deltaX = endX - start.x;
      const deltaY = endY - start.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const elapsed = Math.max(1, Date.now() - start.at);
      const horizontalIntent = start.intent === 'horizontal' || (
        !start.intent && absX >= absY * SWIPE_DIRECTION_RATIO
      );
      if (!horizontalIntent || elapsed > SWIPE_MAX_DURATION) return;

      const threshold = getSwipeDistanceThreshold();
      const velocity = absX / elapsed;
      const isFastFlick = velocity >= SWIPE_FAST_VELOCITY && absX >= threshold * 0.65;
      if (absX < threshold && !isFastFlick) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      triggerSwipeNavigation(deltaX, 'touch-cancel-swipe');
    }, { passive: false, capture: true });

    // iOS WebKit sometimes dispatches iframe touch movement to the content
    // Window without delivering it to Document listeners. Listen at both
    // levels; the shared trigger lock and touchStart flag prevent duplicates.
    let windowTouchStart = null;
    const frameWindow = doc.defaultView;
    if (frameWindow) {
      frameWindow.addEventListener('touchstart', (event) => {
        if (
          event.touches.length !== 1 ||
          isEditableTarget(event.target) ||
          isBlockedReaderGestureTarget(event.target) ||
          hasOpenReaderSurface()
        ) {
          windowTouchStart = null;
          return;
        }
        const touch = event.touches[0];
        const hadSelection = hasSelectionText(doc.getSelection());
        windowTouchStart = {
          x: touch.clientX,
          y: touch.clientY,
          lastX: touch.clientX,
          lastY: touch.clientY,
          at: Date.now(),
          hadSelection,
          intent: null,
          triggered: false,
          blocked: hadSelection || Boolean(pendingSelection) || !dom.selectionToolbar.hidden,
        };
        setGestureDebug(`window touchstart (${Math.round(touch.clientX)}, ${Math.round(touch.clientY)})`);
      }, { passive: true, capture: true });

      frameWindow.addEventListener('touchmove', (event) => {
        if (!windowTouchStart || event.touches.length !== 1) return;
        const touch = event.touches[0];
        const deltaX = touch.clientX - windowTouchStart.x;
        const deltaY = touch.clientY - windowTouchStart.y;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);
        windowTouchStart.lastX = touch.clientX;
        windowTouchStart.lastY = touch.clientY;

        if (windowTouchStart.blocked || isReaderGestureBlocked()) {
          windowTouchStart.blocked = true;
          return;
        }
        if (!windowTouchStart.intent && Date.now() - windowTouchStart.at >= SWIPE_LONG_PRESS_MS) {
          windowTouchStart.blocked = true;
          return;
        }
        if (!windowTouchStart.intent && Math.hypot(deltaX, deltaY) >= SWIPE_INTENT_THRESHOLD) {
          if (absX >= absY * SWIPE_DIRECTION_RATIO) {
            windowTouchStart.intent = 'horizontal';
          } else if (absY >= absX * SWIPE_DIRECTION_RATIO) {
            windowTouchStart.intent = 'vertical';
          } else {
            windowTouchStart.intent = 'diagonal';
          }
        }
        if (windowTouchStart.intent !== 'horizontal') return;

        setGestureDebug(`window touchmove 横向 ${Math.round(deltaX)}px`);
        if (event.cancelable) event.preventDefault();
        const elapsed = Math.max(1, Date.now() - windowTouchStart.at);
        const threshold = getSwipeDistanceThreshold();
        const velocity = absX / elapsed;
        const isFastFlick = velocity >= SWIPE_FAST_VELOCITY && absX >= threshold * 0.65;
        if (
          isMobileLayout() &&
          !windowTouchStart.triggered &&
          elapsed <= SWIPE_MAX_DURATION &&
          (absX >= threshold || isFastFlick)
        ) {
          windowTouchStart.triggered = triggerSwipeNavigation(deltaX, 'webkit-window-swipe');
          if (windowTouchStart.triggered && touchStart) touchStart.triggered = true;
        }
      }, { passive: false, capture: true });

      frameWindow.addEventListener('touchend', (event) => {
        if (!windowTouchStart) return;
        const start = windowTouchStart;
        windowTouchStart = null;
        if (
          start.triggered ||
          start.blocked ||
          start.hadSelection ||
          !isMobileLayout() ||
          isReaderGestureBlocked()
        ) return;
        const touch = event.changedTouches && event.changedTouches[0];
        if (!touch) return;
        const deltaX = touch.clientX - start.x;
        const deltaY = touch.clientY - start.y;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);
        const elapsed = Math.max(1, Date.now() - start.at);
        const horizontalIntent = start.intent === 'horizontal' || (
          !start.intent && absX >= absY * SWIPE_DIRECTION_RATIO
        );
        if (!horizontalIntent || elapsed > SWIPE_MAX_DURATION) return;
        const threshold = getSwipeDistanceThreshold();
        const velocity = absX / elapsed;
        const isFastFlick = velocity >= SWIPE_FAST_VELOCITY && absX >= threshold * 0.65;
        if (absX < threshold && !isFastFlick) return;
        if (event.cancelable) event.preventDefault();
        const triggered = triggerSwipeNavigation(deltaX, 'webkit-window-swipe-end');
        if (triggered && touchStart) touchStart.triggered = true;
      }, { passive: false, capture: true });

      frameWindow.addEventListener('touchcancel', () => {
        windowTouchStart = null;
      }, { passive: true, capture: true });
    }

    // Pointer Events are more reliable than legacy Touch Events in some recent
    // iOS/Android WebViews. Keep both paths and deduplicate them above because
    // browsers may emit pointer and touch events for the same physical swipe.
    gestureTarget.addEventListener('pointerdown', (event) => {
      if (
        event.pointerType !== 'touch' ||
        event.isPrimary === false ||
        isEditableTarget(event.target) ||
        isBlockedReaderGestureTarget(event.target) ||
        hasOpenReaderSurface()
      ) {
        pointerStart = null;
        return;
      }
      setGestureDebug(`pointerdown (${Math.round(event.clientX)}, ${Math.round(event.clientY)})`);
      const hadSelection = hasSelectionText(doc.getSelection());
      pointerStart = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: Date.now(),
        target: event.target,
        hadSelection,
        intent: null,
        triggered: false,
        blocked: hadSelection || Boolean(pendingSelection) || !dom.selectionToolbar.hidden,
      };
      if (hadSelection) selectionInteractionUntil = Date.now() + 1200;
    }, { passive: true, capture: true });

    gestureTarget.addEventListener('pointermove', (event) => {
      if (
        !pointerStart ||
        event.pointerType !== 'touch' ||
        event.pointerId !== pointerStart.id
      ) return;
      const deltaX = event.clientX - pointerStart.x;
      const deltaY = event.clientY - pointerStart.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (pointerStart.blocked || isReaderGestureBlocked()) {
        pointerStart.blocked = true;
        return;
      }
      if (!pointerStart.intent && Date.now() - pointerStart.at >= SWIPE_LONG_PRESS_MS) {
        pointerStart.blocked = true;
        return;
      }
      if (!pointerStart.intent && Math.hypot(deltaX, deltaY) >= SWIPE_INTENT_THRESHOLD) {
        if (absX >= absY * SWIPE_DIRECTION_RATIO) {
          pointerStart.intent = 'horizontal';
        } else if (absY >= absX * SWIPE_DIRECTION_RATIO) {
          pointerStart.intent = 'vertical';
        } else {
          pointerStart.intent = 'diagonal';
        }
        lastReaderTap = null;
      }
      if (pointerStart.intent !== 'horizontal') return;

      setGestureDebug(`pointermove 横向 ${Math.round(deltaX)}px`);
      event.preventDefault();
      event.stopPropagation();
      const elapsed = Math.max(1, Date.now() - pointerStart.at);
      const threshold = getSwipeDistanceThreshold();
      const velocity = absX / elapsed;
      const isFastFlick = velocity >= SWIPE_FAST_VELOCITY && absX >= threshold * 0.65;
      if (
        isMobileLayout() &&
        !pointerStart.triggered &&
        elapsed <= SWIPE_MAX_DURATION &&
        (absX >= threshold || isFastFlick)
      ) {
        pointerStart.triggered = triggerSwipeNavigation(deltaX, 'pointer-swipe');
      }
    }, { passive: false, capture: true });

    gestureTarget.addEventListener('pointerup', (event) => {
      if (
        !pointerStart ||
        event.pointerType !== 'touch' ||
        event.pointerId !== pointerStart.id
      ) return;
      const start = pointerStart;
      pointerStart = null;
      suppressMobileClickNavigationUntil = Date.now() + MOBILE_PAGE_TAP_DEDUPE_MS;
      if (start.triggered || start.blocked || start.hadSelection || isReaderGestureBlocked()) return;

      const deltaX = event.clientX - start.x;
      const deltaY = event.clientY - start.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      const elapsed = Math.max(1, Date.now() - start.at);
      const moved = Math.hypot(deltaX, deltaY);
      const frameWidth = doc.documentElement.clientWidth || iframe.clientWidth || window.innerWidth;
      if (
        !start.intent &&
        elapsed <= READER_TAP_MAX_DURATION &&
        moved <= READER_TAP_MAX_MOVE &&
        !isBlockedReaderGestureTarget(start.target) &&
        triggerMobilePageTap(event.clientX, frameWidth, 'pointer-tap')
      ) {
        event.preventDefault();
        event.stopPropagation();
        lastReaderTap = null;
        return;
      }
      const horizontalIntent = start.intent === 'horizontal' || (
        !start.intent && absX >= absY * SWIPE_DIRECTION_RATIO
      );
      if (!isMobileLayout() || !horizontalIntent || elapsed > SWIPE_MAX_DURATION) return;

      const threshold = getSwipeDistanceThreshold();
      const velocity = absX / elapsed;
      const isFastFlick = velocity >= SWIPE_FAST_VELOCITY && absX >= threshold * 0.65;
      if (absX < threshold && !isFastFlick) return;
      event.preventDefault();
      event.stopPropagation();
      lastReaderTap = null;
      triggerSwipeNavigation(deltaX, 'pointer-swipe');
    }, { passive: false, capture: true });

    gestureTarget.addEventListener('pointercancel', () => {
      pointerStart = null;
    }, { passive: true, capture: true });

    // selectionchange is the reliable path while mobile selection handles are
    // being adjusted. touchend and mouseup remain as browser-specific fallbacks.
    doc.addEventListener('selectionchange', () => {
      if (hasSelectionText(doc.getSelection())) {
        selectionInteractionUntil = Date.now() + 1200;
        scheduleIframeSelectionCapture(doc, iframe, 90);
      }
    });
    doc.addEventListener('mouseup', () => {
      scheduleIframeSelectionCapture(doc, iframe, 50);
    });

    // Hide toolbar when clicking empty space (no selection after click). Do not
    // clear immediately after a mobile selection gesture: some browsers emit a
    // synthetic click before their Selection object has settled.
    doc.addEventListener('click', (event) => {
      const frameWidth = doc.documentElement.clientWidth || iframe.clientWidth || window.innerWidth;
      const canHandleClickTap =
        event.button === 0 &&
        Date.now() >= suppressMobileClickNavigationUntil &&
        !isBlockedReaderGestureTarget(event.target) &&
        !hasSelectionText(doc.getSelection()) &&
        !pendingSelection &&
        Date.now() >= selectionInteractionUntil &&
        !hasOpenReaderSurface();
      if (canHandleClickTap && triggerMobilePageTap(event.clientX, frameWidth, 'click-tap')) {
        event.preventDefault();
        event.stopPropagation();
        lastReaderTap = null;
        return;
      }
      setTimeout(() => {
        const sel = doc.getSelection();
        if (!hasSelectionText(sel) && Date.now() >= selectionInteractionUntil) {
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

  // ==================== AUTOMATIC NARRATION ====================
  function ttsErrorMessage(payload, fallback = '自动朗读暂时不可用') {
    const detail = payload && payload.detail;
    if (detail && typeof detail.message === 'string') return detail.message;
    if (typeof detail === 'string') return detail;
    return fallback;
  }

  function setTtsStatus(message, state = '') {
    dom.ttsStatus.textContent = message;
    dom.ttsStatus.dataset.state = state;
    syncReaderNavigationControls();
  }

  function formatAudioTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const rounded = Math.floor(seconds);
    return `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
  }

  function compactTtsText(value) {
    return String(value || '')
      .replace(/[\u00a0\u3000]/g, ' ')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .replace(/\s+/g, '');
  }

  function isTtsContentElementVisible(element) {
    if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    if (element.closest('script, style, noscript, nav, form, button, input, select, textarea, svg, canvas, iframe, audio, video, footer')) return false;
    const attrs = ['id', 'class', 'role'].map(name => element.getAttribute(name) || '').join(' ');
    if (/(^|[-_\s])(nav|menu|toolbar|breadcrumb|pagination|controls?|buttons?)([-_\s]|$)/i.test(attrs)) return false;
    const style = String(element.getAttribute('style') || '').replace(/\s/g, '').toLowerCase();
    return !style.includes('display:none') && !style.includes('visibility:hidden');
  }

  function buildTtsDocumentIndex(doc) {
    if (!doc || !doc.body) return null;
    const blocks = Array.from(doc.body.querySelectorAll(TTS_CONTENT_BLOCK_SELECTOR)).filter(element => {
      const parentBlock = element.parentElement && element.parentElement.closest(TTS_CONTENT_BLOCK_SELECTOR);
      return !parentBlock && isTtsContentElementVisible(element);
    });
    const roots = blocks.length ? blocks : [doc.body];
    const characters = [];
    const points = [];
    const nodeFilter = doc.defaultView && doc.defaultView.NodeFilter
      ? doc.defaultView.NodeFilter
      : NodeFilter;

    for (const root of roots) {
      const walker = doc.createTreeWalker(root, nodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = walker.nextNode())) {
        const parent = textNode.parentElement;
        if (!parent || !isTtsContentElementVisible(parent)) continue;
        const value = String(textNode.nodeValue || '');
        for (let offset = 0; offset < value.length; offset += 1) {
          const character = value[offset].replace(/[\u00a0\u3000]/g, ' ');
          if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\s]/.test(character)) continue;
          characters.push(character);
          points.push({ node: textNode, offset });
        }
      }
    }
    return { doc, text: characters.join(''), points };
  }

  function getTtsFollowCache() {
    const iframe = findReaderIframes()[0];
    const doc = iframe && iframe.contentDocument;
    if (!doc || !ttsTask) return null;
    if (
      ttsFollowDocumentCache &&
      ttsFollowDocumentCache.doc === doc &&
      ttsFollowDocumentCache.taskId === ttsTask.taskId
    ) return ttsFollowDocumentCache;

    const documentIndex = buildTtsDocumentIndex(doc);
    if (!documentIndex) return null;
    const mappings = new Map();
    let cursor = 0;
    const segments = [...(ttsTask.segments || [])].sort((a, b) => Number(a.index) - Number(b.index));
    for (const segment of segments) {
      const compact = compactTtsText(segment.text);
      if (!compact) continue;
      let start = documentIndex.text.indexOf(compact, cursor);
      if (start < 0) start = documentIndex.text.indexOf(compact);
      if (start < 0) continue;
      mappings.set(Number(segment.index), { start, end: start + compact.length, segment });
      cursor = start + compact.length;
    }
    ttsFollowDocumentCache = {
      doc,
      taskId: ttsTask.taskId,
      documentIndex,
      mappings,
    };
    return ttsFollowDocumentCache;
  }

  function ttsRangeForCue(segment, cue) {
    const cache = getTtsFollowCache();
    const mapping = cache && cache.mappings.get(Number(segment.index));
    if (!cache || !mapping) return null;
    const cueStart = cue ? compactTtsText(segment.text.slice(0, Number(cue.start) || 0)).length : 0;
    const cueEnd = cue
      ? compactTtsText(segment.text.slice(0, Number(cue.end) || 0)).length
      : mapping.end - mapping.start;
    const startIndex = mapping.start + cueStart;
    const endIndex = Math.max(startIndex + 1, mapping.start + cueEnd);
    const startPoint = cache.documentIndex.points[startIndex];
    const endPoint = cache.documentIndex.points[endIndex - 1];
    if (!startPoint || !endPoint) return null;
    try {
      const range = cache.doc.createRange();
      range.setStart(startPoint.node, startPoint.offset);
      range.setEnd(endPoint.node, endPoint.offset + 1);
      return range;
    } catch (_err) {
      return null;
    }
  }

  function removeTtsFollowAnnotations(cfi) {
    if (!cfi || !currentRendition || !currentRendition.annotations) return;
    try { currentRendition.annotations.remove(cfi, 'highlight'); } catch (_err) {}
    try { currentRendition.annotations.remove(cfi, 'underline'); } catch (_err) {}
  }

  function cancelPendingTtsFollowNavigation() {
    if (!ttsFollowPendingNavigation) return;
    ttsFollowPendingNavigation.resolve(false);
    ttsFollowPendingNavigation = null;
  }

  function pauseTtsFollowNavigation() {
    ttsFollowUpdateToken += 1;
    cancelPendingTtsFollowNavigation();
  }

  function clearTtsFollowHighlight({ restorePersistent = false } = {}) {
    pauseTtsFollowNavigation();
    removeTtsFollowAnnotations(ttsFollowCfi);
    ttsFollowCfi = '';
    ttsFollowCueKey = '';
    for (const iframe of findReaderIframes()) {
      try {
        iframe.contentDocument.documentElement.classList.remove('tts-follow-active');
        delete iframe.contentDocument.documentElement.dataset.ttsFollowText;
        delete iframe.contentDocument.documentElement.dataset.ttsFollowSource;
      } catch (_err) { /* ignore inaccessible frames */ }
    }
    if (restorePersistent) restoreHighlights();
  }

  function isRangeVisibleInReader(range) {
    if (!range) return false;
    const doc = range.commonAncestorContainer.ownerDocument;
    const iframe = getIframeForDocument(doc);
    if (!iframe || !dom.epubContainer) return false;
    const frameRect = iframe.getBoundingClientRect();
    const hostRect = dom.epubContainer.getBoundingClientRect();
    return Array.from(range.getClientRects()).some(rect => {
      const left = frameRect.left + rect.left;
      const right = frameRect.left + rect.right;
      const top = frameRect.top + rect.top;
      const bottom = frameRect.top + rect.bottom;
      return right > hostRect.left && left < hostRect.right && bottom > hostRect.top && top < hostRect.bottom;
    });
  }

  async function drainTtsFollowNavigationQueue() {
    ttsFollowNavigationInProgress = true;
    try {
      while (ttsFollowPendingNavigation) {
        const request = ttsFollowPendingNavigation;
        ttsFollowPendingNavigation = null;
        let displayed = false;
        try {
          if (request.updateToken !== ttsFollowUpdateToken || !isTtsNavigationLocked()) {
            request.resolve(false);
            continue;
          }
          await currentRendition.display(request.cfi);
          displayed = true;
        } catch (err) {
          console.warn('TTS follow navigation failed:', err);
        }
        const isLatest = !ttsFollowPendingNavigation &&
          request.updateToken === ttsFollowUpdateToken &&
          isTtsNavigationLocked();
        request.resolve(displayed && isLatest);
      }
    } finally {
      ttsFollowNavigationInProgress = false;
      ttsFollowNavigationWorker = null;
      if (ttsFollowPendingNavigation) {
        ttsFollowNavigationWorker = drainTtsFollowNavigationQueue();
      }
    }
  }

  function queueTtsFollowNavigation(cfi, updateToken) {
    return new Promise((resolve) => {
      if (ttsFollowPendingNavigation) {
        ttsFollowPendingNavigation.resolve(false);
      }
      ttsFollowPendingNavigation = { cfi, updateToken, resolve };
      if (!ttsFollowNavigationWorker) {
        ttsFollowNavigationWorker = drainTtsFollowNavigationQueue();
      }
    });
  }

  async function updateTtsFollowHighlight({
    force = false,
    source = 'timeline',
    navigation = 'if-needed',
  } = {}) {
    const segment = readyTtsSegment(ttsSegmentIndex);
    if (!segment || !currentRendition || ttsChapterId !== currentChapterId) return;
    const cues = Array.isArray(segment.cues) ? segment.cues : [];
    const currentMs = Math.max(0, Number(dom.ttsAudio.currentTime || 0) * 1000);
    let cueIndex = -1;
    for (let index = 0; index < cues.length; index += 1) {
      if (Number(cues[index].startMs || 0) <= currentMs + 20) cueIndex = index;
      else break;
    }
    if (cues.length && cueIndex < 0) cueIndex = 0;
    const cue = cueIndex >= 0 ? cues[cueIndex] : null;
    const cueKey = `${ttsTask.taskId}:${ttsSegmentIndex}:${cueIndex}`;
    if (!force && cueKey === ttsFollowCueKey) return;

    const range = ttsRangeForCue(segment, cue) || ttsRangeForCue(segment, null);
    if (!range) return;
    const cfi = cfiFromIframeRange(range);
    if (!cfi) return;
    const updateToken = ++ttsFollowUpdateToken;
    const previousFollowCfi = ttsFollowCfi;
    ttsFollowCueKey = cueKey;

    const navigationLocked = isTtsNavigationLocked();
    const mustNavigate = navigation === 'force' && navigationLocked;
    const shouldNavigate = navigation === 'if-needed' && navigationLocked && !isRangeVisibleInReader(range);
    if (mustNavigate || shouldNavigate) {
      const followedLatestPosition = await queueTtsFollowNavigation(cfi, updateToken);
      if (!followedLatestPosition) return;
    }
    if (updateToken !== ttsFollowUpdateToken || !currentRendition || !currentRendition.annotations) return;
    removeTtsFollowAnnotations(previousFollowCfi);
    ttsFollowCfi = cfi;
    const activeRange = ttsRangeForCue(segment, cue) || range;
    try {
      currentRendition.annotations.highlight(
        cfi,
        { ttsFollow: true, source },
        null,
        TTS_FOLLOW_CLASS,
        {
          fill: 'rgb(224, 128, 43)',
          'fill-opacity': '0.24',
          stroke: 'rgb(183, 91, 23)',
          'stroke-opacity': '0.28',
        }
      );
      if (typeof currentRendition.annotations.underline === 'function') {
        currentRendition.annotations.underline(
          cfi,
          { ttsFollow: true, source },
          null,
          TTS_FOLLOW_UNDERLINE_CLASS,
          {
            stroke: 'rgb(171, 82, 19)',
            'stroke-opacity': '0.96',
            'stroke-width': '2.4',
          }
        );
      }
      const doc = activeRange.commonAncestorContainer.ownerDocument;
      doc.documentElement.classList.add('tts-follow-active');
      doc.documentElement.dataset.ttsFollowText = cue ? cue.text : segment.text;
      doc.documentElement.dataset.ttsFollowSource = source;
    } catch (err) {
      console.warn('TTS follow highlight failed:', err);
    }
  }

  function getSavedTtsPosition() {
    try {
      const parsed = JSON.parse(localStorage.getItem(TTS_POSITION_KEY) || 'null');
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_err) {
      return null;
    }
  }

  function saveTtsPosition(force = false) {
    if (!currentBookMeta || !ttsChapterId || !ttsTask) return;
    const now = Date.now();
    if (!force && now - ttsLastSavedAt < 1000) return;
    ttsLastSavedAt = now;
    try {
      localStorage.setItem(TTS_POSITION_KEY, JSON.stringify({
        book_id: currentBookMeta.id,
        chapter_id: ttsChapterId,
        segment_index: ttsSegmentIndex,
        current_time: Number(dom.ttsAudio.currentTime || 0),
        voice: dom.ttsVoice.value,
        rate: Number(dom.ttsRate.value),
      }));
    } catch (_err) {
      // Playback continues if localStorage is unavailable.
    }
  }

  function clearTtsPoll() {
    if (ttsPollTimer) clearTimeout(ttsPollTimer);
    ttsPollTimer = null;
  }

  function stopTtsForChapter({ resetTask = false } = {}) {
    clearTtsPoll();
    saveTtsPosition(true);
    ttsWantsPlay = false;
    ttsIsPlaying = false;
    ttsPlaybackStarting = false;
    clearTtsFollowHighlight({ restorePersistent: true });
    ttsFollowDocumentCache = null;
    dom.ttsAudio.pause();
    dom.ttsAudio.removeAttribute('src');
    dom.ttsAudio.dataset.segmentIndex = '';
    dom.ttsAudio.load();
    dom.ttsProgress.value = '0';
    dom.ttsProgress.disabled = true;
    dom.ttsTime.textContent = '00:00 / 00:00';
    if (resetTask) {
      ttsTask = null;
      ttsChapterId = '';
      ttsSegmentIndex = 0;
      dom.ttsSegmentLabel.textContent = '第 0 / 0 段';
      dom.btnTtsPlay.disabled = true;
      dom.btnTtsPause.disabled = true;
      dom.btnTtsPrev.disabled = true;
      dom.btnTtsNext.disabled = true;
      setTtsStatus('选择声音后朗读当前章节');
    }
    syncReaderNavigationControls();
  }

  function setTtsPanelOpen(open) {
    if (open) {
      setReaderChromeVisible(true);
      cancelReaderChromeHide();
      closeOtherMobileReaderPanels('tts');
      setReaderToolsOpen(false, { skipChromeSchedule: true });
      ttsRestoredPosition = getSavedTtsPosition();
    }
    dom.ttsPanel.hidden = !open;
    syncReaderToolStates();
    syncReaderPanelBackdrop();
    if (!open) scheduleReaderChromeHide();
  }

  function toggleTtsPanel() {
    setTtsPanelOpen(dom.ttsPanel.hidden);
  }

  async function loadTtsVoices() {
    try {
      const response = await fetchWithTimeout(API_BASE + '/api/tts/voices');
      if (!response.ok) throw new Error(`Server responded with ${response.status}`);
      const data = await response.json();
      if (!data.enabled) {
        dom.btnToggleTts.disabled = true;
        setTtsStatus('自动朗读功能已关闭', 'failed');
        return;
      }
      const saved = getSavedTtsPosition();
      dom.ttsVoice.innerHTML = (data.voices || []).map(voice => (
        `<option value="${escapeHTML(voice.id)}">${escapeHTML(voice.name)}</option>`
      )).join('');
      const preferred = saved && (data.voices || []).some(voice => voice.id === saved.voice)
        ? saved.voice
        : data.defaultVoice;
      if (preferred) dom.ttsVoice.value = preferred;
      if (saved && [0.75, 1, 1.25, 1.5, 2].includes(Number(saved.rate))) {
        dom.ttsRate.value = String(Number(saved.rate));
      }
    } catch (err) {
      console.warn('Failed to load TTS voices:', err);
      setTtsStatus('无法读取朗读声音列表', 'failed');
    }
  }

  async function startChapterTts({ autoplay = true } = {}) {
    if (!currentBookMeta || !currentChapterId) {
      showToast('当前章节尚未加载完成', 'info');
      return;
    }
    const bookId = currentBookMeta.server_book_id || (
      currentBookMeta.source === 'server' || currentBookMeta._source === 'server'
        ? currentBookMeta.id
        : null
    );
    if (!bookId) {
      showToast('请等待书籍上传服务器后再使用朗读', 'warning');
      return;
    }

    stopTtsForChapter({ resetTask: true });
    ttsChapterId = currentChapterId;
    ttsWantsPlay = autoplay;
    dom.btnTtsStart.disabled = true;
    setTtsStatus('正在清理正文并生成第一段…', 'generating');
    try {
      const response = await fetchWithTimeout(
        API_BASE + '/api/books/' + encodeURIComponent(bookId) + '/chapters/' +
          encodeURIComponent(ttsChapterId) + '/tts',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            voice: dom.ttsVoice.value,
            rate: Number(dom.ttsRate.value),
          }),
        },
        30000
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(ttsErrorMessage(payload));
      if (ttsChapterId !== currentChapterId) return;
      ttsTask = payload;
      ttsFollowDocumentCache = null;
      const saved = ttsRestoredPosition || getSavedTtsPosition();
      const canRestore = saved &&
        saved.book_id === currentBookMeta.id &&
        saved.chapter_id === ttsChapterId &&
        saved.voice === dom.ttsVoice.value &&
        Number(saved.rate) === Number(dom.ttsRate.value);
      ttsSegmentIndex = canRestore
        ? Math.max(0, Math.min(Number(saved.segment_index) || 0, payload.segmentCount - 1))
        : 0;
      ttsRestoredPosition = canRestore ? saved : null;
      applyTtsTask(payload);
    } catch (err) {
      console.error('TTS task creation failed:', err);
      ttsWantsPlay = false;
      ttsIsPlaying = false;
      ttsPlaybackStarting = false;
      clearTtsFollowHighlight({ restorePersistent: true });
      setTtsStatus(err.message || '朗读任务创建失败', 'failed');
      showToast(err.message || '朗读任务创建失败', 'error');
    } finally {
      dom.btnTtsStart.disabled = false;
    }
  }

  function readyTtsSegment(index) {
    return ttsTask && (ttsTask.segments || []).find(segment => Number(segment.index) === index);
  }

  function scheduleTtsPoll() {
    clearTtsPoll();
    if (!ttsTask || ttsTask.status === 'failed') return;
    if (ttsTask.status === 'completed' && !ttsWantsPlay) return;
    const taskId = ttsTask.taskId;
    ttsPollTimer = setTimeout(() => pollTtsTask(taskId), TTS_POLL_INTERVAL_MS);
  }

  async function pollTtsTask(taskId) {
    ttsPollTimer = null;
    if (!ttsTask || ttsTask.taskId !== taskId) return;
    try {
      const response = await fetchWithTimeout(
        API_BASE + '/api/tts/tasks/' + encodeURIComponent(taskId), {}, 10000
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(ttsErrorMessage(payload, '无法读取朗读生成状态'));
      if (!ttsTask || ttsTask.taskId !== taskId || ttsChapterId !== currentChapterId) return;
      ttsTask = payload;
      ttsFollowDocumentCache = null;
      applyTtsTask(payload);
    } catch (err) {
      ttsWantsPlay = false;
      ttsIsPlaying = false;
      ttsPlaybackStarting = false;
      dom.ttsAudio.pause();
      clearTtsFollowHighlight({ restorePersistent: true });
      setTtsStatus(err.message || '朗读状态查询失败', 'failed');
    }
  }

  function applyTtsTask(task) {
    const total = Number(task.segmentCount || 0);
    const completed = Number(task.completedSegments || 0);
    dom.ttsSegmentLabel.textContent = total
      ? `第 ${Math.min(ttsSegmentIndex + 1, total)} / ${total} 段`
      : '第 0 / 0 段';
    dom.btnTtsPrev.disabled = !total || ttsSegmentIndex <= 0;
    dom.btnTtsNext.disabled = !total || ttsSegmentIndex >= total - 1;
    dom.btnTtsPlay.disabled = !total;
    dom.btnTtsPause.disabled = !total;

    if (task.status === 'failed') {
      ttsWantsPlay = false;
      ttsIsPlaying = false;
      ttsPlaybackStarting = false;
      dom.ttsAudio.pause();
      clearTtsFollowHighlight({ restorePersistent: true });
      setTtsStatus(task.error || '语音生成失败，请重试', 'failed');
      return;
    }
    const segment = readyTtsSegment(ttsSegmentIndex);
    if (ttsWantsPlay && segment) {
      playTtsSegment(ttsSegmentIndex, true);
    } else if (ttsWantsPlay) {
      setTtsStatus(`第 ${ttsSegmentIndex + 1} 段生成中，跟随定位与翻页锁定已开启…`, 'generating');
    } else if (ttsIsPlaying) {
      setTtsStatus(
        task.status === 'completed'
          ? `正在播放第 ${ttsSegmentIndex + 1} 段 · 跟随原文，暂停后可翻页`
          : `正在播放第 ${ttsSegmentIndex + 1} 段 · 跟随原文，后续仍在生成`,
        'playing'
      );
    } else if (task.status === 'completed') {
      setTtsStatus(`全部 ${total} 段已缓存，可直接播放`, 'completed');
    } else {
      setTtsStatus(`已生成 ${completed}/${total} 段，后台继续生成…`, 'generating');
    }
    if (task.status !== 'completed' || (ttsWantsPlay && !segment)) scheduleTtsPoll();
  }

  async function playTtsSegment(index, autoplay = true) {
    if (!ttsTask) return;
    const segment = readyTtsSegment(index);
    ttsSegmentIndex = Math.max(0, Math.min(index, Number(ttsTask.segmentCount || 1) - 1));
    ttsFollowCueKey = '';
    if (segment && autoplay) {
      ttsWantsPlay = false;
      ttsPlaybackStarting = true;
    }
    applyTtsTask({ ...ttsTask, status: ttsTask.status });
    if (!segment) {
      ttsPlaybackStarting = false;
      ttsWantsPlay = autoplay;
      setTtsStatus(`第 ${ttsSegmentIndex + 1} 段仍在生成，请稍候…`, 'generating');
      scheduleTtsPoll();
      return;
    }
    const segmentKey = String(ttsSegmentIndex);
    if (dom.ttsAudio.dataset.segmentIndex !== segmentKey) {
      dom.ttsAudio.pause();
      dom.ttsAudio.src = segment.audioUrl;
      dom.ttsAudio.dataset.segmentIndex = segmentKey;
      dom.ttsAudio.load();
      dom.ttsProgress.value = '0';
      const restored = ttsRestoredPosition;
      if (restored && Number(restored.segment_index) === ttsSegmentIndex) {
        dom.ttsAudio.addEventListener('loadedmetadata', () => {
          dom.ttsAudio.currentTime = Math.min(
            Number(restored.current_time) || 0,
            Number.isFinite(dom.ttsAudio.duration) ? dom.ttsAudio.duration : Number(restored.current_time) || 0
          );
          ttsRestoredPosition = null;
        }, { once: true });
      }
    }
    dom.ttsSegmentLabel.textContent = `第 ${ttsSegmentIndex + 1} / ${ttsTask.segmentCount} 段`;
    if (!autoplay) return;
    ttsWantsPlay = false;
    try {
      await updateTtsFollowHighlight({
        force: true,
        source: 'start',
        navigation: 'force',
      });
      await dom.ttsAudio.play();
      ttsIsPlaying = true;
      ttsPlaybackStarting = false;
      setTtsStatus(
        ttsTask.status === 'completed'
          ? `正在播放第 ${ttsSegmentIndex + 1} 段 · 跟随原文，暂停后可翻页`
          : `正在播放第 ${ttsSegmentIndex + 1} 段 · 跟随原文，后续仍在生成`,
        'playing'
      );
    } catch (err) {
      ttsIsPlaying = false;
      ttsPlaybackStarting = false;
      console.warn('Audio autoplay was blocked:', err);
      setTtsStatus('音频已就绪，请点“播放”继续', 'ready');
    }
  }

  function handleTtsOptionChange() {
    if (!ttsTask) return;
    // Do not save the old audio position under the newly selected options.
    ttsTask = null;
    stopTtsForChapter({ resetTask: true });
    setTtsStatus('声音或语速已变化，请重新点击朗读');
  }

  // ==================== SEARCH ====================
  function setSearchPanelOpen(open, { clearOnClose = true } = {}) {
    if (open) {
      setReaderChromeVisible(true);
      cancelReaderChromeHide();
      closeOtherMobileReaderPanels('search');
      if (isMobileLayout()) setReaderToolsOpen(false, { skipChromeSchedule: true });
    }
    dom.searchPanel.hidden = !open;
    dom.toolbarSearch.hidden = !open;
    dom.btnSearchClose.hidden = !open;
    if (!open && clearOnClose) clearSearchResults();
    syncReaderToolStates();
    syncReaderPanelBackdrop();
    refreshReaderLayout();
    if (open) {
      safeFocus(dom.searchInput);
    } else {
      scheduleReaderChromeHide();
    }
  }

  function toggleSearchPanel() {
    setSearchPanelOpen(dom.searchPanel.hidden);
  }

  const SEARCH_MAX_RESULTS = 100;
  const SEARCH_EXCERPT_RADIUS = 40;

  async function performSearch(query) {
    if (!query || query.length < 2) {
      dom.searchResults.innerHTML = '<div class="empty-search">至少输入 2 个字符</div>';
      dom.searchCount.textContent = '0 条';
      return;
    }

    if (!currentBook || !currentBook.spine) {
      dom.searchResults.innerHTML = '<div class="empty-search">请先打开一本书</div>';
      dom.searchCount.textContent = '0 条';
      return;
    }

    dom.searchResults.innerHTML = '<div class="empty-search">搜索中…</div>';
    dom.searchCount.textContent = '搜索中…';

    try {
      clearSearchHighlights();

      const results = await searchBookContent(query);
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
      if (err && err.name === 'SearchCancelledError') return;
      console.error('Search failed:', err);
      dom.searchResults.innerHTML = '<div class="empty-search">搜索失败，请重试</div>';
      dom.searchCount.textContent = '0 条';
    }
  }

  function cancelBookSearch() {
    searchToken += 1;
  }

  function throwIfSearchCancelled(token) {
    if (token !== searchToken) {
      const err = new Error('Search cancelled');
      err.name = 'SearchCancelledError';
      throw err;
    }
  }

  // Walk every spine section and collect substring matches (epub.js v0.3
  // only exposes find/search on Section, not on Book).
  async function searchBookContent(query) {
    const token = ++searchToken;
    const needle = query.toLowerCase();
    const results = [];
    const spineItems = (currentBook.spine.spineItems || []).filter(s => s && s.linear !== 'no');
    const total = spineItems.length;

    for (let i = 0; i < spineItems.length; i++) {
      throwIfSearchCancelled(token);
      dom.searchCount.textContent = `搜索中… ${i + 1}/${total}`;

      const section = spineItems[i];
      let doc = null;
      try {
        // section.load() resolves to the root element; the parsed
        // Document lives on section.document.
        const loaded = await section.load(currentBook.load.bind(currentBook));
        doc = section.document || (loaded && loaded.ownerDocument) || null;
      } catch (e) {
        continue; // skip unreadable sections
      }
      throwIfSearchCancelled(token);

      try {
        if (doc && doc.body) {
          collectSectionMatches(doc, section, needle, query, results);
        }
      } finally {
        if (section.unload) section.unload();
      }
      if (results.length >= SEARCH_MAX_RESULTS) break;

      // Yield to keep the UI responsive on large books.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return results;
  }

  function collectSectionMatches(doc, section, needle, query, results) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    while ((node = walker.nextNode()) && results.length < SEARCH_MAX_RESULTS) {
      const text = node.textContent;
      const lower = text.toLowerCase();
      let from = 0;
      let index = lower.indexOf(needle, from);
      while (index !== -1 && results.length < SEARCH_MAX_RESULTS) {
        const cfi = cfiForTextMatch(doc, section, node, index, query.length);
        const start = Math.max(0, index - SEARCH_EXCERPT_RADIUS);
        const end = Math.min(text.length, index + query.length + SEARCH_EXCERPT_RADIUS);
        const excerpt = (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
        results.push({ cfi, excerpt });
        from = index + query.length;
        index = lower.indexOf(needle, from);
      }
    }
  }

  function cfiForTextMatch(doc, section, textNode, index, length) {
    try {
      const range = doc.createRange();
      range.setStart(textNode, index);
      range.setEnd(textNode, Math.min(textNode.textContent.length, index + length));
      return section.cfiFromRange(range);
    } catch (e) {
      return section.cfiBase ? `epubcfi(${section.cfiBase})` : '';
    }
  }

  function renderSearchResults(query) {
    dom.searchResults.innerHTML = '';
    const maxResults = SEARCH_MAX_RESULTS;
    const displayResults = searchResultsList.slice(0, maxResults);
    const queryRegex = new RegExp(escapeRegex(query), 'gi');

    for (const result of displayResults) {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      const excerpt = (result.excerpt || '').replace(/\n/g, ' ').trim();
      const highlighted = escapeHTML(excerpt).replace(queryRegex, m => `<mark>${m}</mark>`);
      item.innerHTML = `
        <div class="search-result-excerpt">${highlighted}</div>
        <div class="search-result-meta">点击跳转</div>
      `;
      item.addEventListener('click', () => {
        if (blockManualNavigationDuringTts()) return;
        if (result.cfi) currentRendition.display(result.cfi);
        if (isMobileLayout()) {
          setSearchPanelOpen(false, { clearOnClose: false });
        }
      });
      dom.searchResults.appendChild(item);
    }

    if (searchResultsList.length >= maxResults) {
      const more = document.createElement('div');
      more.className = 'search-result-more';
      more.textContent = `仅显示前 ${maxResults} 条匹配，请缩小关键词范围`;
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
        ttsFollowDocumentCache = null;
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
        if (marks.length) ttsFollowDocumentCache = null;
      }
    } catch (e) { /* ignore */ }
  }

  function clearSearchResults() {
    cancelBookSearch();
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

    const direction = delta > 0 ? -1 : 1;
    setReaderFontSize(currentFontSize + direction * FONT_SIZE_STEP);
  }

  // ==================== HIGHLIGHTING / SELECTION ====================
  function enableIframeTextSelection(doc) {
    if (!doc || !doc.head) return;
    applyReaderTypographyToDocument(doc);
    if (doc.getElementById('marginalia-selection-style')) return;
    const style = doc.createElement('style');
    style.id = 'marginalia-selection-style';
    style.textContent = `
      html, body, p, div, span, li, blockquote, h1, h2, h3, h4, h5, h6 {
        -webkit-user-select: text !important;
        user-select: text !important;
        -webkit-touch-callout: default !important;
      }
      html, body {
        touch-action: pan-y;
        touch-action: pan-y pinch-zoom;
        overscroll-behavior-x: contain;
      }
      :where(html, body) {
        background: #fffaf0;
        color: #292c27;
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
      }
      :where(body) {
        font-family: "Noto Serif SC", "Source Han Serif SC", "Songti SC", Georgia, serif;
      }
      :where(p, li, blockquote) {
        line-height: 1.72;
        orphans: 2;
        widows: 2;
      }
      :where(a) {
        color: #2f604a;
        text-decoration-color: rgba(47, 96, 74, 0.38);
        text-underline-offset: 0.16em;
      }
      :where(img, svg, video) {
        max-width: 100%;
        height: auto;
      }
      html.tts-follow-active .${TTS_FOLLOW_CLASS} {
        mix-blend-mode: multiply;
        pointer-events: none !important;
      }
      html.tts-follow-active .${TTS_FOLLOW_UNDERLINE_CLASS} {
        filter: drop-shadow(0 1px 0 rgba(255, 250, 240, 0.72));
        pointer-events: none !important;
      }
    `;
    doc.head.appendChild(style);
  }

  function getContentsForDocument(doc) {
    if (!doc || !currentRendition) return null;
    let contentsList = [];
    try {
      if (typeof currentRendition.getContents === 'function') {
        contentsList = currentRendition.getContents() || [];
      } else if (currentRendition.manager && typeof currentRendition.manager.getContents === 'function') {
        contentsList = currentRendition.manager.getContents() || [];
      }
    } catch (_err) {
      return null;
    }
    return contentsList.find(contents => contents && contents.document === doc) || null;
  }

  function cfiFromIframeRange(range, contents) {
    if (!range) return '';
    const rangeContents = contents || getContentsForDocument(range.commonAncestorContainer.ownerDocument);
    if (!rangeContents || typeof rangeContents.cfiFromRange !== 'function') return '';
    try {
      return rangeContents.cfiFromRange(range.cloneRange()) || '';
    } catch (err) {
      console.warn('Could not create CFI from selection:', err);
      return '';
    }
  }

  function setPendingSelectionFromRange(range, iframe, options = {}) {
    if (!range) return false;
    const text = range.toString().trim();
    if (!text || text.length < 2) return false;

    const doc = range.commonAncestorContainer.ownerDocument;
    const contents = options.contents || getContentsForDocument(doc);
    const cfiRange = options.cfiRange || cfiFromIframeRange(range, contents);
    const loc = currentRendition && currentRendition.currentLocation
      ? currentRendition.currentLocation()
      : null;
    const locationCfi = loc && loc.start ? loc.start.cfi : '';

    pendingSelection = {
      cfiRange,
      cfi: locationCfi,
      text,
      contents,
      document: doc,
      range: range.cloneRange(),
    };
    selectionInteractionUntil = Date.now() + 1200;
    positionSelectionToolbar(range, iframe || getIframeForDocument(doc));
    dom.selectionToolbar.hidden = false;
    return true;
  }

  function captureIframeSelection(doc, iframe) {
    if (!doc) return false;
    const selection = doc.getSelection();
    if (!hasSelectionText(selection) || !selection.rangeCount) return false;
    return setPendingSelectionFromRange(selection.getRangeAt(0), iframe);
  }

  function scheduleIframeSelectionCapture(doc, iframe, delay = 80) {
    if (selectionSettleTimer) clearTimeout(selectionSettleTimer);
    selectionSettleTimer = setTimeout(() => {
      selectionSettleTimer = null;
      captureIframeSelection(doc, iframe);
    }, delay);
  }

  function setupSelectionHandling(rendition) {
    rendition.on('selected', (cfiRange, contents) => {
      const range = rendition.getRange(cfiRange);
      if (!range) return;
      if (!setPendingSelectionFromRange(
        range,
        getIframeForContents(contents) || getIframeForRange(range),
        { cfiRange, contents }
      )) {
        hideSelectionToolbar();
      }
    });

    // Hide only after a genuine click-away. Mobile browsers can emit click
    // while the native selection handles are still settling.
    rendition.on('click', () => {
      setTimeout(() => {
        const iframe = dom.epubContainer.querySelector('iframe');
        const selection = iframe && iframe.contentDocument
          ? iframe.contentDocument.getSelection()
          : null;
        if (!hasSelectionText(selection) && Date.now() >= selectionInteractionUntil) {
          hideSelectionToolbar();
        }
      }, 200);
    });

    // Handle clicks on the EPUB host controls outside the iframe.
    dom.epubContainer.addEventListener('click', () => {
      setTimeout(() => {
        const selection = window.getSelection();
        if (!hasSelectionText(selection) && Date.now() >= selectionInteractionUntil) {
          clearSelection(selection);
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

    const clientRects = typeof range.getClientRects === 'function'
      ? Array.from(range.getClientRects()).filter(item => item.width || item.height)
      : [];
    const boundingRect = range.getBoundingClientRect();
    const anchorRect = clientRects[0] || boundingRect;
    const selectionBounds = clientRects.length
      ? clientRects.reduce((bounds, item) => ({
        top: Math.min(bounds.top, item.top),
        right: Math.max(bounds.right, item.right),
        bottom: Math.max(bounds.bottom, item.bottom),
        left: Math.min(bounds.left, item.left),
      }), {
        top: clientRects[0].top,
        right: clientRects[0].right,
        bottom: clientRects[0].bottom,
        left: clientRects[0].left,
      })
      : boundingRect;
    const frameRect = iframe ? iframe.getBoundingClientRect() : null;
    const toolbar = dom.selectionToolbar;
    const wasHidden = toolbar.hidden;

    if (wasHidden) {
      toolbar.hidden = false;
      toolbar.style.visibility = 'hidden';
    }

    const frameTop = frameRect ? frameRect.top : 0;
    const frameLeft = frameRect ? frameRect.left : 0;
    const selectionTop = selectionBounds.top + frameTop;
    const selectionBottom = selectionBounds.bottom + frameTop;
    const anchorLeft = anchorRect.left + frameLeft;
    const visualViewport = window.visualViewport;
    const viewportTop = visualViewport ? visualViewport.offsetTop : 0;
    const viewportLeft = visualViewport ? visualViewport.offsetLeft : 0;
    const viewportRight = viewportLeft + (visualViewport ? visualViewport.width : window.innerWidth);
    const viewportBottom = viewportTop + (visualViewport ? visualViewport.height : window.innerHeight);
    const edgeGap = 8;

    let top = selectionTop - toolbar.offsetHeight - edgeGap;
    let left = anchorLeft + (anchorRect.width / 2) - (toolbar.offsetWidth / 2);

    // Keep the controls inside the visual viewport, including when the soft
    // keyboard is open or the page is running as an installed PWA.
    if (top < viewportTop + edgeGap) top = selectionBottom + edgeGap;
    if (top + toolbar.offsetHeight > viewportBottom - edgeGap) {
      top = Math.max(viewportTop + edgeGap, selectionTop - toolbar.offsetHeight - edgeGap);
    }
    left = Math.max(viewportLeft + edgeGap, left);
    left = Math.min(left, viewportRight - toolbar.offsetWidth - edgeGap);

    toolbar.style.top = Math.round(top) + 'px';
    toolbar.style.left = Math.round(left) + 'px';
    toolbar.style.visibility = '';
  }

  function hideSelectionToolbar() {
    if (selectionSettleTimer) {
      clearTimeout(selectionSettleTimer);
      selectionSettleTimer = null;
    }
    dom.selectionToolbar.hidden = true;
    pendingSelection = null;
    selectionInteractionUntil = 0;
  }

  // ==================== APPLY HIGHLIGHT ====================
  async function applyHighlight(color, extraFields) {
    if (!pendingSelection || !currentRendition) return null;

    const selectionState = pendingSelection;
    const { cfiRange, cfi, text } = selectionState;
    const storedCfi = cfiRange || cfi;

    try {
      // A range CFI survives focus changes, iframe re-renders and app restarts,
      // so it is the canonical visual representation. DOM wrapping is only a
      // fallback for publications where epub.js cannot create a range CFI.
      let annotationApplied = false;
      if (cfiRange) {
        try {
          applyAnnotationHighlight(cfiRange, color);
          annotationApplied = true;
        } catch (err) {
          console.warn('Annotation highlight failed, using DOM fallback:', err);
        }
      }

      const selectionDoc = selectionState.document;
      const liveSelection = selectionDoc && typeof selectionDoc.getSelection === 'function'
        ? selectionDoc.getSelection()
        : null;
      if (!annotationApplied && selectionDoc) {
        const fallbackRange = hasSelectionText(liveSelection) && liveSelection.rangeCount
          ? liveSelection.getRangeAt(0)
          : selectionState.range;
        if (fallbackRange && fallbackRange.commonAncestorContainer.isConnected) {
          try {
            const span = selectionDoc.createElement('span');
            span.className = 'marginalia-hl';
            span.style.cssText = getHighlightStyle(color);
            fallbackRange.surroundContents(span);
          } catch (err) {
            console.warn('DOM highlight fallback failed:', err);
          }
        }
      }
      clearSelection(liveSelection);

      const highlightText = text || '';

      // Save to IndexedDB
      const highlightId = uuid();
      const highlight = {
        id: highlightId,
        book_id: currentBookMeta.id,
        book_title: currentBookMeta.book_title,
        book_author: currentBookMeta.book_author,
        chapter: currentChapter,
        cfi: storedCfi || '',
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
      if (currentBookMeta.server_book_id || currentBookMeta.source === 'server') {
        await queueReaderSync(currentBookMeta.id, 'highlight.upsert', highlight.id, highlight);
      }
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
    setReaderChromeVisible(true);
    cancelReaderChromeHide();
    rememberDialogTrigger();
    const h = dbGet('highlights', highlightId);
    h.then((highlight) => {
      if (!highlight) return;
      editingHighlightId = highlightId;
      dom.notePreviewText.textContent = highlight.highlight_text;
      dom.noteTextarea.value = highlight.note || '';
      dom.tagInput.value = (highlight.tags || []).join(', ');
      dom.btnDeleteNote.hidden = false;
      dom.noteModal.hidden = false;
      safeFocus(dom.noteTextarea);
    });
  }

  function openNewNoteEditor() {
    if (!pendingSelection) {
      showToast('请先选中一段文字', 'info');
      return;
    }
    setReaderChromeVisible(true);
    cancelReaderChromeHide();
    rememberDialogTrigger();
    editingHighlightId = null;
    dom.notePreviewText.textContent = pendingSelection.text;
    dom.noteTextarea.value = '';
    dom.tagInput.value = '';
    dom.btnDeleteNote.hidden = true;
    dom.noteModal.hidden = false;
    safeFocus(dom.noteTextarea);
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
        if (currentBookMeta && (currentBookMeta.server_book_id || currentBookMeta.source === 'server')) {
          await queueReaderSync(currentBookMeta.id, 'highlight.upsert', h.id, h);
        }
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
          if (currentBookMeta && (currentBookMeta.server_book_id || currentBookMeta.source === 'server')) {
            await queueReaderSync(currentBookMeta.id, 'highlight.upsert', h.id, h);
          }
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

    if (currentBookMeta && (currentBookMeta.server_book_id || currentBookMeta.source === 'server')) {
      await queueReaderSync(currentBookMeta.id, 'highlight.delete', h.id, {});
    } else {
      await queueHighlightDelete(h);
    }
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
    restoreDialogTrigger();
    scheduleReaderChromeHide();
  }

  // ==================== TABLE OF CONTENTS / BOOKMARKS ====================
  function normalizeReaderHref(value) {
    const href = String(value || '').split('#', 1)[0].replace(/^\.\//, '');
    try {
      return decodeURIComponent(href);
    } catch (_err) {
      return href;
    }
  }

  function renderTableOfContents(items) {
    if (!dom.tocList) return;
    const toc = Array.isArray(items) ? items : [];
    dom.tocList.innerHTML = '';
    if (!toc.length) {
      dom.tocList.innerHTML = '<div class="empty-toc">本书没有可用目录</div>';
      return;
    }

    const appendItems = (entries, depth = 0) => {
      for (const item of entries) {
        const href = String(item.href || '');
        const label = String(item.label || item.title || '未命名章节').trim();
        if (href) {
          const button = document.createElement('button');
          button.className = 'toc-item';
          button.type = 'button';
          button.dataset.href = normalizeReaderHref(href);
          button.style.setProperty('--toc-depth', String(Math.min(depth, 5)));
          button.textContent = label;
          button.title = label;
          button.addEventListener('click', () => gotoTocItem(item));
          dom.tocList.appendChild(button);
        }
        const children = item.subitems || item.children || [];
        if (Array.isArray(children) && children.length) appendItems(children, depth + 1);
      }
    };
    appendItems(toc);
  }

  function updateTocActiveState(href) {
    if (!dom.tocList) return;
    const currentHref = normalizeReaderHref(href);
    let activeButton = null;
    for (const button of dom.tocList.querySelectorAll('.toc-item')) {
      const itemHref = normalizeReaderHref(button.dataset.href);
      const active = Boolean(currentHref && itemHref && (
        currentHref === itemHref || currentHref.endsWith('/' + itemHref) || itemHref.endsWith('/' + currentHref)
      ));
      button.classList.toggle('active', active);
      if (active) {
        button.setAttribute('aria-current', 'location');
        activeButton = button;
      } else {
        button.removeAttribute('aria-current');
      }
    }
    if (activeButton && !dom.readerNavigator.classList.contains('collapsed')) {
      activeButton.scrollIntoView({ block: 'nearest' });
    }
  }

  async function gotoTocItem(item) {
    if (blockManualNavigationDuringTts()) return;
    if (!currentRendition || !item || !item.href) return;
    try {
      await currentRendition.display(item.href);
      if (isMobileLayout()) setReaderNavigatorOpen(false);
    } catch (err) {
      console.warn('Failed to navigate to chapter:', err);
      showToast('无法打开该章节', 'warning');
    }
  }

  async function addBookmark() {
    if (!currentBookMeta || !currentRendition) return;
    const cfi = getCurrentAnchorCfi();
    if (!cfi) {
      showToast('当前位置暂时无法添加书签', 'warning');
      return;
    }

    const progress = Number(currentBookMeta.progress_percent || 0);
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
    if (currentBookMeta.server_book_id || currentBookMeta.source === 'server') {
      await queueReaderSync(currentBookMeta.id, 'bookmark.upsert', bookmark.id, bookmark);
    }
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
    if (blockManualNavigationDuringTts()) return;
    if (!currentRendition || !bookmark || !bookmark.cfi) return;
    try {
      await currentRendition.display(bookmark.cfi);
      if (isMobileLayout()) setReaderNavigatorOpen(false);
    } catch (err) {
      console.warn('Failed to navigate to bookmark:', err);
      showToast('无法定位到该书签', 'warning');
    }
  }

  async function deleteBookmarkById(bookmarkId) {
    if (!bookmarkId) return;
    const bookmark = await dbGet('bookmarks', bookmarkId);
    if (bookmark && currentBookMeta &&
        (currentBookMeta.server_book_id || currentBookMeta.source === 'server')) {
      await queueReaderSync(currentBookMeta.id, 'bookmark.delete', bookmarkId, {});
    }
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
        if (blockManualNavigationDuringTts()) return;
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

  function toggleNotesPanel(forceOpen) {
    const shouldOpen = typeof forceOpen === 'boolean'
      ? forceOpen
      : dom.notesPanel.classList.contains('collapsed');
    if (shouldOpen) {
      if (isMobileLayout()) {
        setReaderChromeVisible(true);
        cancelReaderChromeHide();
      }
      closeOtherMobileReaderPanels('notes');
      if (isMobileLayout()) setReaderToolsOpen(false, { skipChromeSchedule: true });
    }
    dom.notesPanel.classList.toggle('open', shouldOpen && isMobileLayout());
    dom.notesPanel.classList.toggle('collapsed', !shouldOpen);
    dom.readerMain.classList.toggle('notes-collapsed', !shouldOpen);
    dom.readerView.classList.toggle('notes-open', shouldOpen);
    if (isMobileLayout()) refreshReaderLayout();
    syncReaderToolStates();
    syncReaderPanelBackdrop();
    if (!shouldOpen) scheduleReaderChromeHide();
  }

  function cancelReaderNotesHoverClose() {
    if (!readerNotesHoverCloseTimer) return;
    clearTimeout(readerNotesHoverCloseTimer);
    readerNotesHoverCloseTimer = null;
  }

  function openReaderNotesOnHover() {
    if (isMobileLayout()) return;
    cancelReaderNotesHoverClose();
    toggleNotesPanel(true);
  }

  function scheduleReaderNotesHoverClose() {
    if (isMobileLayout()) return;
    cancelReaderNotesHoverClose();
    readerNotesHoverCloseTimer = setTimeout(() => {
      readerNotesHoverCloseTimer = null;
      toggleNotesPanel(false);
    }, 160);
  }

  function toggleAiPanel(forceOpen) {
    const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : dom.aiPanel.classList.contains('collapsed');
    if (shouldOpen) {
      setReaderChromeVisible(true);
      cancelReaderChromeHide();
      if (!isMobileLayout()) setReaderNavigatorOpen(false);
      closeOtherMobileReaderPanels('ai');
      if (isMobileLayout()) setReaderToolsOpen(false, { skipChromeSchedule: true });
    }
    dom.aiPanel.classList.toggle('collapsed', !shouldOpen);
    dom.readerMain.classList.toggle('ai-collapsed', !shouldOpen);
    refreshReaderLayout();
    syncReaderToolStates();
    syncReaderPanelBackdrop();
    if (shouldOpen) {
      renderAiMessages();
      if (!isMobileLayout()) setTimeout(() => dom.aiQuestionInput.focus(), 0);
    } else {
      scheduleReaderChromeHide();
    }
  }

  function setAiIndexState(status, errorMessage = '') {
    const messages = {
      uploading: '正在上传 EPUB 并建立 AI 知识库…',
      pending: '书籍已入库，正在等待索引…',
      indexing: '正在解析正文并生成向量索引…',
      ready: '索引已就绪，回答将严格依据原文与笔记。',
      failed: errorMessage ? `索引失败：${errorMessage}` : '索引失败，请重试。',
      outdated: '索引版本已过期，正在重建…',
      unregistered: '正在准备 AI 索引…',
    };
    dom.aiIndexStatus.textContent = messages[status] || messages.unregistered;
    dom.aiIndexStatus.dataset.state = status === 'ready' ? 'ready' : (status === 'failed' ? 'failed' : '');
    dom.btnRetryAiIndex.hidden = status !== 'failed';
    const canAsk = status === 'ready' && !aiRequestInFlight;
    dom.aiQuestionInput.disabled = !canAsk;
    dom.btnSendAi.disabled = !canAsk;
  }

  function renderAiConversationOptions() {
    const options = ['<option value="">新会话</option>'].concat(
      aiConversations.map(item => (
        `<option value="${escapeHTML(item.id)}">${escapeHTML(item.title || '新会话')}</option>`
      ))
    );
    dom.aiConversationSelect.innerHTML = options.join('');
    dom.aiConversationSelect.value = currentAiConversationId || '';
    dom.btnDeleteAiConversation.disabled = !currentAiConversationId;
  }

  async function loadAiConversations(preferredId = currentAiConversationId) {
    if (!currentBookMeta || !currentBookMeta.knowledge_book_id || currentBookMeta.knowledge_status !== 'ready') {
      aiConversations = [];
      currentAiConversationId = null;
      renderAiConversationOptions();
      return;
    }
    const resp = await fetch(
      API_BASE + '/api/knowledge/books/' +
      encodeURIComponent(currentBookMeta.knowledge_book_id) + '/conversations'
    );
    if (!resp.ok) throw new Error(`Server responded with ${resp.status}`);
    const data = await resp.json();
    aiConversations = data.conversations || [];
    const preferred = aiConversations.find(item => item.id === preferredId);
    currentAiConversationId = preferred ? preferred.id : (aiConversations[0] ? aiConversations[0].id : null);
    renderAiConversationOptions();
    await loadAiMessages();
  }

  async function loadAiMessages() {
    if (!currentAiConversationId) {
      aiMessages = [];
      renderAiMessages();
      return;
    }
    const resp = await fetch(
      API_BASE + '/api/knowledge/conversations/' +
      encodeURIComponent(currentAiConversationId) + '/messages?limit=100'
    );
    if (!resp.ok) throw new Error(`Server responded with ${resp.status}`);
    const data = await resp.json();
    aiMessages = (data.messages || []).map(item => ({
      id: item.id,
      role: item.role,
      content: item.content,
      status: item.status,
      citations: item.citations || [],
    }));
    renderAiMessages();
  }

  async function createAiConversation() {
    if (!currentBookMeta || currentBookMeta.knowledge_status !== 'ready') return null;
    const resp = await fetch(
      API_BASE + '/api/knowledge/books/' +
      encodeURIComponent(currentBookMeta.knowledge_book_id) + '/conversations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '' }),
      }
    );
    if (!resp.ok) throw new Error(`Server responded with ${resp.status}`);
    const conversation = await resp.json();
    currentAiConversationId = conversation.id;
    aiConversations.unshift(conversation);
    aiMessages = [];
    renderAiConversationOptions();
    renderAiMessages();
    return conversation;
  }

  async function deleteCurrentAiConversation() {
    if (!currentAiConversationId || !confirm('确定删除当前 AI 问答会话吗？')) return;
    const resp = await fetch(
      API_BASE + '/api/knowledge/conversations/' +
      encodeURIComponent(currentAiConversationId),
      { method: 'DELETE' }
    );
    if (!resp.ok) {
      showToast('会话删除失败', 'error');
      return;
    }
    currentAiConversationId = null;
    await loadAiConversations();
    showToast('会话已删除', 'info');
  }

  function renderAiMessages() {
    if (aiMessages.length === 0) {
      dom.aiMessages.innerHTML = '<div class="ai-empty">问一个和这本书有关的问题。</div>';
      return;
    }
    dom.aiMessages.innerHTML = aiMessages.map((msg, messageIndex) => {
      const citations = (msg.citations || []).map((citation, citationIndex) => `
        <button class="ai-citation" type="button"
          data-message-index="${messageIndex}" data-citation-index="${citationIndex}">
          <strong>[${escapeHTML(citation.label || '')}] ${escapeHTML(citation.chapter || '划线与感悟')}</strong><br>
          ${escapeHTML((citation.quote || '').slice(0, 120))}
        </button>
      `).join('');
      const stateClass = msg.status === 'streaming' ? ' streaming' : '';
      return `<div class="ai-message ${msg.role}${stateClass}">
        ${escapeHTML(msg.content)}
        ${citations ? `<div class="ai-citations">${citations}</div>` : ''}
      </div>`;
    }).join('');
    dom.aiMessages.querySelectorAll('.ai-citation').forEach(button => {
      button.addEventListener('click', () => {
        const message = aiMessages[Number(button.dataset.messageIndex)];
        const citation = message && message.citations[Number(button.dataset.citationIndex)];
        if (citation) jumpToAiCitation(citation);
      });
    });
    dom.aiMessages.scrollTop = dom.aiMessages.scrollHeight;
  }

  function addAiMessage(role, content, extra = {}) {
    const message = { role, content, status: 'completed', citations: [], ...extra };
    aiMessages.push(message);
    renderAiMessages();
    return message;
  }

  async function collectBookQaContext(question) {
    const highlights = currentBookMeta
      ? await dbGetByIndex('highlights', 'by_book', currentBookMeta.id)
      : [];
    highlights.sort((a, b) => (a.progress_percent || 0) - (b.progress_percent || 0));
    return {
      question,
      knowledge_book_id: currentBookMeta ? currentBookMeta.knowledge_book_id : null,
      book_title: currentBookMeta ? currentBookMeta.book_title || '' : '',
      book_author: currentBookMeta ? currentBookMeta.book_author || '' : '',
      chapter: currentChapter || '',
      progress_percent: currentBookMeta ? currentBookMeta.progress_percent || 0 : 0,
      highlights: highlights.map(h => ({
        id: h.id || '',
        cfi: h.cfi || '',
        highlight_text: h.highlight_text || '',
        note: h.note || '',
        tags: h.tags || [],
        chapter: h.chapter || '',
        progress_percent: h.progress_percent || 0,
      })),
    };
  }

  async function parseSseResponse(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        let event = 'message';
        let data = '';
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        onEvent(event, JSON.parse(data));
      }
      if (done) break;
    }
  }

  async function askBookQuestion(question) {
    const trimmed = question.trim();
    if (!trimmed) return;
    if (!currentBookMeta) {
      showToast('请先打开一本书', 'info');
      return;
    }
    if (aiRequestInFlight) return;
    if (currentBookMeta.knowledge_status !== 'ready') {
      showToast('请等待书籍 AI 索引完成', 'info');
      return;
    }

    toggleAiPanel(true);
    if (!currentAiConversationId) await createAiConversation();
    addAiMessage('user', trimmed);
    dom.aiQuestionInput.value = '';
    aiRequestInFlight = true;
    setAiIndexState('ready');
    const assistantMessage = addAiMessage('assistant', '', { status: 'streaming' });

    try {
      const payload = await collectBookQaContext(trimmed);
      const resp = await fetch(
        API_BASE + '/api/knowledge/conversations/' +
        encodeURIComponent(currentAiConversationId) + '/messages/stream',
        {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: trimmed,
          current_location: {
            chapter: payload.chapter,
            href: currentCfi && currentBook && currentBook.spine
              ? ((currentBook.spine.get(currentCfi) || {}).href || '')
              : '',
            cfi: currentCfi || '',
            progress_percent: payload.progress_percent,
          },
          local_highlights: payload.highlights,
        }),
      });
      if (!resp.ok) {
        const error = await resp.json().catch(() => ({}));
        const detail = error.detail && (error.detail.message || error.detail);
        throw new Error(typeof detail === 'string' ? detail : `Server responded with ${resp.status}`);
      }
      let streamError = null;
      await parseSseResponse(resp, (event, data) => {
        if (event === 'delta') assistantMessage.content += data.text || '';
        if (event === 'citations') assistantMessage.citations = data.items || [];
        if (event === 'done') assistantMessage.status = 'completed';
        if (event === 'error') streamError = new Error(data.message || 'AI 问答失败');
        renderAiMessages();
      });
      if (streamError) throw streamError;
      assistantMessage.status = 'completed';
      if (!assistantMessage.content) assistantMessage.content = '没有返回回答。';
      renderAiMessages();
      await loadAiConversations(currentAiConversationId);
    } catch (err) {
      console.error('Book Q&A failed:', err);
      assistantMessage.role = 'error';
      assistantMessage.status = 'failed';
      assistantMessage.content = assistantMessage.content || ('问答失败：' + (
        typeof err.message === 'string' ? err.message : '未知错误'
      ));
      renderAiMessages();
    } finally {
      aiRequestInFlight = false;
      setAiIndexState(currentBookMeta.knowledge_status, currentBookMeta.knowledge_error || '');
    }
  }

  function findTextRange(doc, anchorText) {
    const target = String(anchorText || '').replace(/\s+/g, ' ').trim();
    if (!target) return null;
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const positions = [];
    let normalized = '';
    let previousSpace = false;
    let node;
    while ((node = walker.nextNode())) {
      for (let i = 0; i < node.nodeValue.length; i += 1) {
        const char = node.nodeValue[i];
        const isSpace = /\s/.test(char);
        if (isSpace && previousSpace) continue;
        normalized += isSpace ? ' ' : char;
        positions.push({ node, offset: i });
        previousSpace = isSpace;
      }
    }
    const start = normalized.indexOf(target);
    if (start < 0) return null;
    const end = Math.min(positions.length - 1, start + target.length - 1);
    const range = doc.createRange();
    range.setStart(positions[start].node, positions[start].offset);
    range.setEnd(positions[end].node, positions[end].offset + 1);
    return range;
  }

  async function jumpToAiCitation(citation) {
    if (blockManualNavigationDuringTts()) return;
    if (!currentRendition || !currentBook) return;
    try {
      let cfi = citation.cfi || '';
      if (!cfi && citation.href) {
        let section = currentBook.spine.get(citation.href);
        if (!section && currentBook.spine.spineItems) {
          section = currentBook.spine.spineItems.find(item => (
            item.href === citation.href || item.href.endsWith(citation.href)
          ));
        }
        if (section) {
          await section.load(currentBook.load.bind(currentBook));
          const range = findTextRange(section.document, citation.anchor_text || citation.quote);
          if (range) cfi = section.cfiFromRange(range);
        }
      }
      await currentRendition.display(cfi || citation.href);
      if (cfi) {
        currentRendition.annotations.highlight(cfi, {}, () => {}, 'ai-citation', {
          fill: '#d99a2b',
          'fill-opacity': '0.35',
        });
        setTimeout(() => {
          try { currentRendition.annotations.remove(cfi, 'highlight'); } catch (_e) {}
        }, 2500);
      }
    } catch (err) {
      console.warn('Citation navigation failed:', err);
      if (citation.href) {
        try { await currentRendition.display(citation.href); } catch (_e) {}
      }
      showToast('已跳到引用章节，未能精确定位段落', 'warning');
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
      const queued = await dbGetAllSafe('sync_queue');
      const count = queued.length;

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

  async function applyServerBookState(bookId, state) {
    const book = await dbGet('books', bookId);
    if (!book) return null;
    if (state.progress) {
      book.last_cfi = state.progress.cfi || '';
      book.progress_percent = state.progress.progress_percent || 0;
      book.last_opened = state.progress.last_opened || book.last_opened || 0;
    }
    book.state_revision = state.revision || 0;
    await dbPut('books', book);

    const localHighlights = await dbGetByIndex('highlights', 'by_book', bookId);
    for (const highlight of localHighlights) {
      await dbDelete('highlights', highlight.id);
    }
    for (const highlight of state.highlights || []) {
      await dbPut('highlights', {
        ...highlight,
        id: highlight.client_id || highlight.id,
        server_id: highlight.id,
        book_id: bookId,
        synced: true,
        synced_at: highlight.updated_at || new Date().toISOString(),
      });
    }

    if (dbHasStore('bookmarks')) {
      const localBookmarks = await dbGetByIndex('bookmarks', 'by_book', bookId);
      for (const bookmark of localBookmarks) {
        await dbDelete('bookmarks', bookmark.id);
      }
      for (const bookmark of state.bookmarks || []) {
        await dbPut('bookmarks', { ...bookmark, book_id: bookId });
      }
    }
    if (currentBookMeta && currentBookMeta.id === bookId) {
      currentBookMeta = book;
      await renderNotes();
      updateProgressUI();
    }
    return book;
  }

  async function syncBookState(bookOrId, { timeoutMs = API_TIMEOUT_MS } = {}) {
    const book = typeof bookOrId === 'string'
      ? await dbGet('books', bookOrId)
      : bookOrId;
    if (!book) return null;
    const bookId = book.server_book_id ||
      ((book.source === 'server' || book._source === 'server') ? book.id : null);
    if (!bookId || !navigator.onLine) return book;

    const queued = dbHasStore('sync_queue')
      ? await dbGetByIndex('sync_queue', 'by_book', bookId)
      : [];
    const resp = await fetchWithTimeout(API_BASE + '/api/books/' + encodeURIComponent(bookId) + '/sync', {
      method: queued.length > 0 ? 'POST' : 'GET',
      headers: queued.length > 0 ? { 'Content-Type': 'application/json' } : undefined,
      body: queued.length > 0 ? JSON.stringify({
        operations: queued.map(item => ({
          op_id: item.op_id,
          type: item.type,
          entity_id: item.entity_id || '',
          payload: item.payload || {},
        })),
      }) : undefined,
    }, timeoutMs);
    if (resp.status === 404) {
      await deleteBook(book.id);
      if (currentBookMeta && currentBookMeta.id === book.id) {
        showToast('这本书已从服务器删除', 'warning');
        await showHome({ historyMode: 'replace' });
      }
      return null;
    }
    if (!resp.ok) throw new Error(`Server responded with ${resp.status}`);
    const state = await resp.json();
    for (const sent of queued) {
      const current = await dbGet('sync_queue', sent.id);
      if (current && current.op_id === sent.op_id) {
        await dbDelete('sync_queue', sent.id);
      }
    }
    const merged = await applyServerBookState(bookId, state);
    updateSyncBadge();
    return merged;
  }

  async function syncToBackend() {
    if (dom.btnSync.classList.contains('syncing')) return;

    dom.btnSync.classList.add('syncing');
    dom.btnSync.disabled = true;
    dom.btnSync.querySelector('.sync-label').textContent = '同步中…';

    try {
      await migrateLocalBooksToServer();
      const books = await dbGetAll('books');
      let syncedBooks = 0;
      for (const book of books) {
        if (book.server_book_id || book.source === 'server' || book._source === 'server') {
          await syncBookState(book);
          syncedBooks++;
        }
      }
      await renderLibrary();
      await updateSyncBadge();
      showToast(`已同步 ${syncedBooks} 本书的进度、书签和笔记`, 'success');
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
    const keyword = dom.materialBookFilter.value.trim().toLowerCase();
    const tagFilter = dom.materialTagFilter.value.trim().toLowerCase();
    let materials = await dbGetAll('highlights');
    if (keyword) {
      materials = materials.filter(h =>
        (h.book_title || '').toLowerCase().includes(keyword) ||
        (h.highlight_text || '').toLowerCase().includes(keyword) ||
        (h.note || '').toLowerCase().includes(keyword) ||
        (h.tags || []).some(t => t.toLowerCase().includes(keyword))
      );
    }
    if (tagFilter) {
      materials = materials.filter(h => (h.tags || []).some(t => t.toLowerCase().includes(tagFilter)));
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
    const reflectionBook = await dbGet('books', h.book_id);
    if (reflectionBook &&
        (reflectionBook.server_book_id || reflectionBook.source === 'server')) {
      await queueReaderSync(h.book_id, 'highlight.upsert', h.id, h);
    }
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
    const reflectionBook = await dbGet('books', h.book_id);
    if (reflectionBook &&
        (reflectionBook.server_book_id || reflectionBook.source === 'server')) {
      await queueReaderSync(h.book_id, 'highlight.upsert', h.id, h);
    }
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

    let controllerChanged = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (controllerChanged) return;
      controllerChanged = true;
      if (!currentBookMeta && serverMigrationsInFlight.size === 0) {
        window.location.reload();
        return;
      }
      setOperationStatus({
        message: 'Marginalia 已更新',
        detail: '当前操作不会被打断，请稍后刷新页面使用新版本',
      });
    });

    navigator.serviceWorker.register('sw.js')
      .then((reg) => {
        console.log('Service Worker registered:', reg.scope);
        reg.update().catch(() => {});
      })
      .catch((err) => {
        console.warn('Service Worker registration failed:', err);
      });
  }

  // ==================== EVENT BINDINGS ====================
  function bindEvents() {
    [dom.btnRevealReaderChrome, dom.readerToolbar, dom.readerToolPanel].forEach((element) => {
      if (!element) return;
      element.addEventListener('pointerenter', openReaderChromeOnHover);
      element.addEventListener('pointerleave', scheduleReaderChromeHoverClose);
      element.addEventListener('focusin', openReaderChromeOnHover);
      element.addEventListener('focusout', scheduleReaderChromeHoverClose);
    });

    [dom.readerToolbar, dom.readerToolPanel].forEach((element) => {
      if (!element) return;
      element.addEventListener('pointerdown', () => {
        if (!dom.readerView.classList.contains('active')) return;
        setReaderChromeVisible(true);
        cancelReaderChromeHide();
        cancelReaderChromeHoverClose();
      });
      element.addEventListener('click', () => {
        if (isMobileLayout()) setTimeout(() => scheduleReaderChromeHide(), 0);
      });
    });

    dom.btnLibraryCreate.addEventListener('click', () => showCreation());

    // File import
    dom.fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFileImport(file);
      dom.fileInput.value = '';
    });

    // Reading and creation are entered from, and return to, the home screen.
    dom.btnBack.addEventListener('click', returnToHome);
    dom.btnCreationBack.addEventListener('click', returnToHome);

    // AI book Q&A
    dom.btnReaderTools.addEventListener('click', toggleReaderTools);
    dom.btnToggleNavigator.addEventListener('click', toggleReaderNavigator);
    dom.btnCloseNavigator.addEventListener('click', () => setReaderNavigatorOpen(false, { restoreFocus: true }));
    dom.btnRevealNavigator.addEventListener('click', () => setReaderNavigatorOpen(true));
    [dom.btnRevealNavigator, dom.readerNavigator].forEach((element) => {
      element.addEventListener('pointerenter', openReaderNavigatorOnHover);
      element.addEventListener('pointerleave', scheduleReaderNavigatorHoverClose);
      element.addEventListener('focusin', openReaderNavigatorOnHover);
      element.addEventListener('focusout', scheduleReaderNavigatorHoverClose);
    });
    dom.btnRevealReaderChrome.addEventListener('click', () => revealReaderChromeTemporarily());
    dom.btnToggleAi.addEventListener('click', () => toggleAiPanel());
    dom.btnCloseAi.addEventListener('click', () => toggleAiPanel(false));
    dom.aiForm.addEventListener('submit', (e) => {
      e.preventDefault();
      askBookQuestion(dom.aiQuestionInput.value);
    });
    dom.aiQuestionInput.addEventListener('paste', (e) => {
      const pastedText = e.clipboardData?.getData('text/plain');
      if (typeof pastedText !== 'string' || !/[\r\n]/.test(pastedText)) return;

      e.preventDefault();
      const normalizedText = pastedText.replace(/[ \t]*[\r\n]+[ \t]*/g, ' ');
      const start = dom.aiQuestionInput.selectionStart ?? dom.aiQuestionInput.value.length;
      const end = dom.aiQuestionInput.selectionEnd ?? start;
      dom.aiQuestionInput.setRangeText(normalizedText, start, end, 'end');
      dom.aiQuestionInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    dom.aiQuestionInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      dom.aiForm.requestSubmit();
    });
    dom.btnOperationClose.addEventListener('click', () => hideOperationStatus());
    dom.btnOperationRetry.addEventListener('click', async () => {
      if (!operationBookId) return;
      const book = await dbGet('books', operationBookId);
      if (book) await retryBookUpload(book);
    });
    dom.aiPanel.querySelectorAll('[data-ai-question]').forEach(btn => {
      btn.addEventListener('click', () => askBookQuestion(btn.dataset.aiQuestion || ''));
    });
    dom.aiConversationSelect.addEventListener('change', async () => {
      currentAiConversationId = dom.aiConversationSelect.value || null;
      await loadAiMessages();
      renderAiConversationOptions();
    });
    dom.btnNewAiConversation.addEventListener('click', () => createAiConversation());
    dom.btnDeleteAiConversation.addEventListener('click', deleteCurrentAiConversation);
    dom.btnRetryAiIndex.addEventListener('click', async () => {
      if (!currentBookMeta) return;
      if (!currentBookMeta.knowledge_book_id) {
        if (!currentBookMeta.file_blob && currentBookMeta.filename) {
          await recoverMissingKnowledgeBook(currentBookMeta, { promptForFile: true });
          return;
        }
        await ensureKnowledgeBook(currentBookMeta);
        return;
      }
      try {
        const resp = await fetch(
          API_BASE + '/api/knowledge/books/' +
          encodeURIComponent(currentBookMeta.knowledge_book_id) + '/reindex',
          { method: 'POST' }
        );
        if (resp.status === 404) {
          await recoverMissingKnowledgeBook(currentBookMeta, {
            promptForFile: !currentBookMeta.file_blob,
          });
          return;
        }
        if (!resp.ok) {
          showToast('索引重试失败', 'error');
          return;
        }
        currentBookMeta.knowledge_status = 'pending';
        await dbPut('books', currentBookMeta);
        setAiIndexState('pending');
        pollKnowledgeStatus(currentBookMeta);
      } catch (err) {
        console.error('Knowledge reindex failed:', err);
        showToast('索引重试失败：无法连接服务器', 'error');
      }
    });

    // Toggle notes panel
    dom.btnAddBookmark.addEventListener('click', addBookmark);
    dom.btnToggleNotes.addEventListener('click', () => toggleNotesPanel());
    dom.btnRevealNotes.addEventListener('click', () => toggleNotesPanel(true));
    [dom.btnRevealNotes, dom.notesPanel].forEach((element) => {
      element.addEventListener('pointerenter', openReaderNotesOnHover);
      element.addEventListener('pointerleave', scheduleReaderNotesHoverClose);
      element.addEventListener('focusin', openReaderNotesOnHover);
      element.addEventListener('focusout', scheduleReaderNotesHoverClose);
    });
    dom.btnToggleReaderAutoHide.addEventListener('click', () => {
      setReaderChromeAutoHideEnabled(!readerChromeAutoHideEnabled);
    });
    dom.readerFontFamily.addEventListener('change', () => {
      setReaderFontFamily(dom.readerFontFamily.value);
    });
    dom.readerFontSize.addEventListener('input', () => {
      setReaderFontSize(dom.readerFontSize.value);
    });
    dom.btnReaderFontDecrease.addEventListener('click', () => {
      setReaderFontSize(currentFontSize - FONT_SIZE_STEP);
    });
    dom.btnReaderFontReset.addEventListener('click', () => {
      setReaderFontSize(100);
    });
    dom.btnReaderFontIncrease.addEventListener('click', () => {
      setReaderFontSize(currentFontSize + FONT_SIZE_STEP);
    });
    dom.btnCloseNotesPanel.addEventListener('click', () => toggleNotesPanel(false));
    dom.readerPanelBackdrop.addEventListener('click', () => closeMobileReaderPanels({ restoreFocus: true }));

    // Automatic narration
    dom.btnToggleTts.addEventListener('click', toggleTtsPanel);
    dom.btnCloseTts.addEventListener('click', () => setTtsPanelOpen(false));
    dom.btnTtsStart.addEventListener('click', () => startChapterTts({ autoplay: true }));
    dom.btnTtsPlay.addEventListener('click', () => {
      if (!ttsTask) {
        startChapterTts({ autoplay: true });
      } else {
        ttsWantsPlay = true;
        playTtsSegment(ttsSegmentIndex, true);
      }
    });
    dom.btnTtsPause.addEventListener('click', () => {
      ttsWantsPlay = false;
      ttsIsPlaying = false;
      ttsPlaybackStarting = false;
      pauseTtsFollowNavigation();
      dom.ttsAudio.pause();
      saveTtsPosition(true);
      setTtsStatus(`已暂停第 ${ttsSegmentIndex + 1} 段`, 'paused');
      if (ttsTask && ttsTask.status !== 'completed') scheduleTtsPoll();
    });
    dom.btnTtsPrev.addEventListener('click', () => {
      saveTtsPosition(true);
      ttsWantsPlay = true;
      playTtsSegment(Math.max(0, ttsSegmentIndex - 1), true);
    });
    dom.btnTtsNext.addEventListener('click', () => {
      if (!ttsTask) return;
      saveTtsPosition(true);
      ttsWantsPlay = true;
      playTtsSegment(Math.min(ttsTask.segmentCount - 1, ttsSegmentIndex + 1), true);
    });
    dom.ttsVoice.addEventListener('change', handleTtsOptionChange);
    dom.ttsRate.addEventListener('change', handleTtsOptionChange);
    dom.ttsAudio.addEventListener('loadedmetadata', () => {
      dom.ttsProgress.disabled = !Number.isFinite(dom.ttsAudio.duration);
      dom.ttsTime.textContent = `${formatAudioTime(dom.ttsAudio.currentTime)} / ${formatAudioTime(dom.ttsAudio.duration)}`;
    });
    dom.ttsAudio.addEventListener('timeupdate', () => {
      const duration = dom.ttsAudio.duration;
      dom.ttsProgress.value = Number.isFinite(duration) && duration > 0
        ? String(Math.round((dom.ttsAudio.currentTime / duration) * 1000))
        : '0';
      dom.ttsTime.textContent = `${formatAudioTime(dom.ttsAudio.currentTime)} / ${formatAudioTime(duration)}`;
      updateTtsFollowHighlight({ source: 'timeline', navigation: 'force' });
      saveTtsPosition();
    });
    dom.ttsAudio.addEventListener('ended', () => {
      ttsIsPlaying = false;
      saveTtsPosition(true);
      if (dom.ttsContinuous.checked && ttsTask && ttsSegmentIndex + 1 < ttsTask.segmentCount) {
        ttsWantsPlay = true;
        playTtsSegment(ttsSegmentIndex + 1, true);
      } else {
        ttsWantsPlay = false;
        ttsPlaybackStarting = false;
        clearTtsFollowHighlight({ restorePersistent: true });
        setTtsStatus('当前朗读已结束', 'completed');
      }
    });
    dom.ttsAudio.addEventListener('error', () => {
      if (!dom.ttsAudio.getAttribute('src')) return;
      ttsWantsPlay = false;
      ttsIsPlaying = false;
      ttsPlaybackStarting = false;
      clearTtsFollowHighlight({ restorePersistent: true });
      setTtsStatus('音频加载失败，请重新生成或检查网络', 'failed');
    });
    dom.ttsProgress.addEventListener('input', () => {
      if (!Number.isFinite(dom.ttsAudio.duration)) return;
      dom.ttsAudio.currentTime = (Number(dom.ttsProgress.value) / 1000) * dom.ttsAudio.duration;
      updateTtsFollowHighlight({
        force: true,
        source: 'seek',
        navigation: isTtsNavigationLocked() ? 'force' : 'none',
      });
    });
    dom.ttsProgress.addEventListener('change', () => saveTtsPosition(true));

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
    dom.searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        const query = dom.searchInput.value.trim();
        if (query.length >= 2) {
          performSearch(query);
        } else if (query.length === 0) {
          clearSearchResults();
        }
      }, 300);
    });
    dom.btnSearchClose.addEventListener('click', toggleSearchPanel);
    dom.btnCloseSearchPanel.addEventListener('click', () => setSearchPanelOpen(false));

    // Sync button
    dom.btnSync.addEventListener('click', syncToBackend);

    // Creation workspace
    dom.btnRefreshMaterials.addEventListener('click', renderCreationWorkspace);
    let materialsFilterTimer = null;
    const debouncedRenderMaterials = () => {
      clearTimeout(materialsFilterTimer);
      materialsFilterTimer = setTimeout(renderMaterials, 200);
    };
    dom.materialBookFilter.addEventListener('input', debouncedRenderMaterials);
    dom.materialTagFilter.addEventListener('input', debouncedRenderMaterials);
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
    dom.btnCancelBookDelete.addEventListener('click', closeBookDeleteDialog);
    dom.btnDeleteLocalBook.addEventListener('click', () => confirmBookDelete(false));
    dom.btnDeleteAllBookData.addEventListener('click', () => confirmBookDelete(true));
    dom.bookDeleteModal.addEventListener('click', (e) => {
      if (e.target === dom.bookDeleteModal) closeBookDeleteDialog();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Escape to close modals/toolbars
      if (e.key === 'Escape') {
        if (!dom.noteModal.hidden) {
          closeNoteEditor();
        } else if (!dom.bookDeleteModal.hidden) {
          closeBookDeleteDialog();
        } else if (!dom.ttsPanel.hidden) {
          setTtsPanelOpen(false);
        } else if (closeMobileReaderPanels({ restoreFocus: true })) {
          // Mobile reader panels are modal surfaces and close before the tool menu.
        } else if (!dom.readerToolPanel.hidden) {
          setReaderToolsOpen(false, { restoreFocus: true });
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

    // Online/offline
    window.addEventListener('popstate', (event) => {
      handleHistoryNavigation(event).catch((err) => {
        console.error('History navigation failed:', err);
        showHome({ historyMode: 'replace' });
      });
    });
    window.addEventListener('online', async () => {
      showToast('网络已恢复，正在同步服务器书库', 'success');
      refreshServerLibrary().catch(() => {});
      migrateLocalBooksToServer().catch(() => {});
      syncToBackend().catch(() => {});
    });
    window.addEventListener('offline', () => showToast('已离线 — 数据保存在本地', 'info'));
    window.addEventListener('resize', () => {
      syncReaderPanelBackdrop();
      hideSelectionToolbar();
      refreshReaderLayout();
    });
    mobileLayoutMedia.addEventListener('change', () => {
      dom.notesPanel.classList.remove('open');
      document.body.classList.remove('reader-panel-open');
      cancelReaderChromeHoverClose();
      cancelReaderNavigatorHoverClose();
      cancelReaderNotesHoverClose();
      setReaderChromeVisible(isMobileLayout());
      setReaderNavigatorOpen(false);
      toggleNotesPanel(false);
      syncReaderPanelBackdrop();
      refreshReaderLayout();
      if (dom.readerView.classList.contains('active') && isMobileLayout()) scheduleReaderChromeHide(READER_CHROME_INITIAL_HIDE_MS);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelReaderChromeHide();
        if (!dom.ttsAudio.paused) {
          dom.ttsAudio.pause();
          ttsWantsPlay = false;
          ttsIsPlaying = false;
          ttsPlaybackStarting = false;
          saveTtsPosition(true);
          setTtsStatus(`已暂停第 ${ttsSegmentIndex + 1} 段`, 'paused');
        }
        return;
      }
      if (navigator.onLine) syncToBackend().catch(() => {});
      if (dom.readerView.classList.contains('active')) scheduleReaderChromeHide();
    });
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

    loadReaderChromeAutoHidePreference();
    loadReaderTypographyPreference();
    setReaderNavigatorOpen(false);
    loadTtsVoices().catch(() => {});
    observeReaderIframes();
    bindEvents();
    syncReaderToolStates();
    registerSW();
    await renderLibrary();
    await updateSyncBadge();
    await restoreViewFromHistory();
    refreshServerLibrary().catch(() => {});
    migrateLocalBooksToServer().catch(() => {});

    console.log('Marginalia ready 📖');
  }

  // Start the app
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
