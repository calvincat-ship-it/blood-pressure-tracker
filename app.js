const APP_VERSION = 'v29.01';
const STORAGE_KEY = 'bp_records_v1';
const SETTINGS_KEY = 'bp_settings_v1';
const PHOTO_DB_NAME = 'bp_photos_db';
const PHOTO_STORE = 'photos';
// Cap on how many readings keep an attached photo: only the newest MAX_PHOTOS
// (by reading date/time) retain their photo; older photos are auto-deleted from
// IndexedDB (and therefore from every backup) to keep storage small. The record
// numbers are always kept — only the image is dropped.
const MAX_PHOTOS = 30;

// Cloud backup constants — declared at the top because loadCloudState() (called
// with the other top-level state below) reads CLOUD_KEY; a const referenced
// before its declaration line executes throws a TDZ ReferenceError.
const GOOGLE_CLIENT_ID = '682239566772-fjhc69ef2dgup26hmrtiqj8eefuq1fu9.apps.googleusercontent.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const CLOUD_KEY = 'bp_cloud_v1';
const CLOUD_FILE_NAME = 'bp-backup.json';
const CLOUD_PREV_NAME = 'bp-backup.prev.json';
const CLOUD_DEBOUNCE_MS = 8000;

/** @typedef {{id:string,date:string,time:string,systolic:number,diastolic:number,pulse:number|null,tag:string,note:string,photoId:string|null}} Reading */

function openPhotoDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PHOTO_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(PHOTO_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function savePhoto(id, blob) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    tx.objectStore(PHOTO_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getPhoto(id) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readonly');
    const req = tx.objectStore(PHOTO_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deletePhoto(id) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, 'readwrite');
    tx.objectStore(PHOTO_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deletePhotos(ids) {
  return Promise.all(ids.filter(Boolean).map((id) => deletePhoto(id).catch(() => {})));
}

function resizePhoto(file, maxDim = 1000, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        blob ? resolve(blob) : reject(new Error('resize failed'));
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

function loadReadings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveReadings(readings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(readings));
  maybeDailySnapshot();
  scheduleCloudBackup();
}

const MED_KEY = 'bp_med_logs_v1';

/** @returns {Object.<string,string[]>} map of date(YYYY-MM-DD) -> array of medication times(HH:MM) */
function loadMedLogs() {
  try {
    return JSON.parse(localStorage.getItem(MED_KEY)) || {};
  } catch {
    return {};
  }
}

function saveMedLogs(m) {
  localStorage.setItem(MED_KEY, JSON.stringify(m));
  maybeDailySnapshot();
  scheduleCloudBackup();
}

function medTimesFor(date) {
  return (medLogs[date] || []).slice().sort();
}

// ---- Weight log ----
// One weight (kg) per day, keyed by local date. Backed up alongside readings
// and medication logs (cloud + local file). Recorded via the daily prompt or
// manually from the ⚖️ header button.
const WEIGHT_KEY = 'bp_weight_logs_v1';

/** @returns {Object.<string,number>} map of date(YYYY-MM-DD) -> weight in kg */
function loadWeightLogs() {
  try {
    return JSON.parse(localStorage.getItem(WEIGHT_KEY)) || {};
  } catch {
    return {};
  }
}

function saveWeightLogs(m) {
  localStorage.setItem(WEIGHT_KEY, JSON.stringify(m));
  maybeDailySnapshot();
  scheduleCloudBackup();
}

// The most recent medication time taken at or before a reading's time on the
// same day, or null if the reading was before that day's first dose.
function lastMedBeforeReading(r) {
  let last = null;
  for (const t of medTimesFor(r.date)) {
    if (t <= r.time) last = t; else break;
  }
  return last;
}

// Natural Chinese phrasing: 「08:00服藥」 rather than 「服藥後 08:00」.
function medLabelFor(r) {
  const t = lastMedBeforeReading(r);
  return t ? `${t}服藥` : '尚未用藥';
}

function loadSettings() {
  const defaults = {
    email: '', frequency: 'weekly', customDays: 14, autoClear: false, lastSentAt: null,
    reminderEnabled: false, reminderTimes: ['08:00', '13:00', '20:00'],
    highBpAlertEnabled: false, highBpAlertMode: 'auto', highBpCustomSystolic: 130, highBpCustomDiastolic: 80,
    medReminderEnabled: false, medReminderTime: '08:00', medReminderOverdueMin: 30, medReminderRepeatMin: 30,
    reportName: '', reportId: '', rememberReportInfo: false,
    showManualOnOpen: false, manualSeenVersion: '',
    weightPromptEnabled: true, weightPromptDate: '',
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) };
  } catch {
    return defaults;
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function nextDueDate(s) {
  const d = new Date(s.lastSentAt);
  if (s.frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (s.frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + Math.max(1, Number(s.customDays) || 14));
  return d;
}

// Due purely on the schedule now — no Email address is required, since the
// report can be shared, saved or printed however the user prefers.
function isReminderDue(s, readingsList) {
  if (readingsList.length === 0) return false;
  if (!s.lastSentAt) return true;
  return new Date() >= nextDueDate(s);
}

function buildCsv(list) {
  const header = '日期,時間,收縮壓,舒張壓,心跳,時段,備註\n';
  const rows = sortByDateTime(list).map(r =>
    [r.date, r.time, r.systolic, r.diastolic, r.pulse ?? '', r.tag, `"${(r.note || '').replace(/"/g, '""')}"`].join(',')
  );
  return '﻿' + header + rows.join('\n');
}

function classify(systolic, diastolic) {
  if (systolic > 180 || diastolic > 120) return { label: '高血壓危象', cls: 'crisis' };
  if (systolic >= 140 || diastolic >= 90) return { label: '第二期高血壓', cls: 'stage2' };
  if (systolic >= 130 || diastolic >= 80) return { label: '第一期高血壓', cls: 'stage1' };
  if (systolic >= 120) return { label: '偏高', cls: 'elevated' };
  return { label: '正常', cls: 'normal' };
}

function meetsHighBpThreshold(r, s) {
  if (s.highBpAlertMode === 'custom') {
    const sysThreshold = Number(s.highBpCustomSystolic) || 130;
    const diaThreshold = Number(s.highBpCustomDiastolic) || 80;
    return r.systolic >= sysThreshold || r.diastolic >= diaThreshold;
  }
  const cls = classify(r.systolic, r.diastolic).cls;
  return cls === 'stage1' || cls === 'stage2' || cls === 'crisis';
}

function sortByDateTime(readings) {
  return [...readings].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${m}/${d}`;
}

// Local calendar date (YYYY-MM-DD) using the device's own timezone.
// IMPORTANT: never use Date.toISOString() for a date — that is UTC and is a
// day behind for UTC+ timezones (e.g. Taiwan) between local midnight and the
// UTC-offset hour, which desynced the entry date and the daily med-card reset.
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localTimeStr(d = new Date()) {
  return d.toTimeString().slice(0, 5);
}

const form = document.getElementById('entryForm');
const editIdInput = document.getElementById('editId');
const submitBtn = document.getElementById('submitBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');
const historyList = document.getElementById('historyList');
const emptyState = document.getElementById('emptyState');
const toast = document.getElementById('toast');
const chartRangeSelect = document.getElementById('chartRange');

let readings = loadReadings();
let medLogs = loadMedLogs();
let weightLogs = loadWeightLogs();
let settings = loadSettings();
let cloudState = loadCloudState();
let suppressCloud = false; // set while applying a restore, to avoid a re-upload loop
let reminderDismissedThisSession = false;
let chartDateFilter = { start: '', end: '' };
let historyDateFilter = { start: '', end: '' };
let pendingPhotoBlob = null;
let pendingPhotoRemoved = false;
let currentPhotoId = null;

function filterByRange(list, range) {
  if (!range.start && !range.end) return list;
  return list.filter(r => {
    if (range.start && r.date < range.start) return false;
    if (range.end && r.date > range.end) return false;
    return true;
  });
}

function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 1800);
}

function resetForm() {
  form.reset();
  document.getElementById('moreFields').open = false;
  editIdInput.value = '';
  submitBtn.textContent = '新增血壓記錄';
  cancelEditBtn.hidden = true;
  pendingPhotoBlob = null;
  pendingPhotoRemoved = false;
  currentPhotoId = null;
  hidePhotoPreview();
  document.getElementById('useNowTime').checked = true;
  applyUseNowTime();
}

function refreshNowFields() {
  const now = new Date();
  document.getElementById('fieldDate').value = localDateStr(now);
  document.getElementById('fieldTime').value = localTimeStr(now);
}

// When "自動使用現在時間" is on, the date/time fields are locked to the current
// device time (and refreshed to "now"); turning it off lets the user set the
// blood-pressure record time manually.
function applyUseNowTime() {
  const useNow = document.getElementById('useNowTime').checked;
  const dateEl = document.getElementById('fieldDate');
  const timeEl = document.getElementById('fieldTime');
  dateEl.disabled = useNow;
  timeEl.disabled = useNow;
  if (useNow) refreshNowFields();
}

function showPhotoPreview(blob) {
  const url = URL.createObjectURL(blob);
  const img = document.getElementById('photoPreview');
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = url;
  document.getElementById('photoPreviewWrap').hidden = false;
}

function hidePhotoPreview() {
  const img = document.getElementById('photoPreview');
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = '';
  document.getElementById('photoPreviewWrap').hidden = true;
}

async function startEdit(id) {
  const r = readings.find(x => x.id === id);
  if (!r) return;
  editIdInput.value = r.id;
  document.getElementById('useNowTime').checked = false;
  applyUseNowTime();
  document.getElementById('fieldDate').value = r.date;
  document.getElementById('fieldTime').value = r.time;
  document.getElementById('fieldSystolic').value = r.systolic;
  document.getElementById('fieldDiastolic').value = r.diastolic;
  document.getElementById('fieldPulse').value = r.pulse ?? '';
  document.getElementById('fieldTag').value = r.tag || '';
  document.getElementById('fieldNote').value = r.note || '';
  document.getElementById('moreFields').open = !!(r.tag || r.note || r.photoId);
  submitBtn.textContent = '儲存變更';
  cancelEditBtn.hidden = false;
  pendingPhotoBlob = null;
  pendingPhotoRemoved = false;
  currentPhotoId = r.photoId || null;
  if (r.photoId) {
    const blob = await getPhoto(r.photoId);
    if (blob) showPhotoPreview(blob); else hidePhotoPreview();
  } else {
    hidePhotoPreview();
  }
  window.scrollTo({ top: form.offsetTop - 20, behavior: 'smooth' });
}

function deleteReading(id) {
  if (!confirm('確定要刪除這筆紀錄嗎？')) return;
  const target = readings.find(x => x.id === id);
  readings = readings.filter(x => x.id !== id);
  saveReadings(readings);
  renderAll();
  showToast('已刪除');
  if (target && target.photoId) deletePhoto(target.photoId).catch(() => {});
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  // When 自動使用現在時間 is on, force the device's current time at the moment of
  // submit — never trust a possibly-stale field left over from before midnight.
  let entryDate, entryTime;
  if (document.getElementById('useNowTime').checked) {
    const now = new Date();
    entryDate = localDateStr(now);
    entryTime = localTimeStr(now);
  } else {
    entryDate = document.getElementById('fieldDate').value;
    entryTime = document.getElementById('fieldTime').value;
    if (!entryDate || !entryTime) {
      showToast('請填寫日期與時間');
      return;
    }
  }

  const systolic = Number(document.getElementById('fieldSystolic').value);
  const diastolic = Number(document.getElementById('fieldDiastolic').value);
  const pulseRaw = document.getElementById('fieldPulse').value;

  // Basic plausibility check: systolic must be above diastolic (catches values
  // entered in the wrong fields, e.g. 80/120).
  if (systolic <= diastolic) {
    showToast('收縮壓應大於舒張壓，請確認數值是否輸入正確');
    return;
  }

  let photoId = currentPhotoId;
  if (pendingPhotoRemoved && currentPhotoId) {
    await deletePhoto(currentPhotoId);
    photoId = null;
  }
  if (pendingPhotoBlob) {
    if (currentPhotoId && !pendingPhotoRemoved) {
      await deletePhoto(currentPhotoId);
    }
    photoId = crypto.randomUUID();
    await savePhoto(photoId, pendingPhotoBlob);
  }

  const entry = {
    id: editIdInput.value || crypto.randomUUID(),
    date: entryDate,
    time: entryTime,
    systolic,
    diastolic,
    pulse: pulseRaw ? Number(pulseRaw) : null,
    tag: document.getElementById('fieldTag').value,
    note: document.getElementById('fieldNote').value.trim(),
    photoId,
  };

  const priorSameDayHigh = readings.some(x => x.id !== entry.id && x.date === entry.date && meetsHighBpThreshold(x, settings));

  if (editIdInput.value) {
    readings = readings.map(x => x.id === entry.id ? entry : x);
    showToast('已更新紀錄');
  } else {
    readings.push(entry);
    showToast('已新增紀錄');
  }
  await enforcePhotoLimit(); // keep only the newest MAX_PHOTOS photos on device + in backups
  saveReadings(readings);
  resetForm();
  renderAll();

  // Only prompt to take medication if none has been recorded for that day yet;
  // once the user has logged today's dose the reminder is redundant.
  const medTakenThatDay = medTimesFor(entry.date).length > 0;
  if (settings.highBpAlertEnabled && !medTakenThatDay && !priorSameDayHigh && meetsHighBpThreshold(entry, settings)) {
    alert('目前您的血壓有過高的情況，請記得服藥以控制血壓');
  }
});

cancelEditBtn.addEventListener('click', resetForm);

document.getElementById('useNowTime').addEventListener('change', applyUseNowTime);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  handleDayRollover();
  if (document.getElementById('useNowTime').checked && !editIdInput.value) refreshNowFields();
});

document.getElementById('photoCaptureBtn').addEventListener('click', () => {
  document.getElementById('fieldPhotoInput').click();
});

document.getElementById('fieldPhotoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const blob = await resizePhoto(file);
    pendingPhotoBlob = blob;
    pendingPhotoRemoved = false;
    showPhotoPreview(blob);
  } catch {
    showToast('照片處理失敗');
  }
});

document.getElementById('removePhotoBtn').addEventListener('click', () => {
  pendingPhotoBlob = null;
  pendingPhotoRemoved = true;
  hidePhotoPreview();
});

function exportCsv(list) {
  if (list.length === 0) {
    showToast('此區間沒有資料可匯出');
    return;
  }
  const blob = new Blob([buildCsv(list)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `血壓紀錄_${localDateStr()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const exportRangeSelect = document.getElementById('exportRange');

function toggleExportCustomRow() {
  document.getElementById('exportCustomRow').hidden = exportRangeSelect.value !== 'custom';
}

exportRangeSelect.addEventListener('change', toggleExportCustomRow);

function getExportRangeList() {
  const type = exportRangeSelect.value;
  if (type === '30') {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 29);
    return filterByRange(readings, { start: localDateStr(start), end: localDateStr(end) });
  }
  if (type === 'custom') {
    const start = document.getElementById('exportStart').value;
    const end = document.getElementById('exportEnd').value;
    return filterByRange(readings, { start, end });
  }
  return readings;
}

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  exportCsv(getExportRangeList());
});

// ---- Printable doctor report ----
// Self-contained report shown in an on-screen overlay and printed via a
// dedicated off-screen iframe, so printing never depends on hiding the app
// with @media print (which unreliably printed the homepage on some devices).

const REPORT_CSS = `
.rp { color:#000; font-size:12px; line-height:1.4;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang TC","Noto Sans TC",sans-serif; }
.rp h1 { font-size:18px; margin:0 0 6px; }
.rp .rp-head { margin-bottom:10px; }
.rp .rp-id { font-size:13px; font-weight:700; margin:2px 0 4px; }
.rp .rp-gen { color:#555; font-size:11px; margin:2px 0; }
.rp table { width:100%; border-collapse:collapse; background:#fff; }
.rp .rp-summary { margin-bottom:10px; }
.rp .rp-summary th, .rp .rp-summary td { border:1px solid #999; padding:4px 6px; text-align:left; font-size:11px; }
.rp .rp-summary th { background:#eee; width:22%; }
.rp .rp-warn { color:#a8271f; font-weight:700; margin:4px 0 10px; }
.rp .rp-chart { width:100%; max-width:680px; height:auto; margin-bottom:12px; border:1px solid #ccc; }
.rp .rp-log th, .rp .rp-log td { border:1px solid #999; padding:3px 5px; font-size:10.5px; text-align:center; }
.rp .rp-log th { background:#eee; }
.rp .rp-log td:last-child { text-align:left; }
.rp .rp-log tr { page-break-inside:avoid; }
`;

let currentReportInner = '';

function reportInfoLine(info) {
  return [
    info && info.name ? `姓名：${info.name}` : '',
    info && info.id ? `身分證字號／病歷號：${info.id}` : '',
  ].filter(Boolean).join('　');
}

function buildReportInner(list, info) {
  const sorted = sortByDateTime(list);
  const s = computeStats(list);
  const span = `${sorted[0].date} ～ ${sorted[sorted.length - 1].date}`;
  const idLine = reportInfoLine(info);

  let chartImg = '';
  try {
    const cv = document.createElement('canvas');
    drawChart(cv, sorted.slice(-60), 680, 220);
    chartImg = `<img class="rp-chart" src="${cv.toDataURL('image/png')}" alt="血壓趨勢圖">`;
  } catch {}

  const catBits = Object.keys(CAT_LABELS)
    .filter(k => s.cats[k] > 0)
    .map(k => `${CAT_LABELS[k]} ${s.cats[k]}`)
    .join('、');

  const rows = sorted.map(r => {
    const c = classify(r.systolic, r.diastolic);
    return `<tr><td>${r.date}</td><td>${r.time}</td><td>${r.systolic}/${r.diastolic}</td><td>${r.pulse ?? ''}</td><td>${c.label}</td><td>${medLabelFor(r)}</td><td>${escapeHtml(r.note || '')}</td></tr>`;
  }).join('');

  return `<style>${REPORT_CSS}</style><div class="rp">
      <div class="rp-head">
        <h1>血壓紀錄報告</h1>
        ${idLine ? `<p class="rp-id">${escapeHtml(idLine)}</p>` : ''}
        <p>統計區間：${span}　共 ${s.count} 筆</p>
        <p class="rp-gen">產生時間：${new Date().toLocaleString('zh-TW')}</p>
      </div>
      <table class="rp-summary">
        <tr><th>平均血壓</th><td>${s.avgSys}/${s.avgDia} mmHg</td><th>達標率(&lt;130/80)</th><td>${s.atGoalPct}%</td></tr>
        <tr><th>晨間平均</th><td>${s.morning ? `${s.morning.sys}/${s.morning.dia}` : '—'}</td><th>晚間平均</th><td>${s.evening ? `${s.evening.sys}/${s.evening.dia}` : '—'}</td></tr>
        <tr><th>最高收縮壓</th><td>${s.max.sys}/${s.max.dia}（${s.max.date}）</td><th>最低收縮壓</th><td>${s.min.sys}/${s.min.dia}（${s.min.date}）</td></tr>
        <tr><th>分級分布</th><td colspan="3">${catBits}</td></tr>
      </table>
      ${s.morningHigh ? '<p class="rp-warn">⚠ 晨間平均血壓偏高（≥135/85），建議與醫師討論。</p>' : ''}
      ${chartImg}
      <table class="rp-log">
        <thead><tr><th>日期</th><th>時間</th><th>血壓</th><th>心跳</th><th>分級</th><th>服藥</th><th>備註</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ---- User manual ----
// Single source of truth for the manual: rendered both as the in-app view and
// as the downloadable PDF. IMPORTANT: whenever a feature changes, update these
// sections and bump APP_VERSION so users are shown the manual once.

const MANUAL_SECTIONS = [
  {
    t: '一、首頁',
    lines: [
      '首頁固定顯示三張卡片，不需捲動即可看完。',
      '「最近一次／近 7 天平均」：顯示最新一筆血壓與分級，以及近七天的平均值。',
      '「新增血壓記錄」：輸入血壓的主要位置。',
      '「用藥記錄」：一鍵記錄今天的服藥時間。',
      '標題列右上三個圖示：📈 趨勢圖、📋 歷史紀錄、⚙ 設定。',
    ],
  },
  {
    t: '二、新增血壓記錄',
    lines: [
      '預設勾選「自動使用現在時間」，日期時間會鎖定為當下，送出時再次以當下時間計算，避免跨午夜存到舊日期。',
      '取消勾選後，即可自行設定這筆記錄的日期與時間（補登過去的量測值時使用）。',
      '必填：收縮壓、舒張壓；心跳為選填。',
      '若收縮壓小於或等於舒張壓，系統會擋下並提示，避免數值填反。',
      '「更多選項」可展開填寫時段（起床／睡前／飯後／運動後）、備註，以及拍攝照片。',
      '為節省儲存空間，照片僅保留最新的 30 張；超過後較舊的照片會自動刪除，該筆紀錄的血壓數值與備註仍完整保留，只有照片會被移除（本機與雲端備份一致）。',
    ],
  },
  {
    t: '三、用藥記錄',
    lines: [
      '「用藥時間」欄位預設為現在時間；若服藥後過一段時間才補記錄，可直接改成實際的服藥時間，按「現在」可一鍵填回目前時間。',
      '按「💊 記錄服藥」並確認後，即記下該欄位的服藥時間（需確認以避免誤觸）。',
      '已記錄的時間會以膠囊顯示，點 ✕ 並確認後可刪除。',
      '畫面每日 00:00 自動重置為「今日尚未記錄服藥」。',
      '歷史各天的服藥時間會完整保留，供醫師參考，不會被清除。',
    ],
  },
  {
    t: '四、趨勢圖與統計摘要',
    lines: [
      '由標題列 📈 開啟。可選顯示筆數，或以起訖日期篩選。',
      '圖上三條線分別為收縮壓、舒張壓、心跳。',
      '虛線為目標線（收縮壓 130、舒張壓 80），用來判斷是否達標。',
      '綠色 ▲ 標記為服藥時間點，可對照服藥前後的血壓變化。',
      '統計摘要包含：筆數、平均、達標率（<130/80）、晨間與晚間平均、最高與最低收縮壓、各分級分布。',
      '若晨間平均達 135/85 以上，會顯示晨間高血壓提醒。',
    ],
  },
  {
    t: '五、歷史紀錄',
    lines: [
      '由標題列 📋 開啟，可用起訖日期篩選。',
      '每筆顯示日期時間、血壓、心跳、分級，以及服藥狀態。',
      '服藥狀態：該筆記錄在當天首次服藥之前顯示紅字「尚未用藥」；在服藥之後則顯示該筆記錄前最近一次的服藥時間，例如「08:00服藥」。',
      '✎ 編輯：會關閉歷史視窗並帶入表單修改；🗑 刪除、🖼 檢視照片。',
      '「清除全部」會先確認並顯示筆數，此動作無法復原。',
    ],
  },
  {
    t: '六、提醒功能',
    lines: [
      '量測提醒：每天最多三個時間點。時間到就提醒；若因手機休眠或未開啟 App 而錯過，會在兩小時內補提醒一次。',
      '每日用藥提醒：設定用藥時間、逾時幾分鐘開始提醒、以及提醒間隔。一旦按下「記錄現在服藥」即自動停止，隔天重新判斷。',
      '高血壓服藥提醒：當日第一次出現偏高血壓時提醒服藥；若當天已記錄用藥則不再提醒。',
      '定期報告提醒：依設定週期提醒您產生血壓報告。',
      '重要：本 App 無伺服器，提醒需要頁面保持開啟（可切到背景分頁）。App 完全關閉時無法送出通知。',
    ],
  },
  {
    t: '七、血壓報告（給醫師）',
    lines: [
      '於設定中選擇範圍後按「📄 產生報告」。',
      '產生前會詢問是否填寫姓名與身分證字號／病歷號，兩者皆為選填，可直接選「略過不輸入」。',
      '勾選「記住這些資料」才會存在本機；未勾選則僅用於該次報告，不會保存。',
      '報告內容包含統計摘要、趨勢圖，以及完整記錄表（含每筆的服藥狀態）。',
      '產生後可選擇：📤 分享 PDF（開啟手機分享選單，可選 Email、LINE 等）、💾 儲存 PDF、🖨 列印。',
    ],
  },
  {
    t: '八、匯出與備份',
    lines: [
      '匯出 CSV：依所選範圍輸出試算表格式，方便自行分析。',
      '雲端備份（Google Drive）：在設定中按「連結 Google 雲端備份」並用 Google 帳號登入後，App 會自動把所有紀錄、用藥與設定備份到你自己 Google 雲端硬碟的 App 專屬隱藏空間。',
      '雲端備份的資料只存在你自己的 Google 帳號，不會經過任何伺服器，開發者也看不到。',
      '連結後會顯示目前登入的 Google 帳號，方便確認備份到哪個帳號。',
      '第一次連結授權後，之後開啟、重新整理或手動備份／還原通常都不需要再次授權（只要仍登入該 Google 帳號）。',
      '連結後每次變動都會自動備份；也可按「立即備份」或「從雲端還原」。換手機時，在新手機登入同一個 Google 帳號即可從雲端還原。',
      '雲端備份區塊會顯示同步狀態：正常顯示「上次備份時間」；備份進行中顯示「備份中…」；若因手機休眠或登入逾時導致自動備份未成功，會顯示橘色「有變更尚未備份成功」提醒，此時按「立即備份」即可補上（回到 App 前景時也會自動重試）。',
      '當偵測到自動備份失敗時，首頁上方也會直接出現一張橘色警示卡片，卡片上就有「立即備份」按鈕，不必進入設定即可補上備份；備份成功後卡片會自動消失。',
      '歷史版本：連結雲端後，每天第一次新增血壓或用藥記錄時，會自動在雲端保留一份「當天之前」的歷史版本，最多保留 7 份（超過會自動刪除最舊一份）。',
      '按「從雲端還原」時會列出可還原的版本：預設選「最新版本（即時）」，也可改選某一天的歷史版本。還原較舊的版本後，該版本會成為雲端最新版本，並同步到其他裝置。',
      '多台裝置：開啟 App 時若偵測到雲端有較新的備份，會詢問是否還原到本機（採最後儲存者優先，並保留前一版以防萬一）。',
      '更換帳號：按「更換帳號」（或先解除連結再連結另一個 Google 帳號）時，App 會先清除此裝置上前一個帳號的所有資料，再改用新帳號的雲端資料還原，避免不同帳號的資料混在一起。前一個帳號的雲端備份仍會保留，之後可再切回。',
      '照片保留上限：為避免占用過多空間，照片（本機與雲端備份）僅保留最新的 30 張，較舊的照片會自動刪除，僅保留該筆紀錄的血壓數值與備註。',
      '本機備份檔：也可將所有紀錄、設定與照片匯出成一個檔案離線保存；匯入還原會「完全覆蓋」目前資料，執行前會先確認（還原時同樣只會保留最新 30 張照片）。',
      '清除歷史資料：設定中提供「清除歷史資料」，可選擇僅清除本機資料、僅清除雲端備份資料、或兩者都清除。此操作無法復原，選擇後會再次確認；清除雲端資料需 Google 帳號授權，清除完成後會解除此裝置的雲端連結。',
      '更換手機或瀏覽器前，請先完成雲端備份或匯出本機備份檔。',
    ],
  },
  {
    t: '九、資料與版本說明',
    lines: [
      '所有資料只存在您自己的手機（localStorage 與 IndexedDB），沒有帳號，也不會上傳到任何伺服器。',
      '清除瀏覽器資料會一併刪除紀錄，請定期備份。',
      '設定頁最下方會顯示目前版本，可確認是否已更新到最新版。',
      '版本更新後，開啟 App 會自動顯示一次「本次更新內容」摘要；完整使用說明可隨時到設定中的「開啟完整使用說明」查看。若勾選設定中的「每次開啟時主動顯示使用說明」，則每次開啟都會顯示完整說明。',
      '介面會自動跟隨手機的淺色／深色模式：手機切到深色時，App 也會自動變成深色配色，不需另外設定。',
    ],
  },
  {
    t: '十、體重記錄',
    lines: [
      '每天第一次開啟 App 時，會主動跳出視窗詢問是否記錄今天的體重（單位：公斤 kg）；輸入後按「記錄體重」即可，或按「略過」關閉。',
      '也可隨時點標題列的 ⚖️ 開啟體重記錄視窗，補登或修改今日體重。',
      '同一天再次記錄會覆蓋當天的體重；視窗下方會列出過往每天的體重，以及相較前一筆的增減（kg）。',
      '若不想每天被詢問，可到「設定 → ⏰ 提醒設定 → 每日體重記錄提醒」關閉自動詢問；仍可隨時用 ⚖️ 手動記錄。',
      '體重資料會一併納入雲端備份與本機備份檔。',
    ],
  },
];

// Short per-version highlights shown once after an update (instead of the full
// manual). Key by APP_VERSION; keep only recent entries. Falls back to a generic
// note if the running version has no explicit entry.
const WHATS_NEW = {
  'v29.01': [
    '用藥記錄新增「用藥時間」欄位：預設為現在時間，若延遲一段時間才補記錄，可直接輸入實際的服藥時間。',
    '按一下「現在」即可把時間一鍵填回目前時間。',
  ],
  'v29': [
    '新增體重記錄：每天第一次開啟 App 時，會主動詢問是否記錄今天的體重（公斤）。',
    '可從標題列的 ⚖️ 隨時開啟體重記錄視窗，補登或修改今日體重，並查看過往紀錄與每日增減。',
    '不想每天被詢問，可到「設定 → ⏰ 提醒設定 → 每日體重記錄提醒」關閉；體重資料也會一併納入雲端與本機備份。',
  ],
  'v28.02': [
    '為節省儲存空間，照片現在僅保留最新的 30 張；超過後較舊的照片會自動刪除，該筆紀錄的血壓數值與備註仍完整保留，只有照片會被移除。',
    '此規則同時套用於手機本機與雲端／本機備份，讓備份檔不會因照片過多而變得龐大。',
  ],
  'v28.01': [
    '設定介面中的「定期報告提醒」已移到「📄 報告與匯出」分區，與報告相關功能放在一起更好找。',
  ],
  'v28': [
    '版本更新時，開啟 App 只會顯示「本次更新內容」重點，不再每次跳出整份使用說明。',
    '設定介面改為可收合的大分區（提醒設定 / 報告與匯出 / 資料與雲端備份 / 使用說明），一進設定不用一直往下捲，點開需要的分區即可。',
    '首頁在偵測到雲端自動備份失敗時，會直接顯示警示卡片與「立即備份」按鈕，不必進設定。',
  ],
};

const MANUAL_CSS = `
.mn { color:#000; font-size:13px; line-height:1.65;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang TC","Noto Sans TC",sans-serif; }
.mn h1 { font-size:19px; margin:0 0 4px; }
.mn .mn-sub { color:#555; font-size:12px; margin:0 0 12px; }
.mn h2 { font-size:15px; margin:14px 0 6px; padding-bottom:3px; border-bottom:1px solid #ccc; }
.mn ul { margin:0; padding-left:18px; }
.mn li { margin:3px 0; }
`;

function buildManualHtml() {
  const body = MANUAL_SECTIONS.map(sec =>
    `<h2>${escapeHtml(sec.t)}</h2><ul>${sec.lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
  ).join('');
  return `<style>${MANUAL_CSS}</style><div class="mn">
      <h1>血壓記錄 App 使用說明</h1>
      <p class="mn-sub">適用版本：${APP_VERSION}　說明產生日期：${localDateStr()}</p>
      ${body}
    </div>`;
}

// ---- PDF generation: lay the report out on A4 canvases, embed each as a
// JPEG in a hand-built minimal PDF. Keeps the app dependency-free, and
// rasterising avoids having to embed a CJK font. ----

const PDF_PAGE_W = 1240;  // A4 at ~150dpi
const PDF_PAGE_H = 1754;
const PDF_MARGIN = 60;
const PDF_FONT = '"PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif';

function pdfFont(size, weight = '') {
  return `${weight} ${size}px ${PDF_FONT}`.trim();
}

function newReportPage() {
  const cv = document.createElement('canvas');
  cv.width = PDF_PAGE_W;
  cv.height = PDF_PAGE_H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PDF_PAGE_W, PDF_PAGE_H);
  ctx.textBaseline = 'middle';
  return { cv, ctx };
}

function drawCells(ctx, x, y, widths, cells, opts = {}) {
  const h = opts.height || 34;
  let cx = x;
  cells.forEach((cell, i) => {
    const w = widths[i];
    ctx.fillStyle = (opts.fills && opts.fills[i]) || opts.fill || '#fff';
    ctx.fillRect(cx, y, w, h);
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx, y, w, h);
    ctx.fillStyle = '#000';
    ctx.font = pdfFont(opts.fontSize || 17, (opts.bolds && opts.bolds[i]) ? 'bold' : (opts.weight || ''));
    const align = (opts.aligns && opts.aligns[i]) || 'center';
    ctx.textAlign = align;
    const tx = align === 'left' ? cx + 10 : (align === 'right' ? cx + w - 10 : cx + w / 2);
    ctx.fillText(String(cell ?? ''), tx, y + h / 2, w - 16);
    cx += w;
  });
  return y + h;
}

function drawReportPages(list, info) {
  const sorted = sortByDateTime(list);
  const s = computeStats(list);
  const contentW = PDF_PAGE_W - PDF_MARGIN * 2;
  const idLine = reportInfoLine(info);
  const pages = [];
  let page = newReportPage();
  let ctx = page.ctx;
  pages.push(page.cv);
  let y = PDF_MARGIN;

  ctx.fillStyle = '#000';
  ctx.textAlign = 'left';
  ctx.font = pdfFont(34, 'bold');
  ctx.fillText('血壓紀錄報告', PDF_MARGIN, y + 20);
  y += 54;
  if (idLine) {
    ctx.font = pdfFont(21, 'bold');
    ctx.fillStyle = '#000';
    ctx.fillText(idLine, PDF_MARGIN, y + 10);
    y += 34;
  }
  ctx.font = pdfFont(19);
  ctx.fillStyle = '#333';
  ctx.fillText(`統計區間：${sorted[0].date} ～ ${sorted[sorted.length - 1].date}　共 ${s.count} 筆`, PDF_MARGIN, y + 10);
  y += 32;
  ctx.font = pdfFont(16);
  ctx.fillStyle = '#666';
  ctx.fillText(`產生時間：${new Date().toLocaleString('zh-TW')}`, PDF_MARGIN, y + 10);
  y += 38;

  const sw = [contentW * 0.22, contentW * 0.28, contentW * 0.22, contentW * 0.28];
  const headFill = ['#eee', '#fff', '#eee', '#fff'];
  const headBold = [true, false, true, false];
  const sumRows = [
    ['平均血壓', `${s.avgSys}/${s.avgDia} mmHg`, '達標率(<130/80)', `${s.atGoalPct}%`],
    ['晨間平均', s.morning ? `${s.morning.sys}/${s.morning.dia}` : '—', '晚間平均', s.evening ? `${s.evening.sys}/${s.evening.dia}` : '—'],
    ['最高收縮壓', `${s.max.sys}/${s.max.dia}（${s.max.date}）`, '最低收縮壓', `${s.min.sys}/${s.min.dia}（${s.min.date}）`],
  ];
  sumRows.forEach(r => {
    y = drawCells(ctx, PDF_MARGIN, y, sw, r, {
      height: 38, fills: headFill, bolds: headBold,
      aligns: ['left', 'left', 'left', 'left'],
    });
  });
  const catBits = Object.keys(CAT_LABELS).filter(k => s.cats[k] > 0).map(k => `${CAT_LABELS[k]} ${s.cats[k]}`).join('、');
  y = drawCells(ctx, PDF_MARGIN, y, [sw[0], contentW - sw[0]], ['分級分布', catBits], {
    height: 38, fills: ['#eee', '#fff'], bolds: [true, false], aligns: ['left', 'left'],
  });
  y += 16;

  if (s.morningHigh) {
    ctx.fillStyle = '#a8271f';
    ctx.font = pdfFont(18, 'bold');
    ctx.textAlign = 'left';
    ctx.fillText('⚠ 晨間平均血壓偏高（≥135/85），建議與醫師討論。', PDF_MARGIN, y + 10);
    y += 34;
  }

  try {
    const chartCv = document.createElement('canvas');
    drawChart(chartCv, sorted.slice(-60), contentW, 340);
    ctx.drawImage(chartCv, PDF_MARGIN, y, contentW, 340);
    ctx.strokeStyle = '#ccc';
    ctx.strokeRect(PDF_MARGIN, y, contentW, 340);
    y += 360;
  } catch {}

  const cols = [0.15, 0.10, 0.14, 0.09, 0.17, 0.15, 0.20].map(f => contentW * f);
  const headers = ['日期', '時間', '血壓', '心跳', '分級', '服藥', '備註'];
  const aligns = ['center', 'center', 'center', 'center', 'center', 'center', 'left'];
  const rowH = 34;
  const drawLogHeader = () => {
    y = drawCells(ctx, PDF_MARGIN, y, cols, headers, { height: rowH, fill: '#eee', weight: 'bold', fontSize: 16 });
  };
  drawLogHeader();
  sorted.forEach(r => {
    if (y + rowH > PDF_PAGE_H - PDF_MARGIN) {
      page = newReportPage();
      ctx = page.ctx;
      pages.push(page.cv);
      y = PDF_MARGIN;
      // Repeat an identifying line so separated pages stay attributable.
      ctx.fillStyle = '#555';
      ctx.textAlign = 'left';
      ctx.font = pdfFont(16);
      ctx.fillText(`血壓紀錄報告（續）${idLine ? '　' + idLine : ''}`, PDF_MARGIN, y + 8);
      y += 30;
      drawLogHeader();
    }
    const c = classify(r.systolic, r.diastolic);
    y = drawCells(ctx, PDF_MARGIN, y, cols, [
      r.date, r.time, `${r.systolic}/${r.diastolic}`, r.pulse ?? '', c.label, medLabelFor(r), r.note || '',
    ], { height: rowH, fontSize: 15, aligns });
  });

  return pages;
}

function canvasesToPdfBlob(canvases, quality = 0.85) {
  const enc = (str) => {
    const a = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff;
    return a;
  };
  const parts = [];
  let offset = 0;
  const push = (bytes) => { parts.push(bytes); offset += bytes.length; };
  const pushStr = (s) => push(enc(s));

  const N = canvases.length;
  const objOffsets = [];
  const PW = 595, PH = 842; // A4 in points

  pushStr('%PDF-1.4\n');
  objOffsets[1] = offset;
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const kids = [];
  for (let i = 0; i < N; i++) kids.push(`${3 + i * 3} 0 R`);
  objOffsets[2] = offset;
  pushStr(`2 0 obj\n<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${N} >>\nendobj\n`);

  for (let i = 0; i < N; i++) {
    const pageNum = 3 + i * 3;
    const contentNum = pageNum + 1;
    const imgNum = pageNum + 2;

    objOffsets[pageNum] = offset;
    pushStr(`${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`);

    const content = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q\n`;
    objOffsets[contentNum] = offset;
    pushStr(`${contentNum} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

    const dataUrl = canvases[i].toDataURL('image/jpeg', quality);
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const img = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) img[k] = bin.charCodeAt(k);

    objOffsets[imgNum] = offset;
    pushStr(`${imgNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${canvases[i].width} /Height ${canvases[i].height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`);
    push(img);
    pushStr('\nendstream\nendobj\n');
  }

  const totalObjs = 2 + N * 3;
  const xrefOffset = offset;
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjs; n++) {
    xref += String(objOffsets[n]).padStart(10, '0') + ' 00000 n \n';
  }
  pushStr(xref);
  pushStr(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  parts.forEach(p => { out.set(p, o); o += p.length; });
  return new Blob([out], { type: 'application/pdf' });
}

const reportModal = document.getElementById('reportModal');

let currentReportList = [];
let currentReportInfo = { name: '', id: '' };
let pendingReportList = [];

// Character-by-character wrapping — CJK text has no spaces to break on.
function wrapLines(ctx, text, maxWidth) {
  const out = [];
  let cur = '';
  for (const ch of text) {
    const test = cur + ch;
    if (ctx.measureText(test).width > maxWidth && cur) {
      out.push(cur);
      cur = ch;
    } else {
      cur = test;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function drawManualPages() {
  const contentW = PDF_PAGE_W - PDF_MARGIN * 2;
  const pages = [];
  let page = newReportPage();
  let ctx = page.ctx;
  pages.push(page.cv);
  let y = PDF_MARGIN;

  const newPage = () => {
    page = newReportPage();
    ctx = page.ctx;
    pages.push(page.cv);
    y = PDF_MARGIN;
  };
  const room = (need) => {
    if (y + need > PDF_PAGE_H - PDF_MARGIN) newPage();
  };

  ctx.fillStyle = '#000';
  ctx.textAlign = 'left';
  ctx.font = pdfFont(36, 'bold');
  ctx.fillText('血壓記錄 App 使用說明', PDF_MARGIN, y + 22);
  y += 58;
  ctx.font = pdfFont(19);
  ctx.fillStyle = '#555';
  ctx.fillText(`適用版本：${APP_VERSION}　說明產生日期：${localDateStr()}`, PDF_MARGIN, y + 10);
  y += 44;

  MANUAL_SECTIONS.forEach(sec => {
    room(90);
    ctx.fillStyle = '#000';
    ctx.font = pdfFont(24, 'bold');
    ctx.textAlign = 'left';
    ctx.fillText(sec.t, PDF_MARGIN, y + 14);
    y += 30;
    ctx.strokeStyle = '#bbb';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PDF_MARGIN, y);
    ctx.lineTo(PDF_PAGE_W - PDF_MARGIN, y);
    ctx.stroke();
    y += 16;

    sec.lines.forEach(line => {
      ctx.font = pdfFont(19);
      ctx.fillStyle = '#000';
      const wrapped = wrapLines(ctx, line, contentW - 26);
      wrapped.forEach((seg, i) => {
        room(32);
        ctx.font = pdfFont(19);
        ctx.fillStyle = '#000';
        ctx.textAlign = 'left';
        if (i === 0) ctx.fillText('・', PDF_MARGIN, y + 12);
        ctx.fillText(seg, PDF_MARGIN + 26, y + 12);
        y += 30;
      });
      y += 4;
    });
    y += 12;
  });

  return pages;
}

function manualPdfFile() {
  const blob = canvasesToPdfBlob(drawManualPages());
  return new File([blob], `血壓記錄App使用說明_${APP_VERSION}.pdf`, { type: 'application/pdf' });
}

const manualModal = document.getElementById('manualModal');
let manualForcedShown = false;

function openManual(forced = false) {
  document.getElementById('manualContent').innerHTML = buildManualHtml();
  document.getElementById('manualUpdateNote').hidden = !forced;
  document.getElementById('manualOnOpenInline').checked = !!settings.showManualOnOpen;
  manualForcedShown = forced;
  closeSettings();
  manualModal.hidden = false;
}

// Mark the version as seen only once the user actually closes the forced view.
// Recording it at open time would lose the forced showing if the page reloads
// first (e.g. the service worker updating and refreshing the app).
function closeManual() {
  manualModal.hidden = true;
  if (manualForcedShown) {
    manualForcedShown = false;
    settings.manualSeenVersion = APP_VERSION;
    saveSettings(settings);
  }
  maybeWeightPrompt(); // retry the daily weight prompt now this modal is gone
}

function printManual() {
  const old = document.getElementById('manualFrame');
  if (old) old.remove();
  const iframe = document.createElement('iframe');
  iframe.id = 'manualFrame';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;background:#fff;';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>使用說明</title><style>@page{margin:14mm}body{margin:0;padding:14px;background:#fff}</style></head><body>${buildManualHtml()}</body></html>`);
  doc.close();
  const win = iframe.contentWindow;
  let done = false;
  const go = () => { if (done) return; done = true; try { win.focus(); win.print(); } catch {} };
  iframe.onload = () => setTimeout(go, 200);
  setTimeout(go, 800);
}

async function shareManualPdf() {
  let file;
  try { file = manualPdfFile(); } catch { showToast('產生 PDF 失敗'); return; }
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: '血壓記錄 App 使用說明' }); }
    catch (err) { if (err.name !== 'AbortError') showToast('分享失敗'); }
    return;
  }
  downloadPdf(file);
  showToast('此裝置不支援直接分享，已儲存 PDF');
}

function saveManualPdf() {
  try {
    downloadPdf(manualPdfFile());
    showToast('已儲存使用說明 PDF');
  } catch {
    showToast('產生 PDF 失敗');
  }
}

function setManualOnOpen(on) {
  settings.showManualOnOpen = on;
  saveSettings(settings);
  const s = document.getElementById('settingManualOnOpen');
  if (s) s.checked = on;
  const i = document.getElementById('manualOnOpenInline');
  if (i) i.checked = on;
}

document.getElementById('openManualBtn').addEventListener('click', () => openManual(false));
document.getElementById('closeManualBtn').addEventListener('click', closeManual);
manualModal.addEventListener('click', (e) => { if (e.target === manualModal) closeManual(); });
document.getElementById('shareManualBtn').addEventListener('click', shareManualPdf);
document.getElementById('saveManualBtn').addEventListener('click', saveManualPdf);
document.getElementById('printManualBtn').addEventListener('click', printManual);
document.getElementById('manualOnOpenInline').addEventListener('change', (e) => setManualOnOpen(e.target.checked));

// "What's new" is a lightweight, version-specific highlights view shown once
// after an update — replacing the old habit of forcing the entire manual. The
// full manual stays available via 設定 → 開啟完整使用說明.
function openWhatsNew() {
  const notes = WHATS_NEW[APP_VERSION] || ['本次為功能與介面優化更新。'];
  document.getElementById('whatsNewVersion').textContent = `版本 ${APP_VERSION}`;
  document.getElementById('whatsNewList').innerHTML =
    notes.map(n => `<li>${escapeHtml(n)}</li>`).join('');
  closeSettings();
  document.getElementById('whatsNewModal').hidden = false;
}

// Record the version as seen only on close (same reasoning as closeManual: a
// reload from the SW auto-update must not swallow the single forced showing).
function closeWhatsNew() {
  document.getElementById('whatsNewModal').hidden = true;
  if (settings.manualSeenVersion !== APP_VERSION) {
    settings.manualSeenVersion = APP_VERSION;
    saveSettings(settings);
  }
  maybeWeightPrompt(); // retry the daily weight prompt now this modal is gone
}

document.getElementById('closeWhatsNewBtn').addEventListener('click', closeWhatsNew);
document.getElementById('whatsNewOkBtn').addEventListener('click', closeWhatsNew);
document.getElementById('whatsNewModal').addEventListener('click', (e) => {
  if (e.target.id === 'whatsNewModal') closeWhatsNew();
});

// ---- Daily weight prompt ----
// On the first operation of the app each day, proactively ask whether to record
// today's weight (kg). Controlled by settings.weightPromptEnabled (default on);
// settings.weightPromptDate records the last day we prompted, so it only fires
// once per day. The same modal doubles as the manual weight manager (⚖️ header
// button): record/update today's weight and review or delete past entries.

const weightModal = document.getElementById('weightModal');

function todayWeight() {
  const w = weightLogs[todayStr()];
  return typeof w === 'number' ? w : null;
}

function renderWeightList() {
  const listEl = document.getElementById('weightList');
  const dates = Object.keys(weightLogs)
    .filter(d => typeof weightLogs[d] === 'number')
    .sort()
    .reverse();
  if (dates.length === 0) {
    listEl.innerHTML = '<p class="empty-state">尚無體重紀錄。</p>';
    return;
  }
  listEl.innerHTML = dates.slice(0, 60).map((d, i) => {
    const w = weightLogs[d];
    const prev = i + 1 < dates.length ? weightLogs[dates[i + 1]] : null;
    let delta = '';
    if (typeof prev === 'number') {
      const diff = Math.round((w - prev) * 10) / 10;
      if (diff !== 0) {
        const sign = diff > 0 ? '+' : '';
        delta = `<span class="weight-delta ${diff > 0 ? 'up' : 'down'}">${sign}${diff}</span>`;
      }
    }
    return `<div class="weight-item">
      <span class="weight-date">${d}</span>
      <span class="weight-val">${w} kg${delta}</span>
      <button type="button" class="text-danger-btn weight-del" data-date="${d}" aria-label="刪除 ${d} 體重紀錄">刪除</button>
    </div>`;
  }).join('');
}

function openWeightModal({ prompt = false } = {}) {
  const input = document.getElementById('weightInput');
  const existing = todayWeight();
  input.value = existing != null ? existing : '';
  document.getElementById('weightModalDate').textContent = todayStr();
  document.getElementById('weightPromptHint').hidden = !prompt;
  renderWeightList();
  closeSettings();
  weightModal.hidden = false;
  // Mark today as prompted on show, so dismissing without recording won't re-ask.
  if (prompt && settings.weightPromptDate !== todayStr()) {
    settings.weightPromptDate = todayStr();
    saveSettings(settings);
  }
  setTimeout(() => { try { input.focus(); } catch {} }, 50);
}

function closeWeightModal() {
  weightModal.hidden = true;
}

function saveTodayWeight() {
  const raw = document.getElementById('weightInput').value.trim();
  if (raw === '') {
    showToast('請輸入體重');
    return;
  }
  const w = Number(raw);
  if (!Number.isFinite(w) || w <= 0 || w > 500) {
    showToast('請輸入有效的體重（1～500 kg）');
    return;
  }
  const val = Math.round(w * 10) / 10;
  weightLogs[todayStr()] = val;
  saveWeightLogs(weightLogs);
  renderWeightList();
  showToast(`已記錄今日體重 ${val} kg`);
}

function removeWeight(date) {
  if (!confirm(`確定要刪除「${date}」的體重紀錄嗎？`)) return;
  delete weightLogs[date];
  saveWeightLogs(weightLogs);
  renderWeightList();
}

// Show the once-a-day prompt on the first operation of the day — unless it is
// disabled, already recorded/prompted today, or another modal is already open
// (don't stack on the what's-new / manual view; their close handlers retry, so
// the prompt still appears once those are dismissed).
function maybeWeightPrompt() {
  if (!settings.weightPromptEnabled) return;
  if (settings.weightPromptDate === todayStr()) return;
  if (todayWeight() != null) return;
  if (document.querySelector('.modal-backdrop:not([hidden])')) return;
  openWeightModal({ prompt: true });
}

document.getElementById('weightBtn').addEventListener('click', () => openWeightModal());
document.getElementById('closeWeightBtn').addEventListener('click', closeWeightModal);
document.getElementById('saveWeightBtn').addEventListener('click', saveTodayWeight);
document.getElementById('skipWeightBtn').addEventListener('click', closeWeightModal);
weightModal.addEventListener('click', (e) => { if (e.target === weightModal) closeWeightModal(); });
document.getElementById('weightList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-date]');
  if (btn) removeWeight(btn.dataset.date);
});
document.getElementById('weightInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveTodayWeight(); }
});

