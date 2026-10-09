/**
 * 分析（グラフ）とレビュー（月次・四半期）の画面。
 *
 * app.js の store（端末に持った全取引）だけを使い、通信はしない。
 * グラフは依存ライブラリを入れずに素のSVGで描く（ビルドステップを持たない方針のため）。
 *
 * レビューのコメントは決まった規則で出す（平均との差・定期払い・大きな買い物など）。
 * 文章での振り返りや「もっと安く買う方法」の提案は、月1回 Claude が Obsidian の
 * 月次ノート（tmhys/github_obsidian の 01_Log/03_Money/）に書く。
 */

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

/** 'YYYY-MM' の from〜to（含む）を古い順に並べる */
function monthRange(from, to) {
  const out = [];
  for (let ym = from; ym <= to; ym = ymAdd(ym, 1)) out.push(ym);
  return out;
}

function expensesIn(yms) {
  const out = [];
  yms.forEach((ym) => (store.byMonth.get(ym) || []).forEach((t) => { if (isExpense(t)) out.push(t); }));
  return out;
}

function groupSum(list, keyOf) {
  const m = new Map();
  list.forEach((t) => {
    const k = keyOf(t);
    const cur = m.get(k) || { amount: 0, count: 0 };
    cur.amount += t.amount;
    cur.count += 1;
    m.set(k, cur);
  });
  return m;
}

/** 軸ラベル用の短い金額（¥12万 / ¥8,500） */
function yenShort(n) {
  if (n >= 10000) return '¥' + (Math.round(n / 1000) / 10).toLocaleString('ja-JP') + '万';
  return yen(n);
}

function pct(n) {
  return (n > 0 ? '+' : '') + Math.round(n * 100) + '%';
}

function signedYen(n) {
  return (n > 0 ? '+' : '') + yen(n);
}

/** データがある最初の月（これより前は「0円だった月」ではなく「記録が無い月」） */
function firstDataYm() {
  const keys = Array.from(store.byMonth.keys());
  return keys.length ? keys[keys.length - 1] : todayYm();
}

// ---------------------------------------------------------------------------
// 棒グラフ（1系列・月別）
// ---------------------------------------------------------------------------

/**
 * @param el     描画先
 * @param series [{key, label, value}] 古い順
 * @param opts   {selected, onSelect(s), tip(s), avg}
 */
