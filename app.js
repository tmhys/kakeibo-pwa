/**
 * らくな家計簿 PWA。
 *
 * バックエンドは tmhys/gas の rakuten-ledger WebApp（Apps Script）。
 * ビジネスロジック（カテゴリ推定・重複排除・自動化決済手段の拒否）は
 * サーバー側にすべて置き、このアプリはUIと集計の表示に徹する。
 *
 * 既知の制約（README参照）:
 *   - page=daily（履歴画面のデータ元）は「収入」種別を含まない。
 *     Obsidian連携(ingest_expenses.py)が支出専用に作られているため、
 *     サーバー側で意図的に除外している。収入はホーム画面の月次サマリー
 *     （snapshot.income）でのみ確認できる。
 *   - オフラインキューは無い。保存時は通信が必要。
 */

const STORE_PREFIX = 'kakeibo:';
const DEFAULT_CATEGORIES = ['食費', '日用品', '交通費', '医療費', '衣類', 'レジャー', 'サブスク', '家具・家電', '通信費', '交際費', 'その他'];
const DEFAULT_INCOME_CATEGORIES = ['給与', '還付金', 'お祝い', '副収入', 'その他'];
const DEFAULT_METHOD = '現金';
const HISTORY_DAYS = 60;

// ---------------------------------------------------------------------------
// 設定（localStorage）
// ---------------------------------------------------------------------------

function loadJson_(key, fallback) {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function getSettings() {
  return {
    baseUrl: localStorage.getItem(STORE_PREFIX + 'baseUrl') || '',
    token: localStorage.getItem(STORE_PREFIX + 'token') || '',
    method: localStorage.getItem(STORE_PREFIX + 'method') || DEFAULT_METHOD,
    categories: loadJson_('categories', DEFAULT_CATEGORIES),
    incomeCategories: loadJson_('incomeCategories', DEFAULT_INCOME_CATEGORIES),
  };
}

function saveSettings(patch) {
  const cur = getSettings();
  const next = Object.assign({}, cur, patch);
  localStorage.setItem(STORE_PREFIX + 'baseUrl', next.baseUrl.trim());
  localStorage.setItem(STORE_PREFIX + 'token', next.token.trim());
  localStorage.setItem(STORE_PREFIX + 'method', next.method.trim() || DEFAULT_METHOD);
  localStorage.setItem(STORE_PREFIX + 'categories', JSON.stringify(next.categories));
  localStorage.setItem(STORE_PREFIX + 'incomeCategories', JSON.stringify(next.incomeCategories));
}

function isConfigured() {
  const s = getSettings();
  return !!(s.baseUrl && s.token);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function apiGet(params) {
  const s = getSettings();
  if (!s.baseUrl || !s.token) throw new Error('設定画面でWebApp URLとトークンを入力してください');
  let url;
  try {
    url = new URL(s.baseUrl);
  } catch (e) {
    throw new Error('WebApp URLが正しいURLの形式ではありません');
  }
  url.searchParams.set('token', s.token);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  let res;
  try {
    res = await fetch(url.toString());
  } catch (e) {
    throw new Error('通信できませんでした（URLかネットワークを確認してください）');
  }
  if (!res.ok) throw new Error('サーバーエラー: HTTP ' + res.status);
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('サーバーの応答がJSONではありません（URLが /exec で終わっているか確認してください）');
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

async function apiPostManualEntry(payload) {
  const s = getSettings();
  if (!s.baseUrl || !s.token) throw new Error('設定画面でWebApp URLとトークンを入力してください');
  const body = Object.assign({ action: 'manual-entry', token: s.token }, payload);
  let res;
  try {
    // text/plain にすることでCORSプリフライト(OPTIONS)を起こさない。
    // gas/rakuten-ledger の parseNotifyBody_ は Content-Type に関わらず
    // 本文が "{" で始まればJSONとして読む。
    res = await fetch(s.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('通信できませんでした（URLかネットワークを確認してください）');
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('サーバーの応答がJSONではありません');
  }
  if (!data || !data.ok) throw new Error((data && data.error) || '保存に失敗しました');
  return data;
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function yen(n) {
  const v = Math.round(Number(n) || 0);
  return (v < 0 ? '-¥' : '¥') + Math.abs(v).toLocaleString('ja-JP');
}

function todayYm() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function todayYmd() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function ymAdd(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function ymLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y + '年' + m + '月';
}

let toastTimer = null;
function showToast(msg, kind) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (kind === 'ng' ? ' ng' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.add('hidden'); }, 3200);
}

// ---------------------------------------------------------------------------
// 画面切り替え
// ---------------------------------------------------------------------------

const VIEW_TITLES = { home: 'ホーム', history: '履歴', entry: '入力', settings: '設定' };
let currentView = 'home';

function showView(name) {
  currentView = name;
  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('hidden', el.id !== 'view-' + name);
  });
  document.querySelectorAll('.nav-btn').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === name);
  });
  document.getElementById('page-title').textContent = VIEW_TITLES[name] || '';

  if (name === 'home') loadHome();
  if (name === 'history') loadHistory();
  if (name === 'entry') initEntryView();
  if (name === 'settings') initSettingsView();
}

