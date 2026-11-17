/**
 * 画面に触れない計算だけを集めたもの。index.html で最初に読み込む。
 *
 * ここに置くのは、テスト（tests/run.mjs）で画面なしに動かしたい関数:
 * 金額の表示・年月の計算・検索用の正規化・支出かどうかの判定・月の集計。
 *
 * **月の集計（snapshotOf）は gas（rakuten-ledger/WebApp.gs の computeSnapshot_）と同じ
 * 計算をしている。** 片方だけ直すと画面ごとに数字が食い違うので、tests/fixtures/snapshot.json
 * （gas 側の test/fixtures/snapshot_cases.json と同じ中身）で両方が同じ答えになるか確かめる。
 */

// 支出合計に含めない種別（gas の computeSnapshot_ と同じ）
const NON_EXPENSE_TYPES = ['振替', '集計', '収入'];

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

/**
 * 検索用の正規化。カード明細は半角カナ（ﾄﾞﾄｰﾙ）、通知は全角（ドトール）で来るので、
 * NFKC で揃えて大文字小文字と空白を無視する。
 */
function norm(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s　]+/g, '');
}

function isExpense(t) {
  // カテゴリが「振替」なのに種別が支出のままの行（古い取り込み）も支出に数えない。
  // gas の computeSnapshot_ も同じ判定にしてある（テストで両方を確かめる）
  return NON_EXPENSE_TYPES.indexOf(t.type) === -1 && t.category !== '振替';
}

function sumAmount(list) {
  return list.reduce((a, t) => a + t.amount, 0);
}

/**
 * 1か月の集計（ホーム・ウィジェットの数字）。
 * @param monthOf ym → その月の取引（日付の新しい順）を返す関数
 * @param ym      対象の月
 * @param day     「今日」の日。前月の同じ日までと比べる・着地見込みに使う（過去の月は月末日）
 */
function snapshotOf(monthOf, ym, day) {
  const monthTxs = monthOf(ym) || [];
  const cur = monthTxs.filter(isExpense);
  const prev = (monthOf(ymAdd(ym, -1)) || []).filter(isExpense);
  const prevToDate = prev.filter((t) => Number(t.date.slice(8, 10)) <= day);

  const total = sumAmount(cur);
  const prevToDateTotal = sumAmount(prevToDate);

  const catMap = new Map();
  cur.forEach((t) => {
    const c = t.category || '未分類';
    catMap.set(c, (catMap.get(c) || 0) + t.amount);
  });
  const categories = Array.from(catMap, ([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);

  const uncat = cur.filter((t) => !t.category || t.category === '未分類');
  const income = monthTxs.filter((t) => t.type === '収入');
  const projected = day > 0 ? Math.round(total / day * daysInMonth(ym)) : 0;

  return {
    total,
    prevToDate: prevToDateTotal,
    diffToDate: total - prevToDateTotal,
    projected,
    categories,
    uncat: { count: uncat.length, amount: sumAmount(uncat) },
    income: { count: income.length, total: sumAmount(income) },
    recent: cur.slice(0, 5), // 日付の新しい順で渡される前提
  };
}

if (typeof module !== 'undefined') {
  module.exports = { NON_EXPENSE_TYPES, yen, ymAdd, ymLabel, daysInMonth, norm, isExpense, sumAmount, snapshotOf };
}