function barChart(el, series, opts) {
  opts = opts || {};
  const W = Math.max(280, el.clientWidth || 340);
  const H = 150;
  const top = 18;
  const bottom = 22;
  const plotH = H - top - bottom;
  const gutter = 40; // 右端は目盛りの金額用にあけておく（棒と重ねない）
  const plotW = W - gutter;
  const n = series.length;
  const slot = plotW / Math.max(n, 1);
  const barW = Math.max(2, Math.min(28, slot - 2)); // 隣の棒とは最低2pxあける
  const max = Math.max(1, ...series.map((s) => s.value), opts.avg || 0);
  const y = (v) => top + plotH - (v / max) * plotH;
  const step = Math.ceil(n / 6); // ラベルは6個程度まで

  const parts = [];
  // 目盛りは最大値と中間だけ。控えめに。
  [max, max / 2].forEach((v) => {
    parts.push('<line class="grid" x1="0" x2="' + plotW + '" y1="' + y(v) + '" y2="' + y(v) + '"/>');
    parts.push('<text class="axis" x="' + W + '" y="' + (y(v) + 3) + '" text-anchor="end">' + yenShort(v) + '</text>');
  });
  parts.push('<line class="baseline" x1="0" x2="' + plotW + '" y1="' + (top + plotH) + '" y2="' + (top + plotH) + '"/>');

  series.forEach((s, i) => {
    const cx = slot * i + slot / 2;
    const x = cx - barW / 2;
    const h = (s.value / max) * plotH;
    const yy = top + plotH - h;
    const r = Math.min(4, barW / 2, h);
    const cls = 'bar' + (s.key === opts.selected ? ' selected' : '');
    if (h > 0) {
      // 上だけ角を丸める（下は基線に接する）
      parts.push('<path class="' + cls + '" d="M' + x + ',' + (top + plotH) + 'V' + (yy + r) +
        'Q' + x + ',' + yy + ' ' + (x + r) + ',' + yy + 'H' + (x + barW - r) +
        'Q' + (x + barW) + ',' + yy + ' ' + (x + barW) + ',' + (yy + r) + 'V' + (top + plotH) + 'Z"/>');
    }
    if (i % step === 0 || i === n - 1 && n <= 12) {
      const [yy4, mm] = s.key.split('-');
      const label = (i === 0 || mm === '01') ? yy4.slice(2) + '/' + Number(mm) : Number(mm) + '月';
      parts.push('<text class="axis" x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle">' + label + '</text>');
    }
    // 当たり判定は棒より広く（列全体）
    parts.push('<rect class="hit" data-i="' + i + '" x="' + (slot * i) + '" y="0" width="' + slot + '" height="' + H + '"/>');
  });

  if (opts.avg) {
    parts.push('<line class="avg" x1="0" x2="' + plotW + '" y1="' + y(opts.avg) + '" y2="' + y(opts.avg) + '"/>');
  }

  el.innerHTML = '<div class="chart-tip hidden"></div>' +
    '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img">' + parts.join('') + '</svg>';

  const tipEl = el.querySelector('.chart-tip');
  const showTip = (i) => {
    const s = series[i];
    tipEl.textContent = opts.tip ? opts.tip(s) : s.label + ' ' + yen(s.value);
    tipEl.classList.remove('hidden');
    const cx = slot * i + slot / 2;
    const tw = tipEl.offsetWidth;
    tipEl.style.left = Math.max(0, Math.min(W - tw, cx - tw / 2)) + 'px';
  };
  el.querySelectorAll('.hit').forEach((r) => {
    const i = Number(r.dataset.i);
    r.addEventListener('pointerenter', () => showTip(i));
    r.addEventListener('click', () => {
      showTip(i);
      if (opts.onSelect) opts.onSelect(series[i]);
    });
  });
  el.querySelector('svg').addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') tipEl.classList.add('hidden');
  });
}

/** 横棒の一覧（カテゴリ別・店別）。行をタップすると onClick(item) */
function hbarList(el, items, opts) {
  opts = opts || {};
  if (!items.length) {
    el.innerHTML = '<div class="empty-note">' + (opts.empty || 'データがありません') + '</div>';
    return;
  }
  const max = Math.max(...items.map((it) => it.amount), 1);
  el.innerHTML = items.map((it, i) =>
    '<button class="cat-bar-row" data-i="' + i + '">' +
    '<div class="cat-bar-head"><span class="name">' + escapeHtml(it.name) + '</span>' +
    '<span class="amt">' + (it.sub ? '<span class="sub">' + escapeHtml(it.sub) + '</span> ' : '') + yen(it.amount) + '</span></div>' +
    '<div class="cat-bar-track"><div class="cat-bar-fill" style="width:' + Math.round((it.amount / max) * 100) + '%"></div></div>' +
    '</button>'
  ).join('');
  el.querySelectorAll('.cat-bar-row').forEach((b) => {
    b.onclick = () => opts.onClick && opts.onClick(items[Number(b.dataset.i)]);
  });
}

// ---------------------------------------------------------------------------
// 分析
// ---------------------------------------------------------------------------

let analysisYm = ''; // グラフで選んでいる月

function populateAnalysisOptions() {
  const sel = document.getElementById('analysis-category');
  const cats = Array.from(new Set(store.txs.filter(isExpense).map((t) => t.category)))
    .sort((a, b) => a.localeCompare(b, 'ja'));
  fillSelect(sel, cats, 'すべてのカテゴリ');
}

