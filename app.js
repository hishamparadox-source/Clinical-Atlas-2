'use strict';
/* MedLab Atlas PWA — offline microscopic specimen atlas. Data lives in IndexedDB on this device. */

// ---------- constants (mirrors the Android app models) ----------
const SAMPLE_TYPES = {
  Stool:  { bg: '#FEF3C7', fg: '#92400E', accent: '#B45309', chapter: 'Stool Specimens' },
  Urine:  { bg: '#FEF9C3', fg: '#854D0E', accent: '#A16207', chapter: 'Urine Specimens' },
  Blood:  { bg: '#FEE2E2', fg: '#991B1B', accent: '#B91C1C', chapter: 'Blood Specimens' },
  CSF:    { bg: '#E0E7FF', fg: '#3730A3', accent: '#3730A3', chapter: 'Cerebrospinal Fluid (CSF) Specimens' },
  Sputum: { bg: '#CCFBF1', fg: '#115E59', accent: '#0F766E', chapter: 'Sputum Specimens' },
  Other:  { bg: '#E2E8F0', fg: '#334155', accent: '#334155', chapter: 'Other Specimens' },
};
const CUSTOM_PALETTE = [
  ['#E0F2FE', '#0369A1'], ['#EDE9FE', '#5B21B6'], ['#DCFCE7', '#166534'],
  ['#FCE7F3', '#9D174D'], ['#FFEDD5', '#9A3412'], ['#ECFCCB', '#3F6212'],
];
const DEFAULTS = {
  technicianSignature: '', autoUpdateSignature: true, labTitle: 'MedLab Atlas',
  defaultSampleType: 'Stool', customSampleTypes: [],
  defaultObjectiveLens: '40x (High Dry)', defaultDiagnostic: 'Cyst',
  diagnosticPresets: ['Trophozoite', 'Cyst', 'Egg', 'Crystal', 'Cast', 'Bacteria', 'Parasite', 'Other'],
  objectiveLensPresets: ['4x (Scanning)', '10x (Low Power)', '40x (High Dry)', '100x (Oil Immersion)'],
  tagPresets: ['High Clarity', 'Stained', 'Motile', 'Urgent Review', 'Confirmed', 'Reference Case', 'Teaching Slide', 'Artifact Present'],
  defaultTags: [], pdfImageSize: 'Standard', defaultSort: 'DATE_NEWEST', dark: false,
};
const SORTS = {
  DATE_NEWEST: 'Date (Newest First)', DATE_OLDEST: 'Date (Oldest First)', TAG: 'Tag (A–Z)',
  SAMPLE_TYPE: 'Sample Type (A–Z)', DIAGNOSTIC: 'Diagnostic (A–Z)', PATIENT_ID: 'Patient ID (A–Z)',
};
const PDF_IMG_HEIGHT = { Compact: 165, Standard: 230, Large: 310 }; // pt, same as Android

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
function toast(msg) { const t = h(`<div class="toast">${esc(msg)}</div>`); document.body.append(t); setTimeout(() => t.remove(), 2400); }
function hash(s) { let x = 0; for (const c of s) x = (Math.imul(31, x) + c.charCodeAt(0)) | 0; return x & 0x7fffffff; }
const fmtDate = ts => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// ---------- IndexedDB ----------
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('medlab-atlas', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
        r.result.createObjectStore('kv');
      };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode); const s = t.objectStore(store);
      const out = fn(s); t.oncomplete = () => res(out.result ?? out); t.onerror = () => rej(t.error);
    });
  },
  all: () => new Promise((res, rej) => { const r = DB.db.transaction('records').objectStore('records').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
  put: rec => new Promise((res, rej) => { const r = DB.db.transaction('records', 'readwrite').objectStore('records').put(rec); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
  del: id => DB.tx('records', 'readwrite', s => s.delete(id)),
  clear: () => DB.tx('records', 'readwrite', s => s.clear()),
  getKV: k => new Promise(res => { const r = DB.db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => res(undefined); }),
  setKV: (k, v) => DB.tx('kv', 'readwrite', s => s.put(v, k)),
};

// ---------- state ----------
const S = {
  records: [], settings: { ...DEFAULTS }, search: '', sampleFilter: 'ALL', tagFilter: 'ALL',
  sort: 'DATE_NEWEST', urls: new Map(),
};
function imgUrl(rec) {
  if (!rec.image) return '';
  let u = S.urls.get(rec.id + ':' + rec.updatedAt);
  if (!u) { u = URL.createObjectURL(rec.image); S.urls.set(rec.id + ':' + rec.updatedAt, u); }
  return u;
}
const sampleLabel = r => (r.customSampleType || '').trim() || r.sampleType;
function sampleStyle(r) {
  const label = sampleLabel(r);
  const built = Object.keys(SAMPLE_TYPES).find(k => k.toLowerCase() === label.toLowerCase());
  if (built) { const t = SAMPLE_TYPES[built]; return { bg: t.bg, fg: t.fg, accent: t.accent }; }
  const [bg, fg] = CUSTOM_PALETTE[hash(label.toLowerCase()) % CUSTOM_PALETTE.length];
  return { bg, fg, accent: fg };
}
function chapterTitle(r) {
  const label = sampleLabel(r);
  const built = Object.keys(SAMPLE_TYPES).find(k => k.toLowerCase() === label.toLowerCase());
  if (built) return SAMPLE_TYPES[built].chapter;
  return /specimens$/i.test(label) ? label : label + ' Specimens';
}
const filterKey = r => sampleLabel(r).toLowerCase();

async function load() {
  await DB.open();
  const saved = await DB.getKV('settings');
  S.settings = { ...DEFAULTS, ...(saved || {}) };
  S.sort = S.settings.defaultSort;
  S.records = await DB.all();
  applyTheme();
}
function applyTheme() {
  document.documentElement.dataset.theme = S.settings.dark ? 'dark' : 'light';
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = S.settings.dark ? '#0B1120' : '#0F2942';
}
async function saveSettings() { await DB.setKV('settings', S.settings); applyTheme(); }

// ---------- filtering / sorting ----------
function visibleRecords(sort = S.sort, onlyFiltered = true) {
  let list = [...S.records];
  if (onlyFiltered) {
    const q = S.search.trim().toLowerCase();
    if (S.sampleFilter !== 'ALL') list = list.filter(r => filterKey(r) === S.sampleFilter);
    if (S.tagFilter !== 'ALL') list = list.filter(r => (r.imageTags || []).includes(S.tagFilter));
    if (q) list = list.filter(r => [r.patientId, r.diagnosticCategory, sampleLabel(r), r.technicianSignature, r.clinicalNotes, ...(r.imageTags || [])].join(' ').toLowerCase().includes(q));
  }
  const cmp = {
    DATE_NEWEST: (a, b) => b.createdAt - a.createdAt, DATE_OLDEST: (a, b) => a.createdAt - b.createdAt,
    TAG: (a, b) => ((a.imageTags || [])[0] || '~').localeCompare((b.imageTags || [])[0] || '~'),
    SAMPLE_TYPE: (a, b) => sampleLabel(a).localeCompare(sampleLabel(b)),
    DIAGNOSTIC: (a, b) => (a.diagnosticCategory || '').localeCompare(b.diagnosticCategory || ''),
    PATIENT_ID: (a, b) => (a.patientId || '').localeCompare(b.patientId || '', undefined, { numeric: true }),
  }[sort];
  return list.sort(cmp);
}

// ---------- main screen ----------
function render() {
  const app = $('#app');
  const keep = document.activeElement && document.activeElement.id === 'q' ? document.activeElement.selectionStart : null;
  const labels = [...Object.keys(SAMPLE_TYPES), ...S.settings.customSampleTypes];
  const counts = {}; S.records.forEach(r => { const k = filterKey(r); counts[k] = (counts[k] || 0) + 1; });
  const sampleChips = labels.filter(l => counts[l.toLowerCase()]).map(l => ({ key: l.toLowerCase(), label: l, n: counts[l.toLowerCase()] }));
  Object.keys(counts).forEach(k => { if (!sampleChips.find(c => c.key === k)) sampleChips.push({ key: k, label: k, n: counts[k] }); });
  const tags = [...new Set(S.records.flatMap(r => r.imageTags || []))].sort();
  const list = visibleRecords();

  app.innerHTML = `
  <header class="top">
    <div class="top-row">
      <div style="flex:1"><h1>${esc(S.settings.labTitle)}</h1><small>${S.records.length} specimen${S.records.length === 1 ? '' : 's'} • stored on this device</small></div>
      <button class="icon-btn" id="btn-pdf" title="Export PDF">📄</button>
      <button class="icon-btn" id="btn-set" title="Settings">⚙️</button>
    </div>
    <input id="q" class="search" type="search" placeholder="Search by Patient ID, Diagnosis, Tag, or Examiner..." value="${esc(S.search)}">
  </header>
  <div class="chips">
    <button class="chip ${S.sampleFilter === 'ALL' ? 'on' : ''}" data-s="ALL">All (${S.records.length})</button>
    ${sampleChips.map(c => `<button class="chip ${S.sampleFilter === c.key ? 'on' : ''}" data-s="${esc(c.key)}">${esc(c.label)} (${c.n})</button>`).join('')}
  </div>
  ${tags.length ? `<div class="chips"><button class="chip tag ${S.tagFilter === 'ALL' ? 'on' : ''}" data-t="ALL">All Tags</button>
    ${tags.map(t => `<button class="chip tag ${S.tagFilter === t ? 'on' : ''}" data-t="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
  <div class="toolbar"><select id="sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <span class="hint">${list.length} shown</span></div>
  ${list.length ? `<div class="grid">${list.map(cardHtml).join('')}</div>` :
    `<div class="empty"><div style="font-size:48px">🔬</div><h3>${S.records.length ? 'No matching samples' : 'No specimens yet'}</h3>
     ${S.records.length ? '<button class="btn" id="reset">Reset Filters</button>' : '<p>Capture or import your first microscopic image.</p>'}</div>`}
  <button class="fab" id="fab">＋ Capture Sample</button>`;

  $('#q').oninput = e => { S.search = e.target.value; render(); };
  if (keep !== null) { const q = $('#q'); q.focus(); q.setSelectionRange(keep, keep); }
  $('#sort').onchange = e => { S.sort = e.target.value; render(); };
  app.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { S.sampleFilter = b.dataset.s; render(); });
  app.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { S.tagFilter = b.dataset.t; render(); });
  app.querySelectorAll('.card').forEach(c => c.onclick = () => openDetail(+c.dataset.id));
  $('#fab').onclick = () => openEditor();
  $('#btn-set').onclick = openSettings;
  $('#btn-pdf').onclick = openPdfExport;
  const rs = $('#reset'); if (rs) rs.onclick = () => { S.search = ''; S.sampleFilter = 'ALL'; S.tagFilter = 'ALL'; render(); };
}
function cardHtml(r) {
  const st = sampleStyle(r);
  return `<div class="card" data-id="${r.id}"><img loading="lazy" src="${imgUrl(r)}" alt="">
  <div class="body"><span class="badge" style="background:${st.bg};color:${st.fg}">${esc(sampleLabel(r))}</span>
  <h3>${esc(r.patientId)}</h3><p>${esc(r.diagnosticCategory)} • ${esc(r.objectiveLens)}</p>
  <p>${esc(r.gender)}, ${r.age} y • ${new Date(r.createdAt).toLocaleDateString()}</p>
  ${(r.imageTags || []).length ? `<div class="tags">${r.imageTags.map(t => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}</div></div>`;
}

// ---------- modal helper ----------
function modal(inner, { full = false } = {}) {
  const ov = h(`<div class="overlay"><div class="sheet ${full ? 'full' : ''}">${inner}</div></div>`);
  ov.addEventListener('mousedown', e => { if (e.target === ov && !ov.dataset.sticky) ov.remove(); });
  document.body.append(ov); return ov;
}
function optionList(items, sel) { return items.map(i => `<option ${i === sel ? 'selected' : ''}>${esc(i)}</option>`).join(''); }

// ---------- detail ----------
function openDetail(id) {
  const r = S.records.find(x => x.id === id); if (!r) return;
  const st = sampleStyle(r);
  const ov = modal(`<img src="${imgUrl(r)}" style="width:100%;border-radius:14px">
  <div style="margin:12px 0"><span class="badge" style="background:${st.bg};color:${st.fg}">${esc(sampleLabel(r))}</span></div>
  <div class="sec">
    <div class="kv"><span>Patient ID</span><b>${esc(r.patientId)}</b></div>
    <div class="kv"><span>Gender / Age</span><span>${esc(r.gender)}, ${r.age}</span></div>
    <div class="kv"><span>Objective lens</span><span>${esc(r.objectiveLens)}</span></div>
    <div class="kv"><span>Diagnostic</span><span>${esc(r.diagnosticCategory)}</span></div>
    <div class="kv"><span>Examiner</span><span>${esc(r.technicianSignature || '—')}</span></div>
    <div class="kv"><span>Captured</span><span>${fmtDate(r.createdAt)}</span></div>
    <div class="kv"><span>Updated</span><span>${fmtDate(r.updatedAt)}</span></div></div>
  ${(r.imageTags || []).length ? `<div class="tags" style="margin-bottom:10px">${r.imageTags.map(t => `<span>#${esc(t)}</span>`).join('')}</div>` : ''}
  <div class="sec"><h3>Clinical notes</h3><div style="white-space:pre-wrap">${esc(r.clinicalNotes || '—')}</div></div>
  <div class="actions"><button class="btn danger" id="d-del">Delete</button><button class="btn" id="d-pdf">PDF report</button>
  <button class="btn" id="d-share">Share image</button><button class="btn primary" id="d-edit">Edit</button><button class="btn" id="d-close">Close</button></div>`, { full: true });
  $('#d-close', ov).onclick = () => ov.remove();
  $('#d-edit', ov).onclick = () => { ov.remove(); openEditor(r); };
  $('#d-pdf', ov).onclick = () => { ov.remove(); printRecords([r], { single: true }); };
  $('#d-share', ov).onclick = async () => {
    const f = new File([r.image], `${r.patientId}.jpg`, { type: r.image.type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) navigator.share({ files: [f], title: r.patientId }).catch(() => { });
    else { const a = document.createElement('a'); a.href = imgUrl(r); a.download = f.name; a.click(); }
  };
  $('#d-del', ov).onclick = async () => {
    if (!confirm(`Delete Patient record (${r.patientId}) and its image permanently from this device?`)) return;
    await DB.del(r.id); S.records = S.records.filter(x => x.id !== r.id); ov.remove(); render(); toast('Record deleted');
  };
}

// ---------- editor ----------
function openEditor(rec) {
  const st = S.settings, isNew = !rec;
  const d = rec ? { ...rec, imageTags: [...(rec.imageTags || [])] } : {
    patientId: '', gender: 'Male', age: '', sampleType: st.defaultSampleType, customSampleType: '',
    objectiveLens: st.defaultObjectiveLens, diagnosticCategory: st.defaultDiagnostic, clinicalNotes: '',
    technicianSignature: st.technicianSignature, image: null, imageTags: [...st.defaultTags],
  };
  const sampleOpts = [...Object.keys(SAMPLE_TYPES), ...st.customSampleTypes];
  const cur = (d.customSampleType || '').trim() || d.sampleType;
  if (!sampleOpts.includes(cur)) sampleOpts.push(cur);
  const allTags = [...new Set([...st.tagPresets, ...d.imageTags])];
  const ov = modal(`<h2>${isNew ? 'New specimen' : 'Edit specimen'}</h2>
  <div class="preview" id="pv">${d.image ? `<img src="${URL.createObjectURL(d.image)}">` : '<span class="hint">No image selected</span>'}</div>
  <div class="wrap" style="margin-top:8px">
    <button class="btn sm" id="e-cam">📷 Camera</button><button class="btn sm" id="e-gal">🖼 Gallery</button>
    <button class="btn sm" id="e-studio" ${d.image ? '' : 'disabled'}>✂️ Crop / Resize / Annotate</button></div>
  <input type="file" id="f-cam" accept="image/*" capture="environment" hidden><input type="file" id="f-gal" accept="image/*" hidden>
  <label class="f">Patient ID *</label><input class="in" id="e-pid" value="${esc(d.patientId)}">
  <div class="row"><div><label class="f">Gender</label><select class="in" id="e-gen">${optionList(['Male', 'Female'], d.gender)}</select></div>
  <div><label class="f">Age *</label><input class="in" id="e-age" type="number" min="0" max="130" value="${esc(d.age)}"></div></div>
  <label class="f">Sample type</label><select class="in" id="e-st">${optionList(sampleOpts, cur)}</select>
  <div class="row"><div><label class="f">Objective lens</label><select class="in" id="e-lens">${optionList([...new Set([...st.objectiveLensPresets, d.objectiveLens])], d.objectiveLens)}</select></div>
  <div><label class="f">Diagnostic</label><select class="in" id="e-dx">${optionList([...new Set([...st.diagnosticPresets, d.diagnosticCategory])], d.diagnosticCategory)}</select></div></div>
  <label class="f">Image tags</label><div class="wrap" id="e-tags">${allTags.map(t => `<button type="button" class="chip tag ${d.imageTags.includes(t) ? 'on' : ''}" data-t="${esc(t)}">#${esc(t)}</button>`).join('')}</div>
  <label class="f">Clinical notes</label><textarea class="in" id="e-notes">${esc(d.clinicalNotes)}</textarea>
  <label class="f">Technician signature</label><input class="in" id="e-sig" value="${esc(d.technicianSignature)}">
  <div class="actions"><button class="btn" id="e-cancel">Cancel</button><button class="btn primary" id="e-save">Save</button></div>`, { full: true });
  ov.dataset.sticky = '1';

  const setImage = blob => {
    d.image = blob; $('#pv', ov).innerHTML = `<img src="${URL.createObjectURL(blob)}">`; $('#e-studio', ov).disabled = false;
  };
  const pick = async f => { if (!f) return; const bm = await downscale(f, 2400); setImage(bm); openStudio(d.image, setImage); };
  $('#e-cam', ov).onclick = () => $('#f-cam', ov).click();
  $('#e-gal', ov).onclick = () => $('#f-gal', ov).click();
  $('#f-cam', ov).onchange = e => pick(e.target.files[0]);
  $('#f-gal', ov).onchange = e => pick(e.target.files[0]);
  $('#e-studio', ov).onclick = () => openStudio(d.image, setImage);
  ov.querySelectorAll('#e-tags .chip').forEach(b => b.onclick = () => {
    const t = b.dataset.t, i = d.imageTags.indexOf(t); if (i >= 0) d.imageTags.splice(i, 1); else d.imageTags.push(t); b.classList.toggle('on');
  });
  $('#e-cancel', ov).onclick = () => ov.remove();
  $('#e-save', ov).onclick = async () => {
    const pid = $('#e-pid', ov).value.trim(), age = parseInt($('#e-age', ov).value, 10);
    if (!d.image) return toast('Please add a microscopic image');
    if (!pid) return toast('Patient ID is required');
    if (isNaN(age) || age < 0) return toast('Enter a valid age');
    const sel = $('#e-st', ov).value;
    const builtin = Object.keys(SAMPLE_TYPES).includes(sel);
    const now = Date.now();
    const out = {
      ...(rec ? { id: rec.id, createdAt: rec.createdAt } : { createdAt: now }),
      patientId: pid, gender: $('#e-gen', ov).value, age,
      sampleType: builtin ? sel : 'Other', customSampleType: builtin ? '' : sel,
      objectiveLens: $('#e-lens', ov).value, diagnosticCategory: $('#e-dx', ov).value,
      clinicalNotes: $('#e-notes', ov).value.trim(), technicianSignature: $('#e-sig', ov).value.trim(),
      image: d.image, imageTags: d.imageTags, updatedAt: now,
    };
    const id = await DB.put(out); out.id = out.id ?? id;
    if (rec) S.records = S.records.map(x => x.id === out.id ? out : x); else S.records.push(out);
    if (S.settings.autoUpdateSignature && out.technicianSignature) { S.settings.technicianSignature = out.technicianSignature; saveSettings(); }
    ov.remove(); render(); toast('Saved');
  };
}

// ---------- image helpers ----------
function loadImg(blob) {
  return new Promise((res, rej) => { const u = URL.createObjectURL(blob), i = new Image(); i.onload = () => { res(i); }; i.onerror = rej; i.src = u; });
}
async function downscale(blob, max) {
  const i = await loadImg(blob); const k = Math.min(1, max / Math.max(i.naturalWidth, i.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(i.naturalWidth * k); c.height = Math.round(i.naturalHeight * k);
  c.getContext('2d').drawImage(i, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
}

// ---------- image studio: crop, resize, annotate ----------
async function openStudio(blob, onApply) {
  let img = await loadImg(blob);
  let work = document.createElement('canvas');
  const setWork = src => { work.width = src.naturalWidth || src.width; work.height = src.naturalHeight || src.height; work.getContext('2d').drawImage(src, 0, 0); };
  setWork(img);
  let tab = 'crop', aspect = null, crop = null, annos = [], tool = 'arrow', color = '#EF4444', stroke = 1, drag = null;
  const ASPECTS = { Original: null, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '16:9': 16 / 9 };
  const ov = modal(`<div class="studio"><h2>Image studio</h2>
    <div class="tabs"><button class="chip" data-tab="crop">Crop</button><button class="chip" data-tab="resize">Resize</button><button class="chip" data-tab="annotate">Annotate</button></div>
    <canvas id="cv"></canvas><div id="ctrl" style="margin-top:10px"></div><div class="hint" id="dim" style="margin-top:6px"></div>
    <div class="actions"><button class="btn" id="s-cancel">Cancel</button><button class="btn primary" id="s-done">Use image</button></div></div>`, { full: true });
  ov.dataset.sticky = '1';
  const cv = $('#cv', ov), ctx = cv.getContext('2d');

  function fitCanvas() { cv.width = work.width; cv.height = work.height; }
  function initCrop() {
    const r = aspect ?? work.width / work.height; let w = work.width, hh = w / r;
    if (hh > work.height) { hh = work.height; w = hh * r; }
    crop = { x: (work.width - w) / 2, y: (work.height - hh) / 2, w, h: hh };
  }
  function draw() {
    fitCanvas(); ctx.drawImage(work, 0, 0);
    if (tab === 'crop' && crop) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, cv.width, crop.y); ctx.fillRect(0, crop.y + crop.h, cv.width, cv.height);
      ctx.fillRect(0, crop.y, crop.x, crop.h); ctx.fillRect(crop.x + crop.w, crop.y, cv.width, crop.h);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, cv.width / 400); ctx.strokeRect(crop.x, crop.y, crop.w, crop.h);
    }
    if (tab === 'annotate' || annos.length) annos.forEach(a => drawAnno(ctx, a, cv.width, cv.height));
    if (drag && drag.a) drawAnno(ctx, drag.a, cv.width, cv.height);
    $('#dim', ov).textContent = `${work.width} × ${work.height} px`;
  }
  function drawAnno(c, a, W, H) {
    const lw = Math.max(3, Math.min(W, H) / 120) * a.stroke; c.strokeStyle = c.fillStyle = a.color; c.lineWidth = lw; c.lineCap = 'round';
    if (a.type === 'circle') { c.beginPath(); c.arc(a.cx * W, a.cy * H, a.r * Math.min(W, H), 0, Math.PI * 2); c.stroke(); }
    else {
      const x1 = a.x1 * W, y1 = a.y1 * H, x2 = a.x2 * W, y2 = a.y2 * H, ang = Math.atan2(y2 - y1, x2 - x1), hd = lw * 4.5;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2 - Math.cos(ang) * hd * .6, y2 - Math.sin(ang) * hd * .6); c.stroke();
      c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - hd * Math.cos(ang - .45), y2 - hd * Math.sin(ang - .45)); c.lineTo(x2 - hd * Math.cos(ang + .45), y2 - hd * Math.sin(ang + .45)); c.closePath(); c.fill();
    }
  }
  function controls() {
    ov.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    const c = $('#ctrl', ov);
    if (tab === 'crop') {
      c.innerHTML = `<div class="wrap">${Object.keys(ASPECTS).map(k => `<button class="chip ${ASPECTS[k] === aspect ? 'on' : ''}" data-a="${k}">${k}</button>`).join('')}</div>
      <div class="hint" style="margin:6px 0">Drag on the image to move the crop box.</div><button class="btn sm primary" id="apply-crop">Apply crop</button>`;
      c.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { aspect = ASPECTS[b.dataset.a]; initCrop(); controls(); draw(); });
      $('#apply-crop', c).onclick = () => {
        const n = document.createElement('canvas'); n.width = Math.round(crop.w); n.height = Math.round(crop.h);
        n.getContext('2d').drawImage(work, crop.x, crop.y, crop.w, crop.h, 0, 0, n.width, n.height); work = n; annos = []; initCrop(); draw();
      };
    } else if (tab === 'resize') {
      c.innerHTML = `<div class="wrap">${[['Small (800px)', 800], ['Medium (1200px)', 1200], ['Large (1600px)', 1600]].map(([l, v]) => `<button class="chip" data-r="${v}">${l}</button>`).join('')}</div>
      <div class="hint" style="margin-top:6px">Longest side is scaled down to the chosen size (never enlarged).</div>`;
      c.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
        const m = +b.dataset.r, k = Math.min(1, m / Math.max(work.width, work.height));
        const n = document.createElement('canvas'); n.width = Math.round(work.width * k); n.height = Math.round(work.height * k);
        n.getContext('2d').drawImage(work, 0, 0, n.width, n.height); work = n; initCrop(); draw(); toast(`Resized to ${n.width}×${n.height}`);
      });
    } else {
      c.innerHTML = `<div class="wrap"><button class="chip ${tool === 'arrow' ? 'on' : ''}" data-tool="arrow">➚ Arrow</button><button class="chip ${tool === 'circle' ? 'on' : ''}" data-tool="circle">◯ Circle</button>
      ${['#EF4444', '#FACC15', '#22C55E', '#38BDF8', '#FFFFFF', '#000000'].map(k => `<button class="chip" data-c="${k}" style="background:${k};width:34px;height:30px;${k === color ? 'outline:3px solid var(--primary)' : ''}"></button>`).join('')}</div>
      <div class="row" style="margin-top:8px;align-items:center"><span class="hint">Stroke</span><input type="range" min="0.5" max="3" step="0.25" value="${stroke}" id="stk"><button class="btn sm" id="undo">Undo</button><button class="btn sm" id="clear">Clear</button></div>`;
      c.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => { tool = b.dataset.tool; controls(); });
      c.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { color = b.dataset.c; controls(); });
      $('#stk', c).oninput = e => stroke = +e.target.value;
      $('#undo', c).onclick = () => { annos.pop(); draw(); }; $('#clear', c).onclick = () => { annos = []; draw(); };
    }
  }
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
  cv.onpointerdown = e => {
    cv.setPointerCapture(e.pointerId); const p = pos(e);
    if (tab === 'crop') drag = { sx: p.x, sy: p.y, cx: crop.x, cy: crop.y };
    else if (tab === 'annotate') drag = { sx: p.x, sy: p.y, a: null };
  };
  cv.onpointermove = e => {
    if (!drag) return; const p = pos(e);
    if (tab === 'crop') {
      crop.x = Math.min(work.width - crop.w, Math.max(0, drag.cx + (p.x - drag.sx) * work.width));
      crop.y = Math.min(work.height - crop.h, Math.max(0, drag.cy + (p.y - drag.sy) * work.height));
    } else if (tab === 'annotate') {
      drag.a = tool === 'circle'
        ? { type: 'circle', cx: drag.sx, cy: drag.sy, r: Math.hypot((p.x - drag.sx) * work.width, (p.y - drag.sy) * work.height) / Math.min(work.width, work.height), color, stroke }
        : { type: 'arrow', x1: drag.sx, y1: drag.sy, x2: p.x, y2: p.y, color, stroke };
    }
    draw();
  };
  cv.onpointerup = () => { if (drag && drag.a) { const a = drag.a; if ((a.type === 'circle' && a.r > .005) || (a.type === 'arrow' && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) > .01)) annos.push(a); } drag = null; draw(); };
  ov.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; controls(); draw(); });
  $('#s-cancel', ov).onclick = () => ov.remove();
  $('#s-done', ov).onclick = () => {
    drag = null; const prev = tab; tab = 'annotate'; draw(); tab = prev; // burn annotations, no crop overlay
    const out = document.createElement('canvas'); out.width = work.width; out.height = work.height;
    const o = out.getContext('2d'); o.drawImage(work, 0, 0); annos.forEach(a => drawAnno(o, a, out.width, out.height));
    out.toBlob(b => { onApply(b); ov.remove(); }, 'image/jpeg', 0.92);
  };
  initCrop(); controls(); draw();
}

// ---------- settings ----------
function openSettings() {
  const st = S.settings;
  const lines = a => a.join('\n');
  const ov = modal(`<h2>Settings</h2>
  <div class="sec"><h3>Laboratory</h3>
    <label class="f">Lab title (shown in app & PDF)</label><input class="in" id="s-title" value="${esc(st.labTitle)}">
    <label class="f">Technician signature</label><input class="in" id="s-sig" value="${esc(st.technicianSignature)}">
    <div class="switch"><span>Auto-update signature from last save</span><input type="checkbox" id="s-auto" ${st.autoUpdateSignature ? 'checked' : ''}></div>
    <div class="switch"><span>Dark theme</span><input type="checkbox" id="s-dark" ${st.dark ? 'checked' : ''}></div></div>
  <div class="sec"><h3>Defaults for new samples</h3>
    <div class="row"><div><label class="f">Sample type</label><select class="in" id="s-dst">${optionList([...Object.keys(SAMPLE_TYPES), ...st.customSampleTypes], st.defaultSampleType)}</select></div>
    <div><label class="f">Lens</label><select class="in" id="s-dlens">${optionList(st.objectiveLensPresets, st.defaultObjectiveLens)}</select></div></div>
    <div class="row"><div><label class="f">Diagnostic</label><select class="in" id="s-ddx">${optionList(st.diagnosticPresets, st.defaultDiagnostic)}</select></div>
    <div><label class="f">Default sort</label><select class="in" id="s-dsort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === st.defaultSort ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
    <label class="f">PDF image size</label><select class="in" id="s-pdfsz">${optionList(Object.keys(PDF_IMG_HEIGHT), st.pdfImageSize)}</select></div>
  <div class="sec"><h3>Presets (one per line)</h3>
    <label class="f">Custom sample types</label><textarea class="in" id="s-cst">${esc(lines(st.customSampleTypes))}</textarea>
    <label class="f">Diagnostic categories</label><textarea class="in" id="s-dxp">${esc(lines(st.diagnosticPresets))}</textarea>
    <label class="f">Objective lenses</label><textarea class="in" id="s-lp">${esc(lines(st.objectiveLensPresets))}</textarea>
    <label class="f">Tags</label><textarea class="in" id="s-tp">${esc(lines(st.tagPresets))}</textarea>
    <label class="f">Default tags (comma separated)</label><input class="in" id="s-dtags" value="${esc(st.defaultTags.join(', '))}"></div>
  <div class="sec"><h3>Backup & restore</h3><p class="hint">Everything (records, images, settings) is saved only on this device. Export a backup regularly.</p>
    <div class="wrap"><button class="btn" id="b-exp">Export backup (.json)</button><button class="btn" id="b-imp">Import backup</button>
    <button class="btn danger" id="b-wipe">Erase all data</button></div><input type="file" id="b-file" accept="application/json" hidden></div>
  <div class="actions"><button class="btn" id="s-cancel">Cancel</button><button class="btn primary" id="s-save">Save</button></div>`, { full: true });
  const split = id => $(id, ov).value.split('\n').map(s => s.trim()).filter(Boolean);
  $('#s-cancel', ov).onclick = () => ov.remove();
  $('#s-save', ov).onclick = async () => {
    const dxp = split('#s-dxp'), lp = split('#s-lp'), cst = split('#s-cst');
    Object.assign(st, {
      labTitle: $('#s-title', ov).value.trim() || DEFAULTS.labTitle, technicianSignature: $('#s-sig', ov).value.trim(),
      autoUpdateSignature: $('#s-auto', ov).checked, dark: $('#s-dark', ov).checked,
      customSampleTypes: cst, diagnosticPresets: dxp.length ? dxp : DEFAULTS.diagnosticPresets,
      objectiveLensPresets: lp.length ? lp : DEFAULTS.objectiveLensPresets, tagPresets: split('#s-tp'),
      defaultTags: $('#s-dtags', ov).value.split(',').map(s => s.trim()).filter(Boolean),
      defaultSampleType: $('#s-dst', ov).value, defaultObjectiveLens: $('#s-dlens', ov).value, defaultDiagnostic: $('#s-ddx', ov).value,
      defaultSort: $('#s-dsort', ov).value, pdfImageSize: $('#s-pdfsz', ov).value,
    });
    await saveSettings(); ov.remove(); render(); toast('Settings saved');
  };
  $('#b-exp', ov).onclick = exportBackup;
  $('#b-imp', ov).onclick = () => $('#b-file', ov).click();
  $('#b-file', ov).onchange = async e => { const f = e.target.files[0]; if (f) { await importBackup(f); ov.remove(); } };
  $('#b-wipe', ov).onclick = async () => {
    if (!confirm('Erase ALL records and images from this device? This cannot be undone.')) return;
    await DB.clear(); S.records = []; ov.remove(); render(); toast('All data erased');
  };
}
const blobToDataUrl = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
async function exportBackup() {
  const recs = await Promise.all(S.records.map(async r => ({ ...r, image: await blobToDataUrl(r.image) })));
  const blob = new Blob([JSON.stringify({ app: 'medlab-atlas', version: 1, exportedAt: Date.now(), settings: S.settings, records: recs })], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `medlab-atlas-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  toast('Backup exported');
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'medlab-atlas') throw new Error('Not a MedLab Atlas backup');
    if (!confirm(`Import ${data.records.length} records? Existing data will be replaced.`)) return;
    await DB.clear();
    for (const r of data.records) { const blob = await (await fetch(r.image)).blob(); const { id, ...rest } = r; await DB.put({ ...rest, id, image: blob }); }
    S.settings = { ...DEFAULTS, ...data.settings }; await saveSettings(); S.records = await DB.all(); render(); toast('Backup restored');
  } catch (e) { alert('Import failed: ' + e.message); }
}

// ---------- PDF export (print-to-PDF, A4 booklet) ----------
function openPdfExport() {
  if (!S.records.length) return toast('Nothing to export yet');
  const o = { scope: 'GROUP', single: S.records[0].id, sel: 'SORTED', layout: 'CHAPTERS', onlyFiltered: false, sort: S.sort, manual: [] };
  const ov = modal(`<h2>Export clinical booklet (PDF)</h2><div id="pdf-body"></div>
  <div class="actions"><button class="btn" id="p-cancel">Cancel</button><button class="btn primary" id="p-go">Generate PDF</button></div>
  <p class="hint">Opens the print dialog — choose “Save as PDF” as the destination.</p>`, { full: true });
  const body = $('#pdf-body', ov);
  const draw = () => {
    body.innerHTML = `<div class="wrap"><button class="chip ${o.scope === 'SINGLE' ? 'on' : ''}" data-sc="SINGLE">Single Sample</button><button class="chip ${o.scope === 'GROUP' ? 'on' : ''}" data-sc="GROUP">Group Booklet</button></div>
    ${o.scope === 'SINGLE' ? `<label class="f">Specimen</label><select class="in" id="p-one">${S.records.map(r => `<option value="${r.id}" ${r.id == o.single ? 'selected' : ''}>${esc(r.patientId)} — ${esc(sampleLabel(r))}</option>`).join('')}</select>` : `
    <label class="f">Selection</label><div class="wrap"><button class="chip ${o.sel === 'SORTED' ? 'on' : ''}" data-se="SORTED">Sorted List</button><button class="chip ${o.sel === 'MANUAL' ? 'on' : ''}" data-se="MANUAL">Manual Select</button></div>
    ${o.sel === 'SORTED' ? `<div class="switch"><span>Only currently filtered records</span><input type="checkbox" id="p-filt" ${o.onlyFiltered ? 'checked' : ''}></div>
      <label class="f">Sort</label><select class="in" id="p-sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === o.sort ? 'selected' : ''}>${v}</option>`).join('')}</select>` :
      `<label class="f">Pick cases (tap order = print order)</label><div class="wrap">${S.records.map(r => { const i = o.manual.indexOf(r.id); return `<button class="chip ${i >= 0 ? 'on' : ''}" data-m="${r.id}">${i >= 0 ? (i + 1) + '. ' : ''}${esc(r.patientId)} · ${esc(sampleLabel(r))}</button>`; }).join('')}</div>`}
    <label class="f">Layout</label><div class="wrap"><button class="chip ${o.layout === 'CHAPTERS' ? 'on' : ''}" data-ly="CHAPTERS">Grouped by Sample</button><button class="chip ${o.layout === 'UNIFIED' ? 'on' : ''}" data-ly="UNIFIED">Preserve Order</button></div>`}`;
    body.querySelectorAll('[data-sc]').forEach(b => b.onclick = () => { o.scope = b.dataset.sc; draw(); });
    body.querySelectorAll('[data-se]').forEach(b => b.onclick = () => { o.sel = b.dataset.se; draw(); });
    body.querySelectorAll('[data-ly]').forEach(b => b.onclick = () => { o.layout = b.dataset.ly; draw(); });
    body.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { const id = +b.dataset.m, i = o.manual.indexOf(id); if (i >= 0) o.manual.splice(i, 1); else o.manual.push(id); draw(); });
    const one = $('#p-one', body); if (one) one.onchange = e => o.single = +e.target.value;
    const f = $('#p-filt', body); if (f) f.onchange = e => o.onlyFiltered = e.target.checked;
    const s = $('#p-sort', body); if (s) s.onchange = e => o.sort = e.target.value;
  };
  draw();
  $('#p-cancel', ov).onclick = () => ov.remove();
  $('#p-go', ov).onclick = () => {
    let recs, opts = {};
    if (o.scope === 'SINGLE') { recs = S.records.filter(r => r.id === o.single); opts.single = true; }
    else if (o.sel === 'MANUAL') { recs = o.manual.map(id => S.records.find(r => r.id === id)).filter(Boolean); if (!recs.length) return toast('Select at least one case'); }
    else recs = visibleRecords(o.sort, o.onlyFiltered);
    if (!recs.length) return toast('No records match');
    opts.chapters = o.scope === 'GROUP' && o.layout === 'CHAPTERS';
    ov.remove(); printRecords(recs, opts);
  };
}
async function printRecords(recs, { single = false, chapters = false } = {}) {
  const st = S.settings, imgH = PDF_IMG_HEIGHT[st.pdfImageSize] * 0.3528; // pt -> mm
  const when = new Date().toLocaleString();
  const dataUrls = new Map(await Promise.all(recs.map(async r => [r.id, await blobToDataUrl(r.image)])));
  const caseHtml = (r, n) => { const s = sampleStyle(r); return `<div class="case" style="border-top:4px solid ${s.accent}">
    <h3>${single ? 'Single Specimen Report' : 'Case #' + n} • Patient ID: ${esc(r.patientId)}</h3>
    <img src="${dataUrls.get(r.id)}" style="height:${imgH}mm">
    <table><tr><td>Sample</td><td><b style="color:${s.accent}">${esc(sampleLabel(r))}</b></td></tr>
    <tr><td>Gender / Age</td><td>${esc(r.gender)}, ${r.age} years</td></tr>
    <tr><td>Objective lens</td><td>${esc(r.objectiveLens)}</td></tr>
    <tr><td>Diagnostic</td><td>${esc(r.diagnosticCategory)}</td></tr>
    ${(r.imageTags || []).length ? `<tr><td>Tags</td><td>${r.imageTags.map(t => '#' + esc(t)).join('  ')}</td></tr>` : ''}
    <tr><td>Clinical notes</td><td style="white-space:pre-wrap">${esc(r.clinicalNotes || '—')}</td></tr>
    <tr><td>Examiner</td><td>${esc(r.technicianSignature || '—')}</td></tr>
    <tr><td>Captured</td><td>${fmtDate(r.createdAt)}</td></tr></table></div>`; };
  let html = '';
  if (single) {
    html = `<div class="banner" style="margin-bottom:14px"><h1>${esc(st.labTitle)}</h1><div>Single Specimen Report</div></div>${caseHtml(recs[0], 1)}`;
  } else {
    const groups = new Map(); recs.forEach(r => { const k = filterKey(r); if (!groups.has(k)) groups.set(k, { title: chapterTitle(r), list: [] }); groups.get(k).list.push(r); });
    const stat = (v, l) => `<div><b>${v}</b>${l}</div>`;
    html = `<div class="cover"><div class="banner"><h1>${esc(st.labTitle)}</h1><div style="font-size:16px">Clinical Microscopy Atlas</div><div style="opacity:.8;margin-top:6px">Generated ${esc(when)}</div></div>
      <div class="stats">${stat(recs.length, 'Specimens')}${stat(groups.size, 'Sample types')}${stat(new Set(recs.map(r => r.patientId)).size, 'Patients')}</div>
      <div class="toc"><h3>${chapters ? 'Atlas Contents by Specimen Type' : 'Included Specimens in Export Order'}</h3><ol>
      ${chapters ? [...groups.values()].map(g => `<li>${esc(g.title)} — ${g.list.length}</li>`).join('') : recs.map(r => `<li>${esc(r.patientId)} — ${esc(sampleLabel(r))}</li>`).join('')}</ol></div></div>`;
    if (chapters) { let i = 0; [...groups.values()].forEach((g, ci) => { html += `<div class="chapter">Chapter ${ci + 1}: ${esc(g.title)} — (${g.list.length} ${g.list.length === 1 ? 'case' : 'cases'})</div>`; g.list.forEach(r => { html += caseHtml(r, ++i); }); }); }
    else recs.forEach((r, i) => { html += caseHtml(r, i + 1); });
  }
  html += `<div class="foot">${esc(st.labTitle)} • Generated ${esc(when)}</div>`;
  const root = $('#print-root'); root.innerHTML = `<div class="pdf">${html}</div>`;
  const imgs = [...root.querySelectorAll('img')]; await Promise.all(imgs.map(i => i.decode().catch(() => { })));
  const prevTitle = document.title; document.title = `${st.labTitle} - ${single ? recs[0].patientId : 'Atlas'}`;
  window.onafterprint = () => { root.innerHTML = ''; document.title = prevTitle; window.onafterprint = null; };
  setTimeout(() => window.print(), 100);
}

// ---------- boot ----------
load().then(render).catch(e => { document.body.innerHTML = '<p style="padding:20px">Storage unavailable: ' + esc(e.message) + '</p>'; });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
