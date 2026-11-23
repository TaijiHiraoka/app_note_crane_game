'use strict';

/* =========================================================
   1) 記録する項目の設定
   ここの選択肢を書きかえるだけで、入力画面・一覧・詳細に反映されます。
   key   … 保存するときの名前（あとで変えると過去データと合わなくなるので注意）
   label … 画面に出る名前
   options … 選択肢
   ========================================================= */
const KINDS = {
  hook: {
    label: 'フック',
    maxTries: 20,
    notePlaceholder: 'リングの引っかかり方、アームの癖など',
    fields: [
      { key: 'ringStart', label: 'リングスタート位置', options: ['左', '右'] },
      { key: 'ringShape', label: 'リング形状', options: ['通常リング', '小リング', '太リング', '大リング', 'Sフック'] },
      { key: 'chainLength', label: 'チェーン長さ', options: ['通常', '長い', '短い'] },
      // 開口部は「台を上から見た向き」で 3×3 に並べる（空文字 '' は真ん中の目印）
      { key: 'opening', label: 'フック開口部の向き', layout: 'dir',
        options: ['斜め左奥', '奥', '斜め右奥', '左', '', '右', '斜め左手前', '手前', '斜め右手前'] },
      { key: 'antiSlip', label: '滑り込み防止', options: ['あり', 'なし'] },
      { key: 'aim', label: '狙い方', options: ['ひっかけ', '滑り込み'] },
      { key: 'swing', label: '振れ具合', options: ['よく振れる', '振れない'] },
      { key: 'swingUse', label: '振りの利用', options: ['よく振る', '振りを抑える'] },
      { key: 'cycle', label: '周期', options: ['左', '左から中央', '右から中央', '右'] },
      // 微調整はフックを真上から見た配置で 3×3 に並べる
      { key: 'finePos', label: '微調整（手前奥左右）', layout: 'dir',
        options: ['左奥', '奥', '右奥', '左横', '真上', '右横', '左手前', '手前', '右手前'] },
      { key: 'fineDist', label: '微調整（よせ）', options: ['近く', '遠ざけ'] },
      { key: 'get', label: 'ゲット', options: ['できた', 'できなかった'], layout: 'get' },
    ],
    // 一覧に出す代表項目
    summary: ['aim', 'opening', 'cycle'],
  },
  box: {
    label: '箱',
    maxTries: 40,
    notePlaceholder: 'ずらし方、ハマりどころなど',
    fields: [
      { key: 'bridge', label: '橋構造', options: ['並行', '末広', '段違い'] },
      { key: 'bridgeWidth', label: '橋幅', options: ['普通', '広い', '狭い'] },
      { key: 'topBarGrip', label: '上段バー滑り止め', options: ['あり', 'なし'] },
      { key: 'armTwist', label: 'アーム捩れ', options: ['右', '左', '右強め', '左強め', 'なし'] },
      { key: 'shape', label: '箱形状', options: ['縦長箱', 'デカ箱', '厚みある中箱', '小箱', '立方体', '薄箱'] },
      { key: 'method', label: '取り方', options: ['縦はめ', 'スライド', '押し', 'ちゃぶ台返し', 'とめがけ', '頂点突き'] },
      { key: 'get', label: 'ゲット', options: ['できた', 'できなかった'], layout: 'get' },
      { key: 'assist', label: 'アシスト', options: ['あり', 'なし'] },
    ],
    summary: ['shape', 'method', 'bridge'],
  },
};

// 項目や選択肢を変えたとき、過去の記録を新しい形に直す処理（起動時に1回）
// 対応するものがない値は空欄になります。元の値は記録の中に残してあり、画面には出ません。
const SCHEMA = 3;
const MIGRATIONS = [
  // v2：取り方の名前変更
  (r) => {
    const map = { '押し込み': '押し', 'ちゃぶ台': 'ちゃぶ台返し' };
    if (r.kind === 'box' && map[r.detail.method]) r.detail.method = map[r.detail.method];
  },
  // v3：微調整を「手前奥左右」と「よせ」に組みかえ（同じ名前の選択肢だけ引き継ぐ）
  (r) => {
    if (r.kind !== 'hook') return;
    const d = r.detail;
    const pos = ['左奥', '奥', '右奥', '左横', '真上', '右横', '左手前', '手前', '右手前'];
    if (!d.finePos) d.finePos = [d.fineLR, d.fineFB].find((v) => pos.includes(v));
    if (!d.fineDist && ['近く', '遠ざけ'].includes(d.fineLR)) d.fineDist = d.fineLR;
    if (!d.finePos) delete d.finePos;
    if (!d.fineDist) delete d.fineDist;
  },
];