function renderAnalysis() {
  const root = document.getElementById('analysis-body');
  if (!store.txs) {
    root.classList.add('hidden');
    document.getElementById('analysis-empty').classList.remove('hidden');
    return;
  }
  root.classList.remove('hidden');
  document.getElementById('analysis-empty').classList.add('hidden');
  populateAnalysisOptions();

  const range = document.getElementById('analysis-range').value;
  const cat = document.getElementById('analysis-category').value;
  const q = document.getElementById('analysis-search').value.trim().toLowerCase();
  const to = todayYm();
  const first = firstDataYm();
  let from = range === 'all' ? first : ymAdd(to, -(Number(range) - 1));
  if (from < first) from = first;
  const yms = monthRange(from, to);
  if (!analysisYm || analysisYm < from || analysisYm > to) analysisYm = to;

  const match = (t) => (!cat || t.category === cat) && (!q || t.search.includes(q));
  const all = expensesIn(yms).filter(match);
  const byYm = groupSum(all, (t) => t.ym);
  const series = yms.map((ym) => ({ key: ym, label: ym, value: (byYm.get(ym) || { amount: 0 }).amount }));
  const total = all.reduce((a, t) => a + t.amount, 0);
  // 平均は今月（途中）を除いて出す。途中の月を入れると平均が下がって見える
  const done = series.filter((s) => s.key < to);
  const avg = done.length ? Math.round(done.reduce((a, s) => a + s.value, 0) / done.length) : 0;

  document.getElementById('analysis-trend-title').textContent =
    '月別の支出' + (cat ? '（' + cat + '）' : '') + (q ? '「' + q + '」' : '');
  document.getElementById('analysis-trend-note').textContent =
    '合計 ' + yen(total) + (avg ? ' · 月平均 ' + yen(avg) + '（今月を除く・点線）' : '');
  barChart(document.getElementById('analysis-trend'), series, {
    selected: analysisYm,
    avg,
    tip: (s) => ymLabel(s.key) + ' ' + yen(s.value),
    onSelect: (s) => { analysisYm = s.key; renderAnalysisDetail(match, avg, yms); },
  });
  renderAnalysisDetail(match, avg, yms);
}

/** 選んだ月のカテゴリ別・店別 */
function renderAnalysisDetail(match, avg, yms) {
  const ym = analysisYm;
  const monthTx = expensesIn([ym]).filter(match);
  const total = monthTx.reduce((a, t) => a + t.amount, 0);
  document.getElementById('analysis-month-title').textContent = ymLabel(ym) + ' の内訳';
  document.getElementById('analysis-month-note').textContent = yen(total) +
    (avg ? '（月平均との差 ' + signedYen(total - avg) + '）' : '');
  document.getElementById('analysis-open-history').onclick = () => openHistoryWith({
    month: ym, type: 'expense',
    category: document.getElementById('analysis-category').value,
    search: document.getElementById('analysis-search').value.trim(),
  });

  // カテゴリ別: 期間の月平均（今月を除く）と比べる
  const doneYms = yms.filter((m) => m < todayYm() && m !== ym);
  const base = groupSum(expensesIn(doneYms).filter(match), (t) => t.category);
  const cats = Array.from(groupSum(monthTx, (t) => t.category), ([name, v]) => {
    const b = doneYms.length ? (base.get(name) || { amount: 0 }).amount / doneYms.length : 0;
    return { name, amount: v.amount, sub: doneYms.length ? '平均比 ' + signedYen(Math.round(v.amount - b)) : '' };
  }).sort((a, b) => b.amount - a.amount);
  hbarList(document.getElementById('analysis-categories'), cats, {
    empty: 'この月の支出はありません',
    onClick: (it) => openHistoryWith({ month: ym, category: it.name, type: 'expense' }),
  });

  // 店別（期間全体）。回数と1回あたりも出す（少額を何度も、を見つけやすく）
  const shops = Array.from(groupSum(expensesIn(yms).filter(match), (t) => t.payee), ([name, v]) => ({
    name, amount: v.amount, sub: v.count + '回 · 平均' + yen(Math.round(v.amount / v.count)),
  })).sort((a, b) => b.amount - a.amount).slice(0, 15);
  document.getElementById('analysis-shops-title').textContent =
    'よく使うお店（' + ymLabel(yms[0]) + '〜）';
  hbarList(document.getElementById('analysis-shops'), shops, {
    onClick: (it) => openHistoryWith({ search: it.name, from: yms[0] + '-01', type: 'expense' }),
  });

  // 曜日別（期間全体の1日あたり平均）。週末にかさむかどうか
  const dowSum = [0, 0, 0, 0, 0, 0, 0];
  expensesIn(yms).filter(match).forEach((t) => {
    const [y, m, d] = t.date.split('-').map(Number);
    dowSum[new Date(y, m - 1, d).getDay()] += t.amount;
  });
  const weeks = Math.max(1, yms.length * 30.4 / 7);
  const order = [1, 2, 3, 4, 5, 6, 0];
  hbarList(document.getElementById('analysis-dow'),
    order.map((i) => ({ name: WEEKDAYS[i] + '曜', amount: Math.round(dowSum[i] / weeks) })), {});
}

