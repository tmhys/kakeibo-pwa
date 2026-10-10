/**
 * 家計簿アプリでよくある「見る」機能をまとめたもの。どれも端末に持った全取引（store）
 * から計算し、通信はしない。
 *
 *   ホーム   : 今月のペース（累積の折れ線）・今日使えるお金・カテゴリ別予算
 *   履歴     : カレンダー表示・取引の詳細シート
 *   分析     : 収支と貯蓄率の推移・固定費と変動費・年間レポート（カテゴリ×月）
 *
 * 予算はこの端末だけに保存する（設定画面）。全体の予算を空にすると、
 * gas の MONTHLY_BUDGET（スクリプトプロパティ）を使う。
 */

// ---------------------------------------------------------------------------
// 予算（設定）
// ---------------------------------------------------------------------------

function loadBudgetSettings() {
  return {
    total: Number(localStorage.getItem(STORE_PREFIX + 'budgetTotal')) || 0,
    cats: loadJson_('categoryBudgets', {}),
  };
}

/** 月の予算（総額）。端末の設定が優先、無ければ gas の MONTHLY_BUDGET */
function totalBudget() {
  return loadBudgetSettings().total || store.budget || 0;
}

/** 「食費=40000」の行を読む。全角の＝や、カンマ区切りも受け付ける */
function parseCategoryBudgets(text) {
  const out = {};
  String(text || '').split(/[\n,、]+/).forEach((line) => {
    const m = line.match(/^\s*(.+?)\s*[=＝:：]\s*([\d,，]+)\s*$/);
    if (m) out[m[1]] = Number(m[2].replace(/[,，]/g, ''));
  });
  return out;
}

function initBudgetSettings() {
  const b = loadBudgetSettings();
  document.getElementById('set-budget-total').value = b.total || '';
  document.getElementById('set-budget-total').placeholder = store.budget ? 'gas の設定: ' + store.budget : '例: 200000';
  document.getElementById('set-cat-budgets').value =
    Object.keys(b.cats).map((k) => k + '=' + b.cats[k]).join('\n');
}

function saveBudgetSettings() {
  const total = Number(document.getElementById('set-budget-total').value) || 0;
  localStorage.setItem(STORE_PREFIX + 'budgetTotal', String(total));
  localStorage.setItem(STORE_PREFIX + 'categoryBudgets',
    JSON.stringify(parseCategoryBudgets(document.getElementById('set-cat-budgets').value)));
}

// ---------------------------------------------------------------------------
// 折れ線（累積）
// ---------------------------------------------------------------------------

/**
 * @param series [{name, cls, values: [日1の累積, 日2の累積, ...], dashed}]
 *               values の長さが系列ごとに違ってよい（今月は今日まで）
 */
