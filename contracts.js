/**
 * 定期支払い（契約一覧）と、光熱費など「変動するが必須の固定費」の推移。
 *
 * 契約は取引から自動で見つける:
 *   - 毎月: 支払いの間隔の中央値が 20〜45日（月1〜2回まで。スーパーのような店は除く）
 *   - 年1回: 間隔の中央値が 300〜430日（NHK・損保・JAF の年払いなど）
 *   サブスク・保険・通信・光熱費などのカテゴリは金額が変わっても契約とみなす
 *   （ガス代は毎月違う、DAZN は途中で値上がりした）。それ以外のカテゴリは
 *   毎月・金額がほぼ同じ（直近4回が±5%）のものだけ。年1回は契約らしいカテゴリに限る
 *   （実データで、ガソリンスタンドや年に2回だけ同じ物を買った店を拾ってしまったため）。
 *
 * 人が直した分（名前・区分・周期・解約済み・対象外・明細に出ない契約）は gas の
 * シート「定期支払い」にあり、page=all の contracts で届く（Contracts.gs）。
 */

const CONTRACT_KINDS = ['住居', 'ローン', '保険', '光熱費', '通信', '習い事・教育', 'サブスク', '会費・年会費', '税金', 'その他'];
// 毎月の金額が変わるのが普通の区分（推移を別に見せる）
const VARIABLE_KINDS = ['光熱費'];
// このカテゴリなら金額が変わっても契約とみなす
const CONTRACT_CATEGORIES = /サブスク|保険|通信|光熱|電気|ガス|水道|住居|家賃|住宅|ローン|習い事|教育|会費|税/;

function kindOfCategory(cat) {
  const c = String(cat || '');
  if (/住居|家賃|住宅|管理費/.test(c)) return '住居';
  if (/ローン/.test(c)) return 'ローン';
  if (/保険/.test(c)) return '保険';
  if (/光熱|電気|ガス|水道/.test(c)) return '光熱費';
  if (/通信/.test(c)) return '通信';
  if (/習い事|教育|学費/.test(c)) return '習い事・教育';
  if (/サブスク/.test(c)) return 'サブスク';
  if (/会費/.test(c)) return '会費・年会費';
  if (/税/.test(c)) return '税金';
  return 'その他';
}

function dayNum(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 864e5);
}

function ymdOfDayNum(n) {
  const d = new Date(n * 864e5);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/** 'YYYY-MM-DD' に n か月足す（月末を越えたら月末に寄せる） */
function addMonthsYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const ym = ymAdd(y + '-' + String(m).padStart(2, '0'), n);
  return ym + '-' + String(Math.min(d, daysInMonth(ym))).padStart(2, '0');
}

function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

function cycleOfIntervals(iv) {
  const m = median(iv.slice(-6));
  if (m >= 20 && m <= 45) return 'monthly';
  if (m >= 300 && m <= 430) return 'annual';
  return '';
}

/** 支払日の指定（毎月「27」・毎年「6/30」）から、今日以降で最初の日 */
function nextFromDay(day, cycle, today) {
  if (!day) return '';
  const t = today;
  if (cycle === 'annual') {
    const m = String(day).match(/(\d{1,2})\s*[\/月-]\s*(\d{1,2})/);
    if (!m) return '';
    let y = Number(t.slice(0, 4));
    const mk = (yy) => yy + '-' + String(m[1]).padStart(2, '0') + '-' + String(Math.min(Number(m[2]), daysInMonth(yy + '-' + String(m[1]).padStart(2, '0')))).padStart(2, '0');
    return mk(y) >= t ? mk(y) : mk(y + 1);
  }
  const dd = Number(String(day).match(/\d{1,2}/));
  if (!dd) return '';
  const ym = t.slice(0, 7);
  const cand = ym + '-' + String(Math.min(dd, daysInMonth(ym))).padStart(2, '0');
  if (cand >= t) return cand;
  const nx = ymAdd(ym, 1);
  return nx + '-' + String(Math.min(dd, daysInMonth(nx))).padStart(2, '0');
}

/**
 * 支払いの列から契約1件を組み立てる。
 * @param payments 取引（日付の新しい順でも古い順でもよい）
 * @param o {key, name, kind, cycle, amount, day, status, memo, override, manual}
 */