// ---------------------------------------------------------------------------
// ホーム
// ---------------------------------------------------------------------------

let homeYm = todayYm();

async function loadHome() {
  document.getElementById('month-label').textContent = ymLabel(homeYm);
  if (!isConfigured()) {
    showToast('設定画面でWebApp URLとトークンを入力してください', 'ng');
    showView('settings');
    return;
  }
  try {
    const snap = await apiGet({ month: homeYm });
    renderHome(snap);
  } catch (e) {
    showToast(String(e.message || e), 'ng');
  }
}

function renderHome(s) {
  document.getElementById('home-total').textContent = s.text.total;
  const diffEl = document.getElementById('home-diff');
  diffEl.textContent = s.text.diffLabel;
  diffEl.className = 'total-diff' + (s.overPace ? ' over' : ' under');

  const budgetCard = document.getElementById('budget-card');
  if (s.budget) {
    budgetCard.classList.remove('hidden');
    const pct = Math.min(100, Math.max(0, (s.budget.spent / s.budget.limit) * 100));
    const over = s.budget.remain < 0;
    const fill = document.getElementById('budget-bar-fill');
    fill.style.width = pct + '%';
    fill.classList.toggle('over', over);
    const textEl = document.getElementById('budget-text');
    textEl.textContent = s.text.budget + '（予算 ' + yen(s.budget.limit) + '）';
    textEl.classList.toggle('over', over);
  } else {
    budgetCard.classList.add('hidden');
  }

  const incomeCard = document.getElementById('income-card');
  if (s.income && s.income.total > 0) {
    incomeCard.classList.remove('hidden');
    document.getElementById('income-text').textContent = s.text.income + '（' + s.income.count + '件）';
  } else {
    incomeCard.classList.add('hidden');
  }

  const uncatCard = document.getElementById('uncat-card');
  if (s.uncategorized && s.uncategorized.count > 0) {
    uncatCard.classList.remove('hidden');
    document.getElementById('uncat-text').innerHTML =
      '⚠ ' + s.text.uncategorized + ' あります。<button class="link-btn" id="uncat-to-history">履歴で確認</button>';
    document.getElementById('uncat-to-history').onclick = () => {
      showView('history');
      setTimeout(() => {
        const sel = document.getElementById('history-category-filter');
        if (sel) sel.value = '未分類';
        filterHistory();
      }, 0);
    };
  } else {
    uncatCard.classList.add('hidden');
  }

  const barsEl = document.getElementById('category-bars');
  barsEl.innerHTML = '';
  const top = s.categories.slice(0, 8);
  const max = top.length ? Math.max(...top.map((c) => c.amount)) : 0;
  if (!top.length) {
    barsEl.innerHTML = '<div class="empty-note">今月の支出はまだありません</div>';
  }
  top.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'cat-bar-row';
    const pct = max ? Math.round((c.amount / max) * 100) : 0;
    row.innerHTML =
      '<div class="cat-bar-head"><span>' + escapeHtml(c.name) + '</span><span class="amt">' + yen(c.amount) + '</span></div>' +
      '<div class="cat-bar-track"><div class="cat-bar-fill" style="width:' + pct + '%"></div></div>';
    barsEl.appendChild(row);
  });

  const recentEl = document.getElementById('recent-list');
  recentEl.innerHTML = '';
  if (!s.recent.length) {
    recentEl.innerHTML = '<div class="empty-note">まだありません</div>';
  }
  s.recent.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'recent-row';
    row.innerHTML =
      '<div class="row-main"><div class="row-payee">' + escapeHtml(r.payee) + '</div>' +
      '<div class="row-sub">' + escapeHtml(r.date) + ' · ' + escapeHtml(r.category || '未分類') + '</div></div>' +
      '<div class="row-amt">' + yen(r.amount) + '</div>';
    recentEl.appendChild(row);
  });
}