function lineChart(el, days, series, opts) {
  opts = opts || {};
  const W = Math.max(280, el.clientWidth || 340);
  const H = 160;
  const top = 12;
  const bottom = 20;
  const gutter = 40;
  const plotW = W - gutter;
  const plotH = H - top - bottom;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (d) => ((d - 1) / Math.max(1, days - 1)) * plotW;
  const y = (v) => top + plotH - (v / max) * plotH;

  const parts = [];
  [max, max / 2].forEach((v) => {
    parts.push('<line class="grid" x1="0" x2="' + plotW + '" y1="' + y(v) + '" y2="' + y(v) + '"/>');
    parts.push('<text class="axis" x="' + W + '" y="' + (y(v) + 3) + '" text-anchor="end">' + yenShort(v) + '</text>');
  });
  parts.push('<line class="baseline" x1="0" x2="' + plotW + '" y1="' + (top + plotH) + '" y2="' + (top + plotH) + '"/>');
  [1, 10, 20, days].forEach((d) => {
    parts.push('<text class="axis" x="' + x(d) + '" y="' + (H - 5) + '" text-anchor="' + (d === 1 ? 'start' : d === days ? 'end' : 'middle') + '">' + d + '日</text>');
  });
  series.forEach((s) => {
    if (!s.values.length) return;
    const pts = s.values.map((v, i) => x(i + 1).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    parts.push('<polyline class="line ' + s.cls + (s.dashed ? ' dashed' : '') + '" points="' + pts + '"/>');
    const last = s.values.length;
    if (s.marker) {
      parts.push('<circle class="dot ' + s.cls + '" cx="' + x(last) + '" cy="' + y(s.values[last - 1]) + '" r="4"/>');
    }
  });
  parts.push('<line class="crosshair hidden" x1="0" x2="0" y1="' + top + '" y2="' + (top + plotH) + '"/>');
  parts.push('<rect class="hit" x="0" y="0" width="' + plotW + '" height="' + H + '"/>');

  el.innerHTML = '<div class="chart-tip hidden"></div><svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img">' +
    parts.join('') + '</svg>';

  const svg = el.querySelector('svg');
  const tip = el.querySelector('.chart-tip');
  const cross = el.querySelector('.crosshair');
  const show = (clientX) => {
    const r = svg.getBoundingClientRect();
    const d = Math.min(days, Math.max(1, Math.round(((clientX - r.left) / r.width) * W / plotW * (days - 1)) + 1));
    cross.setAttribute('x1', x(d));
    cross.setAttribute('x2', x(d));
    cross.classList.remove('hidden');
    tip.textContent = d + '日まで  ' + series.filter((s) => s.values[d - 1] != null)
      .map((s) => s.name + ' ' + yen(s.values[d - 1])).join(' / ');
    tip.classList.remove('hidden');
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(W - tw, x(d) - tw / 2)) + 'px';
  };
  svg.addEventListener('pointermove', (e) => show(e.clientX));
  svg.addEventListener('pointerdown', (e) => show(e.clientX));
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') { tip.classList.add('hidden'); cross.classList.add('hidden'); }
  });
}

function cumulative(txs, days) {
  const daily = new Array(days).fill(0);
  txs.forEach((t) => { daily[Number(t.date.slice(8, 10)) - 1] += t.amount; });
  let acc = 0;
  return daily.map((v) => (acc += v));
}

// ---------------------------------------------------------------------------
// ホーム: ペース・今日使えるお金・カテゴリ別予算
// ---------------------------------------------------------------------------