function migrate(r) {
  if ((r.schema || 0) >= SCHEMA) return false;
  r.detail = r.detail || {};
  MIGRATIONS.forEach((fn) => fn(r));
  r.schema = SCHEMA;
  return true;
}

const PHOTO_MAX_SIZE = 1600;  // 写真の長辺(px)。小さくすると容量が減る
const PHOTO_QUALITY = 0.82;   // JPEG画質 0〜1

/* =========================================================
   2) データ保存（IndexedDB：ブラウザ内のデータベース）
   records … 記録本体
   photos  … 写真の画像データ
   ※ GitHub Pages では同じアカウントの別アプリと保存場所を共有するため、
     フィールドノートとは別の名前にしています。
   ========================================================= */
const DB_NAME = 'crane-notes';
const DB_VERSION = 1;
let dbPromise;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function dbGetAll(storeName) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const req = d.transaction(storeName).objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(storeName, id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const req = d.transaction(storeName).objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 複数の書き込みを「全部成功 or 全部失敗」でまとめて行う
async function dbWrite(fn) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(['records', 'photos'], 'readwrite');
    fn(t.objectStore('records'), t.objectStore('photos'));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* =========================================================
   3) 小さな道具
   ========================================================= */
const $ = (sel) => document.querySelector(sel);
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const pad = (n) => String(n).padStart(2, '0');
const fmtDay = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  const { dataset, attrs, ...rest } = props;
  Object.assign(node, rest);
  if (dataset) Object.assign(node.dataset, dataset);
  if (attrs) Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  children.flat().forEach((c) => c != null && c !== false && node.append(c));
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function hasValue(v) { return v !== null && v !== undefined && v !== '' && v !== false; }
const emptyDetail = () => ({ tries: null, note: '' });

/* =========================================================
   4) 写真の縮小（そのままだと1枚数MBになるため）
   ========================================================= */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