// After a version update, show the compact "本次更新內容" once; otherwise fall
// back to the user's own "show full manual on open" preference.
function maybeShowManualOnStart() {
  if (settings.manualSeenVersion !== APP_VERSION) {
    openWhatsNew();   // closeWhatsNew() records the version once it is dismissed
    return;
  }
  if (settings.showManualOnOpen) openManual(false);
}

const reportInfoModal = document.getElementById('reportInfoModal');

// Optional identifying details are asked for right before the report is built,
// so the user decides each time whether personal data goes into the PDF.
function startReportFlow(list) {
  if (!list || list.length === 0) {
    showToast('此範圍沒有資料可產生報告');
    return;
  }
  pendingReportList = list;
  const remember = !!settings.rememberReportInfo;
  document.getElementById('reportName').value = remember ? (settings.reportName || '') : '';
  document.getElementById('reportId').value = remember ? (settings.reportId || '') : '';
  document.getElementById('rememberReportInfo').checked = remember;
  closeSettings();
  reportInfoModal.hidden = false;
}

function finishReportFlow(info) {
  reportInfoModal.hidden = true;
  generateReport(pendingReportList, info);
}

function confirmReportInfo() {
  const name = document.getElementById('reportName').value.trim();
  const id = document.getElementById('reportId').value.trim();
  const remember = document.getElementById('rememberReportInfo').checked;
  settings.rememberReportInfo = remember;
  settings.reportName = remember ? name : '';
  settings.reportId = remember ? id : '';
  saveSettings(settings);
  finishReportFlow({ name, id });
}