function renderHomeExtras(snap) {
  const ym = homeYm;
  const days = daysInMonth(ym);
  const isNow = ym === todayYm();
  const today = isNow ? new Date().getDate() : days;
  const cur = (store.byMonth.get(ym) || []).filter(isExpense);
  const prevYm = ymAdd(ym, -1);
  const prev = (store.byMonth.get(prevYm) || []).filter(isExpense);
  const limit = totalBudget();

  // 今月のペース。先月は日数が違うので、先月の日数ぶんだけ描く
  const series = [
    { name: '先月', cls: 'prev', values: cumulative(prev, daysInMonth(prevYm)) },
    { name: isNow ? '今月' : Number(ym.slice(5)) + '月', cls: 'cur', values: cumulative(cur, days).slice(0, today), marker: isNow },
  ];
  if (limit) {
    series.push({ name: '予算ペース', cls: 'budget', dashed: true, values: Array.from({ length: days }, (_, i) => Math.round(limit * (i + 1) / days)) });
  }
  document.getElementById('pace-legend').innerHTML = series.map((s) =>
    '<span class="legend-item"><span class="swatch ' + s.cls + (s.dashed ? ' dashed' : '') + '"></span>' + escapeHtml(s.name) + '</span>').join('');
  lineChart(document.getElementById('pace-chart'), days, series);

  // 先月の同じ日までとの差、着地見込み
  const prevToDay = cumulative(prev, daysInMonth(prevYm))[Math.min(today, daysInMonth(prevYm)) - 1] || 0;
  const notes = [];
  if (isNow) notes.push('着地見込み ' + yen(snap.projected));
  notes.push('先月の' + today + '日時点 ' + yen(prevToDay));
  document.getElementById('pace-note').textContent = notes.join(' · ');

  // 今日使えるお金（予算があり、今月を見ているときだけ）
  const allow = document.getElementById('allowance');
  if (limit && isNow) {
    const left = days - today + 1; // 今日を含む残り日数
    const remain = limit - snap.total;
    allow.classList.remove('hidden');
    allow.innerHTML = remain > 0
      ? '<div class="allow-label">今日から月末まで 1日あたり使えるお金</div><div class="allow-amount">' + yen(Math.floor(remain / left)) +
        '</div><div class="allow-sub">残り ' + yen(remain) + ' · あと' + left + '日</div>'
      : '<div class="allow-label">予算を超えています</div><div class="allow-amount over">' + yen(-remain) + ' オーバー</div>';
  } else {
    allow.classList.add('hidden');
  }

  // カテゴリ別予算
  const cats = loadBudgetSettings().cats;
  const names = Object.keys(cats);
  const card = document.getElementById('catbudget-card');
  if (!names.length) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  const spent = new Map(snap.categories.map((c) => [c.name, c.amount]));
  const pace = today / days; // 今日までに使っていてよい割合
  document.getElementById('catbudget-list').innerHTML = names.map((name) => {
    const b = cats[name];
    const used = spent.get(name) || 0;
    const ratio = b ? used / b : 0;
    const over = used > b;
    const fast = !over && isNow && ratio > pace + 0.1; // ペースより1割以上早い
    return '<button class="cat-bar-row" data-cat="' + escapeHtml(name) + '">' +
      '<div class="cat-bar-head"><span class="name">' + (over ? '⚠ ' : fast ? '△ ' : '') + escapeHtml(name) + '</span>' +
      '<span class="amt">' + yen(used) + ' / ' + yen(b) + '</span></div>' +
      '<div class="cat-bar-track budget-track"><div class="cat-bar-fill' + (over ? ' over' : fast ? ' fast' : '') +
      '" style="width:' + Math.min(100, Math.round(ratio * 100)) + '%"></div>' +
      (isNow ? '<div class="pace-mark" style="left:' + Math.round(pace * 100) + '%"></div>' : '') + '</div>' +
      '<div class="cat-budget-sub">' + (over ? yen(used - b) + ' 超過' : '残り ' + yen(b - used)) + '</div></button>';
  }).join('');
  document.getElementById('catbudget-list').querySelectorAll('.cat-bar-row').forEach((b) => {
    b.onclick = () => openHistoryWith({ month: ym, category: b.dataset.cat, type: 'expense' });
  });
}

// ---------------------------------------------------------------------------
// 履歴: カレンダー
// ---------------------------------------------------------------------------

let calYm = todayYm();
let calDay = '';

function setHistoryMode(mode) {
  applyHistoryMode(mode);
  renderHistory();
}

function applyHistoryMode(mode) {
  historyMode = mode;
  document.querySelectorAll('#history-mode .type-btn').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  document.getElementById('history-calendar').classList.toggle('hidden', mode !== 'calendar');
  document.getElementById('history-list').classList.toggle('hidden', mode === 'calendar');
  // 月の指定はカレンダー自身の月送りで行うので隠す
  document.getElementById('history-month-filter').classList.toggle('hidden', mode === 'calendar');
  if (mode === 'calendar') {
    const m = document.getElementById('history-month-filter').value;
    if (m) calYm = m;
  }
}