async function compressImage(file) {
  const { img, url } = await loadImage(file);
  try {
    const scale = Math.min(1, PHOTO_MAX_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = el('canvas', { width: w, height: h });
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', PHOTO_QUALITY));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* =========================================================
   5) 入力画面
   draft … 入力中の内容
   {
     mode: 'new' | 'edit', id, createdAt, location, locState, locPromise,
     prize: {id, blob, url, saved} | null,   … 景品の写真（一覧のサムネになる）
     photos: [{id, blob, url, saved}], removedPhotoIds: [],   … 台・全体の写真
     kind: 'hook' | 'box', sel: { hook: {...}, box: {...} }, dirty
   }
   フックと箱は両方の入力を覚えておき、保存するのは選んでいる方だけ。
   ========================================================= */
let draft = null;

async function openForm({ from = null, duplicate = false } = {}) {
  const editing = from && !duplicate;
  draft = {
    mode: editing ? 'edit' : 'new',
    id: editing ? from.id : uid(),
    createdAt: editing ? new Date(from.createdAt) : new Date(),
    location: editing ? from.location : null,
    locState: 'idle',
    locPromise: null,
    prize: null,
    photos: [],
    removedPhotoIds: [],
    kind: (from && from.kind) || 'hook',
    sel: { hook: emptyDetail(), box: emptyDetail() },
    dirty: false,
  };
  if (from && from.kind) {
    draft.sel[from.kind] = { ...emptyDetail(), ...JSON.parse(JSON.stringify(from.detail || {})) };
    // 「同じ設定で新規」は台の設定だけ引き継ぎ、結果・手数・メモは空にする
    if (duplicate) Object.assign(draft.sel[from.kind], { get: undefined, tries: null, note: '' });
  }

  $('#formTitle').textContent = editing ? '記録を編集' : '新しい記録';
  $('#formTime').textContent = `${fmtDay(draft.createdAt)} ${fmtTime(draft.createdAt)}`;
  $('#placeInput').value = from ? (from.place || '') : await lastPlace();
  $('#memoInput').value = editing ? (from.memo || '') : '';
  await fillPlaceList();

  // 編集のときは、保存済みの写真を読み込んでおく
  if (editing) {
    if (from.prizePhotoId) {
      const p = await dbGet('photos', from.prizePhotoId);
      if (p) draft.prize = { id: p.id, blob: p.blob, url: URL.createObjectURL(p.blob), saved: true };
    }
    for (const pid of from.photoIds || []) {
      const p = await dbGet('photos', pid);
      if (p) draft.photos.push({ id: p.id, blob: p.blob, url: URL.createObjectURL(p.blob), saved: true });
    }
  }

  renderKind();
  renderPrize();
  renderDraftPhotos();
  $('#saveBtn').disabled = false;
  $('#saveBtn').textContent = '保存';
  showView('formView');

  if (editing) setLoc(draft.location ? 'ok' : 'none');
  else requestLocation();
}

function discardDraft() {
  if (draft) draft.photos.forEach((p) => URL.revokeObjectURL(p.url));
  if (draft && draft.prize) URL.revokeObjectURL(draft.prize.url);
  draft = null;
}

async function lastPlace() {
  const recs = await dbGetAll('records');
  const last = recs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return (last && last.place) || '';
}

async function fillPlaceList() {
  const places = [...new Set((await dbGetAll('records')).map((r) => r.place).filter(Boolean))];
  $('#placeList').replaceChildren(...places.map((p) => el('option', { value: p })));
}

// フック／箱の切り替えボタン
function setKind(kind) {
  if (!draft || draft.kind === kind) return;
  saveNoteToDraft();
  draft.kind = kind;
  draft.dirty = true;
  renderKind();
}

function renderKind() {
  document.querySelectorAll('.kind-switch button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.kind === draft.kind)));
  const def = KINDS[draft.kind];
  const sel = draft.sel[draft.kind];
  const box = $('#kindFields');
  box.replaceChildren();

  // 選択式の項目
  def.fields.forEach((f) => {
    const chips = el('div', {
      className: 'chips' + (f.layout ? ` chips-${f.layout}` : ''),
      attrs: { role: 'group', 'aria-label': f.label },
    });
    f.options.forEach((o) => {
      if (o === '') { chips.append(el('span', { className: 'dir-center', textContent: 'フック', attrs: { 'aria-hidden': 'true' } })); return; }
      const b = el('button', { type: 'button', textContent: o, dataset: { v: o } });
      b.setAttribute('aria-pressed', String(sel[f.key] === o));
      b.addEventListener('click', () => {
        sel[f.key] = sel[f.key] === o ? undefined : o; // もう一度押すと選択を外す
        draft.dirty = true;
        chips.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.v === sel[f.key])));
      });
      chips.append(b);
    });
    box.append(el('div', { className: 'field' }, el('span', { className: 'field-label', textContent: f.label }), chips));
  });

  // 手数（− ＋ で選ぶ）
  const out = el('output', { className: 'stepper-value' });
  const clearBtn = el('button', { type: 'button', className: 'text-btn small', textContent: 'クリア' });
  const showTries = () => {
    out.textContent = sel.tries ? `${sel.tries}` : '—';
    clearBtn.hidden = !sel.tries;
  };
  const step = (n) => {
    sel.tries = Math.min(def.maxTries, Math.max(1, (sel.tries || 0) + n));
    draft.dirty = true;
    showTries();
  };
  const minus = el('button', { type: 'button', className: 'step-btn', textContent: '−', ariaLabel: '1減らす' });
  const plus = el('button', { type: 'button', className: 'step-btn', textContent: '＋', ariaLabel: '1増やす' });
  minus.addEventListener('click', () => step(-1));
  plus.addEventListener('click', () => step(1));
  clearBtn.addEventListener('click', () => { sel.tries = null; draft.dirty = true; showTries(); });
  showTries();
  box.append(el('div', { className: 'field' },
    el('span', { className: 'field-label', textContent: `手数（1〜${def.maxTries}）` }),
    el('div', { className: 'stepper' }, minus, out, plus, clearBtn)));

  // 種類ごとの自由メモ
  const note = el('textarea', { id: 'noteInput', rows: 4, placeholder: def.notePlaceholder, value: sel.note || '' });
  note.addEventListener('input', () => { draft.dirty = true; });
  box.append(el('label', { className: 'field' },
    el('span', { className: 'field-label', textContent: `${def.label}のメモ` }), note));
}

function saveNoteToDraft() {
  const n = $('#noteInput');
  if (draft && n) draft.sel[draft.kind].note = n.value.trim();
}

