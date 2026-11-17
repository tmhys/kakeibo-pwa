/**
 * 画面を使わずに動かせる計算のテスト。
 *   node tests/run.mjs
 *
 * - 月の集計（core.js の snapshotOf）: tests/fixtures/snapshot.json の期待値（手で計算したもの）と比べる。
 *   gas 側（rakuten-ledger/test/run.mjs）も同じフィクスチャで computeSnapshot_ を確かめているので、
 *   両方が通っていれば、アプリとウィジェット・ダッシュボードの数字は食い違わない。
 * - 定期支払いの自動検出（contracts.js）: 毎月・年1回・値上がり・誤検出しないもの
 *
 * GitHub Actions（.github/workflows/test.yml）でも push のたびに走る。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// core.js と contracts.js を同じ名前空間で読む（ブラウザで <script> を並べたのと同じ）
const api = new Function('module', read('core.js') + '\n;\n' + read('contracts.js') +
  '\n; return { snapshotOf, isExpense, norm, ymAdd, daysInMonth, yen, detectContracts, resolveContracts, nextFromDay, addMonthsYmd };')({ exports: {} });

let passed = 0;
let failed = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++;
  console.error(`✗ ${label}\n    期待: ${e}\n    実際: ${a}`);
}

function toTx(r, i) {
  const [date, type, method, payee, amount, category] = r;
  return { date, ym: date.slice(0, 7), type, method, payee, amount, category, memo: '', seq: i };
}

// --- 月の集計 -------------------------------------------------------------
{
  const fx = JSON.parse(read('tests/fixtures/snapshot.json'));
  const txs = fx.rows.map(toTx).sort((a, b) => (a.date < b.date ? 1 : -1)); // アプリと同じく新しい順
  const monthOf = (ym) => txs.filter((t) => t.ym === ym);
  fx.cases.forEach((c) => {
    const s = api.snapshotOf(monthOf, c.ym, c.day);
    const got = {
      total: s.total, prevToDate: s.prevToDate, diffToDate: s.diffToDate, projected: s.projected,
      categories: s.categories.map((x) => [x.name, x.amount]),
      uncatCount: s.uncat.count, uncatAmount: s.uncat.amount, incomeCount: s.income.count, incomeTotal: s.income.total,
    };
    check('集計: ' + c.label, got, c.expect);
  });
  check('集計: 直近の取引は支出だけ・新しい順', api.snapshotOf(monthOf, '2026-10', 31).recent.map((t) => t.payee),
    ['本', 'NURO光', 'ラーメン（カテゴリ空）', 'Amazon', 'フレスコ']);
}

// --- 支出かどうか --------------------------------------------------------------
check('支出: 普通の支出', api.isExpense({ type: '支出', category: '食費' }), true);
check('支出: 振替は数えない', api.isExpense({ type: '振替', category: '振替' }), false);
check('支出: カテゴリだけ振替の支出も数えない', api.isExpense({ type: '支出', category: '振替' }), false);
check('支出: 収入・集計は数えない', [api.isExpense({ type: '収入' }), api.isExpense({ type: '集計' })], [false, false]);

// --- 小さな関数 ---------------------------------------------------------------
check('正規化: 半角カナと全角が同じ', api.norm('ﾄﾞﾄｰﾙ 三宮店') === api.norm('ドトール三宮店'), true);
check('年月: 年をまたぐ', [api.ymAdd('2026-01', -1), api.ymAdd('2026-12', 1)], ['2025-12', '2027-01']);
check('月の日数: うるう年', [api.daysInMonth('2028-02'), api.daysInMonth('2026-02')], [29, 28]);
check('金額: マイナス', api.yen(-1234.4), '-¥1,234');
check('月末に寄せる', api.addMonthsYmd('2026-01-31', 1), '2026-02-28');
check('支払日: 毎月27日（今日が28日なら翌月）', api.nextFromDay('27', 'monthly', '2026-10-28'), '2026-11-27');
check('支払日: 毎年6/30', api.nextFromDay('6/30', 'annual', '2026-10-28'), '2027-06-30');

// --- 定期支払いの自動検出 ---------------------------------------------------------
{
  const rows = [];
  const add = (date, payee, amount, category) => rows.push([date, '支出', '楽天カード', payee, amount, category]);
  ['2026-06-06', '2026-07-06', '2026-08-06', '2026-09-06'].forEach((d) => add(d, 'NURO光', 5700, '通信費'));
  add('2026-10-06', 'NURO光', 6270, '通信費');
  add('2025-06-15', 'NHK受信料', 12276, '通信費');
  add('2026-06-15', 'NHK受信料', 12276, '通信費');
  // ガス代は毎月違うが契約（光熱費）
  [['2026-06-05', 9000], ['2026-07-05', 7000], ['2026-08-05', 6500], ['2026-09-05', 7800], ['2026-10-05', 11000]].forEach(([d, a]) => add(d, '大阪ガス', a, '光熱費'));
  // ガソリンは毎月だが金額がばらつく → 契約ではない
  [['2026-06-03', 5100], ['2026-07-04', 4300], ['2026-08-02', 5600], ['2026-09-05', 4800], ['2026-10-03', 5200]].forEach(([d, a]) => add(d, 'イデミツ', a, '交通費'));
  // スーパーは月に何度も → 契約ではない
  for (let m = 6; m <= 10; m++) for (const dd of ['03', '10', '17', '24']) add('2026-' + String(m).padStart(2, '0') + '-' + dd, 'フレスコ', 3000, '食費');
  const txs = rows.map(toTx);
  const found = api.detectContracts(txs, '2026-10-24');
  const by = Object.fromEntries(found.map((c) => [c.key, c]));
  check('契約: 見つかるもの', Object.keys(by).sort(), ['NHK受信料', 'NURO光', '大阪ガス']);
  check('契約: NURO光は毎月・値上がり', [by['NURO光'].cycle, by['NURO光'].priceChange && [by['NURO光'].priceChange.from, by['NURO光'].priceChange.to]], ['monthly', [5700, 6270]]);
  check('契約: NHKは年1回・次は来年6月', [by['NHK受信料'].cycle, by['NHK受信料'].next], ['annual', '2027-06-15']);
  check('契約: ガス代は変動扱い・値上がりにしない', [by['大阪ガス'].variable, by['大阪ガス'].priceChange], [true, null]);
  const r = api.resolveContracts(txs, [{ key: 'NURO', name: 'NURO光', status: '解約済み' }, { key: 'NHK', status: '対象外' }], '2026-10-24');
  check('契約: 手直し（解約済み・対象外）', r.contracts.map((c) => c.name + ':' + c.status).sort(), ['NURO光:解約済み', '大阪ガス:契約中']);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