function renderCalendar(f) {
  document.getElementById('history-trend-card').classList.add('hidden');
  const txs = (store.byMonth.get(calYm) || []).filter((t) => historyMatch(t, f, false));
  const byDay = new Map();
  let out = 0;
  let inn = 0;
  txs.forEach((t) => {
    const d = Number(t.date.slice(8, 10));
    const v = byDay.get(d) || { out: 0, in: 0, n: 0 };
    if (t.type === '収入') { v.in += t.amount; inn += t.amount; } else if (isExpense(t)) { v.out += t.amount; out += t.amount; }
    v.n += 1;
    byDay.set(d, v);
  });
  document.getElementById('history-summary').textContent = ymLabel(calYm) + ' · ' + txs.length + '件 · 支出 ' + yen(out) +
    (inn ? ' · 収入 ' + yen(inn) : '');
  document.getElementById('cal-label').textContent = ymLabel(calYm);

  const [y, m] = calYm.split('-').map(Number);
  const first = new Date(y, m - 1, 1).getDay();
  const days = daysInMonth(calYm);
  const max = Math.max(1, ...Array.from(byDay.values()).map((v) => v.out));
  const todayStr = todayYmd();
  const cells = [];
  WEEKDAYS.forEach((w, i) => cells.push('<div class="cal-head' + (i === 0 ? ' sun' : i === 6 ? ' sat' : '') + '">' + w + '</div>'));
  for (let i = 0; i < first; i++) cells.push('<div class="cal-cell empty"></div>');
  for (let d = 1; d <= days; d++) {
    const v = byDay.get(d);
    const ymd = calYm + '-' + String(d).padStart(2, '0');
    // 濃さは支出額（1色の濃淡）。金額の文字は常に本文色
    const level = v && v.out ? Math.min(4, Math.ceil((v.out / max) * 4)) : 0;
    cells.push('<button class="cal-cell lv' + level + (ymd === calDay ? ' selected' : '') + (ymd === todayStr ? ' today' : '') +
      '" data-ymd="' + ymd + '"><span class="cal-d">' + d + '</span>' +
      (v && v.out ? '<span class="cal-amt">' + yenShort(v.out) + '</span>' : '') +
      (v && v.in ? '<span class="cal-in">+' + yenShort(v.in) + '</span>' : '') + '</button>');
  }
  const grid = document.getElementById('cal-grid');
  grid.innerHTML = cells.join('');
  grid.querySelectorAll('.cal-cell[data-ymd]').forEach((c) => {
    c.onclick = () => { calDay = calDay === c.dataset.ymd ? '' : c.dataset.ymd; renderCalendar(f); };
  });

  const dayEl = document.getElementById('cal-day');
  if (calDay && calDay.startsWith(calYm)) {
    const list = txs.filter((t) => t.date === calDay);
    dayEl.innerHTML = '<div class="history-date-head"><span>' + ymdLabel(calDay) + '</span>' +
      totalsHtml({ out: list.filter(isExpense).reduce((a, t) => a + t.amount, 0), in: list.filter((t) => t.type === '収入').reduce((a, t) => a + t.amount, 0) }) +
      '</div><div class="card">' + (list.length ? list.map((t) => historyRowHtml(t, false)).join('') : '<div class="empty-note">この日の取引はありません</div>') + '</div>';
  } else {
    dayEl.innerHTML = '<div class="empty-note cal-hint">日付をタップするとその日の明細が出ます</div>';
  }
}

document.querySelectorAll('#history-mode .type-btn').forEach((b) => {
  b.addEventListener('click', () => setHistoryMode(b.dataset.mode));
});
document.getElementById('cal-prev').addEventListener('click', () => { calYm = ymAdd(calYm, -1); calDay = ''; renderHistory(); });
document.getElementById('cal-next').addEventListener('click', () => { calYm = ymAdd(calYm, 1); calDay = ''; renderHistory(); });

// ---------------------------------------------------------------------------
// 取引の詳細シート（どの一覧の行からでも開く）
// ---------------------------------------------------------------------------