function buildContract(payments, o, today) {
  const pays = payments.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // 新しい順
  const asc = pays.slice().reverse();
  const iv = [];
  for (let i = 1; i < asc.length; i++) iv.push(dayNum(asc[i].date) - dayNum(asc[i - 1].date));
  const cycle = o.cycle || cycleOfIntervals(iv) || (o.manual ? 'monthly' : '');
  const kind = o.kind || kindOfCategory(pays[0] ? pays[0].category : '');
  const last = pays[0] || null;
  const lastAmount = last ? last.amount : (o.amount || 0);
  const prevAmount = pays[1] ? pays[1].amount : 0;
  // 毎月の額が変わるのが普通なのは光熱費だけ。サブスクの値上がり（DAZN 980→2,600）は
  // 「変動」ではなく値上がりとして見せる
  const variable = VARIABLE_KINDS.includes(kind);

  let monthly;
  if (!last) monthly = cycle === 'annual' ? (o.amount || 0) / 12 : (o.amount || 0);
  else if (cycle === 'annual') monthly = lastAmount / 12;
  else if (variable) monthly = pays.slice(0, 12).reduce((a, p) => a + p.amount, 0) / Math.min(12, pays.length);
  else monthly = lastAmount;

  let next = '';
  if (o.day) next = nextFromDay(o.day, cycle, today);
  else if (last && cycle) next = addMonthsYmd(last.date, cycle === 'annual' ? 12 : 1);

  const since = last ? dayNum(today) - dayNum(last.date) : 0;
  const stopped = !!last && o.status !== '解約済み' && since > (cycle === 'annual' ? 400 : 50);
  // 値段の変化: 直前の回ではなく「最後に金額が変わった時点」と比べる（2か月続けて新しい
  // 金額だと、直前の回とは同じになって見逃すため）。変わったのが直近120日以内のものだけ
  let priceChange = null;
  if (!variable && last) {
    const differs = (a) => Math.abs(a - lastAmount) >= Math.max(50, a * 0.05);
    const k = pays.findIndex((p) => differs(p.amount));
    if (k > 0 && dayNum(today) - dayNum(pays[k - 1].date) <= 120) {
      priceChange = { from: pays[k].amount, to: lastAmount, since: pays[k - 1].date };
    }
  }
  const first = asc[0];

  return {
    key: o.key,
    name: o.name || o.key,
    kind,
    cycle,
    variable,
    payments: pays,
    last,
    lastAmount,
    monthly: Math.round(monthly),
    yearly: Math.round(monthly * 12),
    next,
    stopped,
    priceChange,
    isNew: !!first && pays.length >= 2 && dayNum(today) - dayNum(first.date) <= 100,
    status: o.status || '契約中',
    memo: o.memo || '',
    override: !!o.override,
    manual: !!o.manual && !last,
    manualAmount: o.amount || 0,
    day: o.day || '',
  };
}

/** 取引から契約を自動で見つける（人の手直し前） */
function detectContracts(txs, today) {
  const groups = new Map();
  txs.forEach((t) => {
    if (!isExpense(t) || t.payee === '楽天Edy 月次合計') return;
    if (!groups.has(t.payee)) groups.set(t.payee, []);
    groups.get(t.payee).push(t);
  });
  const out = [];
  groups.forEach((pays, payee) => {
    if (pays.length < 2) return;
    const months = new Set(pays.map((p) => p.ym));
    if (pays.length > months.size * 2) return; // 月に3回以上行く店は契約ではない
    const asc = pays.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const iv = [];
    for (let i = 1; i < asc.length; i++) iv.push(dayNum(asc[i].date) - dayNum(asc[i - 1].date));
    const cycle = cycleOfIntervals(iv);
    if (!cycle) return;
    if (cycle === 'monthly' && pays.length < 3) return;
    const lastDate = asc[asc.length - 1].date;
    const since = dayNum(today) - dayNum(lastDate);
    if (since > (cycle === 'annual' ? 760 : 120)) return; // ずっと前に終わったもの
    const fixedCat = CONTRACT_CATEGORIES.test(asc[asc.length - 1].category);
    if (!fixedCat) {
      // 契約らしくないカテゴリは、毎月・ほぼ同額（±5%）が4回以上続くものだけ。
      // ガソリンスタンドや月1回のレストラン、たまたま年に2回買った物を除く
      if (cycle !== 'monthly' || asc.length < 4) return;
      const recent = asc.slice(-4).map((p) => p.amount);
      const m = median(recent);
      if (recent.some((a) => Math.abs(a - m) > m * 0.05)) return;
    }
    out.push(buildContract(pays, { key: payee, cycle }, today));
  });
  return out;
}