['analysis-range', 'analysis-category'].forEach((id) => {
  document.getElementById(id).addEventListener('change', renderAnalysis);
});
let analysisTimer = null;
document.getElementById('analysis-search').addEventListener('input', () => {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(renderAnalysis, 200);
});

// ---------------------------------------------------------------------------
// レビュー（月次・四半期）
// ---------------------------------------------------------------------------

// コンビニ・手数料など、置き換えや見直しの余地が出やすい支払いの目印
const CONVENIENCE_RE = /セブン|ｾﾌﾞﾝ|ローソン|ﾛ-ｿﾝ|ﾛｰｿﾝ|ファミリーマート|ﾌｱﾐﾘ-ﾏ-ﾄ|ﾌｧﾐﾘｰﾏｰﾄ|ファミマ|ミニストップ|ﾐﾆｽﾄｯﾌﾟ|デイリーヤマザキ|ニューデイズ|NEWDAYS/i;
const FEE_RE = /手数料|ATM|ＡＴＭ|延滞|利息/;

const review = { mode: 'month', key: '' };

function quarterOf(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y + '-Q' + Math.ceil(m / 3);
}

function quarterMonths(q) {
  const [y, n] = q.split('-Q').map(Number);
  const first = y + '-' + String((n - 1) * 3 + 1).padStart(2, '0');
  return [first, ymAdd(first, 1), ymAdd(first, 2)];
}

function shiftPeriod(key, mode, delta) {
  return mode === 'month' ? ymAdd(key, delta) : quarterOf(ymAdd(quarterMonths(key)[0], delta * 3));
}

function periodLabel(key, mode) {
  if (mode === 'month') return ymLabel(key);
  const [y, n] = key.split('-Q');
  return y + '年 第' + n + '四半期（' + ((n - 1) * 3 + 1) + '〜' + (n * 3) + '月）';
}

function periodMonths(key, mode) {
  return mode === 'month' ? [key] : quarterMonths(key);
}

/** 既定の対象: 月次は先月、四半期は直近で終わった四半期 */
function defaultPeriod(mode) {
  const last = ymAdd(todayYm(), -1);
  if (mode === 'month') return last;
  const q = quarterOf(todayYm());
  return quarterMonths(q)[2] <= last ? q : shiftPeriod(q, 'quarter', -1);
}

/**
 * 比べる相手（ベースライン）: 月次は直前6か月、四半期は直前4四半期の平均。
 * 記録が始まる前の期間は数えない（0円の月として平均を下げないため）。
 */
function baselinePeriods(key, mode) {
  const n = mode === 'month' ? 6 : 4;
  const first = firstDataYm();
  const out = [];
  for (let i = 1; i <= n; i++) {
    const k = shiftPeriod(key, mode, -i);
    if (periodMonths(k, mode)[0] >= first) out.push(k);
  }
  return out;
}

/** 毎月のように払っている相手（サブスク・固定費の候補）を見つける */
function findRecurring(endYm) {
  const yms = monthRange(ymAdd(endYm, -3), endYm); // 直近4か月
  const per = new Map(); // payee -> Map(ym -> amount)
  expensesIn(yms).forEach((t) => {
    if (!per.has(t.payee)) per.set(t.payee, new Map());
    const m = per.get(t.payee);
    m.set(t.ym, (m.get(t.ym) || 0) + t.amount);
  });
  const out = [];
  per.forEach((m, payee) => {
    if (m.size < 3) return;
    const vals = Array.from(m.values());
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    const spread = Math.max(...vals) - Math.min(...vals);
    // 金額がほぼ一定（ばらつき2割以内）のものだけ。スーパーのような変動する店を除く
    if (spread > mean * 0.2) return;
    const before = expensesIn(monthRange(ymAdd(endYm, -12), ymAdd(endYm, -4))).some((t) => t.payee === payee);
    out.push({ payee, monthly: Math.round(mean), isNew: !before, inLast: m.has(endYm) });
  });
  return out.sort((a, b) => b.monthly - a.monthly);
}