function skipReportInfo() {
  // Explicitly leave personal data out of this report.
  if (!settings.rememberReportInfo) {
    settings.reportName = '';
    settings.reportId = '';
    saveSettings(settings);
  }
  finishReportFlow({ name: '', id: '' });
}

document.getElementById('confirmReportInfoBtn').addEventListener('click', confirmReportInfo);
document.getElementById('skipReportInfoBtn').addEventListener('click', skipReportInfo);
document.getElementById('closeReportInfoBtn').addEventListener('click', () => { reportInfoModal.hidden = true; });
reportInfoModal.addEventListener('click', (e) => { if (e.target === reportInfoModal) reportInfoModal.hidden = true; });

function generateReport(list, info = { name: '', id: '' }) {
  if (!list || list.length === 0) {
    showToast('此範圍沒有資料可產生報告');
    return;
  }
  currentReportList = list;
  currentReportInfo = info;
  currentReportInner = buildReportInner(list, info);
  document.getElementById('reportContent').innerHTML = currentReportInner;
  closeSettings();
  reminderDismissedThisSession = true;
  renderReminder();
  reportModal.hidden = false;
}

function reportPdfFile() {
  const blob = canvasesToPdfBlob(drawReportPages(currentReportList, currentReportInfo));
  const who = currentReportInfo.name ? `_${currentReportInfo.name}` : '';
  return new File([blob], `血壓報告${who}_${localDateStr()}.pdf`, { type: 'application/pdf' });
}

// Records that a report was produced, so the periodic reminder resets.
function markReportDelivered() {
  settings.lastSentAt = new Date().toISOString();
  saveSettings(settings);
  renderSettingsMeta();
  renderReminder();
  if (settings.autoClear && readings.length > 0) {
    if (confirm(`報告已產出。是否要依設定清除全部 ${readings.length} 筆舊紀錄？`)) {
      const photoIds = readings.map(r => r.photoId).filter(Boolean);
      readings = [];
      saveReadings(readings);
      resetForm();
      renderAll();
      deletePhotos(photoIds);
      showToast('已清除舊紀錄');
    }
  }
}

function downloadPdf(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Share the PDF through the device's own share sheet — that is what exposes
// Email, LINE and every other app the phone is set up to share with.
async function shareReportPdf() {
  if (!currentReportList.length) return;
  let file;
  try {
    file = reportPdfFile();
  } catch {
    showToast('產生 PDF 失敗');
    return;
  }
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '血壓紀錄報告' });
      markReportDelivered();
    } catch (err) {
      if (err.name !== 'AbortError') showToast('分享失敗');
    }
    return;
  }
  // Desktop / unsupported: save the PDF and open a prefilled mail draft to attach.
  downloadPdf(file);
  markReportDelivered();
  if (settings.email) {
    const subject = `血壓紀錄報告 ${localDateStr()}`;
    const body = `附上血壓紀錄報告（請將剛剛下載的 ${file.name} 附加到這封信）。`;
    window.location.href = `mailto:${encodeURIComponent(settings.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    showToast('已下載 PDF，請在信件中附加檔案');
  } else {
    showToast('此裝置不支援直接分享，已儲存 PDF');
  }
}

function saveReportPdf() {
  if (!currentReportList.length) return;
  try {
    downloadPdf(reportPdfFile());
    markReportDelivered();
    showToast('已儲存 PDF');
  } catch {
    showToast('產生 PDF 失敗');
  }
}

function printCurrentReport() {
  if (!currentReportInner) return;
  const old = document.getElementById('reportFrame');
  if (old) old.remove();
  const iframe = document.createElement('iframe');
  iframe.id = 'reportFrame';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;background:#fff;';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>血壓報告</title><style>@page{margin:12mm}body{margin:0;padding:12px;background:#fff}</style></head><body>${currentReportInner}</body></html>`);
  doc.close();
  const win = iframe.contentWindow;
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    try { win.focus(); win.print(); } catch {}
  };
  iframe.onload = () => setTimeout(go, 250);
  setTimeout(go, 900); // fallback if onload doesn't fire
}

document.getElementById('reportBtn').addEventListener('click', () => startReportFlow(getExportRangeList()));
document.getElementById('shareReportBtn').addEventListener('click', shareReportPdf);
document.getElementById('savePdfBtn').addEventListener('click', saveReportPdf);
document.getElementById('printReportBtn').addEventListener('click', () => { printCurrentReport(); markReportDelivered(); });
document.getElementById('closeReportBtn').addEventListener('click', () => { reportModal.hidden = true; });
reportModal.addEventListener('click', (e) => { if (e.target === reportModal) reportModal.hidden = true; });

document.getElementById('chartFilterStart').addEventListener('change', (e) => {
  chartDateFilter.start = e.target.value;
  renderChart();
});

document.getElementById('chartFilterEnd').addEventListener('change', (e) => {
  chartDateFilter.end = e.target.value;
  renderChart();
});

document.getElementById('historyFilterStart').addEventListener('change', (e) => {
  historyDateFilter.start = e.target.value;
  renderHistory();
});

document.getElementById('historyFilterEnd').addEventListener('change', (e) => {
  historyDateFilter.end = e.target.value;
  renderHistory();
});

document.getElementById('clearAllBtn').addEventListener('click', () => {
  if (readings.length === 0) {
    showToast('目前沒有紀錄');
    return;
  }
  if (!confirm(`確定要刪除全部 ${readings.length} 筆血壓紀錄嗎？此動作無法復原。`)) return;
  const photoIds = readings.map(r => r.photoId).filter(Boolean);
  readings = [];
  saveReadings(readings);
  resetForm();
  renderAll();
  showToast('已清除所有紀錄');
  deletePhotos(photoIds);
});

// ---- Medication log ----

function refreshMedTimeInput(force = false) {
  const input = document.getElementById('medTimeInput');
  if (!input) return;
  // Default to the current device time, but don't clobber a value the user is
  // actively editing (or has just adjusted) unless explicitly forced.
  if (force || (!input.value && document.activeElement !== input)) {
    input.value = localTimeStr();
  }
}

function renderMedCard() {
  const today = todayStr();
  const times = medTimesFor(today);
  const status = document.getElementById('medTodayStatus');
  const listEl = document.getElementById('medTodayList');
  refreshMedTimeInput();
  if (times.length === 0) {
    status.textContent = '今日尚未記錄服藥，服藥後請按下按鈕。';
    status.className = 'med-status med-status-pending';
    listEl.innerHTML = '';
  } else {
    status.textContent = `今日已記錄服藥 ${times.length} 次`;
    status.className = 'med-status med-status-done';
    listEl.innerHTML = times.map(t =>
      `<span class="med-chip">💊 ${t}<button type="button" data-time="${t}" aria-label="移除 ${t} 服藥紀錄">✕</button></span>`
    ).join('');
  }
}

function logMedicationNow() {
  const date = todayStr();
  const input = document.getElementById('medTimeInput');
  let time = input && input.value ? input.value : localTimeStr();
  if (!/^\d{2}:\d{2}$/.test(time)) {
    alert('請輸入有效的用藥時間。');
    return;
  }
  if (!confirm(`確定要記錄「${time} 服藥」嗎？`)) return;
  const list = medLogs[date] || [];
  list.push(time);
  medLogs[date] = list;
  saveMedLogs(medLogs);
  refreshMedTimeInput(true); // reset back to current time for the next entry
  renderMedCard();
  renderHistory();
  closeMedReminderNotifications();
  showToast(`已記錄服藥時間 ${time}`);
}

function removeMedTime(date, time) {
  const list = medLogs[date] || [];
  const idx = list.indexOf(time);
  if (idx === -1) return;
  if (!confirm(`確定要刪除「${time} 服藥」這筆用藥記錄嗎？`)) return;
  list.splice(idx, 1);
  if (list.length === 0) delete medLogs[date];
  else medLogs[date] = list;
  saveMedLogs(medLogs);
  renderMedCard();
  renderHistory();
}

