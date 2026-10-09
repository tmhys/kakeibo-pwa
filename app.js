/**
 * らくな家計簿。
 *
 * バックエンドは tmhys/gas の rakuten-ledger WebApp（Apps Script）。
 * ビジネスロジック（カテゴリ推定・重複排除・自動化決済手段の拒否）は
 * サーバー側にすべて置き、このアプリはUIと集計の表示に徹する。
 *
 * 速度のための方針:
 *   - Apps Script は1リクエストに数秒かかる。そこで起動時に page=all で
 *     全取引を1回だけ取得し、ホームの月次集計も履歴もすべて手元で計算する。
 *     画面や月の切り替えでは通信しない。
 *   - 取得結果は localStorage に保存し、次回起動時はまずそれで即描画してから
 *     裏で最新を取り直す。
 *   - 履歴は全件を対象にするが、描画は少しずつ（スクロールに合わせて追加）。
 *
 * 既知の制約（README参照）:
 *   - オフラインキューは無い。保存時は通信が必要。
 */

const STORE_PREFIX = 'kakeibo:';
const DEFAULT_CATEGORIES = ['食費', '日用品', '交通費', '医療費', '衣類', 'レジャー', 'サブスク', '家具・家電', '通信費', '交際費', 'その他'];
const DEFAULT_INCOME_CATEGORIES = ['給与', '還付金', 'お祝い', '副収入', 'その他'];
const DEFAULT_METHOD = '現金';
// gas/rakuten-ledger の computeSnapshot_ と同じ定義（支出合計に含めない種別）
const NON_EXPENSE_TYPES = ['振替', '集計', '収入'];
// アプリに戻ってきたとき、これより古ければ裏で取り直す
const STALE_MS = 5 * 60 * 1000;
// 履歴を1回に描画する件数の目安（日付の途中では切らない）
const HISTORY_CHUNK = 200;

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

async function apiGet(params, override) {
  const s = Object.assign(getSettings(), override || {});
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

/** 全取引を取得する。gas側が古い（page=all が無い）と月次スナップショットが返るので検出する。 */
async function apiGetAll(override) {
  const data = await apiGet({ page: 'all' }, override);
  if (!data || !Array.isArray(data.rows)) {
    throw new Error('gas側（rakuten-ledger）が古いようです。最新のコードを貼って「新バージョン」で再デプロイしてください');
  }
  return data;
}

function apiPostManualEntry(payload) {
  return apiPost('manual-entry', payload);
}

async function apiPost(action, payload) {
  const s = getSettings();
  if (!s.baseUrl || !s.token) throw new Error('設定画面でWebApp URLとトークンを入力してください');
  const body = Object.assign({ action, token: s.token }, payload);
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

function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
function ymdLabel(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return m + '/' + d + '（' + WEEKDAYS[new Date(y, m - 1, d).getDay()] + '）';
}

function isExpense(t) {
  return NON_EXPENSE_TYPES.indexOf(t.type) === -1;
}

function sumAmount(list) {
  return list.reduce((a, t) => a + t.amount, 0);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
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
// データ（全取引を端末に持つ）
// ---------------------------------------------------------------------------

const store = {
  txs: null,      // 日付の新しい順。[{date, ym, type, method, payee, amount, category, memo, search}]
  byMonth: null,  // ym -> txs
  budget: 0,
  updatedAt: '',
  fetchedAt: 0,
  inflight: null,
};

function ingest(data) {
  const cols = data.columns || ['date', 'type', 'method', 'payee', 'amount', 'category', 'memo'];
  const idx = {};
  cols.forEach((c, i) => { idx[c] = i; });
  const txs = data.rows.map((r, i) => {
    const t = {
      date: String(r[idx.date] || ''),
      type: String(r[idx.type] || ''),
      method: String(r[idx.method] || ''),
      payee: String(r[idx.payee] || ''),
      amount: Number(r[idx.amount]) || 0,
      category: String(r[idx.category] || '未分類'),
      memo: idx.memo == null ? '' : String(r[idx.memo] || ''),
      seq: i,
    };
    t.ym = t.date.slice(0, 7);
    t.search = (t.payee + '\n' + t.category + '\n' + t.method + '\n' + t.memo).toLowerCase();
    return t;
  });
  // 日付の新しい順。同じ日の中はシートの後ろ（＝後から入った）ほど上。
  txs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.seq - a.seq));

  const byMonth = new Map();
  txs.forEach((t) => {
    if (!byMonth.has(t.ym)) byMonth.set(t.ym, []);
    byMonth.get(t.ym).push(t);
  });

  store.txs = txs;
  store.byMonth = byMonth;
  store.budget = Number(data.budget) || 0;
  store.updatedAt = data.updatedAt || '';
  historyOptionsDirty = true;
}

function loadCache() {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + 'cache');
    if (!raw) return false;
    const c = JSON.parse(raw);
    // 接続先を変えたら別の家計簿なので使わない
    if (!c || c.baseUrl !== getSettings().baseUrl || !c.data || !Array.isArray(c.data.rows)) return false;
    ingest(c.data);
    store.fetchedAt = Number(c.fetchedAt) || 0;
    return true;
  } catch (e) {
    return false;
  }
}

