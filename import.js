/**
 * 銀行の入出金明細CSVの取り込み（半自動）。
 *
 * 楽天銀行・三菱UFJ銀行の入出金は Zaim のアラートメール経由で自動で入るが、
 * 1万円以上しか届かない。それ未満を、銀行サイトから落としたCSVで補う。
 *
 * 解析・振り分け（カード引落しは振替、など）・重複判定は gas 側（Bank.gs）で行い、
 * ここは「ファイルを読む → 結果を見せる → 人が直す → 書き込む」だけを受け持つ。
 * 銀行のCSVは Shift_JIS なので、文字コードの変換だけはここで済ませてから送る。
 */

const IMPORT_TYPES = ['支出', '振替', '収入', 'skip'];
const IMPORT_TYPE_LABEL = { 支出: '支出', 振替: '振替', 収入: '収入', skip: '取り込まない' };
const IMPORT_STATUS_LABEL = { 'dup-id': '取込済み', 'dup-zaim': 'Zaimで取込済み' };

const importState = { csv: '', hint: '', rows: [], choice: {} };

function initImportView() {
  // 前回の結果は残さない（別のファイルを続けて読むことが多いため）
}

/** UTF-8 として読めなければ Shift_JIS として読む（銀行のCSVはたいてい Shift_JIS） */
async function readCsvFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

function hintFromName(name) {
  if (/rakuten|楽天|RB-torihikimeisai/i.test(name)) return 'rakuten';
  if (/mufg|ufj|三菱/i.test(name)) return 'mufg';
  return '';
}

function setImportStatus(msg, kind) {
  const el = document.getElementById('import-status');
  el.textContent = msg;
  el.className = 'test-result' + (kind ? ' ' + kind : '');
}

async function previewImport(file) {
  document.getElementById('import-preview').classList.add('hidden');
  setImportStatus('読み込み中…（' + file.name + '）');
  try {
    importState.csv = await readCsvFile(file);
    importState.hint = document.getElementById('import-hint').value || hintFromName(file.name);
    const res = await apiPost('bank-import', { csv: importState.csv, hint: importState.hint, commit: false });
    importState.rows = res.rows;
    importState.account = res.account;
    importState.choice = {};
    res.rows.forEach((r) => { if (r.status === 'new') importState.choice[r.id] = r.type; });
    setImportStatus('');
    renderImportPreview();
  } catch (e) {
    setImportStatus('✕ ' + String(e.message || e), 'ng');
  }
}

function renderImportPreview() {
  const rows = importState.rows;
  const onlyNew = document.getElementById('import-only-new').checked;
  const fresh = rows.filter((r) => r.status === 'new');
  const willAdd = fresh.filter((r) => importState.choice[r.id] !== 'skip');
  const dates = rows.map((r) => r.date).sort();

  document.getElementById('import-preview').classList.remove('hidden');
  document.getElementById('import-title').textContent = importState.account +
    (dates.length ? '（' + dates[0] + '〜' + dates[dates.length - 1] + '）' : '');
  const byType = {};
  willAdd.forEach((r) => { const t = importState.choice[r.id]; byType[t] = (byType[t] || 0) + r.amount; });
  document.getElementById('import-summary').textContent =
    rows.length + '件中 新規 ' + fresh.length + '件・取込済み ' + (rows.length - fresh.length) + '件' +
    (willAdd.length ? ' ／ 取り込む: ' + Object.keys(byType).map((t) => t + ' ' + yen(byType[t])).join('・') : '');

  const list = (onlyNew ? fresh : rows).slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const listEl = document.getElementById('import-list');
  listEl.innerHTML = list.length ? list.map((r) => {
    const isNew = r.status === 'new';
    const sign = r.dir === '入金' ? '+' : '−';
    const control = isNew
      ? '<select class="import-type" data-id="' + escapeHtml(r.id) + '">' +
        IMPORT_TYPES.map((t) => '<option value="' + t + '"' + (importState.choice[r.id] === t ? ' selected' : '') + '>' +
          IMPORT_TYPE_LABEL[t] + '</option>').join('') + '</select>'
      : '<span class="chip other">' + IMPORT_STATUS_LABEL[r.status] + '</span>';
    return '<div class="history-row import-row' + (isNew ? '' : ' done') +
      (importState.choice[r.id] === 'skip' ? ' skipped' : '') + '">' +
      '<div class="row-main"><div class="row-payee">' + escapeHtml(r.payee) + '</div>' +
      '<div class="row-sub">' + escapeHtml(ymdLabel(r.date)) + ' · ' + escapeHtml(r.category || '') + '</div></div>' +
      '<div class="import-right"><div class="row-amt' + (r.dir === '入金' ? ' income' : '') + '">' + sign + yen(r.amount) + '</div>' +
      control + '</div></div>';
  }).join('') : '<div class="empty-note">新しく取り込む取引はありません（すべて取込済み）</div>';

  listEl.querySelectorAll('.import-type').forEach((sel) => {
    sel.onchange = () => { importState.choice[sel.dataset.id] = sel.value; renderImportPreview(); };
  });
  const btn = document.getElementById('import-commit');
  btn.disabled = !willAdd.length;
  btn.textContent = willAdd.length ? willAdd.length + '件を取り込む' : '取り込むものがありません';
}

async function commitImport() {
  const btn = document.getElementById('import-commit');
  btn.disabled = true;
  btn.textContent = '取り込み中…';
  // サーバーの判定から変えたものだけ送る
  const overrides = {};
  importState.rows.forEach((r) => {
    const c = importState.choice[r.id];
    if (r.status === 'new' && c && c !== r.type) overrides[r.id] = c;
  });
  try {
    const res = await apiPost('bank-import', { csv: importState.csv, hint: importState.hint, commit: true, overrides });
    showToast('✅ ' + res.account + ' を ' + res.added + '件取り込みました');
    document.getElementById('import-preview').classList.add('hidden');
    document.getElementById('import-file').value = '';
    setImportStatus('✅ ' + res.added + '件取り込みました（' + res.skipped + '件は重複・取り込まない）', 'ok');
    refreshData();
  } catch (e) {
    showToast(String(e.message || e), 'ng');
    renderImportPreview();
  }
}

document.getElementById('open-import').addEventListener('click', () => showView('import'));
document.getElementById('import-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) previewImport(f);
});
document.getElementById('import-only-new').addEventListener('change', renderImportPreview);
document.getElementById('import-commit').addEventListener('click', commitImport);