document.getElementById('logMedBtn').addEventListener('click', logMedicationNow);
document.getElementById('medTimeNowBtn').addEventListener('click', () => refreshMedTimeInput(true));

document.getElementById('medTodayList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-time]');
  if (!btn) return;
  removeMedTime(todayStr(), btn.dataset.time);
});

// ---- Chart & history modals ----

const chartModal = document.getElementById('chartModal');
const historyModal = document.getElementById('historyModal');

function openChart() {
  chartModal.hidden = false;
  renderChart();
  // Re-render after layout settles: on first open the canvas can report a
  // 0 width until the modal is laid out (seen on some mobile browsers).
  requestAnimationFrame(renderChart);
}
function closeChart() { chartModal.hidden = true; }
function openHistory() {
  historyModal.hidden = false;
  renderHistory();
}
function closeHistory() { historyModal.hidden = true; }

document.getElementById('chartBtn').addEventListener('click', openChart);
document.getElementById('closeChartBtn').addEventListener('click', closeChart);
chartModal.addEventListener('click', (e) => { if (e.target === chartModal) closeChart(); });

document.getElementById('historyBtn').addEventListener('click', openHistory);
document.getElementById('closeHistoryBtn').addEventListener('click', closeHistory);
historyModal.addEventListener('click', (e) => { if (e.target === historyModal) closeHistory(); });

// ---- Settings & scheduled email reminder ----

const settingsModal = document.getElementById('settingsModal');

function openSettings() {
  document.getElementById('settingEmail').value = settings.email;
  document.getElementById('settingFrequency').value = settings.frequency;
  document.getElementById('settingCustomDays').value = settings.customDays;
  document.getElementById('settingAutoClear').checked = settings.autoClear;
  document.getElementById('settingReminderEnabled').checked = settings.reminderEnabled;
  const times = settings.reminderTimes || [];
  document.getElementById('reminderTime1').value = times[0] || '';
  document.getElementById('reminderTime2').value = times[1] || '';
  document.getElementById('reminderTime3').value = times[2] || '';
  document.getElementById('settingHighBpAlertEnabled').checked = settings.highBpAlertEnabled;
  document.getElementById('highBpAlertMode').value = settings.highBpAlertMode;
  document.getElementById('highBpCustomSystolic').value = settings.highBpCustomSystolic;
  document.getElementById('highBpCustomDiastolic').value = settings.highBpCustomDiastolic;
  document.getElementById('settingMedReminderEnabled').checked = settings.medReminderEnabled;
  document.getElementById('settingMedReminderTime').value = settings.medReminderTime;
  document.getElementById('settingMedReminderOverdue').value = settings.medReminderOverdueMin;
  document.getElementById('settingMedReminderRepeat').value = settings.medReminderRepeatMin;
  document.getElementById('settingManualOnOpen').checked = !!settings.showManualOnOpen;
  document.getElementById('settingWeightPromptEnabled').checked = settings.weightPromptEnabled !== false;
  toggleCustomDaysRow();
  toggleHighBpCustomRow();
  toggleExportCustomRow();
  renderSettingsMeta();
  settingsModal.hidden = false;
}

function closeSettings() {
  settingsModal.hidden = true;
}

function toggleCustomDaysRow() {
  document.getElementById('customDaysRow').hidden = document.getElementById('settingFrequency').value !== 'custom';
}

function toggleHighBpCustomRow() {
  document.getElementById('highBpCustomRow').hidden = document.getElementById('highBpAlertMode').value !== 'custom';
}

function renderSettingsMeta() {
  document.getElementById('lastSentInfo').textContent = settings.lastSentAt
    ? `上次產生報告：${new Date(settings.lastSentAt).toLocaleString('zh-TW')}`
    : '尚未產生過報告';
}

document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
document.getElementById('settingFrequency').addEventListener('change', toggleCustomDaysRow);
document.getElementById('highBpAlertMode').addEventListener('change', toggleHighBpCustomRow);

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  settings.email = document.getElementById('settingEmail').value.trim();
  settings.frequency = document.getElementById('settingFrequency').value;
  settings.customDays = Number(document.getElementById('settingCustomDays').value) || 14;
  settings.autoClear = document.getElementById('settingAutoClear').checked;

  const reminderEnabled = document.getElementById('settingReminderEnabled').checked;
  settings.reminderTimes = [
    document.getElementById('reminderTime1').value,
    document.getElementById('reminderTime2').value,
    document.getElementById('reminderTime3').value,
  ].filter(Boolean);

  if (reminderEnabled && settings.reminderTimes.length === 0) {
    showToast('請至少設定一個提醒時間');
    return;
  }

  if (reminderEnabled && 'Notification' in window && Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      showToast('未取得通知權限，提醒將以應用內提示顯示');
    }
  }
  settings.reminderEnabled = reminderEnabled;

  settings.highBpAlertEnabled = document.getElementById('settingHighBpAlertEnabled').checked;
  settings.highBpAlertMode = document.getElementById('highBpAlertMode').value;
  settings.highBpCustomSystolic = Number(document.getElementById('highBpCustomSystolic').value) || 130;
  settings.highBpCustomDiastolic = Number(document.getElementById('highBpCustomDiastolic').value) || 80;

  const medReminderEnabled = document.getElementById('settingMedReminderEnabled').checked;
  if (medReminderEnabled && !reminderEnabled && 'Notification' in window && Notification.permission === 'default') {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') showToast('未取得通知權限，提醒將以應用內提示顯示');
  }
  settings.medReminderEnabled = medReminderEnabled;
  settings.medReminderTime = document.getElementById('settingMedReminderTime').value || '08:00';
  settings.medReminderOverdueMin = Math.max(0, Number(document.getElementById('settingMedReminderOverdue').value) || 0);
  settings.medReminderRepeatMin = Math.max(5, Number(document.getElementById('settingMedReminderRepeat').value) || 30);
  settings.showManualOnOpen = document.getElementById('settingManualOnOpen').checked;
  settings.weightPromptEnabled = document.getElementById('settingWeightPromptEnabled').checked;

  saveSettings(settings);
  closeSettings();
  renderReminder();
  showToast('設定已儲存');
});

document.getElementById('sendNowBtn').addEventListener('click', () => {
  startReportFlow(getExportRangeList());
});

// ---- Backup export / restore ----

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

// Build the full backup bundle (readings + medication logs + settings +
// photos as data URLs). Shared by the file export and the cloud backup.
async function buildBackupObject() {
  const photoIds = readings.map(r => r.photoId).filter(Boolean);
  const photos = {};
  for (const id of photoIds) {
    const blob = await getPhoto(id);
    if (blob) photos[id] = await blobToDataUrl(blob);
  }
  return {
    version: 3,
    exportedAt: new Date().toISOString(),
    readings,
    medLogs,
    weightLogs,
    settings,
    photos,
  };
}

// The set of photoIds to KEEP: the newest MAX_PHOTOS readings that have a
// photo, by date/time. Everything else is pruned.
function computeKeepPhotoIds(list) {
  const withPhoto = sortByDateTime(list.filter(r => r && r.photoId));
  return new Set(withPhoto.slice(-MAX_PHOTOS).map(r => r.photoId));
}

// Enforce the photo cap on the live data: delete photos beyond the newest
// MAX_PHOTOS from IndexedDB and null out their photoId. Mutates the global
// `readings` in place; returns true if anything changed. Callers persist +
// re-render as appropriate (kept side-effect-free so it can run pre-save).
async function enforcePhotoLimit() {
  const keep = computeKeepPhotoIds(readings);
  const stale = readings.filter(r => r.photoId && !keep.has(r.photoId));
  if (stale.length === 0) return false;
  await deletePhotos(stale.map(r => r.photoId));
  stale.forEach(r => { r.photoId = null; });
  return true;
}

// Overwrite all local data from a backup bundle. Callers are responsible for
// confirming with the user first. Suppresses cloud auto-backup while applying
// so a restore doesn't immediately upload back over the source.
async function applyBackupObject(data) {
  suppressCloud = true;
  try {
    const existingPhotoIds = readings.map(r => r.photoId).filter(Boolean);
    await deletePhotos(existingPhotoIds);

    // Honour the photo cap on restore too: only write the newest MAX_PHOTOS
    // photos and drop the photoId on older readings, so restoring a large (or
    // pre-cap) backup can't blow past the limit. Record numbers are kept.
    const restored = data.readings || [];
    const keep = computeKeepPhotoIds(restored);
    restored.forEach(r => { if (r.photoId && !keep.has(r.photoId)) r.photoId = null; });

    const photos = data.photos || {};
    for (const [id, dataUrl] of Object.entries(photos)) {
      if (!keep.has(id)) continue;
      try {
        const blob = await dataUrlToBlob(dataUrl);
        await savePhoto(id, blob);
      } catch {}
    }

    readings = restored;
    saveReadings(readings);
    medLogs = (data.medLogs && typeof data.medLogs === 'object') ? data.medLogs : {};
    saveMedLogs(medLogs);
    weightLogs = (data.weightLogs && typeof data.weightLogs === 'object') ? data.weightLogs : {};
    saveWeightLogs(weightLogs);
    if (data.settings) {
      settings = { ...loadSettings(), ...data.settings };
      saveSettings(settings);
    }
    resetForm();
    renderAll();
  } finally {
    suppressCloud = false;
  }
}

async function exportBackup() {
  const backup = await buildBackupObject();
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `血壓備份_${localDateStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('已匯出備份檔');
}

async function importBackupFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showToast('備份檔格式錯誤');
    return;
  }
  if (!data || !Array.isArray(data.readings)) {
    showToast('備份檔格式錯誤');
    return;
  }
  if (!confirm(`確定要還原這份備份嗎？這會覆蓋目前所有紀錄與設定（備份中共 ${data.readings.length} 筆紀錄）。`)) return;

  await applyBackupObject(data);
  closeSettings();
  showToast('已還原備份');
  // If cloud backup is on, push the just-restored data up so the cloud and this
  // device agree (applyBackupObject suppressed the auto-upload).
  if (cloudState.enabled) scheduleCloudBackup();
}

document.getElementById('exportBackupBtn').addEventListener('click', exportBackup);

document.getElementById('importBackupBtn').addEventListener('click', () => {
  document.getElementById('importBackupInput').click();
});

document.getElementById('importBackupInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  await importBackupFile(file);
});

// ================= Cloud backup: Google Drive (appDataFolder) =================
// Backs up the whole bundle to a hidden, app-private folder in the user's OWN
// Google Drive — no server ever holds the data. Model: backup-first,
// last-write-wins on a single JSON file. On app open, if the cloud copy is
// newer than what this device last synced, the user is prompted to restore.
// A previous version is preserved as a .prev file only when a genuine
// cross-device conflict is detected, so a stray overwrite stays recoverable.
// (The GOOGLE_CLIENT_ID / DRIVE_SCOPE / CLOUD_* constants are declared at the
// top of the file — see the note there about the top-level loadCloudState call.)

let gisToken = null;       // { access_token, expiresAt } — kept in memory only, never persisted
let tokenClient = null;
let cloudTimer = null;
let cloudBusy = false;
let _tokResolve = null, _tokReject = null;

function loadCloudState() {
  const defaults = { enabled: false, email: '', dataOwnerEmail: '', fileId: '', prevFileId: '', lastSyncedAt: '', lastSnapshotDate: '', pendingBackup: false, backupFailed: false, deviceId: '' };
  let s;
  try { s = { ...defaults, ...JSON.parse(localStorage.getItem(CLOUD_KEY)) }; }
  catch { s = { ...defaults }; }
  if (!s.deviceId) s.deviceId = crypto.randomUUID();
  localStorage.setItem(CLOUD_KEY, JSON.stringify(s));
  return s;
}

function saveCloudState() {
  localStorage.setItem(CLOUD_KEY, JSON.stringify(cloudState));
}

function friendlyCloudErr(e) {
  const m = (e && e.message) || '';
  if (/popup_closed|access_denied|interaction_required|auth_failed|popup_failed/i.test(m)) return '登入未完成';
  if (/network|Failed to fetch/i.test(m)) return '網路連線問題';
  return '請稍後再試';
}

// Lazily load Google Identity Services only when cloud backup is actually used,
// so the app still starts instantly (and offline) for users who never enable it.
function ensureGis() {
  return new Promise((resolve, reject) => {
    if (window.google && google.accounts && google.accounts.oauth2) return resolve();
    let s = document.getElementById('gisScript');
    if (s) {
      s.addEventListener('load', () => resolve());
      s.addEventListener('error', () => reject(new Error('network')));
      return;
    }
    s = document.createElement('script');
    s.id = 'gisScript';
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('network'));
    document.head.appendChild(s);
  });
}

function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      const ok = _tokResolve, fail = _tokReject;
      _tokResolve = _tokReject = null;
      if (resp && resp.access_token) {
        gisToken = { access_token: resp.access_token, expiresAt: Date.now() + ((Number(resp.expires_in) || 3600) * 1000) };
        ok && ok(resp.access_token);
      } else {
        fail && fail(new Error((resp && resp.error) || 'auth_failed'));
      }
    },
    error_callback: (err) => {
      const fail = _tokReject;
      _tokResolve = _tokReject = null;
      fail && fail(new Error((err && err.type) || 'popup_closed'));
    },
  });
}

// Get a valid access token. A cached, unexpired token is reused with no UI at
// all. promptMode maps to Google's token-client prompt:
//   'none'  — background/silent: return a token without any UI, or fail cleanly
//             if Google can't (session lapsed) — never opens a popup.
//   ''      — user-gesture flows: silent when the consent is already remembered,
//             otherwise shows the consent/login popup. After the first grant this
//             stays silent, so reopen/refresh/manual backup never re-prompt.
// We deliberately never force 'consent', which would re-show the screen every
// time. Refresh tokens aren't available in this (no-backend) token model, so
// 'none' + a remembered Google session is the seamless path.
async function getAccessToken(promptMode = '') {
  await ensureGis();
  if (gisToken && gisToken.expiresAt - 60000 > Date.now()) return gisToken.access_token;
  if (!tokenClient) initTokenClient();
  return new Promise((resolve, reject) => {
    _tokResolve = resolve; _tokReject = reject;
    try {
      tokenClient.requestAccessToken({ prompt: promptMode });
    } catch (e) {
      _tokResolve = _tokReject = null;
      reject(e);
    }
  });
}

async function driveFetch(url, opts) {
  let token = await getAccessToken('none');
  const build = (t) => ({ ...opts, headers: { ...(opts && opts.headers), Authorization: 'Bearer ' + t } });
  let res = await fetch(url, build(token));
  if (res.status === 401) { // token stale/revoked — force one silent refresh and retry
    gisToken = null;
    token = await getAccessToken('none');
    res = await fetch(url, build(token));
  }
  return res;
}

async function driveFindFile(name) {
  const q = encodeURIComponent(`name='${name}'`);
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime,appProperties)&pageSize=5`;
  const res = await driveFetch(url, { method: 'GET' });
  if (!res.ok) throw new Error('list_failed');
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function driveGetMeta(fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,appProperties,modifiedTime`;
  const res = await driveFetch(url, { method: 'GET' });
  if (!res.ok) return null;
  return res.json();
}

async function driveDownloadText(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { method: 'GET' });
  if (!res.ok) throw new Error('download_failed');
  return res.text();
}

// The signed-in account's email — Drive's about.get returns it under the
// existing drive.appdata scope, so no extra OAuth permission is needed.
async function driveGetUserEmail() {
  try {
    const res = await driveFetch('https://www.googleapis.com/drive/v3/about?fields=user', { method: 'GET' });
    if (!res.ok) return '';
    const data = await res.json();
    return (data.user && data.user.emailAddress) || '';
  } catch { return ''; }
}

// Existing links (from before the account line was added) have no stored email;
// fetch it quietly on open so the account still shows without a re-link. Also
// back-fills dataOwnerEmail — for an already-linked device the on-device data
// belongs to the linked account — so the account-switch guard has a baseline.
async function refreshCloudEmailIfMissing() {
  if (!cloudState.enabled) return;
  let changed = false;
  if (!cloudState.email) {
    const email = await driveGetUserEmail();
    if (email) { cloudState.email = email; changed = true; }
  }
  if (cloudState.email && !cloudState.dataOwnerEmail) {
    cloudState.dataOwnerEmail = cloudState.email;
    changed = true;
  }
  if (changed) { saveCloudState(); updateCloudUI(); }
}

async function driveUpload(fileId, name, contentStr, appProps) {
  const boundary = 'bpb' + Math.random().toString(16).slice(2);
  const metadata = fileId
    ? { appProperties: appProps }
    : { name, parents: ['appDataFolder'], appProperties: appProps };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    contentStr +
    `\r\n--${boundary}--`;
  const base = 'https://www.googleapis.com/upload/drive/v3/files';
  const url = fileId
    ? `${base}/${fileId}?uploadType=multipart&fields=id,appProperties`
    : `${base}?uploadType=multipart&fields=id,appProperties`;
  const res = await driveFetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error('upload_failed');
  return res.json();
}

async function resolveMainFileId() {
  if (cloudState.fileId) return cloudState.fileId;
  const f = await driveFindFile(CLOUD_FILE_NAME);
  if (f) { cloudState.fileId = f.id; saveCloudState(); return f.id; }
  return '';
}

// Copy the current remote main file to the .prev file before overwriting, so a
// version written by another device isn't lost to a last-write-wins overwrite.
async function preserveRemoteAsPrev(fileId) {
  try {
    const text = await driveDownloadText(fileId);
    const r = await driveUpload(cloudState.prevFileId || '', CLOUD_PREV_NAME, text, { savedAt: new Date().toISOString() });
    cloudState.prevFileId = r.id;
    saveCloudState();
  } catch {}
}

// ---- Historical version snapshots (bp-history-<epoch>.json, up to 7) ----
// On the first data change of each day we server-side COPY the current main
// backup into a dated snapshot file — so each snapshot captures the state as it
// stood BEFORE that day's edits (a clean daily checkpoint), and copying avoids
// re-uploading the whole bundle (photos included) from the phone.

async function driveCopyFile(fileId, name, appProps) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}/copy?fields=id,appProperties,createdTime`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: ['appDataFolder'], appProperties: appProps }),
  });
  if (!res.ok) throw new Error('copy_failed');
  return res.json();
}