function saveCache(data) {
  try {
    localStorage.setItem(STORE_PREFIX + 'cache', JSON.stringify({
      baseUrl: getSettings().baseUrl, fetchedAt: store.fetchedAt, data,
    }));
  } catch (e) { /* 容量超過などは無視（次回起動時に取り直すだけ） */ }
}

function clearCache() {
  try { localStorage.removeItem(STORE_PREFIX + 'cache'); } catch (e) { /* noop */ }
  store.txs = null;
  store.byMonth = null;
  store.fetchedAt = 0;
}

function setSyncing(on) {
  document.getElementById('refresh-btn').classList.toggle('spinning', on);
}

/** 最新を取り直して今の画面を描き直す。多重に呼ばれても通信は1本にまとめる。 */
function refreshData() {
  if (!isConfigured()) return Promise.resolve();
  if (store.inflight) return store.inflight;
  setSyncing(true);
  store.inflight = apiGetAll()
    .then((data) => {
      store.fetchedAt = Date.now();
      ingest(data);
      saveCache(data);
      renderCurrentView();
    })
    .catch((e) => {
      showToast(String(e.message || e), 'ng');
      renderCurrentView();
    })
    .finally(() => {
      store.inflight = null;
      setSyncing(false);
    });
  return store.inflight;
}

// ---------------------------------------------------------------------------
// 画面切り替え
// ---------------------------------------------------------------------------

const VIEW_TITLES = { home: 'ホーム', history: '履歴', analysis: '分析', review: 'レビュー', entry: '入力', import: '銀行明細の取り込み', settings: '設定' };
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

  if (['home', 'history', 'analysis', 'review', 'import'].includes(name) && !isConfigured()) {
    showToast('設定画面でWebApp URLとトークンを入力してください', 'ng');
    showView('settings');
    return;
  }
  if (name === 'entry') initEntryView();
  if (name === 'settings') initSettingsView();
  if (name === 'import') initImportView();
  renderCurrentView();
  window.scrollTo(0, 0);
}

function renderCurrentView() {
  if (currentView === 'home') renderHome();
  if (currentView === 'history') renderHistory();
  if (currentView === 'analysis') renderAnalysis();
  if (currentView === 'review') renderReview();
}

// ---------------------------------------------------------------------------
// ホーム（gas/rakuten-ledger の computeSnapshot_ と同じ集計を手元で行う）
// ---------------------------------------------------------------------------

let homeYm = todayYm();