/** 自動で見つけたものに、人の手直し（シート「定期支払い」）を重ねる */
function resolveContracts(txs, overrides, today) {
  const auto = detectContracts(txs, today);
  const hidden = [];
  const result = [];
  const absorbed = new Set();
  (overrides || []).forEach((o) => {
    const key = norm(o.key);
    if (!key) return;
    auto.forEach((c) => { if (norm(c.key).includes(key)) absorbed.add(c); });
    if (o.status === '対象外') { hidden.push(o); return; }
    const pays = txs.filter((t) => isExpense(t) && norm(t.payee).includes(key));
    const cycle = o.cycle === '毎年' ? 'annual' : o.cycle === '毎月' ? 'monthly' : '';
    result.push(buildContract(pays, Object.assign({}, o, { cycle, override: true, manual: !pays.length }), today));
  });
  auto.forEach((c) => { if (!absorbed.has(c)) result.push(c); });
  return { contracts: result.filter((c) => c.cycle || c.manual), hidden };
}

// ---------------------------------------------------------------------------
// 画面
// ---------------------------------------------------------------------------

function currentContracts() {
  if (!store.txs) return { contracts: [], hidden: [] };
  return resolveContracts(store.txs, store.contracts || [], todayYmd());
}

function cycleLabel(c) {
  return c.cycle === 'annual' ? '年1回' : '毎月';
}

function contractAmountHtml(c) {
  if (c.cycle === 'annual') return '<div class="row-amt">' + yen(c.lastAmount) + '<span class="per">/年</span></div>';
  return '<div class="row-amt">' + (c.variable ? '約' : '') + yen(c.monthly) + '<span class="per">/月</span></div>';
}

function contractRowHtml(c, i) {
  const flags = [];
  if (c.stopped) flags.push('<span class="chip uncat">止まっている？</span>');
  if (c.priceChange) flags.push('<span class="chip ' + (c.priceChange.to > c.priceChange.from ? 'uncat' : '') + '">' +
    (c.priceChange.to > c.priceChange.from ? '値上がり ' : '値下がり ') + yen(c.priceChange.from) + '→' + yen(c.priceChange.to) + '</span>');
  if (c.isNew) flags.push('<span class="chip">最近始まった</span>');
  if (c.manual) flags.push('<span class="chip other">明細なし</span>');
  const lastTxt = c.last ? '最終 ' + c.last.date.slice(5).replace('-', '/') + ' ' + yen(c.last.amount) : (c.day ? '支払日 ' + c.day : '');
  return '<div class="history-row contract-row" data-ci="' + i + '"><div class="row-main"><div class="row-payee">' + escapeHtml(c.name) + '</div>' +
    '<div class="row-sub"><span class="chip other">' + cycleLabel(c) + '</span>' + escapeHtml(lastTxt) + '</div>' +
    (flags.length ? '<div class="row-flags">' + flags.join('') + '</div>' : '') + '</div>' + contractAmountHtml(c) + '</div>';
}

let fixedList = []; // 画面に出している契約（タップで開く用）

