const STORAGE_KEY = 'bp_records_v1';

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
  if (readings.length === 0) {
    showToast('目前沒有資料可匯出');
    return;
  }
  const header = '日期,時間,收縮壓,舒張壓,心跳,時段,備註\n';
  const rows = sortByDateTime(readings).map(r =>
    [r.date, r.time, r.systolic, r.diastolic, r.pulse ?? '', r.tag, `"${(r.note || '').replace(/"/g, '""')}"`].join(',')
  );
  const csv = '﻿' + header + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `血壓紀錄_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
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
  const sorted = [...sortByDateTime(readings)].reverse();
  emptyState.hidden = sorted.length > 0;
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
  const data = sortByDateTime(readings).slice(-range);

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
}

window.addEventListener('resize', () => renderChart());

resetForm();
renderAll();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