function openDetail(t) {
  const same = store.txs.filter((x) => x.payee === t.payee && isExpense(x));
  const since = ymAdd(todayYm(), -11);
  const recent = same.filter((x) => x.ym >= since);
  const isIncome = t.type === '収入';
  const rows = [
    ['日付', t.date.slice(0, 4) + '年' + ymdLabel(t.date)],
    ['種別', t.type || '支出'],
    ['カテゴリ', t.category],
    ['決済手段', t.method || '—'],
  ];
  if (t.memo) rows.push(['メモ', t.memo]);
  const stats = same.length > 1
    ? '<div class="sheet-stats"><div><span class="k">このお店の合計</span><span class="v">' + yen(same.reduce((a, x) => a + x.amount, 0)) + '（' + same.length + '回）</span></div>' +
      '<div><span class="k">直近12か月</span><span class="v">' + yen(recent.reduce((a, x) => a + x.amount, 0)) + '（' + recent.length + '回・月平均 ' +
      yen(Math.round(recent.reduce((a, x) => a + x.amount, 0) / 12)) + '）</span></div>' +
      '<div><span class="k">初めて / 最後</span><span class="v">' + same[same.length - 1].date + ' / ' + same[0].date + '</span></div></div>'
    : '';

  document.getElementById('sheet-body').innerHTML =
    '<div class="sheet-payee">' + escapeHtml(t.payee) + '</div>' +
    '<div class="sheet-amount' + (isIncome ? ' income' : '') + '">' + (isIncome ? '+' : '') + yen(t.amount) + '</div>' +
    '<dl class="sheet-dl">' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + escapeHtml(v) + '</dd>').join('') + '</dl>' + stats +
    '<div class="sheet-actions">' +
    '<button class="secondary-btn" id="sheet-history">このお店の履歴</button>' +
    '<button class="secondary-btn" id="sheet-trend">月別の推移</button>' +
    '<button class="secondary-btn" id="sheet-cat">' + escapeHtml(t.category) + 'の今月</button></div>';
  document.getElementById('sheet').classList.remove('hidden');
  document.getElementById('sheet-history').onclick = () => { closeDetail(); openHistoryWith({ search: t.payee }); };
  document.getElementById('sheet-trend').onclick = () => {
    closeDetail();
    showView('analysis');
    document.getElementById('analysis-search').value = t.payee;
    document.getElementById('analysis-category').value = '';
    renderAnalysis();
  };
  document.getElementById('sheet-cat').onclick = () => { closeDetail(); openHistoryWith({ month: todayYm(), category: t.category, type: 'expense' }); };
  renderCategoryEditor(t); // features2.js
}

function closeDetail() {
  document.getElementById('sheet').classList.add('hidden');
}