function renderFixed() {
  const body = document.getElementById('fixed-body');
  if (!store.txs) {
    body.innerHTML = '<div class="card"><div class="empty-note">' + (store.inflight ? '読み込み中…' : 'データがありません') + '</div></div>';
    return;
  }
  const { contracts } = currentContracts();
  const active = contracts.filter((c) => c.status !== '解約済み' && !c.stopped);
  const inactive = contracts.filter((c) => c.status === '解約済み' || c.stopped);
  fixedList = active.concat(inactive);
  const monthlyTotal = active.reduce((a, c) => a + c.monthly, 0);
  const today = todayYmd();
  const soon = active.filter((c) => c.next && c.next >= today && dayNum(c.next) - dayNum(today) <= 35)
    .sort((a, b) => (a.next < b.next ? -1 : 1));
  const warn = contracts.filter((c) => (c.priceChange && c.priceChange.to > c.priceChange.from && c.status !== '解約済み') || c.stopped);

  const parts = [];
  parts.push('<section class="card"><div class="tiles">' +
    '<div class="tile"><div class="tile-k">毎月の定期支払い</div><div class="tile-v">' + yen(monthlyTotal) + '</div><div class="tile-s">年払いは月割り</div></div>' +
    '<div class="tile"><div class="tile-k">年間</div><div class="tile-v">' + yen(monthlyTotal * 12) + '</div><div class="tile-s">見直すと毎年効く</div></div>' +
    '<div class="tile"><div class="tile-k">契約中</div><div class="tile-v">' + active.length + '件</div><div class="tile-s">' +
    (warn.length ? '⚠ 要確認 ' + warn.length + '件' : '要確認なし') + '</div></div></div>' +
    (store.contracts ? '' : '<div class="help-text">名前や区分を直したり、解約済みにしたりするには gas の再デプロイが必要です（いまは自動で見つけた一覧だけ）。</div>') +
    '</section>');

  // 次の支払い予定
  parts.push('<section class="card"><div class="card-title">これから35日の支払い予定</div>' +
    (soon.length ? soon.map((c) => '<div class="history-row soon-row' + (c.cycle === 'annual' ? ' annual' : '') + '" data-ci="' + fixedList.indexOf(c) + '">' +
      '<div class="row-main"><div class="row-payee">' + escapeHtml(c.name) + '</div><div class="row-sub">' + ymdLabel(c.next) + ' ごろ · ' + cycleLabel(c) + '</div></div>' +
      '<div class="row-amt">' + (c.variable ? '約' : '') + yen(c.cycle === 'annual' ? c.lastAmount : (c.variable ? c.monthly : c.lastAmount || c.manualAmount)) + '</div></div>').join('')
      : '<div class="empty-note">35日以内の予定はありません</div>') + '</section>');

  // 区分ごとの一覧
  CONTRACT_KINDS.forEach((k) => {
    const list = active.filter((c) => c.kind === k);
    if (!list.length) return;
    const sum = list.reduce((a, c) => a + c.monthly, 0);
    parts.push('<section class="card"><div class="card-title-row"><div class="card-title">' + k + '</div><div class="kind-sum">月 ' + yen(sum) + '</div></div>' +
      list.sort((a, b) => b.monthly - a.monthly).map((c) => contractRowHtml(c, fixedList.indexOf(c))).join('') + '</section>');
  });

  // 光熱費など変動する固定費の推移
  const variable = active.filter((c) => c.variable && c.cycle === 'monthly');
  if (variable.length) {
    parts.push('<section class="card"><div class="card-title">変動する固定費の推移（光熱費など）</div>' +
      variable.map((c, vi) => {
        const latest = c.last;
        const lastYear = latest ? c.payments.find((p) => p.ym === ymAdd(latest.ym, -12)) : null;
        const avg12 = Math.round(c.payments.slice(0, 12).reduce((a, p) => a + p.amount, 0) / Math.min(12, c.payments.length));
        return '<div class="util-item"><div class="util-name">' + escapeHtml(c.name) + '</div>' +
          '<div class="tiles"><div class="tile"><div class="tile-k">最新（' + (latest ? Number(latest.ym.slice(5)) + '月' : '—') + '）</div><div class="tile-v">' + (latest ? yen(latest.amount) : '—') + '</div></div>' +
          '<div class="tile"><div class="tile-k">前年同月</div><div class="tile-v">' + (lastYear ? yen(lastYear.amount) : '—') + '</div><div class="tile-s">' +
          (lastYear ? signedYen(latest.amount - lastYear.amount) : '記録なし') + '</div></div>' +
          '<div class="tile"><div class="tile-k">12か月平均</div><div class="tile-v">' + yen(avg12) + '</div><div class="tile-s">年 ' + yen(avg12 * 12) + '</div></div></div>' +
          '<div id="util-chart-' + vi + '" class="chart"></div></div>';
      }).join('') + '</section>');
  }

  if (inactive.length) {
    parts.push('<section class="card"><div class="card-title">解約済み・止まっているもの</div>' +
      '<div class="help-text">「止まっている？」は、いつもの間隔を過ぎても支払いが無いものです。解約したなら「解約済み」にしておくと合計から外れます。</div>' +
      inactive.map((c) => contractRowHtml(c, fixedList.indexOf(c))).join('') + '</section>');
  }

  parts.push('<button id="contract-add" class="secondary-btn wide">＋ 明細に出ない契約を追加（別口座のローンなど）</button>');
  parts.push('<div class="help-text center">毎月・年1回の支払いを取引から自動で見つけています。違うものはタップして「一覧から外す」にできます。</div>');
  body.innerHTML = parts.join('');

  variable.forEach((c, vi) => {
    const to = todayYm();
    const yms = monthRange(ymAdd(to, -23), to);
    const by = new Map();
    c.payments.forEach((p) => by.set(p.ym, (by.get(p.ym) || 0) + p.amount));
    barChart(document.getElementById('util-chart-' + vi), yms.map((ym) => ({ key: ym, label: ym, value: by.get(ym) || 0 })), {
      selected: c.last ? c.last.ym : '',
      tip: (s) => ymLabel(s.key) + ' ' + yen(s.value),
    });
  });
  body.querySelectorAll('[data-ci]').forEach((r) => {
    r.onclick = () => openContract(fixedList[Number(r.dataset.ci)]);
  });
  document.getElementById('contract-add').onclick = () => openContract(null);
}

