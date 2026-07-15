const STORAGE_KEY = 'bp_records_v1';
const SETTINGS_KEY = 'bp_settings_v1';
const PHOTO_DB_NAME = 'bp_photos_db';
const PHOTO_STORE = 'photos';

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
}

function medTimesFor(date) {
  return (medLogs[date] || []).slice().sort();
}

function loadSettings() {
  const defaults = {
    email: '', frequency: 'weekly', customDays: 14, autoClear: false, lastSentAt: null,
    reminderEnabled: false, reminderTimes: ['08:00', '13:00', '20:00'],
    highBpAlertEnabled: false, highBpAlertMode: 'auto', highBpCustomSystolic: 130, highBpCustomDiastolic: 80,
    medReminderEnabled: false, medReminderTime: '08:00', medReminderOverdueMin: 30, medReminderRepeatMin: 30,
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

function isReminderDue(s, readingsList) {
  if (!s.email || readingsList.length === 0) return false;
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

function buildEmailBody(list) {
  const sorted = sortByDateTime(list);
  const lines = sorted.map(r => {
    const c = classify(r.systolic, r.diastolic);
    return `${r.date} ${r.time}  ${r.systolic}/${r.diastolic} mmHg${r.pulse ? `  心跳 ${r.pulse}` : ''}  [${c.label}]${r.tag ? `  ${r.tag}` : ''}${r.note ? `  備註:${r.note}` : ''}`;
  });
  return `血壓紀錄（共 ${sorted.length} 筆）\n\n${lines.join('\n')}`;
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
let settings = loadSettings();
let reminderDismissedThisSession = false;
let pendingSendConfirmation = false;
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
  const now = new Date();
  document.getElementById('fieldDate').value = now.toISOString().slice(0, 10);
  document.getElementById('fieldTime').value = now.toTimeString().slice(0, 5);
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
  const systolic = Number(document.getElementById('fieldSystolic').value);
  const diastolic = Number(document.getElementById('fieldDiastolic').value);
  const pulseRaw = document.getElementById('fieldPulse').value;

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
    date: document.getElementById('fieldDate').value,
    time: document.getElementById('fieldTime').value,
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
  saveReadings(readings);
  resetForm();
  renderAll();

  if (settings.highBpAlertEnabled && !priorSameDayHigh && meetsHighBpThreshold(entry, settings)) {
    alert('目前您的血壓有過高的情況，請記得服藥以控制血壓');
  }
});

cancelEditBtn.addEventListener('click', resetForm);

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
  a.download = `血壓紀錄_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const exportRangeSelect = document.getElementById('exportRange');

function toggleExportCustomRow() {
  document.getElementById('exportCustomRow').hidden = exportRangeSelect.value !== 'custom';
}

exportRangeSelect.addEventListener('change', toggleExportCustomRow);

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  const type = exportRangeSelect.value;
  if (type === '30') {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 29);
    const toStr = (d) => d.toISOString().slice(0, 10);
    exportCsv(filterByRange(readings, { start: toStr(start), end: toStr(end) }));
  } else if (type === 'custom') {
    const start = document.getElementById('exportStart').value;
    const end = document.getElementById('exportEnd').value;
    exportCsv(filterByRange(readings, { start, end }));
  } else {
    exportCsv(readings);
  }
});

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

document.getElementById('shareBtn').addEventListener('click', async () => {
  if (readings.length === 0) {
    showToast('目前沒有資料可分享');
    return;
  }
  const shareData = { title: '血壓記錄', text: buildEmailBody(readings) };
  try {
    const file = new File([buildCsv(readings)], `血壓紀錄_${new Date().toISOString().slice(0, 10)}.csv`, { type: 'text/csv' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      shareData.files = [file];
    }
  } catch {}

  if (navigator.share) {
    try {
      await navigator.share(shareData);
    } catch (err) {
      if (err.name !== 'AbortError') showToast('分享失敗');
    }
  } else {
    showToast('此瀏覽器不支援分享，改為下載 CSV');
    exportCsv(readings);
  }
});

// ---- Medication log ----

function renderMedCard() {
  const today = todayStr();
  const times = medTimesFor(today);
  const status = document.getElementById('medTodayStatus');
  const listEl = document.getElementById('medTodayList');
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
  const time = new Date().toTimeString().slice(0, 5);
  if (!confirm(`確定要記錄「現在（${time}）服藥」嗎？`)) return;
  const list = medLogs[date] || [];
  list.push(time);
  medLogs[date] = list;
  saveMedLogs(medLogs);
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
    ? `上次寄送：${new Date(settings.lastSentAt).toLocaleString('zh-TW')}`
    : '尚未寄送過';
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

  saveSettings(settings);
  closeSettings();
  renderReminder();
  showToast('設定已儲存');
});

document.getElementById('sendNowBtn').addEventListener('click', () => {
  closeSettings();
  sendReminderEmail();
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

async function exportBackup() {
  const photoIds = readings.map(r => r.photoId).filter(Boolean);
  const photos = {};
  for (const id of photoIds) {
    const blob = await getPhoto(id);
    if (blob) photos[id] = await blobToDataUrl(blob);
  }
  const backup = {
    version: 2,
    exportedAt: new Date().toISOString(),
    readings,
    medLogs,
    settings,
    photos,
  };
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `血壓備份_${new Date().toISOString().slice(0, 10)}.json`;
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

  const existingPhotoIds = readings.map(r => r.photoId).filter(Boolean);
  await deletePhotos(existingPhotoIds);

  const photos = data.photos || {};
  for (const [id, dataUrl] of Object.entries(photos)) {
    try {
      const blob = await dataUrlToBlob(dataUrl);
      await savePhoto(id, blob);
    } catch {}
  }

  readings = data.readings;
  saveReadings(readings);
  medLogs = (data.medLogs && typeof data.medLogs === 'object') ? data.medLogs : {};
  saveMedLogs(medLogs);
  pruneOldMedLogs();
  if (data.settings) {
    settings = { ...loadSettings(), ...data.settings };
    saveSettings(settings);
  }
  resetForm();
  renderAll();
  closeSettings();
  showToast('已還原備份');
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

function sendReminderEmail() {
  if (!settings.email) {
    showToast('請先在設定中輸入 Email');
    openSettings();
    return;
  }
  if (readings.length === 0) {
    showToast('目前沒有紀錄可寄送');
    return;
  }
  const sorted = sortByDateTime(readings);
  const subject = `血壓紀錄 ${fmtDate(sorted[0].date)} - ${fmtDate(sorted[sorted.length - 1].date)}`;
  const body = buildEmailBody(readings);
  const mailto = `mailto:${encodeURIComponent(settings.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  pendingSendConfirmation = true;
  window.location.href = mailto;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !pendingSendConfirmation) return;
  pendingSendConfirmation = false;
  setTimeout(() => {
    if (!confirm('請問郵件是否已經寄出？')) {
      renderReminder();
      return;
    }
    settings.lastSentAt = new Date().toISOString();
    saveSettings(settings);
    if (settings.autoClear) {
      const photoIds = readings.map(r => r.photoId).filter(Boolean);
      readings = [];
      saveReadings(readings);
      deletePhotos(photoIds);
      showToast('已寄送並清除舊紀錄');
    } else {
      showToast('已記錄寄送時間');
    }
    renderAll();
    renderSettingsMeta();
  }, 300);
});

document.getElementById('reminderSendBtn').addEventListener('click', sendReminderEmail);

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
    ? `距離上次寄送已經到了設定的週期，該把血壓紀錄寄給 ${settings.email} 了。`
    : `已設定定期寄送到 ${settings.email}，要現在寄送第一次嗎？`;
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
    latestTag.textContent = '';
    latestTag.className = 'summary-tag';
  } else {
    latestValue.textContent = `${latest.systolic}/${latest.diastolic}`;
    const c = classify(latest.systolic, latest.diastolic);
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
  const today = todayStr();
  historyList.innerHTML = sorted.map(r => {
    const c = classify(r.systolic, r.diastolic);
    const medTimes = medTimesFor(r.date);
    let medBadge = '';
    if (medTimes.length > 0) {
      medBadge = `<span class="med-inline med-inline-done">💊 服藥 ${medTimes.join('、')}</span>`;
    } else if (r.date === today) {
      medBadge = `<span class="med-inline med-inline-pending">還沒吃藥</span>`;
    }
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

function renderChart() {
  const canvas = document.getElementById('trendChart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth;
  const cssHeight = 180;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const range = Number(chartRangeSelect.value);
  const data = sortByDateTime(filterByRange(readings, chartDateFilter)).slice(-range);

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
  return new Date().toISOString().slice(0, 10);
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

function checkMeasurementReminders() {
  if (!settings.reminderEnabled) return;
  const times = (settings.reminderTimes || []).filter(Boolean);
  if (times.length === 0) return;
  const hhmm = new Date().toTimeString().slice(0, 5);
  const fired = loadFiredSlots();
  let changed = false;
  times.forEach((t) => {
    if (t === hhmm && !fired.times.includes(t)) {
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

// ---- Daily medication-log reset (clears at 00:00) ----

let activeDay = todayStr();

function pruneOldMedLogs() {
  const today = todayStr();
  let changed = false;
  for (const date of Object.keys(medLogs)) {
    if (date !== today) {
      delete medLogs[date];
      changed = true;
    }
  }
  if (changed) saveMedLogs(medLogs);
  return changed;
}

function handleDayRollover() {
  const today = todayStr();
  const pruned = pruneOldMedLogs();
  if (today !== activeDay) {
    activeDay = today;
    renderAll();
  } else if (pruned) {
    renderMedCard();
    renderHistory();
  }
}

function checkAllReminders() {
  handleDayRollover();
  checkMeasurementReminders();
  checkMedReminder();
}

pruneOldMedLogs();
setInterval(checkAllReminders, 20000);
checkAllReminders();

resetForm();
renderAll();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