function computeReview(key, mode) {
  const yms = periodMonths(key, mode);
  const cur = expensesIn(yms);
  const total = cur.reduce((a, t) => a + t.amount, 0);
  const income = yms.flatMap((ym) => (store.byMonth.get(ym) || []).filter((t) => t.type === '収入'))
    .reduce((a, t) => a + t.amount, 0);
  const prevKey = shiftPeriod(key, mode, -1);
  const prevTotal = expensesIn(periodMonths(prevKey, mode)).reduce((a, t) => a + t.amount, 0);

  const bases = baselinePeriods(key, mode);
  const baseTx = expensesIn(bases.flatMap((k) => periodMonths(k, mode)));
  const baseAvg = bases.length ? baseTx.reduce((a, t) => a + t.amount, 0) / bases.length : 0;

  const catCur = groupSum(cur, (t) => t.category);
  const catBase = groupSum(baseTx, (t) => t.category);
  const categories = Array.from(new Set([...catCur.keys(), ...catBase.keys()])).map((name) => {
    const amount = (catCur.get(name) || { amount: 0 }).amount;
    const avg = bases.length ? (catBase.get(name) || { amount: 0 }).amount / bases.length : 0;
    return { name, amount, avg: Math.round(avg), diff: Math.round(amount - avg) };
  }).filter((c) => c.amount || c.avg >= 1000).sort((a, b) => b.amount - a.amount);

  const comments = [];
  const add = (kind, text, action) => comments.push({ kind, text, action });
  const scale = yms.length; // 四半期は閾値を3倍にする

  if (!cur.length) {
    add('info', 'この期間の支出データはありません。');
    return { yms, total, income, prevTotal, baseAvg, bases, categories, comments, shops: [], big: [] };
  }

  // 1. 全体
  if (bases.length) {
    const d = total - baseAvg;
    const r = baseAvg ? d / baseAvg : 0;
    if (r >= 0.15) add('warn', '支出が平均より ' + signedYen(Math.round(d)) + '（' + pct(r) + '）多めです。下の「増えたカテゴリ」が主な理由です。');
    else if (r <= -0.1) add('good', '支出が平均より ' + yen(Math.round(-d)) + '（' + pct(r) + '）少なく抑えられています。');
    else add('info', '支出は平均並みです（' + signedYen(Math.round(d)) + '）。');
  }
  if (income) {
    add(income >= total ? 'good' : 'info', '収入 ' + yen(income) + ' · 収支 ' + signedYen(income - total) + '（記録されている収入のみ）');
  }

  // 2. 増えた・減ったカテゴリ（平均との差が大きいもの）
  const curByCatPayee = (name) => Array.from(groupSum(cur.filter((t) => t.category === name), (t) => t.payee),
    ([p, v]) => ({ p, amount: v.amount })).sort((a, b) => b.amount - a.amount).slice(0, 3);
  if (bases.length) {
    categories
      .filter((c) => c.diff >= 3000 * scale && (c.avg === 0 || c.diff / c.avg >= 0.3) && c.name !== '未分類')
      .sort((a, b) => b.diff - a.diff).slice(0, 3)
      .forEach((c) => {
        const tops = curByCatPayee(c.name).map((x) => x.p + ' ' + yen(x.amount)).join('、');
        add('warn', c.name + 'が平均より ' + signedYen(c.diff) + (c.avg ? '（' + pct(c.diff / c.avg) + '）' : '（普段はほぼ無し）') +
          '。主な支払い: ' + tops, { category: c.name });
      });
    categories
      .filter((c) => -c.diff >= 3000 * scale && c.avg && -c.diff / c.avg >= 0.3 && c.name !== '未分類')
      .sort((a, b) => a.diff - b.diff).slice(0, 2)
      .forEach((c) => add('good', c.name + 'は平均より ' + yen(-c.diff) + ' 少なめでした（' + pct(c.diff / c.avg) + '）。'));
  }

  // 3. 大きな買い物
  const big = cur.filter((t) => t.amount >= 10000 * (mode === 'month' ? 1 : 1.5))
    .sort((a, b) => b.amount - a.amount).slice(0, 5);
  if (big.length) {
    add('info', '大きな支払い ' + big.length + '件・計 ' + yen(big.reduce((a, t) => a + t.amount, 0)) +
      '（' + big.slice(0, 3).map((t) => t.payee + ' ' + yen(t.amount)).join('、') + '）');
  }

  // 4. 定期的な支払い（サブスク・固定費）
  const rec = findRecurring(yms[yms.length - 1]).filter((r) => r.inLast);
  if (rec.length) {
    const sum = rec.reduce((a, r) => a + r.monthly, 0);
    add('idea', '毎月ほぼ同額の支払いが ' + rec.length + '件・月 ' + yen(sum) + '（年 ' + yen(sum * 12) + '）あります: ' +
      rec.slice(0, 5).map((r) => r.payee + ' ' + yen(r.monthly)).join('、') +
      '。使っていないもの・年払いや安いプランにできるものがないか見直す価値があります。');
    rec.filter((r) => r.isNew).slice(0, 3).forEach((r) =>
      add('warn', '最近始まった定期払い: ' + r.payee + '（月 ' + yen(r.monthly) + '）。続ける予定か確認を。', { search: r.payee }));
  }

  // 5. コンビニ
  const conv = cur.filter((t) => CONVENIENCE_RE.test(t.payee));
  if (conv.length >= 8 * scale) {
    const amt = conv.reduce((a, t) => a + t.amount, 0);
    add('idea', 'コンビニ ' + conv.length + '回・計 ' + yen(amt) + '（1回平均 ' + yen(Math.round(amt / conv.length)) +
      '）。飲み物・日用品はスーパーやドラッグストアでまとめ買いすると2〜3割安くなることが多いです。');
  }

  // 6. 同じ店で少額を何度も
  const freq = Array.from(groupSum(cur, (t) => t.payee), ([p, v]) => ({ p, ...v }))
    .filter((x) => x.count >= 6 * scale && x.amount / x.count < 1500 && !CONVENIENCE_RE.test(x.p))
    .sort((a, b) => b.count - a.count).slice(0, 2);
  freq.forEach((x) => add('idea', x.p + ' で ' + x.count + '回・計 ' + yen(x.amount) +
    '（少額を何度も）。回数を減らす・まとめるだけで効きやすい支出です。', { search: x.p }));

  // 7. 手数料
  const fees = cur.filter((t) => FEE_RE.test(t.payee));
  if (fees.length) {
    add('warn', '手数料・利息の支払いが ' + fees.length + '件・計 ' + yen(fees.reduce((a, t) => a + t.amount, 0)) +
      '。避けられるものがないか確認を。', { search: '手数料' });
  }

  // 8. 未分類
  const uncat = cur.filter((t) => t.category === '未分類');
  if (uncat.length) {
    add('info', '未分類が ' + uncat.length + '件・' + yen(uncat.reduce((a, t) => a + t.amount, 0)) +
      ' あります。分類するとレビューの精度が上がります。', { category: '未分類' });
  }

  const shops = Array.from(groupSum(cur, (t) => t.payee), ([name, v]) => ({
    name, amount: v.amount, sub: v.count + '回',
  })).sort((a, b) => b.amount - a.amount).slice(0, 10);

  return { yms, total, income, prevTotal, baseAvg, bases, categories, comments, shops, big };
}