function requestLocation() {
  const current = draft;
  if (!('geolocation' in navigator)) { setLoc('unsupported'); return; }
  setLoc('loading');
  current.locPromise = new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (draft === current) {
          draft.location = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
          };
          setLoc('ok');
        }
        resolve();
      },
      (err) => {
        if (draft === current) setLoc(err.code === 1 ? 'denied' : 'error');
        resolve();
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

function setLoc(state) {
  if (!draft) return;
  draft.locState = state;
  const text = {
    loading: '取得しています…',
    ok: draft.location && `${draft.location.lat.toFixed(5)}, ${draft.location.lng.toFixed(5)}（誤差 約${draft.location.accuracy}m）`,
    denied: '位置情報が許可されていません（店舗名だけでも記録できます）',
    error: '取得できませんでした',
    unsupported: 'この端末では使えません',
    none: '記録なし',
  }[state];
  $('#locStatus').textContent = text || '';
  $('#locRetry').hidden = !(state === 'denied' || state === 'error' || state === 'none');
}

async function addFiles(files) {
  for (const file of files) {
    try {
      const blob = await compressImage(file);
      if (!draft) return;
      draft.photos.push({ id: uid(), blob, url: URL.createObjectURL(blob), saved: false });
      draft.dirty = true;
    } catch {
      toast('この写真は読み込めませんでした');
    }
  }
  renderDraftPhotos();
}

// 景品の写真（1枚だけ。撮り直すと入れかわる）
async function setPrize(file) {
  if (!file || !draft) return;
  try {
    const blob = await compressImage(file);
    if (!draft) return;
    removePrize();
    draft.prize = { id: uid(), blob, url: URL.createObjectURL(blob), saved: false };
    draft.dirty = true;
  } catch {
    toast('この写真は読み込めませんでした');
  }
  renderPrize();
}

function removePrize() {
  const p = draft && draft.prize;
  if (!p) return;
  URL.revokeObjectURL(p.url);
  if (p.saved) draft.removedPhotoIds.push(p.id);
  draft.prize = null;
  draft.dirty = true;
}

function renderPrize() {
  const box = $('#prizePreview');
  box.replaceChildren();
  const has = !!(draft && draft.prize);
  $('#prizeCameraLabel').firstChild.textContent = has ? '撮り直す' : '撮影する';
  if (!has) {
    box.append(el('span', { className: 'prize-empty', textContent: '景品' }));
    return;
  }
  const remove = el('button', { type: 'button', textContent: '×', ariaLabel: '景品の写真を外す' });
  remove.addEventListener('click', () => { removePrize(); renderPrize(); });
  box.append(el('img', { src: draft.prize.url, alt: '' }), remove);
}

function renderDraftPhotos() {
  const box = $('#photoPreview');
  box.replaceChildren();
  if (!draft) return;
  draft.photos.forEach((p, i) => {
    const remove = el('button', { type: 'button', textContent: '×', ariaLabel: `${i + 1}枚目の写真を外す` });
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(p.url);
      if (p.saved) draft.removedPhotoIds.push(p.id);
      draft.photos = draft.photos.filter((x) => x !== p);
      draft.dirty = true;
      renderDraftPhotos();
    });
    box.append(el('div', { className: 'thumb' }, el('img', { src: p.url, alt: '' }), remove));
  });
}

async function saveDraft() {
  if (!draft) return;
  saveNoteToDraft();
  const place = $('#placeInput').value.trim();
  const memo = $('#memoInput').value.trim();
  const detail = JSON.parse(JSON.stringify(draft.sel[draft.kind])); // undefined の項目はここで消える
  if (!detail.note) delete detail.note;
  if (!detail.tries) delete detail.tries;

  if (!draft.photos.length && !draft.prize && !place && !memo && !Object.keys(detail).length) {
    toast('何か1つ入力してください');
    return;
  }
  const btn = $('#saveBtn');
  btn.disabled = true;

  // 位置情報の取得中なら最大5秒だけ待つ
  if (draft.locState === 'loading' && draft.locPromise) {
    btn.textContent = '位置を待っています';
    await Promise.race([draft.locPromise, sleep(5000)]);
  }
  if (!draft) return;

  const record = {
    id: draft.id,
    schema: SCHEMA,                           // データ形式の版（将来の変更用）
    createdAt: draft.createdAt.toISOString(),
    updatedAt: new Date().toISOString(),
    location: draft.location,                 // {lat, lng, accuracy} または null
    place,                                    // 店舗名など
    memo,                                     // 全体のメモ
    kind: draft.kind,                         // 'hook' | 'box'
    detail,                                   // 選んだ種類の項目＋tries（手数）＋note（種類のメモ）
    prizePhotoId: draft.prize ? draft.prize.id : null,  // 景品の写真
    photoIds: draft.photos.map((p) => p.id),            // 台・全体の写真
  };
  const allPhotos = draft.prize ? [draft.prize, ...draft.photos] : draft.photos;
  const newPhotos = allPhotos.filter((p) => !p.saved).map((p) => ({ id: p.id, recordId: record.id, blob: p.blob }));
  const removed = draft.removedPhotoIds.slice();
  const wasEdit = draft.mode === 'edit';

  try {
    await dbWrite((records, photoStore) => {
      newPhotos.forEach((p) => photoStore.put(p));
      removed.forEach((id) => photoStore.delete(id));
      records.put(record);
    });
  } catch {
    btn.disabled = false;
    btn.textContent = '保存';
    toast('保存できませんでした。端末の空き容量を確認してください');
    return;
  }

  // ブラウザに「このデータを勝手に消さないで」とお願いする
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  toast('保存しました');
  if (wasEdit) {
    history.back();                 // 入力画面を閉じて詳細へ戻る
    await renderDetail(record.id);  // 詳細を新しい内容で描き直す
  } else if (!$('#detailView').hidden) {
    closeAllOnPop = true;           // 「同じ設定で新規」から来たときは一覧まで戻る
    history.go(-2);
  } else {
    history.back();
  }
  renderList();
}

