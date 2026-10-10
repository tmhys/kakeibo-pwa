/**
 * 使い勝手の機能（その2）。
 *
 *   取引の詳細  : カテゴリを直す（任意で「このお店は今後も」のルール追加・過去分もまとめて）
 *   入力        : よく使う入力のワンタップ候補・利用先の入力補完
 *   履歴        : 絞り込んだ結果をCSVで書き出す
 *   分析        : 医療費控除の目安・データの点検（重複の疑い・未分類）
 *
 * カテゴリの修正だけは gas に書き込む（Edit.gs、action: 'update-category'）。
 * それ以外は端末に持った全取引だけで動く。
 */

// ---------------------------------------------------------------------------
// カテゴリを直す（詳細シートの中）
// ---------------------------------------------------------------------------

/** 選べるカテゴリ: 設定の支出カテゴリ ＋ 実データに出てくるもの（振替などは除く） */
function editableCategories() {
  const set = new Set(getSettings().categories);
  store.txs.forEach((t) => { if (isExpense(t) && t.category) set.add(t.category); });
  set.delete('振替');
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'ja'));
}

/** 利用先からルールのパターンの初期値を作る（末尾の支店名・番号を落とす） */
function suggestPattern(payee) {
  const p = String(payee || '').trim();
  const cut = p.split(/[\s　]+/)[0];
  return cut.length >= 2 ? cut : p;
}

function renderCategoryEditor(t) {
  if (!isExpense(t)) return; // 振替・収入・集計はカテゴリの意味が違うので対象外
  const body = document.getElementById('sheet-body');
  const wrap = document.createElement('div');
  wrap.className = 'cat-editor';
  if (!t.id) {
    wrap.innerHTML = '<div class="help-text">カテゴリを直すには gas（rakuten-ledger）の再デプロイが必要です。</div>';
    body.appendChild(wrap);
    return;
  }
  const cats = editableCategories();
  wrap.innerHTML =
    '<div class="card-title">カテゴリを変更</div>' +
    '<select id="ce-cat">' + cats.map((c) => '<option' + (c === t.category ? ' selected' : '') + '>' + escapeHtml(c) + '</option>').join('') +
    '<option value="__new">＋ 新しいカテゴリ…</option></select>' +
    '<input id="ce-new" type="text" class="hidden" placeholder="新しいカテゴリ名">' +
    '<label class="mini-check"><input id="ce-rule" type="checkbox" checked>このお店は今後もこのカテゴリにする</label>' +
    '<div id="ce-rule-box"><input id="ce-pattern" type="text" value="' + escapeHtml(suggestPattern(t.payee)) + '">' +
    '<div class="help-text">↑ 利用先にこの文字が含まれていたら当てはめます（短くすると支店違いもまとめて当たります）</div>' +
    '<label class="mini-check"><input id="ce-past" type="checkbox" checked>過去の同じお店もまとめて変更（<span id="ce-count">0</span>件）</label></div>' +
    '<button id="ce-save" class="save-btn small">カテゴリを保存</button>';
  body.appendChild(wrap);

  const $ = (id) => document.getElementById(id);
  const matches = () => {
    const pat = norm($('ce-pattern').value);
    const cat = currentCat();
    if (!pat) return [];
    return store.txs.filter((x) => isExpense(x) && x.category !== cat && norm(x.payee).includes(pat));
  };
  const currentCat = () => ($('ce-cat').value === '__new' ? $('ce-new').value.trim() : $('ce-cat').value);
  const update = () => {
    $('ce-new').classList.toggle('hidden', $('ce-cat').value !== '__new');
    $('ce-rule-box').classList.toggle('hidden', !$('ce-rule').checked);
    $('ce-count').textContent = matches().filter((x) => x !== t).length;
  };
  ['ce-cat', 'ce-rule', 'ce-pattern', 'ce-new'].forEach((id) => $(id).addEventListener('input', update));
  $('ce-cat').addEventListener('change', update);
  update();

  $('ce-save').onclick = async () => {
    const category = currentCat();
    if (!category) { showToast('カテゴリを選んでください', 'ng'); return; }
    const useRule = $('ce-rule').checked && $('ce-pattern').value.trim();
    const applyPast = useRule && $('ce-past').checked;
    const btn = $('ce-save');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const res = await apiPost('update-category', {
        id: t.id, category,
        rule: useRule ? { pattern: $('ce-pattern').value.trim(), applyPast } : undefined,
      });
      // サーバーの結果を待たずに手元も直しておく（すぐ画面に出すため）。直後に取り直して確定させる
      const local = applyPast ? matches() : [];
      t.category = category;
      local.forEach((x) => { x.category = category; });
      [t].concat(local).forEach((x) => { x.search = norm(x.payee) + '\n' + norm(x.category) + '\n' + norm(x.method) + '\n' + norm(x.memo); });
      historyOptionsDirty = true;
      showToast('✅ ' + res.updated + '件を「' + category + '」に変更' + (res.ruleAdded ? '・ルールに追加' : ''));
      closeDetail();
      renderCurrentView();
      refreshData();
    } catch (e) {
      showToast(String(e.message || e), 'ng');
      btn.disabled = false;
      btn.textContent = 'カテゴリを保存';
    }
  };
}