document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-seq]');
  if (!row || e.target.closest('select, button.link-btn')) return;
  const t = store.bySeq && store.bySeq.get(Number(row.dataset.seq));
  if (t) openDetail(t);
});
document.getElementById('sheet').addEventListener('click', (e) => {
  if (e.target.id === 'sheet' || e.target.closest('#sheet-close')) closeDetail();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

// ---------------------------------------------------------------------------
// 分析: 収支と貯蓄率・固定費と変動費・年間レポート
// ---------------------------------------------------------------------------

// 毎月ほぼ決まって出ていくカテゴリ（固定費の目安）。定期払いの判定と合わせて使う
const FIXED_CATEGORIES = ['通信費', '保険', 'サブスク', '光熱費', '住居', '家賃', '住宅', '習い事', '教育', 'ローン', '税金'];

/** 収支（収入−支出）の棒。0を境に上（黒字）と下（赤字）に伸ばす */
function signedBarChart(el, series) {
  const W = Math.max(280, el.clientWidth || 340);
  const H = 150;
  const top = 10;
  const bottom = 20;
  const gutter = 44;
  const plotW = W - gutter;
  const plotH = H - top - bottom;
  const maxAbs = Math.max(1, ...series.map((s) => Math.abs(s.value)));
  const hasNeg = series.some((s) => s.value < 0);
  const hasPos = series.some((s) => s.value > 0);
  const zero = hasNeg && hasPos ? top + plotH / 2 : hasNeg ? top : top + plotH;
  const scale = (hasNeg && hasPos ? plotH / 2 : plotH) / maxAbs;
  const n = series.length;
  const slot = plotW / Math.max(1, n);
  const barW = Math.max(2, Math.min(28, slot - 2));
  const step = Math.ceil(n / 6);
  const parts = ['<line class="baseline" x1="0" x2="' + plotW + '" y1="' + zero + '" y2="' + zero + '"/>'];
  if (hasPos) parts.push('<text class="axis" x="' + W + '" y="' + (zero - maxAbs * scale + 3) + '" text-anchor="end">+' + yenShort(maxAbs) + '</text>');
  if (hasNeg) parts.push('<text class="axis" x="' + W + '" y="' + (zero + maxAbs * scale + 3) + '" text-anchor="end">-' + yenShort(maxAbs) + '</text>');
  series.forEach((s, i) => {
    const h = Math.abs(s.value) * scale;
    const x = slot * i + (slot - barW) / 2;
    if (h > 0) parts.push('<rect class="sbar ' + (s.value >= 0 ? 'pos' : 'neg') + '" x="' + x + '" y="' + (s.value >= 0 ? zero - h : zero) +
      '" width="' + barW + '" height="' + h + '" rx="' + Math.min(3, barW / 2) + '"/>');
    if (i % step === 0) {
      const [yy, mm] = s.key.split('-');
      parts.push('<text class="axis" x="' + (slot * i + slot / 2) + '" y="' + (H - 5) + '" text-anchor="middle">' +
        (i === 0 || mm === '01' ? yy.slice(2) + '/' + Number(mm) : Number(mm) + '月') + '</text>');
    }
    parts.push('<rect class="hit" data-i="' + i + '" x="' + slot * i + '" y="0" width="' + slot + '" height="' + H + '"/>');
  });
  el.innerHTML = '<div class="chart-tip hidden"></div><svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img">' + parts.join('') + '</svg>';
  const tip = el.querySelector('.chart-tip');
  el.querySelectorAll('.hit').forEach((r) => {
    const show = () => {
      const s = series[Number(r.dataset.i)];
      tip.textContent = ymLabel(s.key) + ' 収入 ' + yen(s.income) + ' − 支出 ' + yen(s.expense) + ' = ' + signedYen(s.value);
      tip.classList.remove('hidden');
      const tw = tip.offsetWidth;
      tip.style.left = Math.max(0, Math.min(W - tw, slot * Number(r.dataset.i) + slot / 2 - tw / 2)) + 'px';
    };
    r.addEventListener('pointerenter', show);
    r.addEventListener('click', show);
  });
}

/** 分析画面の追加カード。analysis.js の renderAnalysis の最後に呼ばれる */
function renderAnalysisExtras(yms) {
  const done = yms.filter((m) => m < todayYm());

  // 収支と貯蓄率（収入の記録がある期間だけ）
  const flowCard = document.getElementById('flow-card');
  // 今月は給与がまだ入っていないことが多く、途中の赤字に見えるので除く
  const flow = done.map((ym) => {
    const list = store.byMonth.get(ym) || [];
    const income = list.filter((t) => t.type === '収入').reduce((a, t) => a + t.amount, 0);
    const expense = list.filter(isExpense).reduce((a, t) => a + t.amount, 0);
    return { key: ym, income, expense, value: income - expense };
  });
  const withIncome = flow.filter((f) => f.income > 0);
  if (!withIncome.length) {
    flowCard.classList.add('hidden');
  } else {
    flowCard.classList.remove('hidden');
    signedBarChart(document.getElementById('flow-chart'), flow);
    const inc = withIncome.reduce((a, f) => a + f.income, 0);
    const exp = withIncome.reduce((a, f) => a + f.expense, 0);
    document.getElementById('flow-note').textContent = '貯蓄率 ' + Math.round(((inc - exp) / inc) * 100) + '%' +
      '（収入のある' + withIncome.length + 'か月の合計・今月を除く）· 月平均の黒字 ' + yen(Math.round((inc - exp) / withIncome.length)) +
      ' · 記録されている収入のみ';
  }

  // 固定費と変動費（今月を除く期間の月平均）
  const fixedCard = document.getElementById('fixed-card');
  if (!done.length) {
    fixedCard.classList.add('hidden');
  } else {
    fixedCard.classList.remove('hidden');
    const recurring = new Set(findRecurring(done[done.length - 1]).map((r) => r.payee));
    const isFixed = (t) => FIXED_CATEGORIES.includes(t.category) || recurring.has(t.payee);
    const tx = expensesIn(done);
    const fixed = tx.filter(isFixed);
    const fixedAvg = fixed.reduce((a, t) => a + t.amount, 0) / done.length;
    const varAvg = (tx.reduce((a, t) => a + t.amount, 0) / done.length) - fixedAvg;
    const total = fixedAvg + varAvg || 1;
    document.getElementById('fixed-tiles').innerHTML =
      '<div class="tile"><div class="tile-k">固定費 / 月</div><div class="tile-v">' + yen(Math.round(fixedAvg)) + '</div><div class="tile-s">' + Math.round(fixedAvg / total * 100) + '%</div></div>' +
      '<div class="tile"><div class="tile-k">変動費 / 月</div><div class="tile-v">' + yen(Math.round(varAvg)) + '</div><div class="tile-s">' + Math.round(varAvg / total * 100) + '%</div></div>' +
      '<div class="tile"><div class="tile-k">固定費 / 年</div><div class="tile-v">' + yen(Math.round(fixedAvg * 12)) + '</div><div class="tile-s">見直すと毎年効く</div></div>';
    const items = Array.from(groupSum(fixed, (t) => t.payee), ([name, v]) => ({
      name, amount: Math.round(v.amount / done.length), sub: '月平均',
    })).sort((a, b) => b.amount - a.amount).slice(0, 10);
    hbarList(document.getElementById('fixed-list'), items, {
      empty: '固定費は見つかりませんでした',
      onClick: (it) => openHistoryWith({ search: it.name, type: 'expense' }),
    });
  }

  renderYearReport();
  renderDataCheck(); // features2.js
}

let reportYear = '';

function renderYearReport() {
  const years = Array.from(new Set(Array.from(store.byMonth.keys()).map((ym) => ym.slice(0, 4)))).sort().reverse();
  const sel = document.getElementById('report-year');
  if (!reportYear || !years.includes(reportYear)) reportYear = years[0] || String(new Date().getFullYear());
  sel.innerHTML = years.map((y) => '<option value="' + y + '"' + (y === reportYear ? ' selected' : '') + '>' + y + '年</option>').join('');

  const months = Array.from({ length: 12 }, (_, i) => reportYear + '-' + String(i + 1).padStart(2, '0'));
  const tx = expensesIn(months);
  const cell = new Map();
  const catTotal = new Map();
  const monTotal = new Map();
  tx.forEach((t) => {
    const k = t.category + '|' + t.ym;
    cell.set(k, (cell.get(k) || 0) + t.amount);
    catTotal.set(t.category, (catTotal.get(t.category) || 0) + t.amount);
    monTotal.set(t.ym, (monTotal.get(t.ym) || 0) + t.amount);
  });
  const cats = Array.from(catTotal.keys()).sort((a, b) => catTotal.get(b) - catTotal.get(a));
  const max = Math.max(1, ...cell.values());
  const yearTotal = tx.reduce((a, t) => a + t.amount, 0);
  const activeMonths = months.filter((m) => monTotal.get(m)).length || 1;
  document.getElementById('report-note').textContent = '年間 ' + yen(yearTotal) + ' · 月平均 ' + yen(Math.round(yearTotal / activeMonths)) +
    '（記録のある' + activeMonths + 'か月）· 濃いほど多い・タップで明細';

  const head = '<tr><th class="sticky">カテゴリ</th>' + months.map((m) => '<th>' + Number(m.slice(5)) + '月</th>').join('') + '<th>合計</th></tr>';
  const body = cats.map((c) => '<tr><th class="sticky">' + escapeHtml(c) + '</th>' + months.map((m) => {
    const v = cell.get(c + '|' + m) || 0;
    const lv = v ? Math.min(4, Math.ceil((v / max) * 4)) : 0;
    return '<td class="lv' + lv + '" data-cat="' + escapeHtml(c) + '" data-ym="' + m + '">' + (v ? yenShort(v).replace('¥', '') : '') + '</td>';
  }).join('') + '<td class="total">' + yenShort(catTotal.get(c)).replace('¥', '') + '</td></tr>').join('');
  const foot = '<tr class="foot"><th class="sticky">合計</th>' + months.map((m) =>
    '<td>' + (monTotal.get(m) ? yenShort(monTotal.get(m)).replace('¥', '') : '') + '</td>').join('') +
    '<td class="total">' + yenShort(yearTotal).replace('¥', '') + '</td></tr>';
  const wrap = document.getElementById('report-table');
  wrap.innerHTML = cats.length ? '<table class="year-table"><thead>' + head + '</thead><tbody>' + body + foot + '</tbody></table>'
    : '<div class="empty-note">この年の支出はありません</div>';
  wrap.querySelectorAll('td[data-cat]').forEach((td) => {
    td.onclick = () => openHistoryWith({ month: td.dataset.ym, category: td.dataset.cat, type: 'expense' });
  });
  renderMedical(reportYear); // features2.js
}

document.getElementById('report-year').addEventListener('change', (e) => { reportYear = e.target.value; renderYearReport(); });
