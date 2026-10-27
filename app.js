(() => {
  'use strict';

  const STORAGE_KEY = 'rizhang.expenses.v1';
  const MAX_AMOUNT_CENTS = 9999999999;
  const CATEGORY_ORDER = ['food', 'transport', 'shopping', 'daily', 'fun', 'other'];
  const CATEGORIES = Object.freeze({
    food: { label: '餐饮', emoji: '🍜', color: '#a96226', bg: '#fbead5' },
    transport: { label: '交通', emoji: '🚌', color: '#416f8e', bg: '#e4eef6' },
    shopping: { label: '购物', emoji: '🛍️', color: '#a45060', bg: '#f8e5e8' },
    daily: { label: '日用', emoji: '🧻', color: '#5e754c', bg: '#eaf0df' },
    fun: { label: '娱乐', emoji: '🎬', color: '#6a5a8d', bg: '#eee9f7' },
    other: { label: '其他', emoji: '✦', color: '#77746b', bg: '#f0ede6' },
  });
  const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const WEEKDAY_LONG = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const moneyFormatter = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const state = {
    expenses: [],
    selectedDate: '',
    addCategory: 'food',
    editCategory: 'food',
    editingId: null,
    lastAddedId: null,
    storageAvailable: true,
    initialWarning: '',
    deferredInstallPrompt: null,
    toastTimer: 0,
  };

  const els = {};

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function toDateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function todayKey() {
    return toDateKey(new Date());
  }

  function isValidDateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day, 12);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }

  function parseDateKey(value) {
    if (!isValidDateKey(value)) return new Date();
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  function addDays(value, amount) {
    const date = parseDateKey(value);
    date.setDate(date.getDate() + amount);
    return toDateKey(date);
  }

  function dateOrdinal(value) {
    const [year, month, day] = value.split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  }

  function getDateDisplay(value) {
    const date = parseDateKey(value);
    const today = parseDateKey(todayKey());
    const difference = dateOrdinal(todayKey()) - dateOrdinal(value);
    const relative = difference === 0
      ? '今天'
      : difference === 1
        ? '昨天'
        : difference === 2
          ? '前天'
          : `${date.getMonth() + 1}月`;
    const yearPrefix = date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}年`;
    const full = `${yearPrefix}${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY_LONG[date.getDay()]}`;
    return { relative, full };
  }

  function formatMoney(cents) {
    return moneyFormatter.format((Number(cents) || 0) / 100);
  }

  function formatMoneyWithSymbol(cents) {
    return `¥${formatMoney(cents)}`;
  }

  function centsToInput(cents) {
    const value = (Math.max(0, Number(cents) || 0) / 100).toFixed(2);
    if (value.endsWith('.00')) return value.slice(0, -3);
    if (value.endsWith('0')) return value.slice(0, -1);
    return value;
  }

  function parseAmountToCents(rawValue) {
    if (typeof rawValue !== 'string') rawValue = String(rawValue ?? '');
    const normalized = rawValue
      .trim()
      .replace(/[，,\s]/g, '')
      .replace(/。/g, '.')
      .replace(/[¥￥]/g, '');
    if (!normalized || !/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) return null;
    const cents = Math.round(Number(normalized) * 100);
    if (!Number.isFinite(cents) || cents <= 0 || cents > MAX_AMOUNT_CENTS) return null;
    return cents;
  }

  function parseCreatedAt(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--:--';
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function createId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeRecord(input) {
    if (!input || typeof input !== 'object') return null;
    let cents = Number(input.amountCents);
    if (!Number.isFinite(cents)) cents = Math.round(Number(input.amount) * 100);
    if (!Number.isFinite(cents)) return null;
    cents = Math.round(cents);
    if (cents <= 0 || cents > MAX_AMOUNT_CENTS) return null;

    const category = Object.prototype.hasOwnProperty.call(CATEGORIES, input.category) ? input.category : 'other';
    const note = typeof input.note === 'string'
      ? input.note.replace(/\s+/g, ' ').trim().slice(0, 40)
      : '';
    const date = isValidDateKey(input.date) ? input.date : todayKey();
    const id = typeof input.id === 'string' && input.id ? input.id : createId();

    return {
      id,
      amountCents: cents,
      category,
      note,
      date,
      createdAt: parseCreatedAt(input.createdAt),
    };
  }

  function normalizeRecords(list) {
    if (!Array.isArray(list)) return [];
    const seenIds = new Set();
    const records = [];
    for (const item of list) {
      const record = normalizeRecord(item);
      if (!record) continue;
      if (seenIds.has(record.id)) record.id = createId();
      seenIds.add(record.id);
      records.push(record);
    }
    return records;
  }

  function loadExpenses() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.expenses;
      if (!Array.isArray(list)) {
        state.initialWarning = '本地数据格式无法识别，请先导入备份';
        return [];
      }
      return normalizeRecords(list);
    } catch (error) {
      console.error('Unable to read local expenses:', error);
      state.storageAvailable = false;
      state.initialWarning = '浏览器存储不可用，本次账目可能无法保存';
      return [];
    }
  }

  function persistExpenses() {
    const payload = {
      app: '日账',
      version: 1,
      updatedAt: new Date().toISOString(),
      expenses: state.expenses,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      state.storageAvailable = true;
      return true;
    } catch (error) {
      console.error('Unable to save local expenses:', error);
      state.storageAvailable = false;
      showToast('数据保存失败，请先导出备份', true);
      return false;
    }
  }

  function getDayRecords(date = state.selectedDate) {
    return state.expenses.filter((record) => record.date === date);
  }

  function sumRecords(records) {
    return records.reduce((total, record) => total + record.amountCents, 0);
  }

  function getMonthRecords(date = state.selectedDate) {
    const monthPrefix = date.slice(0, 7);
    return state.expenses.filter((record) => record.date.startsWith(monthPrefix));
  }

  function cacheElements() {
    els.dataButton = document.querySelector('#dataButton');
    els.footerDataButton = document.querySelector('#footerDataButton');
    els.prevDate = document.querySelector('#prevDate');
    els.nextDate = document.querySelector('#nextDate');
    els.dateInput = document.querySelector('#dateInput');
    els.dateRelative = document.querySelector('#dateRelative');
    els.dateFull = document.querySelector('#dateFull');
    els.summaryLabel = document.querySelector('#summaryLabel');
    els.dayCount = document.querySelector('#dayCount');
    els.totalRow = document.querySelector('#totalRow');
    els.totalMajor = document.querySelector('#totalMajor');
    els.totalMinor = document.querySelector('#totalMinor');
    els.monthTotal = document.querySelector('#monthTotal');
    els.monthCount = document.querySelector('#monthCount');
    els.expenseForm = document.querySelector('#expenseForm');
    els.amountInput = document.querySelector('#amountInput');
    els.amountField = els.amountInput.closest('.amount-field');
    els.amountError = document.querySelector('#amountError');
    els.noteInput = document.querySelector('#noteInput');
    els.quickRow = document.querySelector('.quick-row');
    els.addCategories = document.querySelector('#addCategories');
    els.editCategories = document.querySelector('#editCategories');
    els.expenseList = document.querySelector('#expenseList');
    els.listTotal = document.querySelector('#listTotal');
    els.weekChart = document.querySelector('#weekChart');
    els.weekTotal = document.querySelector('#weekTotal');
    els.editDialog = document.querySelector('#editDialog');
    els.editForm = document.querySelector('#editForm');
    els.editAmount = document.querySelector('#editAmount');
    els.editAmountField = els.editAmount.closest('.amount-field');
    els.editAmountError = document.querySelector('#editAmountError');
    els.editNote = document.querySelector('#editNote');
    els.editDate = document.querySelector('#editDate');
    els.deleteEntry = document.querySelector('#deleteEntry');
    els.dataDialog = document.querySelector('#dataDialog');
    els.dataRecordCount = document.querySelector('#dataRecordCount');
    els.dataDayCount = document.querySelector('#dataDayCount');
    els.exportButton = document.querySelector('#exportButton');
    els.importButton = document.querySelector('#importButton');
    els.importFile = document.querySelector('#importFile');
    els.installButton = document.querySelector('#installButton');
    els.clearDataButton = document.querySelector('#clearDataButton');
    els.toast = document.querySelector('#toast');
  }

  function init() {
    cacheElements();
    state.selectedDate = todayKey();
    state.expenses = loadExpenses();

    buildCategoryOptions(els.addCategories, (category) => {
      state.addCategory = category;
      updateCategorySelection(els.addCategories, category);
    });
    buildCategoryOptions(els.editCategories, (category) => {
      state.editCategory = category;
      updateCategorySelection(els.editCategories, category);
    });

    bindEvents();
    renderAll();
    registerServiceWorker();

    if (state.initialWarning) {
      window.setTimeout(() => showToast(state.initialWarning, true), 450);
    }
  }

  function buildCategoryOptions(container, onSelect) {
    const fragment = document.createDocumentFragment();
    for (const key of CATEGORY_ORDER) {
      const category = CATEGORIES[key];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'category-option';
      button.dataset.category = key;
      button.style.setProperty('--cat-color', category.color);
      button.style.setProperty('--cat-bg', category.bg);
      button.setAttribute('aria-pressed', 'false');

      const emoji = document.createElement('span');
      emoji.className = 'category-emoji';
      emoji.setAttribute('aria-hidden', 'true');
      emoji.textContent = category.emoji;
      const label = document.createElement('span');
      label.textContent = category.label;
      button.append(emoji, label);
      button.addEventListener('click', () => onSelect(key));
      fragment.append(button);
    }
    container.replaceChildren(fragment);
  }

  function updateCategorySelection(container, selectedCategory) {
    for (const button of container.querySelectorAll('.category-option')) {
      button.setAttribute('aria-pressed', String(button.dataset.category === selectedCategory));
    }
  }

  function renderAll(options = {}) {
    const today = todayKey();
    if (state.selectedDate > today) state.selectedDate = today;

    const dateDisplay = getDateDisplay(state.selectedDate);
    const dayRecords = getDayRecords();
    const dayTotal = sumRecords(dayRecords);
    const monthRecords = getMonthRecords();
    const monthTotal = sumRecords(monthRecords);

    renderDate(dateDisplay, today);
    renderSummary(dateDisplay, dayRecords, dayTotal, monthRecords, monthTotal, options.animateTotal);
    renderExpenseList(dayRecords, dayTotal);
    renderWeek();
    updateDataStats();
    state.lastAddedId = null;
  }

  function renderDate(dateDisplay, today) {
    els.dateRelative.textContent = dateDisplay.relative;
    els.dateFull.textContent = dateDisplay.full;
    els.dateInput.value = state.selectedDate;
    els.dateInput.max = today;
    els.dateInput.setAttribute('aria-label', `选择日期，当前为${dateDisplay.full}`);
    els.nextDate.disabled = state.selectedDate >= today;
  }

  function renderSummary(dateDisplay, dayRecords, dayTotal, monthRecords, monthTotal, animateTotal) {
    const formatted = formatMoney(dayTotal);
    const [major, minor = '00'] = formatted.split('.');
    const summaryText = dateDisplay.relative === '今天'
      ? '今日支出'
      : dateDisplay.relative === '昨天'
        ? '昨日支出'
        : '当日支出';

    els.summaryLabel.textContent = summaryText;
    els.dayCount.textContent = String(dayRecords.length);
    els.totalMajor.textContent = major;
    els.totalMinor.textContent = `.${minor}`;
    els.monthTotal.textContent = formatMoneyWithSymbol(monthTotal);
    els.monthCount.textContent = `${monthRecords.length} 笔`;
    els.totalRow.setAttribute('aria-label', `${dateDisplay.full}，${summaryText} ${formatMoney(dayTotal)} 元，共 ${dayRecords.length} 笔`);
    els.totalRow.classList.toggle('is-long', major.replace(/\D/g, '').length > 7);

    if (animateTotal) {
      els.totalRow.classList.remove('is-updating');
      void els.totalRow.offsetWidth;
      els.totalRow.classList.add('is-updating');
    }
  }

  function renderExpenseList(dayRecords, dayTotal) {
    els.listTotal.textContent = formatMoneyWithSymbol(dayTotal);
    els.expenseList.replaceChildren();

    if (!dayRecords.length) {
      els.expenseList.classList.remove('has-items');
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const icon = document.createElement('span');
      icon.className = 'empty-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '🧾';
      const title = document.createElement('strong');
      title.textContent = state.selectedDate === todayKey() ? '今天还没有支出' : '这一天还没有支出';
      const copy = document.createElement('p');
      copy.textContent = '在上方记下第一笔，金额会自动累计。';
      empty.append(icon, title, copy);
      els.expenseList.append(empty);
      return;
    }

    els.expenseList.classList.add('has-items');
    const sorted = [...dayRecords].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const fragment = document.createDocumentFragment();

    for (const record of sorted) {
      const category = CATEGORIES[record.category] || CATEGORIES.other;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'expense-row';
      row.dataset.id = record.id;
      if (record.id === state.lastAddedId) row.classList.add('is-new');

      const icon = document.createElement('span');
      icon.className = 'expense-icon';
      icon.style.setProperty('--cat-bg', category.bg);
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = category.emoji;

      const copy = document.createElement('span');
      copy.className = 'expense-copy';
      const note = document.createElement('span');
      note.className = 'expense-note';
      note.textContent = record.note || category.label;
      const meta = document.createElement('span');
      meta.className = 'expense-meta';
      const metaParts = [];
      if (record.note) metaParts.push(category.label);
      metaParts.push(formatTime(record.createdAt));
      meta.textContent = metaParts.join(' · ');
      copy.append(note, meta);

      const amount = document.createElement('span');
      amount.className = 'expense-amount';
      amount.textContent = `−${formatMoneyWithSymbol(record.amountCents)}`;
      const arrow = document.createElement('span');
      arrow.className = 'row-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '›';

      row.setAttribute('aria-label', `编辑支出：${record.note || category.label}，${formatMoney(record.amountCents)} 元，${formatTime(record.createdAt)}`);
      row.append(icon, copy, amount, arrow);
      fragment.append(row);
    }

    els.expenseList.append(fragment);
  }

  function renderWeek() {
    const dates = [];
    for (let offset = 6; offset >= 0; offset -= 1) {
      dates.push(addDays(state.selectedDate, -offset));
    }
    const totals = dates.map((date) => sumRecords(getDayRecords(date)));
    const maxValue = Math.max(...totals);
    const weekTotal = totals.reduce((total, value) => total + value, 0);
    const today = todayKey();

    els.weekTotal.textContent = `共 ${formatMoneyWithSymbol(weekTotal)}`;
    const fragment = document.createDocumentFragment();

    dates.forEach((dateKey, index) => {
      const date = parseDateKey(dateKey);
      const value = totals[index];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'week-day';
      button.dataset.date = dateKey;
      if (dateKey === state.selectedDate) {
        button.classList.add('is-active');
        button.setAttribute('aria-current', 'date');
      }
      if (dateKey === today) button.classList.add('is-today');
      button.setAttribute(
        'aria-label',
        `${date.getMonth() + 1}月${date.getDate()}日，${WEEKDAY_SHORT[date.getDay()]}，支出 ${formatMoney(value)} 元`,
      );

      const track = document.createElement('span');
      track.className = 'week-bar-track';
      const bar = document.createElement('span');
      bar.className = 'week-bar';
      const height = value === 0 || maxValue === 0 ? 5 : Math.max(10, Math.round((value / maxValue) * 59));
      bar.style.height = `${height}px`;
      track.append(bar);

      const label = document.createElement('span');
      label.className = 'week-day-label';
      const number = document.createElement('span');
      number.className = 'week-date-number';
      number.textContent = String(date.getDate());
      const weekday = document.createElement('span');
      weekday.className = 'week-weekday';
      weekday.textContent = WEEKDAY_SHORT[date.getDay()];
      label.append(number, weekday);
      button.append(track, label);
      fragment.append(button);
    });

    els.weekChart.replaceChildren(fragment);
  }

  function updateDataStats() {
    const distinctDays = new Set(state.expenses.map((record) => record.date));
    els.dataRecordCount.textContent = String(state.expenses.length);
    els.dataDayCount.textContent = String(distinctDays.size);
  }

  function changeSelectedDate(nextDate) {
    const today = todayKey();
    state.selectedDate = nextDate > today ? today : nextDate;
    renderAll();
  }

  function openDialog(dialog) {
    if (!dialog || dialog.open) return;
    dialog.showModal();
    document.documentElement.style.overflow = 'hidden';
  }

  function showToast(message, isError = false) {
    if (!els.toast) return;
    window.clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.classList.toggle('is-error', Boolean(isError));
    els.toast.classList.add('is-visible');
    state.toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, 2800);
  }

  function hideAmountError(input, field, errorElement) {
    input.removeAttribute('aria-invalid');
    field.classList.remove('is-invalid');
    errorElement.hidden = true;
  }

  function showAmountError(input, field, errorElement) {
    input.setAttribute('aria-invalid', 'true');
    field.classList.add('is-invalid');
    errorElement.hidden = false;
  }

  function bindEvents() {
    els.prevDate.addEventListener('click', () => {
      changeSelectedDate(addDays(state.selectedDate, -1));
    });

    els.nextDate.addEventListener('click', () => {
      if (state.selectedDate < todayKey()) {
        changeSelectedDate(addDays(state.selectedDate, 1));
      }
    });

    els.dateInput.addEventListener('change', () => {
      if (!isValidDateKey(els.dateInput.value)) {
        els.dateInput.value = state.selectedDate;
        return;
      }
      changeSelectedDate(els.dateInput.value);
    });

    els.expenseForm.addEventListener('submit', handleAddExpense);
    els.amountInput.addEventListener('input', () => {
      hideAmountError(els.amountInput, els.amountField, els.amountError);
    });
    els.quickRow.addEventListener('click', handleQuickAmount);

    els.expenseList.addEventListener('click', (event) => {
      const row = event.target.closest('.expense-row');
      if (row) openEditDialog(row.dataset.id);
    });

    els.dataButton.addEventListener('click', openDataDialog);
    els.footerDataButton.addEventListener('click', openDataDialog);

    document.querySelectorAll('[data-close-dialog]').forEach((button) => {
      button.addEventListener('click', () => {
        const dialog = button.closest('dialog');
        if (dialog) dialog.close();
      });
    });

    [els.editDialog, els.dataDialog].forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
      dialog.addEventListener('close', () => {
        if (!document.querySelector('dialog[open]')) {
          document.documentElement.style.overflow = '';
        }
      });
    });

    els.editForm.addEventListener('submit', handleEditSubmit);
    els.editAmount.addEventListener('input', () => {
      hideAmountError(els.editAmount, els.editAmountField, els.editAmountError);
    });

    els.deleteEntry.addEventListener('click', handleDeleteEntry);
    els.exportButton.addEventListener('click', exportBackup);
    els.importButton.addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', importBackup);
    els.clearDataButton.addEventListener('click', clearAllRecords);
    els.installButton.addEventListener('click', installApp);
    els.weekChart.addEventListener('click', (event) => {
      const day = event.target.closest('.week-day');
      if (day) changeSelectedDate(day.dataset.date);
    });

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.deferredInstallPrompt = event;
      els.installButton.hidden = false;
    });

    window.addEventListener('appinstalled', () => {
      state.deferredInstallPrompt = null;
      els.installButton.hidden = true;
      showToast('已添加到桌面');
    });

    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return;
      state.expenses = loadExpenses();
      renderAll();
    });
  }

  function handleAddExpense(event) {
    event.preventDefault();
    const cents = parseAmountToCents(els.amountInput.value);
    if (cents === null) {
      showAmountError(els.amountInput, els.amountField, els.amountError);
      els.amountInput.focus();
      return;
    }

    hideAmountError(els.amountInput, els.amountField, els.amountError);
    const record = {
      id: createId(),
      amountCents: cents,
      category: state.addCategory,
      note: els.noteInput.value.replace(/\s+/g, ' ').trim().slice(0, 40),
      date: state.selectedDate,
      createdAt: new Date().toISOString(),
    };
    state.expenses.push(record);
    state.lastAddedId = record.id;
    const saved = persistExpenses();

    els.amountInput.value = '';
    els.noteInput.value = '';
    const dayTotal = sumRecords(getDayRecords());
    const dateDisplay = getDateDisplay(state.selectedDate);
    renderAll({ animateTotal: true });

    if (saved) {
      const selected = parseDateKey(state.selectedDate);
      const prefix = dateDisplay.relative === '今天'
        ? '已记一笔'
        : `已记入${selected.getMonth() + 1}月${selected.getDate()}日`;
      showToast(`${prefix} ${formatMoneyWithSymbol(cents)} · 当日合计 ${formatMoneyWithSymbol(dayTotal)}`);
    } else {
      showToast('已记一笔，但保存失败，请立即导出备份', true);
    }

    if (window.matchMedia('(hover: hover)').matches) {
      els.amountInput.focus({ preventScroll: true });
    }
  }

  function handleQuickAmount(event) {
    const button = event.target.closest('[data-quick]');
    if (!button) return;
    const increment = Number(button.dataset.quick) * 100;
    const current = parseAmountToCents(els.amountInput.value) || 0;
    const next = current + increment;
    if (next > MAX_AMOUNT_CENTS) {
      showAmountError(els.amountInput, els.amountField, els.amountError);
      return;
    }
    els.amountInput.value = centsToInput(next);
    hideAmountError(els.amountInput, els.amountField, els.amountError);
  }

  function openEditDialog(id) {
    const record = state.expenses.find((item) => item.id === id);
    if (!record) return;

    state.editingId = record.id;
    state.editCategory = record.category;
    els.editAmount.value = centsToInput(record.amountCents);
    els.editNote.value = record.note;
    els.editDate.value = record.date;
    els.editDate.max = todayKey();
    hideAmountError(els.editAmount, els.editAmountField, els.editAmountError);
    updateCategorySelection(els.editCategories, record.category);
    openDialog(els.editDialog);

    if (window.matchMedia('(hover: hover)').matches) {
      window.setTimeout(() => {
        els.editAmount.focus();
        els.editAmount.select();
      }, 70);
    }
  }

  function handleEditSubmit(event) {
    event.preventDefault();
    const record = state.expenses.find((item) => item.id === state.editingId);
    if (!record) {
      els.editDialog.close();
      return;
    }

    const cents = parseAmountToCents(els.editAmount.value);
    if (cents === null) {
      showAmountError(els.editAmount, els.editAmountField, els.editAmountError);
      els.editAmount.focus();
      return;
    }

    hideAmountError(els.editAmount, els.editAmountField, els.editAmountError);
    const today = todayKey();
    const chosenDate = isValidDateKey(els.editDate.value) ? els.editDate.value : record.date;
    record.amountCents = cents;
    record.category = state.editCategory;
    record.note = els.editNote.value.replace(/\s+/g, ' ').trim().slice(0, 40);
    record.date = chosenDate > today ? today : chosenDate;

    const saved = persistExpenses();
    state.selectedDate = record.date;
    state.editingId = null;
    els.editDialog.close();
    renderAll({ animateTotal: true });

    if (saved) {
      showToast(`已保存修改 · 当日合计 ${formatMoneyWithSymbol(sumRecords(getDayRecords()))}`);
    } else {
      showToast('修改已在本次会话中生效，但保存失败', true);
    }
  }

  function handleDeleteEntry() {
    const record = state.expenses.find((item) => item.id === state.editingId);
    if (!record) return;
    const category = CATEGORIES[record.category] || CATEGORIES.other;
    const label = record.note || category.label;
    if (!window.confirm(`确定删除“${label}” ${formatMoneyWithSymbol(record.amountCents)} 吗？\n删除后无法恢复。`)) {
      return;
    }

    state.expenses = state.expenses.filter((item) => item.id !== record.id);
    const saved = persistExpenses();
    state.editingId = null;
    els.editDialog.close();
    renderAll();
    showToast(saved ? '已删除这笔记录' : '记录已删除，但保存状态失败', !saved);
  }

  function openDataDialog() {
    updateDataStats();
    openDialog(els.dataDialog);
  }

  function exportBackup() {
    if (!state.expenses.length) {
      showToast('还没有可以导出的记录');
      return;
    }
    const payload = {
      app: '日账',
      version: 1,
      exportedAt: new Date().toISOString(),
      expenses: state.expenses,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `日账备份-${todayKey()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
    showToast(`已导出 ${state.expenses.length} 笔记录`);
  }

  async function importBackup(event) {
    const input = event.currentTarget;
    const file = input.files && input.files[0];
    if (!file) return;

    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Backup file is too large');
      const text = await file.text();
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.expenses;
      if (!Array.isArray(list)) throw new Error('Missing expenses array');

      const imported = normalizeRecords(list);
      if (list.length > 0 && imported.length === 0) throw new Error('No valid records');

      const existingIds = new Set(state.expenses.map((record) => record.id));
      const newRecords = imported.filter((record) => !existingIds.has(record.id));
      if (!newRecords.length) {
        showToast('没有发现新的记录');
        return;
      }

      state.expenses.push(...newRecords);
      const saved = persistExpenses();
      renderAll();
      els.dataDialog.close();
      showToast(saved ? `已导入 ${newRecords.length} 笔记录` : '已导入，但保存失败', !saved);
    } catch (error) {
      console.error('Unable to import backup:', error);
      showToast('备份文件无法识别，请检查文件内容', true);
    } finally {
      input.value = '';
    }
  }

  function clearAllRecords() {
    if (!state.expenses.length) {
      showToast('当前没有记录');
      return;
    }
    const confirmed = window.confirm('确定清空全部记录吗？\n建议先导出备份，清空后无法恢复。');
    if (!confirmed) return;

    state.expenses = [];
    const saved = persistExpenses();
    renderAll();
    els.dataDialog.close();
    showToast(saved ? '全部记录已清空' : '记录已清空，但保存状态失败', !saved);
  }

  async function installApp() {
    if (!state.deferredInstallPrompt) {
      showToast('请使用浏览器菜单中的“添加到主屏幕”');
      return;
    }
    try {
      state.deferredInstallPrompt.prompt();
      const choice = await state.deferredInstallPrompt.userChoice;
      if (choice.outcome === 'accepted') showToast('正在添加到桌面');
    } catch (error) {
      console.error('Install prompt failed:', error);
      showToast('请使用浏览器菜单添加到主屏幕');
    } finally {
      state.deferredInstallPrompt = null;
      els.installButton.hidden = true;
    }
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
      navigator.serviceWorker.register('./service-worker.js').catch((error) => {
        console.info('Service worker was not registered:', error.message);
      });
    }
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist().catch(() => {});
    }
  }

  init();
})();