// ---------------------------------------------------------------------------
// 入力: よく使う入力・利用先の補完
// ---------------------------------------------------------------------------

function renderQuickPicks() {
  const el = document.getElementById('quick-picks');
  if (!store.txs || entryState.type !== 'expense') { el.innerHTML = ''; el.classList.add('hidden'); return; }
  const s = getSettings();
  const since = ymAdd(todayYm(), -3) + '-01';
  // 手入力した支出（決済手段が既定の手段＝現金など）で、直近3か月によく使ったもの
  const counts = new Map();
  store.txs.forEach((t) => {
    if (t.date < since || !isExpense(t) || t.method !== s.method) return;
    const k = t.payee + '\u0000' + t.category;
    const c = counts.get(k) || { payee: t.payee, category: t.category, n: 0, last: t.amount };
    c.n += 1;
    counts.set(k, c);
  });
  const top = Array.from(counts.values()).filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 8);
  el.classList.toggle('hidden', !top.length);
  el.innerHTML = top.length ? '<div class="card-title">よく使う（タップで利用先とカテゴリを入力）</div><div class="chips">' +
    top.map((c, i) => '<button class="quick-chip" data-i="' + i + '">' + escapeHtml(c.payee) +
      '<span>' + escapeHtml(c.category) + '</span></button>').join('') + '</div>' : '';
  el.querySelectorAll('.quick-chip').forEach((b) => {
    b.onclick = () => {
      const c = top[Number(b.dataset.i)];
      document.getElementById('entry-payee').value = c.payee;
      const grid = ['自動'].concat(getSettings().categories);
      entryState.category = grid.includes(c.category) ? c.category : '自動';
      renderCategoryGrid();
      if (!entryState.amountStr) showToast(c.payee + ' を入れました。金額を入力してください');
    };
  });

  // 利用先の補完（よく出てくる順に200件）
  const freq = new Map();
  store.txs.forEach((t) => { if (isExpense(t)) freq.set(t.payee, (freq.get(t.payee) || 0) + 1); });
  document.getElementById('payee-list').innerHTML = Array.from(freq).sort((a, b) => b[1] - a[1]).slice(0, 200)
    .map(([p]) => '<option value="' + escapeHtml(p) + '">').join('');
}

document.getElementById('type-expense').addEventListener('click', renderQuickPicks);
document.getElementById('type-income').addEventListener('click', renderQuickPicks);