function computeSnapshot(ym) {
  const monthTxs = store.byMonth.get(ym) || [];
  const cur = monthTxs.filter(isExpense);
  const prev = (store.byMonth.get(ymAdd(ym, -1)) || []).filter(isExpense);
  const day = ym === todayYm() ? new Date().getDate() : daysInMonth(ym);
  const prevToDate = prev.filter((t) => Number(t.date.slice(8, 10)) <= day);

  const total = sumAmount(cur);
  const diffToDate = total - sumAmount(prevToDate);

  const catMap = new Map();
  cur.forEach((t) => catMap.set(t.category, (catMap.get(t.category) || 0) + t.amount));
  const categories = Array.from(catMap, ([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);

  const uncat = cur.filter((t) => !t.category || t.category === '未分類');
  const income = monthTxs.filter((t) => t.type === '収入');
  const projected = day > 0 ? Math.round(total / day * daysInMonth(ym)) : 0;

  return {
    total,
    diffToDate,
    projected,
    categories,
    uncat: { count: uncat.length, amount: sumAmount(uncat) },
    income: { count: income.length, total: sumAmount(income) },
    recent: cur.slice(0, 5), // byMonth は日付の新しい順
  };
}

function renderHome() {
  document.getElementById('month-label').textContent = ymLabel(homeYm);
  document.getElementById('sync-note').textContent = store.updatedAt ? '更新 ' + store.updatedAt : '';
  if (!store.txs) {
    document.getElementById('home-total').textContent = '…';
    document.getElementById('home-diff').textContent = store.inflight ? '読み込み中…' : '';
    return;
  }
  const s = computeSnapshot(homeYm);

  document.getElementById('home-total').textContent = yen(s.total);
  const diffEl = document.getElementById('home-diff');
  diffEl.textContent = (s.diffToDate > 0 ? '先月同日比 +' : '先月同日比 ') + yen(s.diffToDate);
  diffEl.className = 'total-diff' + (s.diffToDate > 0 ? ' over' : ' under');

  const budgetCard = document.getElementById('budget-card');
  if (store.budget > 0) {
    const limit = store.budget;
    const remain = limit - s.total;
    budgetCard.classList.remove('hidden');
    const pct = Math.min(100, Math.max(0, (s.total / limit) * 100));
    const over = remain < 0;
    const fill = document.getElementById('budget-bar-fill');
    fill.style.width = pct + '%';
    fill.classList.toggle('over', over);
    const textEl = document.getElementById('budget-text');
    textEl.textContent = (over ? '予算オーバー ' + yen(-remain) : '予算残り ' + yen(remain)) +
      '（予算 ' + yen(limit) + '・着地見込み ' + yen(s.projected) + '）';
    textEl.classList.toggle('over', over);
  } else {
    budgetCard.classList.add('hidden');
  }

  const incomeCard = document.getElementById('income-card');
  if (s.income.total > 0) {
    incomeCard.classList.remove('hidden');
    document.getElementById('income-text').textContent = '収入 ' + yen(s.income.total) + '（' + s.income.count + '件）';
  } else {
    incomeCard.classList.add('hidden');
  }

  const uncatCard = document.getElementById('uncat-card');
  if (s.uncat.count > 0) {
    uncatCard.classList.remove('hidden');
    document.getElementById('uncat-text').innerHTML =
      '⚠ 未分類 ' + s.uncat.count + '件 / ' + yen(s.uncat.amount) +
      ' あります。<button class="link-btn" id="uncat-to-history">履歴で確認</button>';
    document.getElementById('uncat-to-history').onclick = () => {
      openHistoryWith({ month: homeYm, category: '未分類', type: 'expense' });
    };
  } else {
    uncatCard.classList.add('hidden');
  }

  const barsEl = document.getElementById('category-bars');
  const top = s.categories.slice(0, 8);
  const max = top.length ? top[0].amount : 0;
  barsEl.innerHTML = top.length ? top.map((c) => {
    const pct = max ? Math.round((c.amount / max) * 100) : 0;
    return '<button class="cat-bar-row" data-cat="' + escapeHtml(c.name) + '">' +
      '<div class="cat-bar-head"><span>' + escapeHtml(c.name) + '</span><span class="amt">' + yen(c.amount) + '</span></div>' +
      '<div class="cat-bar-track"><div class="cat-bar-fill" style="width:' + pct + '%"></div></div></button>';
  }).join('') : '<div class="empty-note">この月の支出はありません</div>';

  const recentEl = document.getElementById('recent-list');
  recentEl.innerHTML = s.recent.length ? s.recent.map((t) =>
    '<div class="recent-row"><div class="row-main"><div class="row-payee">' + escapeHtml(t.payee) + '</div>' +
    '<div class="row-sub">' + escapeHtml(ymdLabel(t.date)) + ' · ' + escapeHtml(t.category) + '</div></div>' +
    '<div class="row-amt">' + yen(t.amount) + '</div></div>'
  ).join('') : '<div class="empty-note">まだありません</div>';
}

document.getElementById('month-prev').addEventListener('click', () => { homeYm = ymAdd(homeYm, -1); renderHome(); });
document.getElementById('month-next').addEventListener('click', () => { homeYm = ymAdd(homeYm, 1); renderHome(); });
document.getElementById('category-bars').addEventListener('click', (e) => {
  const row = e.target.closest('.cat-bar-row');
  if (row) openHistoryWith({ month: homeYm, category: row.dataset.cat, type: 'expense' });
});

// ---------------------------------------------------------------------------
// 履歴（全件。描画はスクロールに合わせて少しずつ）
// ---------------------------------------------------------------------------

let historyOptionsDirty = true;
let historyFiltered = [];
let historyRendered = 0;
let historyTotals = null; // {day: Map, mon: Map}
let historyObserver = null;
let historyChartYm = ''; // 推移グラフで選んだ月（一覧の該当月へ飛ぶ用）

const TYPE_FILTERS = {
  io: (t) => t.type !== '振替' && t.type !== '集計',
  expense: isExpense,
  income: (t) => t.type === '収入',
  all: () => true,
};

const HISTORY_FIELDS = ['history-search', 'history-month-filter', 'history-type-filter', 'history-category-filter',
  'history-method-filter', 'history-from', 'history-to', 'history-min', 'history-max', 'history-sort'];

function fillSelect(sel, values, allLabel, labelOf) {
  const cur = sel.value;
  sel.innerHTML = '<option value="">' + allLabel + '</option>' +
    values.map((v) => '<option value="' + escapeHtml(v) + '">' + escapeHtml(labelOf ? labelOf(v) : v) + '</option>').join('');
  if (values.includes(cur)) sel.value = cur;
}

function populateHistoryOptions() {
  if (!historyOptionsDirty || !store.txs) return;
  historyOptionsDirty = false;
  const byJa = (a, b) => a.localeCompare(b, 'ja');
  fillSelect(document.getElementById('history-category-filter'),
    Array.from(new Set(store.txs.map((t) => t.category))).sort(byJa), 'すべてのカテゴリ');
  fillSelect(document.getElementById('history-method-filter'),
    Array.from(new Set(store.txs.map((t) => t.method).filter(Boolean))).sort(byJa), 'すべての決済手段');
  fillSelect(document.getElementById('history-month-filter'),
    Array.from(store.byMonth.keys()), 'すべての期間', ymLabel); // byMonth は新しい順
}

/** 他の画面から条件つきで履歴を開く。指定しなかった条件はリセットする。 */
function openHistoryWith(f) {
  showView('history');
  populateHistoryOptions();
  const defaults = { 'history-type-filter': 'io', 'history-sort': 'date' };
  HISTORY_FIELDS.forEach((id) => { document.getElementById(id).value = defaults[id] || ''; });
  const map = {
    search: 'history-search', month: 'history-month-filter', category: 'history-category-filter',
    type: 'history-type-filter', method: 'history-method-filter', from: 'history-from', to: 'history-to',
  };
  Object.keys(map).forEach((k) => { if (f[k]) document.getElementById(map[k]).value = f[k]; });
  document.getElementById('history-adv').classList.add('hidden'); // 使っていれば sync が開き直す
  syncAdvancedToggle();
  renderHistory();
}

function readHistoryFilters() {
  const v = (id) => document.getElementById(id).value;
  return {
    q: v('history-search').trim().toLowerCase(),
    month: v('history-month-filter'),
    cat: v('history-category-filter'),
    method: v('history-method-filter'),
    from: v('history-from'),
    to: v('history-to'),
    min: v('history-min') === '' ? null : Number(v('history-min')),
    max: v('history-max') === '' ? null : Number(v('history-max')),
    sort: v('history-sort') || 'date',
    typeOk: TYPE_FILTERS[v('history-type-filter')] || TYPE_FILTERS.io,
  };
}

/** 詳細フィルタ（期間・金額・決済手段・並び順）が使われているか */
function advancedActive() {
  const f = readHistoryFilters();
  return !!(f.method || f.from || f.to || f.min != null || f.max != null || f.sort !== 'date');
}

function syncAdvancedToggle() {
  const btn = document.getElementById('history-adv-toggle');
  const panel = document.getElementById('history-adv');
  if (advancedActive()) panel.classList.remove('hidden');
  btn.textContent = (panel.classList.contains('hidden') ? '▸ ' : '▾ ') + '詳細な条件' + (advancedActive() ? '（使用中）' : '');
}

function renderHistory() {
  const listEl = document.getElementById('history-list');
  const summaryEl = document.getElementById('history-summary');
  if (!store.txs) {
    summaryEl.textContent = '';
    listEl.innerHTML = '<div class="card"><div class="empty-note">' +
      (store.inflight ? '読み込み中…' : 'データがありません') + '</div></div>';
    return;
  }
  populateHistoryOptions();

  const f = readHistoryFilters();
  const source = f.month ? (store.byMonth.get(f.month) || []) : store.txs;
  historyFiltered = source.filter((t) =>
    f.typeOk(t) &&
    (!f.cat || t.category === f.cat) &&
    (!f.method || t.method === f.method) &&
    (!f.from || t.date >= f.from) &&
    (!f.to || t.date <= f.to) &&
    (f.min == null || t.amount >= f.min) &&
    (f.max == null || t.amount <= f.max) &&
    (!f.q || t.search.includes(f.q)));
  if (f.sort === 'amount') {
    historyFiltered = historyFiltered.slice().sort((a, b) => b.amount - a.amount);
  }

  // 日・月ごとの合計は絞り込み後の全件で先に出しておく（描画は分割するため）
  const day = new Map();
  const mon = new Map();
  let expenseAll = 0;
  let incomeAll = 0;
  historyFiltered.forEach((t) => {
    const key = t.type === '収入' ? 'in' : isExpense(t) ? 'out' : null;
    if (!key) return;
    [[day, t.date], [mon, t.ym]].forEach(([map, k]) => {
      if (!map.has(k)) map.set(k, { in: 0, out: 0 });
      map.get(k)[key] += t.amount;
    });
    if (key === 'in') incomeAll += t.amount; else expenseAll += t.amount;
  });
  historyTotals = { day, mon };

  summaryEl.textContent = [historyFiltered.length + '件']
    .concat(expenseAll || !incomeAll ? ['支出 ' + yen(expenseAll)] : [])
    .concat(incomeAll ? ['収入 ' + yen(incomeAll)] : [])
    .join(' · ');

  renderHistoryTrend(f, mon);
  syncAdvancedToggle();

  listEl.innerHTML = '';
  historyRendered = 0;
  if (!historyFiltered.length) {
    listEl.innerHTML = '<div class="card"><div class="empty-note">該当する取引がありません</div></div>';
    return;
  }
  renderHistoryChunk();
}

/**
 * 絞り込んだ結果の月別推移。「Amazon でいつ・いくら使ったか」のような調べ物用。
 * 何も絞っていないとき（＝全支出）や単月指定のときは出さない（ホーム・分析と同じになるため）。
 */
function renderHistoryTrend(f, mon) {
  const card = document.getElementById('history-trend-card');
  const narrowed = f.q || f.cat || f.method || f.min != null || f.max != null;
  if (!narrowed || f.month || mon.size < 2) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const yms = Array.from(mon.keys()).sort();
  const series = monthRange(yms[0], yms[yms.length - 1]).map((ym) => ({
    key: ym, label: ym, value: (mon.get(ym) || { out: 0 }).out,
  }));
  const months = series.length;
  const total = series.reduce((a, s) => a + s.value, 0);
  document.getElementById('history-trend-note').textContent =
    '月平均 ' + yen(Math.round(total / months)) + '（' + months + 'か月）';
  barChart(document.getElementById('history-trend'), series, {
    selected: historyChartYm,
    tip: (s) => ymLabel(s.key) + ' ' + yen(s.value),
    onSelect: (s) => {
      historyChartYm = s.key;
      // 並びが日付順なら、その月の見出しまで描画してからスクロールする
      if (f.sort !== 'date') return;
      while (!document.querySelector('[data-month-head="' + s.key + '"]') && historyRendered < historyFiltered.length) {
        renderHistoryChunk();
      }
      const head = document.querySelector('[data-month-head="' + s.key + '"]');
      if (head) head.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  });
}

function totalsHtml(t) {
  return '<span>' + (t.out ? yen(t.out) : '') +
    (t.in ? ' <span class="plus">+' + yen(t.in) + '</span>' : '') + '</span>';
}

function historyRowHtml(t, withDate) {
  const isIncome = t.type === '収入';
  const isOther = !isIncome && !isExpense(t);
  const sub = (withDate ? escapeHtml(ymdLabel(t.date)) + ' ' : '') +
    (isOther ? '<span class="chip other">' + escapeHtml(t.type) + '</span>' : '') +
    '<span class="chip' + (t.category === '未分類' ? ' uncat' : '') + '">' + escapeHtml(t.category) + '</span>' +
    escapeHtml(t.method) + (t.memo ? ' · ' + escapeHtml(t.memo) : '');
  return '<div class="history-row"><div class="row-main"><div class="row-payee">' + escapeHtml(t.payee) + '</div>' +
    '<div class="row-sub">' + sub + '</div></div>' +
    '<div class="row-amt' + (isIncome ? ' income' : isOther ? ' other' : '') + '">' +
    (isIncome ? '+' : '') + yen(t.amount) + '</div></div>';
}

function renderHistoryChunk() {
  const listEl = document.getElementById('history-list');
  const old = document.getElementById('history-more');
  if (old) old.remove();

  const list = historyFiltered;
  let i = historyRendered;
  const html = [];

  if (readHistoryFilters().sort === 'amount') {
    // 金額順は日付でまとめられないので、日付つきの1枚のリストにする
    html.push('<div class="card">');
    const end = Math.min(list.length, i + HISTORY_CHUNK);
    for (; i < end; i++) html.push(historyRowHtml(list[i], true));
    html.push('</div>');
  } else {
    let lastYm = i > 0 ? list[i - 1].ym : '';
    // 1日分はまとめて描くので、区切りは必ず日付の境目になる
    while (i < list.length && i - historyRendered < HISTORY_CHUNK) {
      const date = list[i].date;
      if (list[i].ym !== lastYm) {
        lastYm = list[i].ym;
        html.push('<div class="history-month-head" data-month-head="' + lastYm + '"><span>' + ymLabel(lastYm) + '</span>' +
          totalsHtml(historyTotals.mon.get(lastYm) || {}) + '</div>');
      }
      html.push('<div class="history-date-group"><div class="history-date-head"><span>' + ymdLabel(date) + '</span>' +
        totalsHtml(historyTotals.day.get(date) || {}) + '</div><div class="card">');
      while (i < list.length && list[i].date === date) {
        html.push(historyRowHtml(list[i], false));
        i++;
      }
      html.push('</div></div>');
    }
  }
  historyRendered = i;
  listEl.insertAdjacentHTML('beforeend', html.join(''));

  if (historyRendered < list.length) {
    listEl.insertAdjacentHTML('beforeend',
      '<button id="history-more" class="secondary-btn">さらに表示（残り ' + (list.length - historyRendered) + '件）</button>');
    const more = document.getElementById('history-more');
    more.onclick = renderHistoryChunk;
    if ('IntersectionObserver' in window) {
      if (!historyObserver) {
        historyObserver = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting) && currentView === 'history') renderHistoryChunk();
        }, { rootMargin: '600px' });
      }
      historyObserver.disconnect();
      historyObserver.observe(more);
    }
  } else if (historyObserver) {
    historyObserver.disconnect();
  }
}