async function driveDelete(fileId) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' });
  return res.ok || res.status === 404;
}

function snapshotTime(f) {
  const s = f.appProperties && f.appProperties.snapshotAt;
  const t = s ? Date.parse(s) : Date.parse(f.createdTime || '');
  return Number.isNaN(t) ? 0 : t;
}

// All history snapshots, newest first.
async function listSnapshots() {
  const q = encodeURIComponent("name contains 'bp-history-'");
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,createdTime,appProperties)&pageSize=50`;
  const res = await driveFetch(url, { method: 'GET' });
  if (!res.ok) throw new Error('list_failed');
  const data = await res.json();
  return (data.files || []).sort((a, b) => snapshotTime(b) - snapshotTime(a));
}

async function pruneSnapshots(max) {
  const snaps = await listSnapshots(); // newest first
  for (const f of snaps.slice(max)) { // anything past the newest `max` = oldest
    try { await driveDelete(f.id); } catch {}
  }
}

async function createDailySnapshot() {
  const mainId = await resolveMainFileId();
  if (!mainId) return; // nothing backed up yet — no prior state to snapshot
  const meta = await driveGetMeta(mainId);
  const props = {
    snapshotAt: new Date().toISOString(),
    dateStr: localDateStr(),
    srcUpdatedAt: (meta && meta.appProperties && meta.appProperties.updatedAt) || '',
    count: (meta && meta.appProperties && meta.appProperties.count) || '',
  };
  await driveCopyFile(mainId, `bp-history-${Date.now()}.json`, props);
  await pruneSnapshots(7);
}

let snapshotInFlight = false;

// Called from saveReadings/saveMedLogs. Fire-and-forget; on failure leaves
// lastSnapshotDate unchanged so the next change retries (in-flight flag stops
// pile-ups). Suppressed during a restore.
function maybeDailySnapshot() {
  if (!cloudState.enabled || suppressCloud || snapshotInFlight) return;
  const today = localDateStr();
  if (cloudState.lastSnapshotDate === today) return;
  snapshotInFlight = true;
  createDailySnapshot()
    .then(() => { cloudState.lastSnapshotDate = today; saveCloudState(); })
    .catch(() => {})
    .finally(() => { snapshotInFlight = false; });
}

function setCloudBusy(b) {
  ['cloudConnectBtn', 'cloudBackupNowBtn', 'cloudRestoreBtn', 'cloudSwitchBtn', 'cloudDisconnectBtn', 'cloudAlertBackupBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = b;
  });
}

function updateCloudUI() {
  const enabled = !!cloudState.enabled;
  const disc = document.getElementById('cloudDisconnectedBox');
  const conn = document.getElementById('cloudConnectedBox');
  if (disc) disc.hidden = enabled;
  if (conn) conn.hidden = !enabled;
  const account = document.getElementById('cloudAccount');
  if (account) {
    if (enabled && cloudState.email) {
      account.hidden = false;
      account.textContent = `帳號：${cloudState.email}`;
    } else {
      account.hidden = true;
      account.textContent = '';
    }
  }
  const status = document.getElementById('cloudStatus');
  if (status) {
    status.classList.remove('cloud-status-warn');
    const last = cloudState.lastSyncedAt ? fmtDateTime(cloudState.lastSyncedAt) : '';
    if (!enabled) {
      status.textContent = '';
    } else if (cloudState.backupFailed) {
      status.textContent = `⚠ 有變更尚未備份成功${last ? `（上次成功：${last}）` : ''}，請按「立即備份」。`;
      status.classList.add('cloud-status-warn');
    } else if (cloudState.pendingBackup) {
      status.textContent = `備份中…${last ? `（上次：${last}）` : ''}`;
    } else if (last) {
      status.textContent = `已連結，上次備份：${last}`;
    } else {
      status.textContent = '已連結，尚未備份';
    }
  }
  // Surface a backup-failure warning on the homepage so the user can retry
  // without opening 設定 (mirrors the amber warning inside the cloud section).
  const alertCard = document.getElementById('cloudAlertCard');
  if (alertCard) {
    const showAlert = enabled && cloudState.backupFailed;
    alertCard.hidden = !showAlert;
    if (showAlert) {
      const last = cloudState.lastSyncedAt ? fmtDateTime(cloudState.lastSyncedAt) : '';
      const txt = document.getElementById('cloudAlertText');
      if (txt) txt.textContent = `⚠ 有變更尚未成功備份到雲端硬碟${last ? `（上次成功：${last}）` : ''}，請按「立即備份」補上。`;
    }
  }
}

function scheduleCloudBackup() {
  if (!cloudState.enabled || suppressCloud) return;
  if (!cloudState.pendingBackup) { cloudState.pendingBackup = true; saveCloudState(); updateCloudUI(); }
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => { cloudBackupNow({}); }, CLOUD_DEBOUNCE_MS);
}

async function cloudBackupNow({ manual = false, interactive = false } = {}) {
  if (!cloudState.enabled && !interactive) return;
  if (cloudBusy) return;
  cloudBusy = true;
  setCloudBusy(true);
  try {
    if (interactive) await getAccessToken(''); // user gesture: silent if already granted, popup only if needed
    const bundle = await buildBackupObject();
    const updatedAt = new Date().toISOString();
    bundle.cloudUpdatedAt = updatedAt;
    bundle.deviceId = cloudState.deviceId;
    const contentStr = JSON.stringify(bundle);

    const fileId = await resolveMainFileId();
    if (fileId) {
      const meta = await driveGetMeta(fileId);
      const remoteUpdated = meta && meta.appProperties && meta.appProperties.updatedAt;
      if (remoteUpdated && remoteUpdated !== cloudState.lastSyncedAt) {
        await preserveRemoteAsPrev(fileId); // another device wrote since we synced — keep it recoverable
      }
    }

    const result = await driveUpload(fileId, CLOUD_FILE_NAME, contentStr, { updatedAt, deviceId: cloudState.deviceId, count: String(readings.length) });
    cloudState.fileId = result.id;
    cloudState.lastSyncedAt = updatedAt;
    cloudState.pendingBackup = false;
    cloudState.backupFailed = false;
    if (cloudState.email) cloudState.dataOwnerEmail = cloudState.email; // this device's data now belongs to this account
    saveCloudState();
    updateCloudUI();
    if (manual) showToast('已備份到雲端');
  } catch (e) {
    // The change is saved locally but not yet in the cloud. Mark it so the
    // status shows an honest "not backed up" warning (instead of a stale last-
    // backup time) and prompts the user to tap 立即備份.
    cloudState.backupFailed = true;
    saveCloudState();
    updateCloudUI();
    if (manual || interactive) showToast('雲端備份失敗：' + friendlyCloudErr(e));
  } finally {
    cloudBusy = false;
    setCloudBusy(false);
  }
}

async function cloudRestore({ manual = false, confirmFirst = true, confirmMsg = '' } = {}) {
  setCloudBusy(true);
  try {
    if (manual) await getAccessToken(''); // user gesture: silent if already granted, popup only if needed
    const fileId = await resolveMainFileId();
    if (!fileId) { if (manual) showToast('雲端沒有備份可還原'); return 'none'; }
    const text = await driveDownloadText(fileId);
    let data;
    try { data = JSON.parse(text); } catch { showToast('雲端備份格式錯誤'); return 'error'; }
    if (!data || !Array.isArray(data.readings)) { showToast('雲端備份格式錯誤'); return 'error'; }
    if (confirmFirst) {
      const msg = confirmMsg || `確定要用雲端備份還原嗎？這會覆蓋此裝置目前所有紀錄與設定（雲端共 ${data.readings.length} 筆紀錄）。`;
      if (!confirm(msg)) return 'declined';
    }
    await applyBackupObject(data);
    const meta = await driveGetMeta(fileId);
    cloudState.lastSyncedAt = (meta && meta.appProperties && meta.appProperties.updatedAt) || data.cloudUpdatedAt || cloudState.lastSyncedAt;
    cloudState.pendingBackup = false;
    cloudState.backupFailed = false;
    if (cloudState.email) cloudState.dataOwnerEmail = cloudState.email;
    saveCloudState();
    updateCloudUI();
    closeSettings();
    showToast('已從雲端還原');
    return 'restored';
  } catch (e) {
    showToast('雲端還原失敗：' + friendlyCloudErr(e));
    return 'error';
  } finally {
    setCloudBusy(false);
  }
}

// ---- Restore version picker ----
// The 從雲端還原 button opens a picker listing the live latest backup plus the
// history snapshots, so the user can choose which version to restore to.

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' });
}

async function openRestorePicker() {
  setCloudBusy(true);
  try {
    await getAccessToken(''); // user gesture
    const mainId = await resolveMainFileId();
    const items = [];
    if (mainId) {
      const meta = await driveGetMeta(mainId);
      const p = (meta && meta.appProperties) || {};
      items.push({
        value: 'latest',
        main: '最新版本（即時）',
        sub: [fmtDateTime(p.updatedAt), p.count ? `${p.count} 筆` : ''].filter(Boolean).join('　'),
      });
    }
    let snaps = [];
    try { snaps = await listSnapshots(); } catch {}
    for (const f of snaps) {
      const p = f.appProperties || {};
      items.push({
        value: f.id,
        main: `歷史版本　${p.dateStr || ''}`.trim(),
        sub: [fmtDateTime(p.snapshotAt || f.createdTime), p.count ? `${p.count} 筆` : ''].filter(Boolean).join('　'),
      });
    }
    if (items.length === 0) { showToast('雲端沒有備份可還原'); return; }
    renderRestoreVersions(items);
    document.getElementById('restorePickerModal').hidden = false;
  } catch (e) {
    showToast('讀取版本清單失敗：' + friendlyCloudErr(e));
  } finally {
    setCloudBusy(false);
  }
}

function renderRestoreVersions(items) {
  const list = document.getElementById('restoreVersionList');
  list.innerHTML = items.map((it, i) => `
    <label class="restore-version-item">
      <input type="radio" name="restoreVersion" value="${escapeHtml(it.value)}"${i === 0 ? ' checked' : ''}>
      <span class="rv-text">
        <span class="rv-main">${escapeHtml(it.main)}</span>
        <span class="rv-sub">${escapeHtml(it.sub)}</span>
      </span>
    </label>`).join('');
}

function closeRestorePicker() {
  document.getElementById('restorePickerModal').hidden = true;
}

async function confirmRestoreVersion() {
  const sel = document.querySelector('input[name="restoreVersion"]:checked');
  if (!sel) return;
  const value = sel.value;
  const labelEl = sel.closest('.restore-version-item').querySelector('.rv-main');
  const label = labelEl ? labelEl.textContent : '所選版本';
  closeRestorePicker();
  if (value === 'latest') {
    await cloudRestore({ manual: true });
  } else {
    await restoreFromSnapshot(value, label);
  }
}

async function restoreFromSnapshot(fileId, label) {
  setCloudBusy(true);
  try {
    const text = await driveDownloadText(fileId);
    let data;
    try { data = JSON.parse(text); } catch { showToast('版本資料格式錯誤'); return; }
    if (!data || !Array.isArray(data.readings)) { showToast('版本資料格式錯誤'); return; }
    if (!confirm(`確定要還原到「${label}」嗎？這會覆蓋此裝置目前所有紀錄與設定（該版本共 ${data.readings.length} 筆紀錄），並成為雲端最新版本。`)) return;
    await applyBackupObject(data);
    // Per the design decision: a restored older version becomes the new cloud
    // latest, so the roll-back takes effect across devices. Forcing lastSyncedAt
    // empty makes the upload treat the current main as "changed" and preserve it
    // as the .prev safety copy before overwriting.
    cloudState.lastSyncedAt = '';
    if (cloudState.email) cloudState.dataOwnerEmail = cloudState.email;
    saveCloudState();
    await cloudBackupNow({});
    updateCloudUI();
    closeSettings();
    showToast('已還原並更新雲端最新版本');
  } catch (e) {
    showToast('還原失敗：' + friendlyCloudErr(e));
  } finally {
    setCloudBusy(false);
  }
}

// First time the user links an account: reconcile this device with whatever is
// already in the cloud, so linking never silently loses data on either side.
async function cloudReconcileOnConnect() {
  const f = await driveFindFile(CLOUD_FILE_NAME);
  if (!f) { await cloudBackupNow({ manual: true }); return; }
  cloudState.fileId = f.id;
  saveCloudState();
  if (readings.length === 0) {
    await cloudRestore({ manual: true, confirmFirst: false });
    return;
  }
  const restore = confirm('雲端已有一份備份。\n\n選「確定」＝用雲端資料還原到此裝置；\n選「取消」＝保留此裝置資料並上傳覆蓋雲端。');
  if (restore) await cloudRestore({ manual: true, confirmFirst: false });
  else await cloudBackupNow({ manual: true });
}

// Wipe all on-device data (readings, medication logs, photos, settings and
// reminder runtime state). Used when switching to a different Google account so
// one account's data never mixes into another's. Suppresses cloud auto-backup
// while clearing. Cloud connection state (bp_cloud_v1) is NOT touched here.
async function clearAllLocalData() {
  suppressCloud = true;
  try {
    const ids = readings.map(r => r.photoId).filter(Boolean);
    await deletePhotos(ids).catch(() => {});
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(MED_KEY);
    localStorage.removeItem(WEIGHT_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(FIRED_SLOTS_KEY);
    localStorage.removeItem(MED_REMINDER_STATE_KEY);
    readings = loadReadings();   // []
    medLogs = loadMedLogs();     // {}
    weightLogs = loadWeightLogs(); // {}
    settings = loadSettings();   // defaults
    resetForm();
    renderAll();
  } finally {
    suppressCloud = false;
  }
}

async function cloudConnect({ switchAccount = false } = {}) {
  setCloudBusy(true);
  try {
    if (switchAccount) gisToken = null; // force the account chooser so a different account can be picked
    await getAccessToken(switchAccount ? 'select_account' : ''); // first link shows consent; a remembered grant stays silent
    const newEmail = await driveGetUserEmail();

    // Account-switch guard: if this device holds data belonging to a DIFFERENT
    // account, clear it before adopting the new one, so accounts never mix.
    const prevOwner = cloudState.dataOwnerEmail || cloudState.email;
    const switching = readings.length > 0 && !!prevOwner && !!newEmail && prevOwner !== newEmail;
    if (switching && !switchAccount) { // auto-detected (解除→連結 a different account): confirm the wipe
      const ok = confirm(`偵測到更換帳號。\n\n此裝置目前的資料屬於「${prevOwner}」，將先清除，改用「${newEmail}」的雲端資料。\n（前一個帳號的雲端備份仍會保留，之後可再切回。）\n\n確定要更換嗎？`);
      if (!ok) { showToast('已取消更換帳號'); return; }
    }
    if (switching) await clearAllLocalData();

    cloudState.enabled = true;
    cloudState.email = newEmail;
    cloudState.fileId = '';
    cloudState.prevFileId = '';
    cloudState.lastSyncedAt = '';
    cloudState.lastSnapshotDate = '';
    saveCloudState();
    updateCloudUI();
    showToast(switching ? '已更換帳號' : '已連結 Google 雲端備份');
    await cloudReconcileOnConnect();
    if (newEmail) { cloudState.dataOwnerEmail = newEmail; saveCloudState(); updateCloudUI(); }
  } catch (e) {
    showToast('連結失敗：' + friendlyCloudErr(e));
  } finally {
    setCloudBusy(false);
  }
}

// Explicit 更換帳號 button: confirm intent, then run the connect flow forcing the
// Google account chooser. If a different account is picked, cloudConnect clears
// this device's current-account data and restores the new account's cloud data.
async function cloudSwitchAccount() {
  if (!confirm('更換帳號會先清除此裝置上目前帳號的資料，再改用你選擇的另一個 Google 帳號的雲端資料。\n（目前帳號的雲端備份仍會保留，之後可再切回。）\n\n要選擇要更換的帳號嗎？')) return;
  await cloudConnect({ switchAccount: true });
}

// ---- Clear historical data (settings → 清除歷史資料) ----
// Destructive; guarded by a second confirm, and cloud-scoped deletions require
// Google authorization. Every clear ends by disconnecting cloud on this device
// (see disconnectCloudSilently) so a cleared device can't later clobber the
// cloud, and a cloud-cleared account isn't silently re-populated.

// Local health records only (readings + medication logs + photos) — settings,
// reminders and report info are deliberately preserved (per the user's choice).
async function clearLocalRecords() {
  suppressCloud = true;
  try {
    const ids = readings.map(r => r.photoId).filter(Boolean);
    await deletePhotos(ids).catch(() => {});
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(MED_KEY);
    localStorage.removeItem(WEIGHT_KEY);
    readings = loadReadings();
    medLogs = loadMedLogs();
    weightLogs = loadWeightLogs();
    resetForm();
    renderAll();
  } finally {
    suppressCloud = false;
  }
}

async function listAllAppDataFiles() {
  const url = 'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&pageSize=200';
  const res = await driveFetch(url, { method: 'GET' });
  if (!res.ok) throw new Error('list_failed');
  const data = await res.json();
  return data.files || [];
}

// Delete everything in the account's appDataFolder — main backup, .prev, and
// every history snapshot.
async function deleteAllCloudData() {
  const files = await listAllAppDataFiles();
  for (const f of files) { await driveDelete(f.id).catch(() => {}); }
}

function disconnectCloudSilently() {
  gisToken = null;
  cloudState.enabled = false;
  cloudState.email = '';
  cloudState.dataOwnerEmail = '';
  cloudState.fileId = '';
  cloudState.prevFileId = '';
  cloudState.lastSyncedAt = '';
  cloudState.lastSnapshotDate = '';
  cloudState.pendingBackup = false;
  cloudState.backupFailed = false;
  saveCloudState();
  updateCloudUI();
}

function openClearDataModal() {
  const first = document.querySelector('input[name="clearScope"][value="local"]');
  if (first) first.checked = true;
  document.getElementById('clearDataModal').hidden = false;
}

function closeClearDataModal() {
  document.getElementById('clearDataModal').hidden = true;
}

async function performClearData() {
  const sel = document.querySelector('input[name="clearScope"]:checked');
  if (!sel) return;
  const scope = sel.value; // 'local' | 'cloud' | 'both'
  const clearsCloud = scope === 'cloud' || scope === 'both';
  const clearsLocal = scope === 'local' || scope === 'both';

  setCloudBusy(true);
  try {
    // Cloud-inclusive deletions require a VISIBLE Google authorization. Do it
    // FIRST — right on the button's user gesture — clearing any cached token and
    // forcing prompt:'consent'. A silent '' token would reuse an existing grant
    // and show no UI; and running auth AFTER a blocking confirm() can let the
    // click's activation lapse, getting the consent popup blocked.
    if (clearsCloud) {
      gisToken = null;
      await getAccessToken('consent');
    }

    const desc = scope === 'local' ? '此裝置的血壓與用藥紀錄（含照片）'
      : scope === 'cloud' ? '雲端上所有備份與歷史版本'
      : '此裝置與雲端上的所有血壓與用藥紀錄、備份與歷史版本';
    // Second confirmation (the modal selection is the first).
    const msg = `確定要清除${desc}嗎？\n\n此操作無法復原！`
      + '\n清除完成後會解除此裝置的雲端連結。';
    if (!confirm(msg)) { showToast('已取消清除'); return; }

    closeClearDataModal();
    if (clearsCloud) await deleteAllCloudData();
    if (clearsLocal) await clearLocalRecords();
    disconnectCloudSilently();
    showToast('已清除所選資料');
  } catch (e) {
    showToast('清除失敗：' + friendlyCloudErr(e));
  } finally {
    setCloudBusy(false);
  }
}

function cloudDisconnect() {
  if (!confirm('解除連結後，此裝置將停止自動備份（雲端上已存的備份不會被刪除）。確定解除？')) return;
  try {
    if (gisToken && window.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(gisToken.access_token, () => {});
    }
  } catch {}
  gisToken = null;
  cloudState.enabled = false;
  cloudState.email = '';
  cloudState.fileId = '';
  cloudState.prevFileId = '';
  cloudState.lastSyncedAt = '';
  cloudState.pendingBackup = false;
  cloudState.backupFailed = false;
  saveCloudState();
  updateCloudUI();
  showToast('已解除雲端連結');
}

// On app open / return to foreground: if the cloud has a version this device
// hasn't synced (i.e. edited on another device), offer to restore it. If the
// user keeps local data, push it up so we agree and stop re-prompting.
async function cloudCheckOnOpen() {
  if (!cloudState.enabled || cloudBusy) return;
  try {
    const fileId = await resolveMainFileId();
    if (!fileId) return;
    const meta = await driveGetMeta(fileId);
    const remoteUpdated = meta && meta.appProperties && meta.appProperties.updatedAt;
    if (!remoteUpdated || remoteUpdated === cloudState.lastSyncedAt) return;
    const status = await cloudRestore({
      confirmFirst: true,
      confirmMsg: '雲端有較新的備份（可能來自其他裝置）。\n\n要用雲端資料還原到此裝置嗎？選「取消」則保留此裝置資料，之後的變更會覆蓋雲端。',
    });
    if (status === 'declined') await cloudBackupNow({});
  } catch {}
}

document.getElementById('cloudConnectBtn').addEventListener('click', () => cloudConnect());
document.getElementById('cloudSwitchBtn').addEventListener('click', cloudSwitchAccount);
document.getElementById('cloudDisconnectBtn').addEventListener('click', cloudDisconnect);
document.getElementById('cloudBackupNowBtn').addEventListener('click', () => cloudBackupNow({ manual: true, interactive: true }));
document.getElementById('cloudAlertBackupBtn').addEventListener('click', () => cloudBackupNow({ manual: true, interactive: true }));
document.getElementById('cloudRestoreBtn').addEventListener('click', openRestorePicker);
document.getElementById('closeRestorePickerBtn').addEventListener('click', closeRestorePicker);
document.getElementById('confirmRestoreVersionBtn').addEventListener('click', confirmRestoreVersion);
document.getElementById('restorePickerModal').addEventListener('click', (e) => {
  if (e.target.id === 'restorePickerModal') closeRestorePicker();
});
document.getElementById('openClearDataBtn').addEventListener('click', openClearDataModal);
document.getElementById('closeClearDataBtn').addEventListener('click', closeClearDataModal);
document.getElementById('confirmClearDataBtn').addEventListener('click', performClearData);
document.getElementById('clearDataModal').addEventListener('click', (e) => {
  if (e.target.id === 'clearDataModal') closeClearDataModal();
});
updateCloudUI();

// The periodic reminder now produces the report (which is then shared, saved
// or printed) instead of opening a text-only mailto.
function openReportFromReminder() {
  if (readings.length === 0) {
    showToast('目前沒有紀錄可產生報告');
    return;
  }
  startReportFlow(getExportRangeList());
}

document.getElementById('reminderSendBtn').addEventListener('click', openReportFromReminder);

document.getElementById('reminderLaterBtn').addEventListener('click', () => {
  reminderDismissedThisSession = true;
  renderReminder();
});

document.getElementById('reminderSkipBtn').addEventListener('click', () => {
  settings.lastSentAt = new Date().toISOString();
  saveSettings(settings);
  renderReminder();
  showToast('已略過本次提醒');
});

function renderReminder() {
  const card = document.getElementById('reminderCard');
  if (reminderDismissedThisSession || !isReminderDue(settings, readings)) {
    card.hidden = true;
    return;
  }
  document.getElementById('reminderText').textContent = settings.lastSentAt
    ? '距離上次產生報告已達設定的週期，該產生一份新的血壓報告了。'
    : '已啟用定期報告提醒，要現在產生第一份血壓報告嗎？';
  card.hidden = false;
}

chartRangeSelect.addEventListener('change', renderChart);

historyList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.closest('.history-item').dataset.id;
  if (btn.dataset.action === 'edit') { closeHistory(); startEdit(id); }
  if (btn.dataset.action === 'delete') deleteReading(id);
  if (btn.dataset.action === 'view-photo') viewPhoto(id);
});

async function viewPhoto(id) {
  const r = readings.find(x => x.id === id);
  if (!r || !r.photoId) return;
  const blob = await getPhoto(r.photoId);
  if (!blob) {
    showToast('找不到照片');
    return;
  }
  const url = URL.createObjectURL(blob);
  const viewer = document.getElementById('photoViewer');
  document.getElementById('photoViewerImg').src = url;
  viewer.dataset.objectUrl = url;
  viewer.hidden = false;
}

function closePhotoViewer() {
  const viewer = document.getElementById('photoViewer');
  if (viewer.dataset.objectUrl) {
    URL.revokeObjectURL(viewer.dataset.objectUrl);
    delete viewer.dataset.objectUrl;
  }
  viewer.hidden = true;
}

document.getElementById('closePhotoViewerBtn').addEventListener('click', closePhotoViewer);
document.getElementById('photoViewer').addEventListener('click', (e) => {
  if (e.target.id === 'photoViewer') closePhotoViewer();
});

function renderSummary() {
  const sorted = sortByDateTime(readings);
  const latest = sorted[sorted.length - 1];
  const latestValue = document.getElementById('latestValue');
  const latestTag = document.getElementById('latestTag');
  if (!latest) {
    latestValue.textContent = '—';
    latestValue.className = 'summary-value';
    latestTag.textContent = '';
    latestTag.className = 'summary-tag';
  } else {
    latestValue.textContent = `${latest.systolic}/${latest.diastolic}`;
    const c = classify(latest.systolic, latest.diastolic);
    latestValue.className = `summary-value cat-${c.cls}`;
    latestTag.textContent = c.label;
    latestTag.className = `summary-tag badge-${c.cls}`;
  }

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recent = readings.filter(r => new Date(`${r.date}T${r.time}`) >= sevenDaysAgo);
  const avgValue = document.getElementById('avgValue');
  if (recent.length === 0) {
    avgValue.textContent = '—';
  } else {
    const avgSys = Math.round(recent.reduce((s, r) => s + r.systolic, 0) / recent.length);
    const avgDia = Math.round(recent.reduce((s, r) => s + r.diastolic, 0) / recent.length);
    avgValue.textContent = `${avgSys}/${avgDia}`;
  }
}

function renderHistory() {
  const sorted = [...sortByDateTime(filterByRange(readings, historyDateFilter))].reverse();
  emptyState.hidden = sorted.length > 0;
  emptyState.textContent = (historyDateFilter.start || historyDateFilter.end)
    ? '此區間沒有紀錄'
    : '尚無紀錄，開始新增第一筆血壓記錄吧！';
  historyList.innerHTML = sorted.map(r => {
    const c = classify(r.systolic, r.diastolic);
    // Per-reading medication status: the most recent medication taken at or
    // before this reading's time on the same day. Readings before the day's
    // first dose lock to 尚未用藥 (red); later readings show that dose time.
    const lastMedBefore = lastMedBeforeReading(r);
    const medBadge = lastMedBefore
      ? `<span class="med-inline med-inline-done">💊 ${lastMedBefore}服藥</span>`
      : `<span class="med-inline med-inline-pending">尚未用藥</span>`;
    return `
      <div class="history-item" data-id="${r.id}">
        <div class="history-main">
          <span class="history-date">${fmtDate(r.date)} ${r.time}${r.tag ? ` · ${r.tag}` : ''}</span>
          <span class="history-values">${r.systolic}/${r.diastolic}${r.pulse ? `<span class="pulse-inline">♥ ${r.pulse}</span>` : ''}</span>
          <span class="history-tag badge-${c.cls}">${c.label}</span>
          ${medBadge}
          ${r.note ? `<span class="history-note">${escapeHtml(r.note)}</span>` : ''}
        </div>
        <div class="history-actions">
          ${r.photoId ? `<button data-action="view-photo" class="view-photo-btn" aria-label="檢視照片" title="檢視照片">🖼</button>` : ''}
          <button data-action="edit" aria-label="編輯" title="編輯">✎</button>
          <button data-action="delete" aria-label="刪除" title="刪除">🗑</button>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getChartData() {
  const range = Number(chartRangeSelect.value);
  return sortByDateTime(filterByRange(readings, chartDateFilter)).slice(-range);
}