/* =========================================================
   6) 一覧
   ========================================================= */
let listUrls = [];
let filter = 'all';

function isWin(rec) { return rec.detail && rec.detail.get === 'できた'; }

function tagsFor(rec) {
  const d = rec.detail || {};
  const tags = [];
  if (rec.kind) tags.push(el('span', { className: `tag tag-${rec.kind}`, textContent: KINDS[rec.kind].label }));
  if (d.get) tags.push(el('span', { className: 'tag ' + (d.get === 'できた' ? 'tag-win' : 'tag-lose'), textContent: d.get === 'できた' ? 'ゲット' : '取れず' }));
  if (d.tries) tags.push(el('span', { className: 'tag', textContent: `${d.tries}手` }));
  return tags;
}

function renderStats(records) {
  const parts = Object.entries(KINDS).map(([k, def]) => {
    const xs = records.filter((r) => r.kind === k);
    if (!xs.length) return null;
    const wins = xs.filter(isWin);
    const tries = wins.map((r) => r.detail.tries).filter(Boolean);
    const avg = tries.length ? `・平均${(tries.reduce((a, b) => a + b, 0) / tries.length).toFixed(1)}手` : '';
    return `${def.label} ${wins.length}/${xs.length}ゲット${avg}`;
  }).filter(Boolean);
  $('#stats').textContent = parts.join('　');
}