let historyInputTimer = null;
HISTORY_FIELDS.forEach((id) => {
  const el = document.getElementById(id);
  const isText = el.tagName === 'INPUT' && el.type !== 'date';
  el.addEventListener(isText ? 'input' : 'change', () => {
    historyChartYm = '';
    clearTimeout(historyInputTimer);
    historyInputTimer = setTimeout(renderHistory, isText ? 200 : 0);
  });
});
document.getElementById('history-adv-toggle').addEventListener('click', () => {
  document.getElementById('history-adv').classList.toggle('hidden');
  syncAdvancedToggle();
});
document.getElementById('history-reset').addEventListener('click', () => openHistoryWith({}));

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
    // ホーム・履歴に反映するため裏で取り直す（入力画面の操作は止めない）
    refreshData();
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
document.getElementById('refresh-btn').addEventListener('click', () => refreshData());

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
    const data = await apiGetAll({ baseUrl, token });
    resultEl.textContent = '✅ 接続できました（取引 ' + data.rows.length + '件）';
    resultEl.className = 'test-result ok';
  } catch (e) {
    resultEl.textContent = '✕ ' + String(e.message || e);
    resultEl.className = 'test-result ng';
  }
});

document.getElementById('set-save').addEventListener('click', () => {
  const before = getSettings();
  const categories = document.getElementById('set-categories').value.split(',').map((s) => s.trim()).filter(Boolean);
  const incomeCategories = document.getElementById('set-income-categories').value.split(',').map((s) => s.trim()).filter(Boolean);
  saveSettings({
    baseUrl: document.getElementById('set-baseurl').value,
    token: document.getElementById('set-token').value,
    method: document.getElementById('set-method').value,
    categories: categories.length ? categories : DEFAULT_CATEGORIES,
    incomeCategories: incomeCategories.length ? incomeCategories : DEFAULT_INCOME_CATEGORIES,
  });
  const after = getSettings();
  showToast('設定を保存しました');
  if (before.baseUrl !== after.baseUrl || before.token !== after.token || !store.txs) {
    clearCache();
    refreshData();
  }
  showView('home');
});

// ---------------------------------------------------------------------------
// ナビゲーション & 起動
// ---------------------------------------------------------------------------

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// 以前の版が入れた Service Worker（アプリ本体をキャッシュし続けて更新が届かない）を外す
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => { /* noop */ });
}
if ('caches' in window) {
  caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => { /* noop */ });
}

// アプリに戻ってきたとき、しばらく経っていれば裏で最新にする
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isConfigured() && Date.now() - store.fetchedAt > STALE_MS) {
    refreshData();
  }
});

if (!isConfigured()) {
  showView('settings');
} else {
  loadCache();          // 前回のデータで即描画
  showView('home');
  refreshData();        // 裏で最新を取得して描き直す
}
