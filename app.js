const STORAGE_KEY = 'bp_records_v1';
const SETTINGS_KEY = 'bp_settings_v1';

/** @typedef {{id:string,date:string,time:string,systolic:number,diastolic:number,pulse:number|null,tag:string,note:string}} Reading */

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

function loadSettings() {
  const defaults = { email: '', frequency: 'weekly', customDays: 14, autoClear: false, lastSentAt: null };
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
let settings = loadSettings();
let reminderDismissedThisSession = false;
let pendingSendConfirmation = false;
let dateFilter = { start: '', end: '' };
let historyCollapsed = localStorage.getItem('bp_history_collapsed') === '1';

function filteredReadings() {
  if (!dateFilter.start && !dateFilter.end) return readings;
  return readings.filter(r => {
    if (dateFilter.start && r.date < dateFilter.start) return false;
    if (dateFilter.end && r.date > dateFilter.end) return false;
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
  editIdInput.value = '';
  submitBtn.textContent = '新增紀錄';
  cancelEditBtn.hidden = true;
  const now = new Date();
  document.getElementById('fieldDate').value = now.toISOString().slice(0, 10);
  document.getElementById('fieldTime').value = now.toTimeString().slice(0, 5);
}

function startEdit(id) {
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
  submitBtn.textContent = '儲存變更';
  cancelEditBtn.hidden = false;
  window.scrollTo({ top: form.offsetTop - 20, behavior: 'smooth' });
}

function deleteReading(id) {
  if (!confirm('確定要刪除這筆紀錄嗎？')) return;
  readings = readings.filter(x => x.id !== id);
  saveReadings(readings);
  renderAll();
  showToast('已刪除');
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const systolic = Number(document.getElementById('fieldSystolic').value);
  const diastolic = Number(document.getElementById('fieldDiastolic').value);
  const pulseRaw = document.getElementById('fieldPulse').value;
  const entry = {
    id: editIdInput.value || crypto.randomUUID(),
    date: document.getElementById('fieldDate').value,
    time: document.getElementById('fieldTime').value,
    systolic,
    diastolic,
    pulse: pulseRaw ? Number(pulseRaw) : null,
    tag: document.getElementById('fieldTag').value,
    note: document.getElementById('fieldNote').value.trim(),
  };

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
});

cancelEditBtn.addEventListener('click', resetForm);

document.getElementById('exportBtn').addEventListener('click', () => {
  const list = filteredReadings();
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
});

document.getElementById('filterStart').addEventListener('change', (e) => {
  dateFilter.start = e.target.value;
  renderAll();
});

document.getElementById('filterEnd').addEventListener('change', (e) => {
  dateFilter.end = e.target.value;
  renderAll();
});

document.getElementById('clearDateFilterBtn').addEventListener('click', () => {
  dateFilter = { start: '', end: '' };
  document.getElementById('filterStart').value = '';
  document.getElementById('filterEnd').value = '';
  renderAll();
});

function applyHistoryCollapsed() {
  document.getElementById('historyBody').hidden = historyCollapsed;
  document.getElementById('historyToggleIcon').textContent = historyCollapsed ? '▸' : '▾';
  document.getElementById('historyToggleBtn').setAttribute('aria-expanded', String(!historyCollapsed));
}

document.getElementById('historyToggleBtn').addEventListener('click', () => {
  historyCollapsed = !historyCollapsed;
  localStorage.setItem('bp_history_collapsed', historyCollapsed ? '1' : '0');
  applyHistoryCollapsed();
});

document.getElementById('clearAllBtn').addEventListener('click', () => {
  if (readings.length === 0) {
    showToast('目前沒有紀錄');
    return;
  }
  if (!confirm(`確定要刪除全部 ${readings.length} 筆血壓紀錄嗎？此動作無法復原。`)) return;
  readings = [];
  saveReadings(readings);
  resetForm();
  renderAll();
  showToast('已清除所有紀錄');
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
    document.getElementById('exportBtn').click();
  }
});

// ---- Settings & scheduled email reminder ----

const settingsModal = document.getElementById('settingsModal');

function openSettings() {
  document.getElementById('settingEmail').value = settings.email;
  document.getElementById('settingFrequency').value = settings.frequency;
  document.getElementById('settingCustomDays').value = settings.customDays;
  document.getElementById('settingAutoClear').checked = settings.autoClear;
  toggleCustomDaysRow();
  renderSettingsMeta();
  settingsModal.hidden = false;
}

function closeSettings() {
  settingsModal.hidden = true;
}

function toggleCustomDaysRow() {
  document.getElementById('customDaysRow').hidden = document.getElementById('settingFrequency').value !== 'custom';
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

document.getElementById('settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  settings.email = document.getElementById('settingEmail').value.trim();
  settings.frequency = document.getElementById('settingFrequency').value;
  settings.customDays = Number(document.getElementById('settingCustomDays').value) || 14;
  settings.autoClear = document.getElementById('settingAutoClear').checked;
  saveSettings(settings);
  closeSettings();
  renderReminder();
  showToast('設定已儲存');
});

document.getElementById('sendNowBtn').addEventListener('click', () => {
  closeSettings();
  sendReminderEmail();
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
      readings = [];
      saveReadings(readings);
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
  if (btn.dataset.action === 'edit') startEdit(id);
  if (btn.dataset.action === 'delete') deleteReading(id);
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
  const sorted = [...sortByDateTime(filteredReadings())].reverse();
  emptyState.hidden = sorted.length > 0;
  emptyState.textContent = (dateFilter.start || dateFilter.end)
    ? '此區間沒有紀錄'
    : '尚無紀錄，開始新增第一筆血壓記錄吧！';
  historyList.innerHTML = sorted.map(r => {
    const c = classify(r.systolic, r.diastolic);
    return `
      <div class="history-item" data-id="${r.id}">
        <div class="history-main">
          <span class="history-date">${fmtDate(r.date)} ${r.time}${r.tag ? ` · ${r.tag}` : ''}</span>
          <span class="history-values">${r.systolic}/${r.diastolic}${r.pulse ? `<span class="pulse-inline">♥ ${r.pulse}</span>` : ''}</span>
          <span class="history-tag badge-${c.cls}">${c.label}</span>
          ${r.note ? `<span class="history-note">${escapeHtml(r.note)}</span>` : ''}
        </div>
        <div class="history-actions">
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
  const data = sortByDateTime(filteredReadings()).slice(-range);

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
  renderHistory();
  renderChart();
  renderReminder();
}

window.addEventListener('resize', () => renderChart());

resetForm();
applyHistoryCollapsed();
renderAll();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