document.getElementById('month-prev').addEventListener('click', () => { homeYm = ymAdd(homeYm, -1); loadHome(); });
document.getElementById('month-next').addEventListener('click', () => { homeYm = ymAdd(homeYm, 1); loadHome(); });

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// 履歴
// ---------------------------------------------------------------------------

let historyDaily = null; // {days: {ymd: {total,count,items,text}}, from, to}

async function loadHistory() {
  if (!isConfigured()) {
    showToast('設定画面でWebApp URLとトークンを入力してください', 'ng');
    showView('settings');
    return;
  }
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="card"><div class="empty-note">読み込み中…</div></div>';
  try {
    historyDaily = await apiGet({ page: 'daily', days: HISTORY_DAYS });
    populateHistoryCategoryFilter();
    filterHistory();
  } catch (e) {
    listEl.innerHTML = '';
    showToast(String(e.message || e), 'ng');
  }
}

function populateHistoryCategoryFilter() {
  const sel = document.getElementById('history-category-filter');
  const cur = sel.value;
  const set = new Set();
  Object.values(historyDaily.days || {}).forEach((d) => {
    (d.items || []).forEach((it) => set.add(it.category || '未分類'));
  });
  const cats = Array.from(set).sort();
  sel.innerHTML = '<option value="">すべてのカテゴリ</option>' +
    cats.map((c) => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('');
  if (cats.includes(cur)) sel.value = cur;
}

function filterHistory() {
  if (!historyDaily) return;
  const q = document.getElementById('history-search').value.trim().toLowerCase();
  const catFilter = document.getElementById('history-category-filter').value;
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '';

  const dates = Object.keys(historyDaily.days || {}).sort().reverse();
  let shown = 0;

  dates.forEach((ymd) => {
    const day = historyDaily.days[ymd];
    const items = (day.items || []).filter((it) => {
      if (catFilter && (it.category || '未分類') !== catFilter) return false;
      if (!q) return true;
      return (it.payee || '').toLowerCase().includes(q) || (it.category || '').toLowerCase().includes(q);
    });
    if (!items.length) return;
    shown += items.length;

    const group = document.createElement('div');
    group.className = 'history-date-group';
    const dayTotal = items.reduce((a, it) => a + (Number(it.amount) || 0), 0);
    group.innerHTML = '<div class="history-date-head"><span>' + escapeHtml(ymd) + '</span><span>' + yen(dayTotal) + '</span></div>';

    const card = document.createElement('div');
    card.className = 'card';
    items.forEach((it) => {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.innerHTML =
        '<div class="row-main"><div class="row-payee">' + escapeHtml(it.payee) + '</div>' +
        '<div class="row-sub"><span class="chip' + (it.category === '未分類' ? ' uncat' : '') + '">' +
        escapeHtml(it.category || '未分類') + '</span>' + escapeHtml(it.method || '') + '</div></div>' +
        '<div class="row-amt">' + yen(it.amount) + '</div>';
      card.appendChild(row);
    });
    group.appendChild(card);
    listEl.appendChild(group);
  });

  if (!shown) {
    listEl.innerHTML = '<div class="card"><div class="empty-note">該当する取引がありません</div></div>';
  }
}

document.getElementById('history-search').addEventListener('input', filterHistory);
document.getElementById('history-category-filter').addEventListener('change', filterHistory);

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

const entryState = {
  type: 'expense', // 'expense' | 'income'
  amountStr: '',
  category: '',
};
const sessionSaved = [];

function initEntryView() {
  document.getElementById('entry-date').value = todayYmd();
  const s = getSettings();
  document.getElementById('entry-method').value = s.method;
  renderEntryType();
  renderCategoryGrid();
  renderAmount();
}

function renderEntryType() {
  document.getElementById('type-expense').classList.toggle('on', entryState.type === 'expense');
  document.getElementById('type-income').classList.toggle('on', entryState.type === 'income');
  document.getElementById('method-field').classList.toggle('hidden', entryState.type === 'income');
  document.getElementById('category-grid-title').textContent = entryState.type === 'income' ? '収入カテゴリ' : 'カテゴリ';
  document.getElementById('payee-label').textContent = entryState.type === 'income'
    ? '内容（未入力ならカテゴリ名を使います）'
    : '利用先（未入力ならカテゴリ名を使います）';
}

function renderCategoryGrid() {
  const s = getSettings();
  const cats = entryState.type === 'income' ? s.incomeCategories : ['自動'].concat(s.categories);
  const grid = document.getElementById('category-grid');
  grid.innerHTML = '';
  cats.forEach((c) => {
    const btn = document.createElement('button');
    btn.className = 'cat-btn' + (entryState.category === c ? ' selected' : '');
    btn.textContent = c;
    btn.onclick = () => {
      entryState.category = (entryState.category === c) ? '' : c;
      renderCategoryGrid();
    };
    grid.appendChild(btn);
  });
}

function renderAmount() {
  const n = Number(entryState.amountStr || '0');
  document.getElementById('amount-display').textContent = yen(n);
}

document.getElementById('type-expense').addEventListener('click', () => { entryState.type = 'expense'; entryState.category = ''; renderEntryType(); renderCategoryGrid(); });
document.getElementById('type-income').addEventListener('click', () => { entryState.type = 'income'; entryState.category = ''; renderEntryType(); renderCategoryGrid(); });

document.querySelectorAll('.keypad .key').forEach((btn) => {
  btn.addEventListener('click', () => {
    const k = btn.dataset.key;
    if (k === 'back') {
      entryState.amountStr = entryState.amountStr.slice(0, -1);
    } else if (entryState.amountStr.length < 9) {
      entryState.amountStr += k;
      entryState.amountStr = entryState.amountStr.replace(/^0+(?=\d)/, '');
    }
    renderAmount();
  });
});

document.getElementById('entry-save').addEventListener('click', async () => {
  const amount = Number(entryState.amountStr || '0');
  if (!amount) { showToast('金額を入力してください', 'ng'); return; }

  let payee = document.getElementById('entry-payee').value.trim();
  if (!payee) {
    if (entryState.category && entryState.category !== '自動') payee = entryState.category;
  }
  if (!payee) {
    showToast(entryState.type === 'income' ? '内容を入力してください' : '利用先を入力するかカテゴリを選んでください', 'ng');
    return;
  }

  const payload = {
    type: entryState.type === 'income' ? 'income' : undefined,
    date: document.getElementById('entry-date').value || todayYmd(),
    payee,
    amount,
    category: entryState.category || '自動',
    memo: document.getElementById('entry-memo').value.trim(),
  };
  if (entryState.type !== 'income') {
    payload.method = document.getElementById('entry-method').value.trim() || DEFAULT_METHOD;
  }

  const btn = document.getElementById('entry-save');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const res = await apiPostManualEntry(payload);
    showToast('✅ ' + res.message);
    sessionSaved.unshift({ payee, amount, category: res.category, type: res.type, date: payload.date });
    renderSessionSaved();
    // 連続入力しやすいよう、金額とメモ・利用先だけリセット（カテゴリ・決済手段は保持）
    entryState.amountStr = '';
    renderAmount();
    document.getElementById('entry-payee').value = '';
    document.getElementById('entry-memo').value = '';
  } catch (e) {
    showToast(String(e.message || e), 'ng');
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
});

function renderSessionSaved() {
  const el = document.getElementById('entry-recent');
  if (!sessionSaved.length) {
    el.innerHTML = '<div class="empty-note">まだありません</div>';
    return;
  }
  el.innerHTML = '';
  sessionSaved.slice(0, 10).forEach((r) => {
    const row = document.createElement('div');
    row.className = 'recent-row';
    const isIncome = r.type === '収入';
    row.innerHTML =
      '<div class="row-main"><div class="row-payee">' + escapeHtml(r.payee) + '</div>' +
      '<div class="row-sub">' + escapeHtml(r.date) + ' · ' + escapeHtml(r.category) + '</div></div>' +
      '<div class="row-amt' + (isIncome ? ' income' : '') + '">' + (isIncome ? '+' : '') + yen(r.amount) + '</div>';
    el.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

function initSettingsView() {
  const s = getSettings();
  document.getElementById('set-baseurl').value = s.baseUrl;
  document.getElementById('set-token').value = s.token;
  document.getElementById('set-method').value = s.method;
  document.getElementById('set-categories').value = s.categories.join(', ');
  document.getElementById('set-income-categories').value = s.incomeCategories.join(', ');
  document.getElementById('set-test-result').textContent = '';
  document.getElementById('set-test-result').className = 'test-result';
}

document.getElementById('settings-btn').addEventListener('click', () => showView('settings'));

document.getElementById('set-test').addEventListener('click', async () => {
  // 保存前の入力値でその場でテストする（設定保存とは独立）
  const baseUrl = document.getElementById('set-baseurl').value.trim();
  const token = document.getElementById('set-token').value.trim();
  const resultEl = document.getElementById('set-test-result');
  resultEl.textContent = '確認中…';
  resultEl.className = 'test-result';
  if (!baseUrl || !token) {
    resultEl.textContent = 'URLとトークンを両方入力してください';
    resultEl.className = 'test-result ng';
    return;
  }
  try {
    const url = new URL(baseUrl);
    url.searchParams.set('token', token);
    const res = await fetch(url.toString());
    const data = await res.json();
    if (data && data.error) throw new Error(data.error);
    resultEl.textContent = '✅ 接続できました（' + (data.month || '') + ' 支出合計 ' + (data.text ? data.text.total : yen(data.total)) + '）';
    resultEl.className = 'test-result ok';
  } catch (e) {
    resultEl.textContent = '✕ ' + String(e.message || e);
    resultEl.className = 'test-result ng';
  }
});

document.getElementById('set-save').addEventListener('click', () => {
  const categories = document.getElementById('set-categories').value.split(',').map((s) => s.trim()).filter(Boolean);
  const incomeCategories = document.getElementById('set-income-categories').value.split(',').map((s) => s.trim()).filter(Boolean);
  saveSettings({
    baseUrl: document.getElementById('set-baseurl').value,
    token: document.getElementById('set-token').value,
    method: document.getElementById('set-method').value,
    categories: categories.length ? categories : DEFAULT_CATEGORIES,
    incomeCategories: incomeCategories.length ? incomeCategories : DEFAULT_INCOME_CATEGORIES,
  });
  showToast('設定を保存しました');
  showView('home');
});

// ---------------------------------------------------------------------------
// ナビゲーション & 起動
// ---------------------------------------------------------------------------

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* PWA機能が無くても本体は動く */ });
  });
}

if (!isConfigured()) {
  showView('settings');
} else {
  showView('home');
}