// ---------------------------------------------------------------------------
// 契約の詳細と手直し（詳細シートを使い回す）
// ---------------------------------------------------------------------------

function openContract(c) {
  const isNew = !c;
  const v = c || { key: '', name: '', kind: 'ローン', cycle: 'monthly', status: '契約中', memo: '', payments: [], manualAmount: 0, day: '' };
  const pays = v.payments || [];
  const parts = [];
  if (!isNew) {
    parts.push('<div class="sheet-payee">' + escapeHtml(v.name) + '</div>' +
      '<div class="sheet-amount">' + (v.cycle === 'annual' ? yen(v.lastAmount) + '<span class="per">/年</span>' : (v.variable ? '約' : '') + yen(v.monthly) + '<span class="per">/月</span>') + '</div>' +
      '<dl class="sheet-dl"><dt>区分</dt><dd>' + escapeHtml(v.kind) + '</dd><dt>周期</dt><dd>' + cycleLabel(v) + '</dd>' +
      '<dt>年間</dt><dd>' + yen(v.yearly) + '</dd>' +
      (v.next ? '<dt>次の支払い</dt><dd>' + ymdLabel(v.next) + ' ごろ</dd>' : '') +
      (v.priceChange ? '<dt>金額の変化</dt><dd>' + yen(v.priceChange.from) + ' → ' + yen(v.priceChange.to) + '</dd>' : '') + '</dl>');
    if (pays.length) {
      parts.push('<div class="card-title">支払いの記録（直近12回）</div><div class="sheet-pays">' +
        pays.slice(0, 12).map((p) => '<div><span>' + p.date + '</span><span>' + yen(p.amount) + '</span></div>').join('') + '</div>');
    }
  } else {
    parts.push('<div class="sheet-payee">明細に出ない契約を追加</div><div class="help-text">別の口座から引き落とされるローンや、現金で払う月謝など。取引の利用先に「キー」の文字が含まれていれば、その支払いとして数えます。</div>');
  }

  if (!store.contracts) {
    parts.push('<div class="help-text top-gap">手直しを保存するには gas（rakuten-ledger）の再デプロイが必要です。</div>');
  } else {
    const cy = v.cycle === 'annual' ? '毎年' : v.cycle === 'monthly' && (v.override || isNew) ? '毎月' : '';
    parts.push('<div class="cat-editor">' +
      '<div class="card-title">' + (isNew ? '内容' : '手直し') + '</div>' +
      '<label class="mini-field">名前<input id="ct-name" type="text" value="' + escapeHtml(isNew ? '' : v.name) + '" placeholder="例: 住宅ローン"></label>' +
      '<label class="mini-field">キー（利用先に含まれる文字）<input id="ct-key" type="text" value="' + escapeHtml(v.key) + '" placeholder="例: ｼﾞｭｳﾀｸﾛｰﾝ"></label>' +
      '<div class="filter-row"><label class="mini-field">区分<select id="ct-kind">' + CONTRACT_KINDS.map((k) => '<option' + (k === v.kind ? ' selected' : '') + '>' + k + '</option>').join('') + '</select></label>' +
      '<label class="mini-field">周期<select id="ct-cycle"><option value="">自動</option><option' + (cy === '毎月' ? ' selected' : '') + '>毎月</option><option' + (cy === '毎年' ? ' selected' : '') + '>毎年</option></select></label></div>' +
      '<div class="filter-row"><label class="mini-field">金額（明細に出ない場合）<input id="ct-amount" type="number" inputmode="numeric" value="' + (v.manualAmount || '') + '"></label>' +
      '<label class="mini-field">支払日（例: 27 / 6/30）<input id="ct-day" type="text" value="' + escapeHtml(v.day || '') + '"></label></div>' +
      '<label class="mini-field">状態<select id="ct-status">' + ['契約中', '解約済み', '対象外'].map((s) =>
        '<option value="' + s + '"' + (s === v.status ? ' selected' : '') + '>' + (s === '対象外' ? '一覧から外す（契約ではない）' : s) + '</option>').join('') + '</select></label>' +
      '<label class="mini-field">メモ<input id="ct-memo" type="text" value="' + escapeHtml(v.memo || '') + '" placeholder="例: 2027年3月更新"></label>' +
      '<button id="ct-save" class="save-btn small">保存</button>' +
      (v.override ? '<button id="ct-reset" class="link-btn plain">手直しを取り消す（自動の判定に戻す）</button>' : '') +
      '</div>');
  }
  if (!isNew && v.key) parts.push('<div class="sheet-actions"><button class="secondary-btn" id="ct-history">この支払いの履歴</button></div>');

  document.getElementById('sheet-body').innerHTML = parts.join('');
  document.getElementById('sheet').classList.remove('hidden');

  const $ = (id) => document.getElementById(id);
  if ($('ct-history')) $('ct-history').onclick = () => { closeDetail(); openHistoryWith({ search: v.key, type: 'expense' }); };
  if ($('ct-save')) {
    $('ct-save').onclick = () => saveContract({
      key: $('ct-key').value.trim() || $('ct-name').value.trim(),
      name: $('ct-name').value.trim(),
      kind: $('ct-kind').value,
      cycle: $('ct-cycle').value,
      amount: Number($('ct-amount').value) || '',
      day: $('ct-day').value.trim(),
      status: $('ct-status').value,
      memo: $('ct-memo').value.trim(),
    }, false, isNew ? '' : v.key);
  }
  if ($('ct-reset')) $('ct-reset').onclick = () => saveContract({ key: v.key }, true, '');
}