function renderChart() {
  const canvas = document.getElementById('trendChart');
  const data = getChartData();
  renderStats(data);
  const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  drawChart(canvas, data, cssWidth, 180);
}

function drawChart(canvas, data, cssWidth, cssHeight) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  if (data.length === 0) {
    ctx.fillStyle = '#9aa8b0';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('尚無資料', cssWidth / 2, cssHeight / 2);
    return;
  }

  const padding = { top: 14, right: 10, bottom: 20, left: 30 };
  const plotW = cssWidth - padding.left - padding.right;
  const plotH = cssHeight - padding.top - padding.bottom;

  const values = data.flatMap(r => [r.systolic, r.diastolic, r.pulse].filter(v => v != null));
  const maxV = Math.max(...values, 140) + 10;
  const minV = Math.min(...values, 60) - 10;

  function x(i) { return padding.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW); }
  function y(v) { return padding.top + plotH - ((v - minV) / (maxV - minV)) * plotH; }

  // gridlines
  ctx.strokeStyle = '#e7edf0';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#9aa8b0';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = minV + ((maxV - minV) * i) / steps;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(padding.left, yy);
    ctx.lineTo(cssWidth - padding.right, yy);
    ctx.stroke();
    ctx.fillText(Math.round(v).toString(), padding.left - 4, yy + 3);
  }

  // target reference lines (goal < 130/80)
  function drawTargetLine(v, color, label) {
    if (v < minV || v > maxV) return;
    const yy = y(v);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, yy);
    ctx.lineTo(cssWidth - padding.right, yy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(label, cssWidth - padding.right, yy - 2);
    ctx.restore();
  }
  drawTargetLine(130, 'rgba(217,83,79,0.55)', '目標 130');
  drawTargetLine(80, 'rgba(47,102,144,0.55)', '目標 80');

  // medication markers: interpolate each dose's x from its date+time position
  const dts = data.map(r => new Date(`${r.date}T${r.time}`).getTime());
  function xForDatetime(t) {
    if (data.length === 1 || t <= dts[0]) return x(0);
    if (t >= dts[dts.length - 1]) return x(dts.length - 1);
    for (let j = 0; j < dts.length - 1; j++) {
      if (t >= dts[j] && t <= dts[j + 1]) {
        const span = (dts[j + 1] - dts[j]) || 1;
        return x(j) + ((t - dts[j]) / span) * (x(j + 1) - x(j));
      }
    }
    return x(dts.length - 1);
  }
  const firstDT = dts[0];
  const lastDT = dts[dts.length - 1];
  const medXs = [];
  Object.entries(medLogs).forEach(([date, times]) => {
    (times || []).forEach(t => {
      const dt = new Date(`${date}T${t}`).getTime();
      if (dt >= firstDT && dt <= lastDT) medXs.push(xForDatetime(dt));
    });
  });
  // faint vertical guides behind the data lines
  ctx.save();
  ctx.strokeStyle = 'rgba(58,167,109,0.28)';
  ctx.lineWidth = 1;
  medXs.forEach(mx => {
    ctx.beginPath();
    ctx.moveTo(mx, padding.top);
    ctx.lineTo(mx, padding.top + plotH);
    ctx.stroke();
  });
  ctx.restore();

  function drawLine(key, color) {
    const pts = data.map((r, i) => ({ x: x(i), y: r[key] != null ? y(r[key]) : null })).filter(p => p.y != null);
    if (pts.length === 0) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();
    ctx.fillStyle = color;
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  drawLine('diastolic', '#2f6690');
  drawLine('pulse', '#8a6dc9');
  drawLine('systolic', '#d9534f');

  // medication triangle markers on the bottom axis (drawn on top)
  ctx.save();
  ctx.fillStyle = '#3aa76d';
  const by = padding.top + plotH;
  medXs.forEach(mx => {
    ctx.beginPath();
    ctx.moveTo(mx, by - 6);
    ctx.lineTo(mx - 3.5, by);
    ctx.lineTo(mx + 3.5, by);
    ctx.closePath();
    ctx.fill();
  });
  ctx.restore();

  // x-axis labels (first, middle, last)
  ctx.fillStyle = '#9aa8b0';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(fmtDate(data[0].date), padding.left, cssHeight - 4);
  if (data.length > 1) {
    ctx.textAlign = 'right';
    ctx.fillText(fmtDate(data[data.length - 1].date), cssWidth - padding.right, cssHeight - 4);
  }
}