async function renderList() {
  listUrls.forEach((u) => URL.revokeObjectURL(u));
  listUrls = [];

  const all = (await dbGetAll('records')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const records = all.filter((r) => filter === 'all' || r.kind === filter || (filter === 'win' && isWin(r)));
  $('#count').textContent = all.length ? `${all.length}件` : '';
  renderStats(all);

  const empty = $('#empty');
  empty.hidden = records.length > 0;
  empty.querySelector('.empty-lead').textContent = all.length ? '条件に合う記録がありません' : 'まだ記録がありません';

  const list = $('#list');
  list.replaceChildren();
  const thumbJobs = [];
  let lastDay = '';

  records.forEach((rec) => {
    const d = new Date(rec.createdAt);
    const day = fmtDay(d);
    if (day !== lastDay) {
      list.append(el('h2', { className: 'day', textContent: day }));
      lastDay = day;
    }
    const def = KINDS[rec.kind];
    const dt = rec.detail || {};
    let keys = def ? def.summary.map((k) => dt[k]).filter(Boolean) : [];
    // 代表項目が空なら、選んである項目から最大3つ表示
    if (def && !keys.length) keys = def.fields.filter((f) => f.key !== 'get' && dt[f.key]).slice(0, 3).map((f) => dt[f.key]);
    const thumbId = rec.prizePhotoId || rec.photoIds[0];  // 景品の写真を優先してサムネに
    const sub = keys.length ? keys.join(' / ') : (rec.memo || (thumbId ? '写真のみ' : ''));

    const thumb = thumbId ? el('img', { className: 'entry-thumb', alt: '' }) : el('span');
    const item = el('button', { className: 'entry', type: 'button' },
      el('span', { className: 'entry-time', textContent: fmtTime(d) }),
      el('span', { className: 'entry-main' },
        el('span', { className: 'entry-tags' }, tagsFor(rec)),
        el('span', { className: 'entry-text' + (rec.place ? '' : ' placeholder'), textContent: rec.place || '店舗未入力' }),
        sub ? el('span', { className: 'entry-meta', textContent: sub }) : null),
      thumb);
    item.addEventListener('click', () => openDetail(rec.id));
    list.append(item);
    if (thumbId) thumbJobs.push([thumb, thumbId]);
  });

  // サムネイルは後から順に読み込む
  for (const [img, id] of thumbJobs) {
    const p = await dbGet('photos', id);
    if (p) {
      const u = URL.createObjectURL(p.blob);
      listUrls.push(u);
      img.src = u;
    }
  }
}

/* =========================================================
   7) 詳細
   ========================================================= */
let detailUrls = [];
let detailRecord = null;

async function openDetail(id) {
  if (await renderDetail(id)) showView('detailView');
}

async function renderDetail(id) {
  const rec = await dbGet('records', id);
  if (!rec) return false;
  detailUrls.forEach((u) => URL.revokeObjectURL(u));
  detailUrls = [];
  detailRecord = rec;
  const d = new Date(rec.createdAt);
  $('#detailTitle').textContent = `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d)}`;

  const body = $('#detailBody');
  body.replaceChildren();

  if (rec.prizePhotoId) {
    const p = await dbGet('photos', rec.prizePhotoId);
    if (p) {
      const u = URL.createObjectURL(p.blob);
      detailUrls.push(u);
      body.append(el('figure', { className: 'detail-prize' },
        el('img', { src: u, alt: '景品の写真' }), el('figcaption', { textContent: '景品' })));
    }
  }

  const photosBox = el('div', { className: 'detail-photos' });
  for (const pid of rec.photoIds) {
    const p = await dbGet('photos', pid);
    if (!p) continue;
    const u = URL.createObjectURL(p.blob);
    detailUrls.push(u);
    photosBox.append(el('img', { src: u, alt: '記録した写真' }));
  }
  if (photosBox.children.length) body.append(photosBox);

  body.append(el('div', { className: 'detail-tags' }, tagsFor(rec)));

  const rows = [['日時', `${fmtDay(d)} ${fmtTime(d)}`], ['店舗', rec.place || '—']];
  if (rec.location) {
    const { lat, lng } = rec.location;
    rows.push(['位置', el('a', {
      className: 'map-link',
      href: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
      target: '_blank', rel: 'noopener',
      textContent: '地図で見る',
    })]);
  }
  if (rec.memo) rows.push(['メモ', rec.memo]);
  body.append(el('dl', { className: 'meta' }, rows.map(metaRow)));

  const def = KINDS[rec.kind];
  if (def) {
    const dt = rec.detail || {};
    const kindRows = def.fields.map((f) => [f.label, dt[f.key] || '—']);
    kindRows.push(['手数', dt.tries ? `${dt.tries}手` : '—']);
    if (dt.note) kindRows.push([`${def.label}のメモ`, dt.note]);
    body.append(el('h3', { className: 'detail-head', textContent: `${def.label}の設定` }));
    body.append(el('dl', { className: 'meta meta-wide' }, kindRows.map(metaRow)));
  }
  return true;
}

function metaRow([k, v]) {
  return el('div', { className: 'meta-row' }, el('dt', { textContent: k }), el('dd', { className: 'detail-value' }, v));
}

function closeDetail() {
  detailUrls.forEach((u) => URL.revokeObjectURL(u));
  detailUrls = [];
  detailRecord = null;
}

async function deleteCurrent() {
  if (!detailRecord) return;
  if (!confirm('この記録を削除しますか？写真も一緒に消えます。')) return;
  const rec = detailRecord;
  await dbWrite((records, photos) => {
    rec.photoIds.forEach((id) => photos.delete(id));
    if (rec.prizePhotoId) photos.delete(rec.prizePhotoId);
    records.delete(rec.id);
  });
  toast('削除しました');
  history.back();
  renderList();
}

/* =========================================================
   8) 画面の切り替え（スマホの「戻る」でも閉じられるように）
   入力画面は詳細の上に重なることがあるので、一番上の画面だけ閉じる。
   ========================================================= */
let closeAllOnPop = false;

function showView(id) {
  $('#' + id).hidden = false;
  $('#' + id).scrollTop = 0;
  history.pushState({ view: id }, '');
}

function closeForm() { $('#formView').hidden = true; discardDraft(); }
function closeDetailView() { $('#detailView').hidden = true; closeDetail(); }

window.addEventListener('popstate', () => {
  if (closeAllOnPop) {
    closeAllOnPop = false;
    if (!$('#formView').hidden) closeForm();
    if (!$('#detailView').hidden) closeDetailView();
    return;
  }
  if (!$('#formView').hidden) closeForm();
  else if (!$('#detailView').hidden) closeDetailView();
});

/* =========================================================
   9) バックアップ（書き出し・読み込み）
   ========================================================= */
const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function exportAll() {
  const records = await dbGetAll('records');
  const photos = await dbGetAll('photos');
  const data = {
    app: 'crane-notes',
    version: 2,
    exportedAt: new Date().toISOString(),
    records,
    photos: await Promise.all(photos.map(async (p) => ({ id: p.id, recordId: p.recordId, dataUrl: await blobToDataURL(p.blob) }))),
  };
  const now = new Date();
  const name = `crane-notes-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });

  // iPhone などでは共有メニューで保存（ファイルAppやGoogleドライブへ）
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = el('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('ファイルを読めませんでした'); return; }
  if (!data || data.app !== 'crane-notes' || !Array.isArray(data.records)) {
    toast('このアプリのバックアップではありません');
    return;
  }
  const photos = await Promise.all((data.photos || []).map(async (p) => ({
    id: p.id, recordId: p.recordId, blob: await (await fetch(p.dataUrl)).blob(),
  })));
  await dbWrite((records, photoStore) => {
    photos.forEach((p) => photoStore.put(p));
    data.records.forEach((r) => records.put(r)); // 同じIDは上書き、新しいものは追加
  });
  toast(`${data.records.length}件を読み込みました`);
  await migrateRecords().catch(() => {});
  renderList();
}

async function showStorageInfo() {
  const info = $('#storageInfo');
  info.textContent = '';
  if (navigator.storage && navigator.storage.estimate) {
    const { usage = 0 } = await navigator.storage.estimate();
    info.textContent = `使用中の容量：約${(usage / 1024 / 1024).toFixed(1)}MB`;
  }
}

/* =========================================================
   10) Googleドライブへ書き出し（Google Apps Script 経由）
   ・写真はドライブのフォルダに1枚ずつ保存（すでにあるものは送らない）
   ・記録はスプレッドシートに1件1行で保存（同じ記録IDは上書き）
   何度押しても、増えた分・変わった分だけが反映されます。
   ========================================================= */
const GAS_URL_KEY = 'crane-notes.gasUrl';
const GAS_SECRET_KEY = 'crane-notes.gasSecret';
const PHOTO_BATCH = 4;     // 1回に送る写真の枚数
const RECORD_BATCH = 300;  // 1回に送る記録の件数

function loadDriveSettings() {
  try {
    $('#gasUrl').value = localStorage.getItem(GAS_URL_KEY) || '';
    $('#gasSecret').value = localStorage.getItem(GAS_SECRET_KEY) || '';
  } catch { /* 保存できない環境では毎回入力 */ }
}

function saveDriveSettings(url, secret) {
  try {
    localStorage.setItem(GAS_URL_KEY, url);
    localStorage.setItem(GAS_SECRET_KEY, secret);
  } catch { /* 無視 */ }
}

async function callGas(url, payload) {
  // 余計なヘッダーを付けずに送ると、ブラウザの事前確認なしで Apps Script に届く
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`通信エラー（${res.status}）`);
  let data;
  try { data = await res.json(); } catch { throw new Error('URLが正しくないか、公開設定が「全員」になっていません'); }
  if (!data.ok) throw new Error(data.error || '不明なエラー');
  return data;
}

const localDate = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;

// 記録1件を「見出し → 値」の形にする（見出しがスプレッドシートの列名になる）
function recordToRow(rec) {
  const d = new Date(rec.createdAt);
  const dt = rec.detail || {};
  const def = KINDS[rec.kind];
  const v = {
    '記録ID': rec.id,
    '日時': { date: rec.createdAt },
    '日付': localDate(d),
    '時刻': fmtTime(d),
    '曜日': WEEK[d.getDay()],
    '店舗': rec.place || '',
    '種類': def ? def.label : '',
    'ゲット': dt.get || '',
    'ゲット数': dt.get === 'できた' ? 1 : 0,
    '手数': dt.tries || '',
  };
  // フック・箱の全項目を列にする（記録していない側は空欄）
  Object.values(KINDS).forEach((k) => k.fields.forEach((f) => {
    if (f.key === 'get') return;
    if (!(f.label in v)) v[f.label] = '';
  }));
  if (def) def.fields.forEach((f) => { if (f.key !== 'get') v[f.label] = dt[f.key] || ''; });
  v['種類のメモ'] = dt.note || '';
  v['メモ'] = rec.memo || '';
  v['緯度'] = rec.location ? rec.location.lat : '';
  v['経度'] = rec.location ? rec.location.lng : '';
  v['写真枚数'] = rec.photoIds.length + (rec.prizePhotoId ? 1 : 0);
  v['作成日時'] = { date: rec.createdAt };
  v['更新日時'] = { date: rec.updatedAt || rec.createdAt };
  return { values: v, prizePhotoId: rec.prizePhotoId || null, photoIds: rec.photoIds };
}

function setSyncStatus(text) { $('#syncStatus').textContent = text; }

let syncing = false;
async function syncToDrive() {
  if (syncing) return;
  const url = $('#gasUrl').value.trim();
  const secret = $('#gasSecret').value.trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec/.test(url)) { setSyncStatus('Apps Script のURL（…/exec で終わるもの）を入れてください'); return; }
  if (!secret) { setSyncStatus('合言葉を入れてください'); return; }
  saveDriveSettings(url, secret);

  syncing = true;
  const btn = $('#syncBtn');
  btn.disabled = true;
  $('#sheetLink').hidden = true;
  try {
    const records = await dbGetAll('records');
    if (!records.length) { setSyncStatus('書き出す記録がありません'); return; }

    // 1. ドライブにまだない写真を調べる
    setSyncStatus('ドライブの写真を確認しています…');
    const photoMeta = [];
    records.forEach((r) => {
      if (r.prizePhotoId) photoMeta.push({ id: r.prizePhotoId, recordId: r.id, role: 'prize', createdAt: r.createdAt });
      r.photoIds.forEach((id) => photoMeta.push({ id, recordId: r.id, role: 'table', createdAt: r.createdAt }));
    });
    const { existing } = await callGas(url, { secret, action: 'check', photoIds: photoMeta.map((p) => p.id) });
    const have = new Set(existing);
    const missing = photoMeta.filter((p) => !have.has(p.id));

    // 2. 足りない写真を少しずつ送る
    for (let i = 0; i < missing.length; i += PHOTO_BATCH) {
      setSyncStatus(`写真を送っています… ${Math.min(i + PHOTO_BATCH, missing.length)} / ${missing.length}`);
      const batch = [];
      for (const m of missing.slice(i, i + PHOTO_BATCH)) {
        const p = await dbGet('photos', m.id);
        if (!p) continue;
        batch.push({ ...m, dataUrl: await blobToDataURL(p.blob) });
      }
      if (batch.length) await callGas(url, { secret, action: 'photos', photos: batch });
    }

    // 3. 記録をスプレッドシートへ
    const rows = records.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(recordToRow);
    let result;
    for (let i = 0; i < rows.length; i += RECORD_BATCH) {
      setSyncStatus(`スプレッドシートに書き込んでいます… ${Math.min(i + RECORD_BATCH, rows.length)} / ${rows.length}`);
      result = await callGas(url, { secret, action: 'records', rows: rows.slice(i, i + RECORD_BATCH) });
    }
    setSyncStatus(`完了：記録${rows.length}件（新しい写真${missing.length}枚）`);
    if (result && result.spreadsheetUrl) {
      $('#sheetLink').href = result.spreadsheetUrl;
      $('#sheetLink').hidden = false;
    }
    try { localStorage.setItem('crane-notes.lastSync', new Date().toISOString()); } catch { /* 無視 */ }
  } catch (e) {
    setSyncStatus(`書き出せませんでした：${e.message || e}`);
  } finally {
    syncing = false;
    btn.disabled = false;
  }
}

/* =========================================================
   11) ボタンをつなぐ
   ========================================================= */
$('#newBtn').addEventListener('click', () => openForm());
$('#cancelBtn').addEventListener('click', () => {
  const dirty = draft && (draft.dirty || $('#memoInput').value.trim() || ($('#noteInput') && $('#noteInput').value.trim()));
  if (dirty && !confirm('入力中の内容を破棄しますか？')) return;
  history.back();
});
$('#saveBtn').addEventListener('click', saveDraft);
$('#locRetry').addEventListener('click', requestLocation);
document.querySelectorAll('.kind-switch button').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));
['#placeInput', '#memoInput'].forEach((sel) => $(sel).addEventListener('input', () => { if (draft) draft.dirty = true; }));
['#cameraInput', '#pickInput'].forEach((sel) => {
  $(sel).addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = ''; // 同じ写真をもう一度選べるように
    await addFiles(files);
  });
});
$('#backBtn').addEventListener('click', () => history.back());
$('#deleteBtn').addEventListener('click', deleteCurrent);
$('#editBtn').addEventListener('click', () => detailRecord && openForm({ from: detailRecord }));
$('#dupBtn').addEventListener('click', () => detailRecord && openForm({ from: detailRecord, duplicate: true }));

$('#filters').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-filter]');
  if (!b) return;
  filter = b.dataset.filter;
  document.querySelectorAll('#filters button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderList();
});

$('#menuBtn').addEventListener('click', () => { showStorageInfo(); loadDriveSettings(); $('#menu').showModal(); });
$('#syncBtn').addEventListener('click', syncToDrive);
$('#menuClose').addEventListener('click', () => $('#menu').close());
$('#exportBtn').addEventListener('click', () => exportAll().catch(() => toast('書き出しに失敗しました')));
$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) { $('#menu').close(); await importFile(f).catch(() => toast('読み込みに失敗しました')); }
});

$('#prizeCameraInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; setPrize(f); });
$('#prizePickInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; setPrize(f); });

// 過去の記録を新しい形に直す
async function migrateRecords() {
  const records = await dbGetAll('records');
  const changed = records.filter(migrate);
  if (changed.length) await dbWrite((recs) => changed.forEach((r) => recs.put(r)));
}

migrateRecords().catch(() => {}).finally(renderList);

// オフラインでも開けるようにする（PWAの仕組み）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