// ---------------------------------------------------------------------------
// CSVの書き出し
// ---------------------------------------------------------------------------

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Excel で文字化けしないよう BOM つき UTF-8 で保存させる */
function downloadCsv(filename, rows) {
  const text = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function txCsvRows(list) {
  return [['日付', '種別', '決済手段', '利用先', '金額', 'カテゴリ', 'メモ']]
    .concat(list.map((t) => [t.date, t.type, t.method, t.payee, t.amount, t.category, t.memo]));
}

document.getElementById('history-export').addEventListener('click', () => {
  if (historyMode === 'calendar') setHistoryMode('list');
  if (!historyFiltered.length) { showToast('書き出す取引がありません', 'ng'); return; }
  const sorted = historyFiltered.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  downloadCsv('kakeibo_' + sorted[0].date + '_' + sorted[sorted.length - 1].date + '.csv', txCsvRows(sorted));
  showToast(sorted.length + '件を書き出しました');
});

// ---------------------------------------------------------------------------
// 医療費控除の目安
// ---------------------------------------------------------------------------

const MEDICAL_THRESHOLD = 100000;

function renderMedical(year) {
  document.getElementById('medical-title').textContent = '医療費控除の目安（' + year + '年）';
  const body = document.getElementById('medical-body');
  const list = store.txs.filter((t) => t.date.startsWith(year) && isExpense(t) && /医療|病院|薬/.test(t.category));
  const total = list.reduce((a, t) => a + t.amount, 0);
  if (!list.length) {
    body.innerHTML = '<div class="empty-note">この年の医療費（カテゴリ名に「医療・病院・薬」を含むもの）はありません</div>';
    return;
  }
  const over = total - MEDICAL_THRESHOLD;
  const byPayee = Array.from(groupSum(list, (t) => t.payee), ([name, v]) => ({ name, amount: v.amount, sub: v.count + '回' }))
    .sort((a, b) => b.amount - a.amount).slice(0, 8);
  body.innerHTML =
    '<div class="tiles"><div class="tile"><div class="tile-k">医療費の合計</div><div class="tile-v">' + yen(total) + '</div><div class="tile-s">' + list.length + '件</div></div>' +
    '<div class="tile"><div class="tile-k">10万円まで</div><div class="tile-v">' + (over >= 0 ? '超えた' : yen(-over)) + '</div><div class="tile-s">' + (over >= 0 ? '控除の対象になりうる' : 'あと') + '</div></div>' +
    '<div class="tile"><div class="tile-k">控除額の目安</div><div class="tile-v">' + (over > 0 ? yen(Math.min(over, 2000000)) : '¥0') + '</div><div class="tile-s">保険の補填前</div></div></div>' +
    '<div id="medical-list" class="category-bars"></div>' +
    '<div class="help-text top-gap">家族の分を合算できます。所得が200万円未満なら基準は「所得の5%」。保険金などで補填された額は差し引きます。目安なので、申告は領収書で確認してください。</div>' +
    '<button id="medical-export" class="secondary-btn">医療費の明細をCSVで書き出す</button>';
  hbarList(document.getElementById('medical-list'), byPayee, {
    onClick: (it) => openHistoryWith({ search: it.name, from: year + '-01-01', to: year + '-12-31', type: 'expense' }),
  });
  document.getElementById('medical-export').onclick = () => {
    downloadCsv('iryouhi_' + year + '.csv', txCsvRows(list.slice().reverse()));
  };
}

// ---------------------------------------------------------------------------
// データの点検: 重複の疑い・未分類
// ---------------------------------------------------------------------------

/**
 * 同じ日・同じ金額の支出が2件以上あるもの（直近12か月）。
 * 楽天ペイの支払い通知と楽天カードの明細のように、別の経路から同じ支払いが
 * 二重に入ることがあるので、人が見て判断できるように並べる。
 */
function findDuplicates() {
  const since = ymAdd(todayYm(), -11) + '-01';
  const groups = new Map();
  store.txs.forEach((t) => {
    if (t.date < since || !isExpense(t) || t.amount < 100) return;
    const k = t.date + '|' + t.amount;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  });
  return Array.from(groups.values()).filter((g) => g.length >= 2)
    // 決済手段が違う組を先に（別経路の二重取り込みの可能性が高い）
    .sort((a, b) => (new Set(b.map((t) => t.method)).size - new Set(a.map((t) => t.method)).size) || (a[0].date < b[0].date ? 1 : -1));
}

function renderDataCheck() {
  const body = document.getElementById('datacheck-body');
  const dups = findDuplicates();
  const uncat = store.txs.filter((t) => isExpense(t) && t.category === '未分類');
  const uncatAmt = uncat.reduce((a, t) => a + t.amount, 0);
  const parts = [];
  parts.push('<div class="check-row"><span>' + (uncat.length ? '⚠' : '✓') + ' 未分類</span><span>' +
    (uncat.length ? uncat.length + '件・' + yen(uncatAmt) + ' <button class="link-btn plain" id="check-uncat">確認する</button>' : 'なし') + '</span></div>');
  parts.push('<div class="check-row"><span>' + (dups.length ? '⚠' : '✓') + ' 重複の疑い（直近12か月）</span><span>' +
    (dups.length ? dups.length + '組' : 'なし') + '</span></div>');
  if (dups.length) {
    parts.push('<div class="help-text">同じ日・同じ金額の支出です。別の経路（支払い通知とカード明細など）から同じ支払いが二重に入っていないか確認してください。タップで詳細。</div>');
    parts.push('<div class="dup-list">' + dups.slice(0, 10).map((g) =>
      '<div class="dup-group"><div class="history-date-head"><span>' + ymdLabel(g[0].date) + ' · ' + yen(g[0].amount) + ' × ' + g.length + '</span>' +
      (new Set(g.map((t) => t.method)).size > 1 ? '<span class="chip uncat">決済手段が違う</span>' : '<span></span>') + '</div>' +
      '<div class="card">' + g.map((t) => historyRowHtml(t, false)).join('') + '</div></div>').join('') + '</div>');
  }
  body.innerHTML = parts.join('');
  const b = document.getElementById('check-uncat');
  if (b) b.onclick = () => openHistoryWith({ category: '未分類', type: 'expense' });
}