function computeStats(list) {
  if (list.length === 0) return null;
  const avg = (arr) => Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
  const morning = list.filter(r => r.time < '12:00');
  const evening = list.filter(r => r.time >= '12:00');
  const cats = { normal: 0, elevated: 0, stage1: 0, stage2: 0, crisis: 0 };
  list.forEach(r => { cats[classify(r.systolic, r.diastolic).cls]++; });
  const atGoal = list.filter(r => r.systolic < 130 && r.diastolic < 80).length;
  const maxR = list.reduce((a, b) => (b.systolic > a.systolic ? b : a));
  const minR = list.reduce((a, b) => (b.systolic < a.systolic ? b : a));
  const period = (sub) => sub.length
    ? { sys: avg(sub.map(r => r.systolic)), dia: avg(sub.map(r => r.diastolic)), n: sub.length }
    : null;
  const m = period(morning);
  // Home-BP morning hypertension: morning average ≥135/85.
  const morningHigh = !!m && (m.sys >= 135 || m.dia >= 85);
  return {
    count: list.length,
    avgSys: avg(list.map(r => r.systolic)),
    avgDia: avg(list.map(r => r.diastolic)),
    morning: m,
    evening: period(evening),
    cats,
    atGoalPct: Math.round((atGoal / list.length) * 100),
    max: { sys: maxR.systolic, dia: maxR.diastolic, date: maxR.date },
    min: { sys: minR.systolic, dia: minR.diastolic, date: minR.date },
    morningHigh,
  };
}

const CAT_LABELS = { normal: '正常', elevated: '偏高', stage1: '第一期', stage2: '第二期', crisis: '危象' };

function renderStats(list) {
  const box = document.getElementById('statsBox');
  if (!box) return;
  const s = computeStats(list);
  if (!s) { box.innerHTML = '<p class="stats-empty">此範圍尚無資料</p>'; return; }
  const catBits = Object.keys(CAT_LABELS)
    .filter(k => s.cats[k] > 0)
    .map(k => `<span class="stat-cat badge-${k}">${CAT_LABELS[k]} ${s.cats[k]}</span>`)
    .join('');
  box.innerHTML = `
    <div class="stats-grid">
      <div class="stat-cell"><span class="stat-k">筆數</span><span class="stat-v">${s.count}</span></div>
      <div class="stat-cell"><span class="stat-k">平均</span><span class="stat-v">${s.avgSys}/${s.avgDia}</span></div>
      <div class="stat-cell"><span class="stat-k">達標率<br><small>&lt;130/80</small></span><span class="stat-v">${s.atGoalPct}%</span></div>
      <div class="stat-cell"><span class="stat-k">晨間平均</span><span class="stat-v">${s.morning ? `${s.morning.sys}/${s.morning.dia}` : '—'}</span></div>
      <div class="stat-cell"><span class="stat-k">晚間平均</span><span class="stat-v">${s.evening ? `${s.evening.sys}/${s.evening.dia}` : '—'}</span></div>
      <div class="stat-cell"><span class="stat-k">最高 / 最低<br><small>收縮壓</small></span><span class="stat-v stat-v-sm">${s.max.sys} / ${s.min.sys}</span></div>
    </div>
    <div class="stat-cats">${catBits}</div>
    ${s.morningHigh ? '<p class="stat-warn">⚠ 晨間平均血壓偏高（≥135/85），建議與醫師討論晨間血壓控制。</p>' : ''}
  `;
}

function renderAll() {
  renderSummary();
  renderMedCard();
  renderHistory();
  renderChart();
  renderReminder();
}

window.addEventListener('resize', () => renderChart());

// ---- Measurement reminder notifications ----

const FIRED_SLOTS_KEY = 'bp_reminder_fired';

function todayStr() {
  return localDateStr();
}

function loadFiredSlots() {
  try {
    const raw = JSON.parse(localStorage.getItem(FIRED_SLOTS_KEY));
    if (raw && raw.date === todayStr()) return raw;
  } catch {}
  return { date: todayStr(), times: [] };
}

function saveFiredSlots(state) {
  localStorage.setItem(FIRED_SLOTS_KEY, JSON.stringify(state));
}

async function fireMeasurementReminder(t) {
  const body = `建議現在（${t}）量測血壓`;
  if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('量血壓提醒', { body, icon: 'icons/icon-192.png', tag: `bp-reminder-${t}` });
      return;
    } catch {}
  }
  showToast(`⏰ ${body}`);
}

const REMINDER_CATCHUP_MINUTES = 120;

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function checkMeasurementReminders() {
  if (!settings.reminderEnabled) return;
  const times = (settings.reminderTimes || []).filter(Boolean);
  if (times.length === 0) return;
  const nowMin = hhmmToMinutes(new Date().toTimeString().slice(0, 5));
  const fired = loadFiredSlots();
  let changed = false;
  times.forEach((t) => {
    if (fired.times.includes(t)) return;
    const tMin = hhmmToMinutes(t);
    // Fire once the scheduled time has arrived, catching up if the exact minute
    // was missed (background throttling of setInterval, device asleep, or the
    // app opened late) — but not for slots long past, to avoid a burst of stale
    // reminders when the app is opened much later in the day.
    if (nowMin >= tMin && nowMin - tMin <= REMINDER_CATCHUP_MINUTES) {
      fireMeasurementReminder(t);
      fired.times.push(t);
      changed = true;
    }
  });
  if (changed) saveFiredSlots(fired);
}

// ---- Daily medication reminder ----

const MED_REMINDER_STATE_KEY = 'bp_med_reminder_state';

function loadMedReminderState() {
  try {
    const raw = JSON.parse(localStorage.getItem(MED_REMINDER_STATE_KEY));
    if (raw && raw.date === todayStr()) return raw;
  } catch {}
  return { date: todayStr(), lastFiredAt: 0 };
}

function saveMedReminderState(state) {
  localStorage.setItem(MED_REMINDER_STATE_KEY, JSON.stringify(state));
}

async function fireMedReminder() {
  const body = `今天還沒記錄服藥（用藥時間 ${settings.medReminderTime}），記得吃藥並按下「記錄現在服藥」。`;
  if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('💊 用藥提醒', { body, icon: 'icons/icon-192.png', tag: 'bp-med-reminder', renotify: true });
      return;
    } catch {}
  }
  showToast(`💊 ${body}`);
}

async function closeMedReminderNotifications() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const notifs = await reg.getNotifications({ tag: 'bp-med-reminder' });
    notifs.forEach(n => n.close());
  } catch {}
}

function checkMedReminder() {
  if (!settings.medReminderEnabled) return;
  const today = todayStr();
  if (medTimesFor(today).length > 0) return; // already recorded medication today

  const [h, m] = (settings.medReminderTime || '08:00').split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return;
  const due = new Date();
  due.setHours(h, m, 0, 0);
  due.setMinutes(due.getMinutes() + (Number(settings.medReminderOverdueMin) || 0));
  const now = Date.now();
  if (now < due.getTime()) return; // scheduled time + grace period not reached yet

  const state = loadMedReminderState();
  const repeatMs = Math.max(5, Number(settings.medReminderRepeatMin) || 30) * 60000;
  if (state.date === today && state.lastFiredAt && (now - state.lastFiredAt) < repeatMs) return;

  fireMedReminder();
  saveMedReminderState({ date: today, lastFiredAt: now });
}

// ---- Daily display reset at 00:00 ----
// The 用藥記錄 card always shows only today's entries; older days are kept in
// storage so the 歷史紀錄 keeps each day's medication times for the doctor.
// This just refreshes the views when the date rolls over while the app stays open.

let activeDay = todayStr();

function handleDayRollover() {
  const today = todayStr();
  if (today !== activeDay) {
    activeDay = today;
    renderAll();
    maybeWeightPrompt(); // new day while the app stays open → prompt once
  }
}

function checkAllReminders() {
  handleDayRollover();
  // Keep the auto-time entry fields current so a form left open past midnight
  // still shows today's date (submit also recomputes, so data is safe either way).
  if (document.getElementById('useNowTime').checked && !editIdInput.value) {
    refreshNowFields();
  }
  checkMeasurementReminders();
  checkMedReminder();
}

setInterval(checkAllReminders, 20000);
checkAllReminders();

resetForm();
renderAll();
document.getElementById('appVersion').textContent = `版本 ${APP_VERSION}`;
maybeShowManualOnStart();
maybeWeightPrompt(); // first operation of the day → ask about recording weight
                     // (skips itself if the what's-new/manual modal is showing;
                     //  those modals' close handlers retry it)

// Prune photos beyond the newest MAX_PHOTOS on startup too, so data that
// predates this cap (or arrived via an old backup) gets cleaned up and the
// change propagates to the cloud backup.
enforcePhotoLimit().then((changed) => {
  if (changed) { saveReadings(readings); renderAll(); }
});

// Cloud backup: check for a newer cloud copy on open and whenever the app
// returns to the foreground (e.g. edited on another device meanwhile).
if (cloudState.enabled) {
  cloudCheckOnOpen();
  refreshCloudEmailIfMissing();
  // Retry a backup that a background (throttled/expired-token) attempt left
  // unfinished, now that we're in the foreground.
  if (cloudState.pendingBackup || cloudState.backupFailed) cloudBackupNow({});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cloudState.enabled) {
    cloudCheckOnOpen();
    if (cloudState.pendingBackup || cloudState.backupFailed) cloudBackupNow({});
  }
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  // Reload once when a newly-installed service worker takes control, so a
  // long-lived installed PWA actually picks up deployed updates instead of
  // running stale cached code. Skip on the very first install (no prior
  // controller) to avoid a needless reload.
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing || !hadController) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // Proactively check for a new version now and whenever the app returns to
      // the foreground; without this a home-screen PWA that never closes can
      // stay on an old version indefinitely.
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}