async function saveContract(c, remove, oldKey) {
  if (!c.key) { showToast('名前かキーを入れてください', 'ng'); return; }
  try {
    // キーを変えたときは、古いキーの手直しを消してから新しいキーで保存する
    if (oldKey && norm(oldKey) !== norm(c.key) && (store.contracts || []).some((o) => norm(o.key) === norm(oldKey))) {
      await apiPost('save-contract', { contract: { key: oldKey }, remove: true });
    }
    const res = await apiPost('save-contract', { contract: c, remove });
    store.contracts = res.contracts;
    closeDetail();
    showToast(remove ? '自動の判定に戻しました' : '保存しました');
    renderCurrentView();
  } catch (e) {
    showToast(String(e.message || e), 'ng');
  }
}

// ---------------------------------------------------------------------------
// ホームの要約
// ---------------------------------------------------------------------------

function renderContractsHome() {
  const card = document.getElementById('contracts-home');
  if (!store.txs) { card.classList.add('hidden'); return; }
  const { contracts } = currentContracts();
  const active = contracts.filter((c) => c.status !== '解約済み' && !c.stopped);
  if (!active.length) { card.classList.add('hidden'); return; }
  const today = todayYmd();
  const next = active.filter((c) => c.next && c.next >= today).sort((a, b) => (a.next < b.next ? -1 : 1))[0];
  const warn = contracts.filter((c) => (c.priceChange && c.priceChange.to > c.priceChange.from && c.status !== '解約済み') || c.stopped);
  card.classList.remove('hidden');
  card.innerHTML = '<div class="card-title-row"><div class="card-title">毎月の定期支払い</div><span class="link-btn plain">一覧 →</span></div>' +
    '<div class="contracts-home-total">' + yen(active.reduce((a, c) => a + c.monthly, 0)) + '<span class="per">/月 · ' + active.length + '件</span></div>' +
    (next ? '<div class="row-sub">次: ' + escapeHtml(next.name) + ' ' + ymdLabel(next.next) + ' ごろ</div>' : '') +
    (warn.length ? '<div class="row-sub warn-text">⚠ 要確認 ' + warn.length + '件（値上がり・止まっているもの）</div>' : '');
  card.onclick = () => showView('fixed');
}

if (typeof document !== 'undefined') {
  const btn = document.getElementById('open-fixed');
  if (btn) btn.addEventListener('click', () => showView('fixed'));
}

if (typeof module !== 'undefined') {
  module.exports = { detectContracts, resolveContracts, buildContract, kindOfCategory, nextFromDay, addMonthsYmd };
}
