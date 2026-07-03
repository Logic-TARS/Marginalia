/**
 * Marginalia — Core Application Logic
 * Handles: IndexedDB, epub.js reader, highlights, notes, sync, PWA
 */
(function () {
  'use strict';

  // ==================== CONSTANTS ====================
  const DB_NAME = 'marginalia';
  const DB_VERSION = 1;
  const API_BASE = 'http://localhost:8000';

  // ==================== STATE ====================
  let db = null;
  let currentBook = null;       // epub.js Book instance
  let currentRendition = null;  // epub.js Rendition instance
  let currentBookMeta = null;   // our DB book record
  let currentChapter = '';
  let currentCfi = '';
  let pendingSelection = null;  // { cfiRange, text } from last selection

  // ==================== DOM REFS ====================
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    app: $('#app'),
    libraryView: $('#library-view'),
    readerView: $('#reader-view'),
    bookList: $('#book-list'),
    emptyLibrary: $('#empty-library'),
    fileInput: $('#file-input'),
    epubContainer: $('#epub-container'),
    notesPanel: $('#notes-panel'),
    notesList: $('#notes-list'),
    notesCount: $('#notes-count'),
    toolbarBookTitle: $('#toolbar-book-title'),
    toolbarChapter: $('#toolbar-chapter'),
    progressSlider: $('#progress-slider'),
    progressText: $('#progress-text'),
    btnBack: $('#btn-back'),
    btnToggleNotes: $('#btn-toggle-notes'),
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

  // ==================== VIEW SWITCHING ====================
  function showLibrary() {
    dom.libraryView.classList.add('active');
    dom.readerView.classList.remove('active');
    currentBook = null;
    currentRendition = null;
    currentBookMeta = null;
    renderLibrary();
  }

  function showReader() {
    dom.libraryView.classList.remove('active');
    dom.readerView.classList.add('active');
  }

  // ==================== LIBRARY ====================
  async function renderLibrary() {
    const books = await dbGetAll('books');
    // Sort by last opened, most recent first
    books.sort((a, b) => (b.last_opened || 0) - (a.last_opened || 0));

    if (books.length === 0) {
      dom.emptyLibrary.hidden = false;
      dom.bookList.querySelectorAll('.book-card').forEach(c => c.remove());
      return;
    }

    dom.emptyLibrary.hidden = true;
    dom.bookList.innerHTML = '';

    for (const book of books) {
      const card = document.createElement('div');
      card.className = 'book-card';
      card.dataset.bookId = book.id;

      const highlightCount = await getBookHighlightCount(book.id);

      card.innerHTML = `
        <div class="book-card-cover">📖</div>
        <div class="book-card-info">
          <div class="book-card-title">${escapeHTML(book.book_title || '未命名书籍')}</div>
          <div class="book-card-author">${escapeHTML(book.book_author || '未知作者')}</div>
          <div class="book-card-meta">
            <span>✏️ ${highlightCount} 条划线</span>
            <span>${formatRelativeDate(book.last_opened)}</span>
          </div>
          <div class="book-card-progress">
            <div class="book-card-progress-bar" style="width:${book.progress_percent || 0}%"></div>
          </div>
        </div>
        <button class="book-card-delete" data-action="delete" title="删除">🗑</button>
      `;

      card.addEventListener('click', (e) => {
        // Don't open book if delete button clicked
        if (e.target.closest('[data-action="delete"]')) return;
        openBook(book);
      });

      card.querySelector('.book-card-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`确定删除《${book.book_title}》及其所有划线笔记吗？`)) {
          await deleteBook(book.id);
          renderLibrary();
          showToast('已删除', 'info');
        }
      });

      dom.bookList.appendChild(card);
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
      await dbDelete('highlights', h.id);
    }
  }

  // ==================== BOOK IMPORT ====================
  function handleFileImport(file) {
    if (!file || !file.name.endsWith('.epub')) {
      showToast('请选择 .epub 文件', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      const blob = new Blob([e.target.result], { type: 'application/epub+zip' });
      const bookMeta = await extractBookMeta(blob);

      const bookRecord = {
        id: uuid(),
        book_title: bookMeta.title || file.name.replace(/\.epub$/i, ''),
        book_author: bookMeta.author || '',
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
    };
    reader.readAsArrayBuffer(file);
  }

  function extractBookMeta(blob) {
    return new Promise((resolve) => {
      const meta = { title: '', author: '' };
      try {
        const book = ePub(blob);
        book.loaded.metadata.then((md) => {
          meta.title = md.title || '';
          meta.author = md.creator || '';
          resolve(meta);
        }).catch(() => resolve(meta));

        // Timeout: if metadata doesn't load within 5s, resolve with empty
        setTimeout(() => resolve(meta), 5000);
      } catch (e) {
        resolve(meta);
      }
    });
  }

  // ==================== READER ====================
  async function openBook(bookMeta) {
    currentBookMeta = bookMeta;
    showReader();

    // Update toolbar
    dom.toolbarBookTitle.textContent = bookMeta.book_title;
    dom.toolbarChapter.textContent = '加载中…';

    // Update last opened
    bookMeta.last_opened = Date.now();
    await dbPut('books', bookMeta);

    // Render notes for this book
    await renderNotes();

    // Initialize epub.js
    try {
      const blob = new Blob([bookMeta.file_blob], { type: 'application/epub+zip' });
      const book = ePub(blob);
      currentBook = book;

      const rendition = book.renderTo(dom.epubContainer, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'paginated',
      });
      currentRendition = rendition;

      // Track chapter/location changes
      rendition.on('relocated', (location) => {
        handleLocationChange(location);
      });

      // Setup highlight selection handling
      setupSelectionHandling(rendition);

      // Restore saved CFI or start from beginning
      const startCfi = bookMeta.last_cfi || undefined;
      const displayed = rendition.display(startCfi);
      displayed.then(() => {
        updateProgressUI();
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
      console.error('Failed to open book:', err);
      showToast('打开书籍失败: ' + err.message, 'error');
    }
  }

  function handleLocationChange(location) {
    if (!location || !location.start) return;
    currentCfi = location.start.cfi;
    const percent = location.start.percentage || 0;
    const pct = Math.round(percent * 100);

    // Update progress UI
    dom.progressSlider.value = pct;
    dom.progressText.textContent = pct + '%';

    // Save progress to DB
    if (currentBookMeta) {
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
        dom.toolbarChapter.textContent = `进度 ${Math.round(location.start.percentage * 100)}%`;
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
    const pct = Math.round(currentRendition.location.start.percentage * 100);
    dom.progressSlider.value = pct;
    dom.progressText.textContent = pct + '%';
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
      positionSelectionToolbar(selection);
      dom.selectionToolbar.hidden = false;
    });

    // Hide toolbar when clicking elsewhere in the book
    rendition.on('click', () => {
      hideSelectionToolbar();
    });

    // Handle clicks on the epub container outside selections
    dom.epubContainer.addEventListener('click', (e) => {
      // If clicking outside a selection, hide toolbar after a tick
      // (the 'selected' event fires after so we need a delay)
      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.toString().trim()) {
          // Only hide if no pending selection is being processed
          if (!pendingSelection || sel.toString().trim() !== pendingSelection.text) {
            hideSelectionToolbar();
          }
        }
      }, 100);
    });
  }

  function positionSelectionToolbar(selection) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const toolbar = dom.selectionToolbar;

    let top = rect.top - toolbar.offsetHeight - 8;
    let left = rect.left + (rect.width / 2) - (toolbar.offsetWidth / 2);

    // Keep within viewport
    if (top < 0) top = rect.bottom + 8;
    if (left < 8) left = 8;
    if (left + toolbar.offsetWidth > window.innerWidth - 8) {
      left = window.innerWidth - toolbar.offsetWidth - 8;
    }

    toolbar.style.top = top + 'px';
    toolbar.style.left = left + 'px';
  }

  function hideSelectionToolbar() {
    dom.selectionToolbar.hidden = true;
    pendingSelection = null;
  }

  // ==================== APPLY HIGHLIGHT ====================
  async function applyHighlight(color) {
    if (!pendingSelection || !currentRendition) return;

    const { cfiRange, text } = pendingSelection;

    try {
      // Apply highlight in epub.js
      currentRendition.annotations.highlight(
        cfiRange,
        {},  // data (we track in IDB, not in epub.js data)
        null, // optional callback after highlight is rendered
        color, // className for styling
        {}     // options
      );

      // Save to IndexedDB
      const highlight = {
        id: uuid(),
        book_id: currentBookMeta.id,
        book_title: currentBookMeta.book_title,
        book_author: currentBookMeta.book_author,
        chapter: currentChapter,
        cfi: cfiRange,
        highlight_text: text,
        note: '',
        tags: [],
        color: color,
        created_at: new Date().toISOString(),
        progress_percent: currentBookMeta.progress_percent || 0,
        synced: false,
        synced_at: null,
      };

      await dbPut('highlights', highlight);
      await renderNotes();
      updateSyncBadge();
      hideSelectionToolbar();

      // Do NOT clear the browser selection — keep highlight visible
    } catch (err) {
      console.error('Highlight failed:', err);
      showToast('高亮失败', 'error');
      hideSelectionToolbar();
    }
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
        await dbPut('highlights', h);
      }
    } else {
      // New highlight + note (selected text without prior highlight)
      if (!pendingSelection) return;
      await applyHighlight('yellow');  // default color for note-only additions
      // Find the last added highlight and update it
      const highlights = await dbGetByIndex('highlights', 'by_book', currentBookMeta.id);
      if (highlights.length > 0) {
        const last = highlights[highlights.length - 1];
        last.note = noteText;
        last.tags = tags;
        await dbPut('highlights', last);
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

    const h = await dbGet('highlights', editingHighlightId);
    if (h && currentRendition) {
      // Remove epub.js annotation
      try {
        currentRendition.annotations.remove(h.cfi, 'highlight');
      } catch (e) { /* ignore — may already be removed */ }
    }

    await dbDelete('highlights', editingHighlightId);
    closeNoteEditor();
    await renderNotes();
    updateSyncBadge();
    showToast('已删除', 'info');
  }

  function closeNoteEditor() {
    dom.noteModal.hidden = true;
    editingHighlightId = null;
  }

  // ==================== NOTES PANEL ====================
  async function renderNotes() {
    if (!currentBookMeta) return;

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

      item.innerHTML = `
        <div class="note-item-text">${escapeHTML(h.highlight_text)}</div>
        <div class="note-item-note ${h.note ? 'has-note' : ''}">${escapeHTML(h.note || '')}</div>
        <div class="note-item-tags">${tagsHTML}</div>
        <div class="note-item-meta">
          ${formatRelativeDate(new Date(h.created_at).getTime())}
          ${h.synced ? ' ✓ 已同步' : ' ⬘ 未同步'}
        </div>
      `;

      // Click to navigate to highlight location
      item.addEventListener('click', () => {
        if (currentRendition && h.cfi) {
          currentRendition.display(h.cfi);
        }
        // On mobile, close notes panel
        if (window.innerWidth <= 768) {
          dom.notesPanel.classList.remove('open');
        }
      });

      // Double-click to edit note
      item.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        openNoteEditor(h.id);
      });

      dom.notesList.appendChild(item);
    }
  }

  function toggleNotesPanel() {
    if (window.innerWidth <= 768) {
      dom.notesPanel.classList.toggle('open');
    } else {
      dom.notesPanel.classList.toggle('collapsed');
    }
  }

  // ==================== SYNC ====================
  async function updateSyncBadge() {
    if (!currentBookMeta) return;
    const unsynced = await dbGetByIndex('highlights', 'by_synced', false);
    const count = unsynced.length;

    const badge = dom.syncBadge;
    if (count > 0) {
      badge.textContent = count;
      badge.hidden = false;
      dom.btnSync.disabled = false;
    } else {
      badge.hidden = true;
      dom.btnSync.disabled = true;
    }
    dom.syncBadge.textContent = count > 99 ? '99+' : count;
  }

  async function syncToBackend() {
    const unsynced = await dbGetByIndex('highlights', 'by_synced', false);
    if (unsynced.length === 0) {
      showToast('没有需要同步的数据', 'info');
      return;
    }

    dom.btnSync.classList.add('syncing');
    dom.btnSync.querySelector('.sync-label').textContent = '同步中…';

    try {
      const payload = {
        highlights: unsynced.map(h => ({
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

      // Mark all as synced
      for (const h of unsynced) {
        h.synced = true;
        h.synced_at = new Date().toISOString();
        await dbPut('highlights', h);
      }

      await renderNotes();
      updateSyncBadge();
      showToast(`已同步 ${result.received} 条划线`, 'success');
    } catch (err) {
      console.error('Sync failed:', err);
      showToast('同步失败，请检查后端是否运行', 'error');
    } finally {
      dom.btnSync.classList.remove('syncing');
      dom.btnSync.querySelector('.sync-label').textContent = '同步';
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
    // File import
    dom.fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleFileImport(file);
      dom.fileInput.value = '';
    });

    // Back to library
    dom.btnBack.addEventListener('click', showLibrary);

    // Toggle notes panel
    dom.btnToggleNotes.addEventListener('click', toggleNotesPanel);

    // Progress slider
    dom.progressSlider.addEventListener('input', () => {
      const pct = parseInt(dom.progressSlider.value);
      dom.progressText.textContent = pct + '%';
    });
    dom.progressSlider.addEventListener('change', () => {
      if (!currentRendition) return;
      const pct = parseInt(dom.progressSlider.value) / 100;
      // Navigate to approximate location using percentage
      currentRendition.book.locations.cfiFromPercentage(pct)
        .then((cfi) => {
          if (cfi) currentRendition.display(cfi);
        })
        .catch(() => {});
    });

    // Sync button
    dom.btnSync.addEventListener('click', syncToBackend);

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
      }
      // Ctrl+S for sync
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (!dom.readerView.classList.contains('active')) return;
        syncToBackend();
      }
    });

    // Online/offline
    window.addEventListener('online', () => showToast('网络已恢复', 'success'));
    window.addEventListener('offline', () => showToast('已离线 — 数据保存在本地', 'info'));
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
    updateSyncBadge();

    console.log('Marginalia ready 📖');
  }

  // Start the app
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