const COMMENT_ICON = { warn: '⚠', good: '✓', idea: '💡', info: '・' };
const COMMENT_LABEL = { warn: '注意', good: '良い点', idea: '見直し', info: '' };

function renderReview() {
  if (!review.key) review.key = defaultPeriod(review.mode);
  document.querySelectorAll('#review-mode .type-btn').forEach((b) => b.classList.toggle('on', b.dataset.mode === review.mode));
  document.getElementById('review-label').textContent = periodLabel(review.key, review.mode);
  document.getElementById('review-next').disabled = periodMonths(review.key, review.mode)[0] > todayYm();

  const body = document.getElementById('review-body');
  if (!store.txs) {
    body.innerHTML = '<div class="card"><div class="empty-note">' + (store.inflight ? '読み込み中…' : 'データがありません') + '</div></div>';
    return;
  }
  const r = computeReview(review.key, review.mode);
  const unit = review.mode === 'month' ? '月' : '四半期';
  const ongoing = r.yms[r.yms.length - 1] >= todayYm();

  const parts = [];
  parts.push('<section class="card total-card"><div class="total-label">支出合計' + (ongoing ? '（集計中）' : '') + '</div>' +
    '<div class="total-amount">' + yen(r.total) + '</div>' +
    '<div class="review-compare">' +
    '<span>前' + unit + ' ' + yen(r.prevTotal) + '（' + signedYen(r.total - r.prevTotal) + '）</span>' +
    (r.bases.length ? '<span>直近' + r.bases.length + unit + '平均 ' + yen(Math.round(r.baseAvg)) + '（' + signedYen(Math.round(r.total - r.baseAvg)) + '）</span>' : '') +
    '</div></section>');

  parts.push('<section class="card"><div class="card-title">コメント</div><div class="review-comments">' +
    r.comments.map((c, i) =>
      '<div class="review-comment ' + c.kind + '"><span class="icon" aria-label="' + COMMENT_LABEL[c.kind] + '">' + COMMENT_ICON[c.kind] + '</span>' +
      '<span class="text">' + escapeHtml(c.text) +
      (c.action ? ' <button class="link-btn" data-c="' + i + '">履歴で見る</button>' : '') + '</span></div>'
    ).join('') + '</div>' +
    '<div class="review-foot">文章での振り返りと「もっと安く買う方法」の提案は、毎月1日に Claude が Obsidian の月次ノート（01_Log/03_Money）に書きます。</div></section>');

  parts.push('<section class="card"><div class="card-title">カテゴリ別（平均との差）</div>' +
    '<table class="review-table"><thead><tr><th>カテゴリ</th><th>今' + unit + '</th><th>平均</th><th>差</th></tr></thead><tbody>' +
    r.categories.map((c) =>
      '<tr data-cat="' + escapeHtml(c.name) + '"><td>' + escapeHtml(c.name) + '</td><td>' + yen(c.amount) + '</td><td>' +
      (r.bases.length ? yen(c.avg) : '—') + '</td><td class="' + (r.bases.length && c.diff >= 3000 ? 'up' : r.bases.length && c.diff <= -3000 ? 'down' : '') + '">' +
      (r.bases.length ? signedYen(c.diff) : '—') + '</td></tr>'
    ).join('') + '</tbody></table></section>');

  parts.push('<section class="card"><div class="card-title">支払いの多かったお店</div><div id="review-shops" class="category-bars"></div></section>');
  body.innerHTML = parts.join('');

  const from = r.yms[0] + '-01';
  const lastYm = r.yms[r.yms.length - 1];
  const to = lastYm + '-' + String(daysInMonth(lastYm)).padStart(2, '0');
  body.querySelectorAll('.review-comment .link-btn').forEach((b) => {
    const a = r.comments[Number(b.dataset.c)].action;
    b.onclick = () => openHistoryWith(Object.assign({ from, to, type: 'expense' }, a));
  });
  body.querySelectorAll('.review-table tbody tr').forEach((tr) => {
    tr.onclick = () => openHistoryWith({ from, to, category: tr.dataset.cat, type: 'expense' });
  });
  hbarList(document.getElementById('review-shops'), r.shops, {
    onClick: (it) => openHistoryWith({ from, to, search: it.name, type: 'expense' }),
  });
}

document.querySelectorAll('#review-mode .type-btn').forEach((b) => {
  b.addEventListener('click', () => {
    if (review.mode === b.dataset.mode) return;
    review.mode = b.dataset.mode;
    review.key = defaultPeriod(review.mode);
    renderReview();
  });
});
document.getElementById('review-prev').addEventListener('click', () => { review.key = shiftPeriod(review.key, review.mode, -1); renderReview(); });
document.getElementById('review-next').addEventListener('click', () => { review.key = shiftPeriod(review.key, review.mode, 1); renderReview(); });
