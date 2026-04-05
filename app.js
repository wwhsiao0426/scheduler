// ─── Constants ────────────────────────────────────────────────────────────────

const PEOPLE     = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const DOW_ZH     = ['日', '一', '二', '三', '四', '五', '六'];
const SLOT_LABELS = ['14:00-22:00', '15:00-23:00', '16:00-00:00', '20:00-04:00'];
const MAX_CONSECUTIVE = 6;   // hard limit: cannot exceed this many consecutive working days
const SOFT_PENALTY    = 999; // penalty added to sort score for soft-avoid people

// ─── State ────────────────────────────────────────────────────────────────────

let currentSchedule = null;
let currentYear     = null;
let currentMonth    = null;
let currentHolidays = [];

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initYearMonth();
  loadConfig();
});

function initYearMonth() {
  const yearSel  = document.getElementById('year-select');
  const monthSel = document.getElementById('month-select');
  const now      = new Date();
  for (let y = now.getFullYear() - 3; y <= now.getFullYear() + 3; y++) {
    const o = document.createElement('option');
    o.value = y; o.textContent = y;
    if (y === now.getFullYear()) o.selected = true;
    yearSel.appendChild(o);
  }
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m + ' 月';
    if (m === now.getMonth() + 1) o.selected = true;
    monthSel.appendChild(o);
  }
}

function loadConfig() {
  // Priority: localStorage (user override) → config.js hardcoded defaults
  const sid = localStorage.getItem('scheduleSheetId') || (typeof APP_CONFIG !== 'undefined' ? APP_CONFIG.sheetId  : '');
  const cid = localStorage.getItem('scheduleClientId') || (typeof APP_CONFIG !== 'undefined' ? APP_CONFIG.clientId : '');
  if (sid) document.getElementById('sheet-id').value = sid;
  if (cid) document.getElementById('client-id').value = cid;
}

function saveConfig() {
  const sid = document.getElementById('sheet-id').value.trim();
  const cid = document.getElementById('client-id').value.trim();
  localStorage.setItem('scheduleSheetId', sid);
  localStorage.setItem('scheduleClientId', cid);
  showMsg('設定已儲存', 'success');
}

function toggleSection(id) {
  const el   = document.getElementById(id);
  const icon = document.getElementById('config-icon');
  if (!el) return;
  const hidden = el.style.display === 'none';
  el.style.display = hidden ? '' : 'none';
  if (icon) icon.classList.toggle('collapsed', !hidden);
}

function showMsg(text, type = 'info') {
  const el = document.getElementById('msg-area');
  el.textContent = text;
  el.className   = type;
}

// ─── Schedule Helpers ─────────────────────────────────────────────────────────

function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function parseHolidays(str) {
  if (!str || !str.trim()) return [];
  return str.split(',')
    .map(s => parseInt(s.trim()))
    .filter(n => !isNaN(n) && n >= 1 && n <= 31);
}

function initCounts() {
  const c = {};
  PEOPLE.forEach(p => {
    c[p] = { slot1: 0, slot2: 0, slot3: 0, slot4: 0, holiday: 0, holidayBackup: 0, off: 0 };
  });
  return c;
}

/**
 * Pick the best available person for a slot.
 * @param {string[]} hardExcl  - must NOT pick these
 * @param {string[]} softAvoid - try to avoid (backup-yesterday)
 * @param {string[]} prioritize - strongly prefer these (requested to work today)
 */
function pickPerson(counts, slot, hardExcl, softAvoid = [], prioritize = []) {
  const avail = PEOPLE.filter(p => !hardExcl.includes(p));
  if (avail.length === 0) throw new Error('排班人數不足，無法滿足所有限制');

  // For s1 / s2 / s4: when tied, prefer people with high slot3 count
  // (rescue them from being stuck in slot3 as leftover again)
  const isRescueSlot = ['slot1', 'slot2', 'slot4'].includes(slot);

  avail.sort((a, b) => {
    // 1. Primary: target slot count (+ soft/priority modifiers)
    const ca = counts[a][slot]
      + (softAvoid.includes(a)  ?  SOFT_PENALTY : 0)
      + (prioritize.includes(a) ? -SOFT_PENALTY : 0);
    const cb = counts[b][slot]
      + (softAvoid.includes(b)  ?  SOFT_PENALTY : 0)
      + (prioritize.includes(b) ? -SOFT_PENALTY : 0);
    let d = ca - cb;
    if (d !== 0) return d;

    // 2. Total work count (ascending) – overall fairness
    const totA = counts[a].slot1 + counts[a].slot2 + counts[a].slot3 + counts[a].slot4;
    const totB = counts[b].slot1 + counts[b].slot2 + counts[b].slot3 + counts[b].slot4;
    d = totA - totB;
    if (d !== 0) return d;

    // 3. slot3 rescue (descending) – pick high-slot3 person to free them from slot3
    if (isRescueSlot) {
      d = counts[b].slot3 - counts[a].slot3;
      if (d !== 0) return d;
    }

    // 4. Alphabetical as final tiebreak
    return a.localeCompare(b);
  });
  return avail[0];
}

// ─── Request Parsing ──────────────────────────────────────────────────────────

function parseRequests() {
  const reqOff  = {};
  const reqWork = {};
  PEOPLE.forEach(p => {
    reqOff[p]  = parseHolidays(document.getElementById(`req-off-${p}`)?.value  || '');
    reqWork[p] = parseHolidays(document.getElementById(`req-work-${p}`)?.value || '');
  });
  return { reqOff, reqWork };
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateRequests(year, month, extraHolidays, reqOff, reqWork) {
  const warnings = [];
  const days     = getDaysInMonth(year, month);
  const toCol    = dow => (dow === 0 ? 6 : dow - 1);

  for (let day = 1; day <= days; day++) {
    const dow       = new Date(year, month - 1, day).getDay();
    const isHoliday = toCol(dow) >= 5 || extraHolidays.includes(day);

    const offPeople  = PEOPLE.filter(p => reqOff[p].includes(day));
    const workPeople = PEOPLE.filter(p => reqWork[p].includes(day));

    // Same person requests both off and work on same day
    const conflicts = PEOPLE.filter(p => reqOff[p].includes(day) && reqWork[p].includes(day));
    if (conflicts.length > 0)
      warnings.push(`⚠️ ${conflicts.join('、')} 在 ${day} 日同時申請休假與排班，有衝突`);

    if (isHoliday) {
      if (workPeople.length > 1)
        warnings.push(`⚠️ ${day} 日為假日，${workPeople.join('、')} 同時申請排班，只能排 1 人上班`);
      if (offPeople.length === PEOPLE.length)
        warnings.push(`⚠️ ${day} 日（假日）所有人申請休假，仍需至少 1 人上班`);
    } else {
      if (offPeople.length > 1)
        warnings.push(`⚠️ ${day} 日有 ${offPeople.length} 人（${offPeople.join('、')}）同時申請休假，平日只能 1 人休假`);
      if (offPeople.length >= 6)
        warnings.push(`⚠️ ${day} 日申請休假人數過多，無法完成排班`);
    }
  }
  return warnings;
}

// ─── Distribution Fairness Check ─────────────────────────────────────────────

function checkDistribution(counts, workDays, holDays) {
  const warnings = [];
  const checks = [
    { key: 'slot1',  label: SLOT_LABELS[0], ideal: workDays / 7 },
    { key: 'slot2',  label: SLOT_LABELS[1], ideal: workDays / 7 },
    { key: 'slot3',  label: SLOT_LABELS[2], ideal: 3 * workDays / 7 },
    { key: 'slot4',  label: SLOT_LABELS[3], ideal: workDays / 7 },
    { key: 'holiday',label: '假日上班',      ideal: holDays / 7 },
  ];
  checks.forEach(({ key, label, ideal }) => {
    const vals = PEOPLE.map(p => counts[p][key]);
    const max  = Math.max(...vals);
    const min  = Math.min(...vals);
    if (max - min > 2) {
      const hi = PEOPLE.filter(p => counts[p][key] === max).join('、');
      const lo = PEOPLE.filter(p => counts[p][key] === min).join('、');
      warnings.push(`⚠️ ${label} 分布不均：${hi} 排 ${max} 次 vs ${lo} 排 ${min} 次（相差 ${max - min} 次）`);
    }
  });
  return warnings;
}

// ─── Main Schedule Generation ─────────────────────────────────────────────────

function generateSchedule(year, month, extraHolidays, reqOff = {}, reqWork = {}) {
  const days   = getDaysInMonth(year, month);
  const counts = initCounts();
  const result = [];

  // Consecutive working-day counter per person
  // "Working" = assigned to a weekday slot OR is holiday worker (NOT backup or off)
  const streak = {};
  PEOPLE.forEach(p => { streak[p] = 0; });

  // The person who was backup yesterday (soft-avoid next day)
  let yesterdayBackup = null;

  for (let day = 1; day <= days; day++) {
    const date      = new Date(year, month - 1, day);
    const dow       = date.getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = isWeekend || extraHolidays.includes(day);

    // Hard exclusion: streak limit + requested off today
    const reqOffToday  = PEOPLE.filter(p => (reqOff[p]  || []).includes(day));
    const reqWorkToday = PEOPLE.filter(p => (reqWork[p] || []).includes(day));
    const mustRest     = [...new Set([...PEOPLE.filter(p => streak[p] >= MAX_CONSECUTIVE), ...reqOffToday])];

    // Soft avoid: yesterday's backup person
    const softAvoid = yesterdayBackup ? [yesterdayBackup] : [];

    // Per-cell warnings recorded here: { personName: 'warn-type' }
    // warn types: 'streak5' | 'streak6' | 'backup-next-day'
    const warnings = {};

    if (isHoliday) {
      // ── Holiday ──────────────────────────────────────────────────────────
      const worker = pickPerson(counts, 'holiday', mustRest, softAvoid, reqWorkToday);
      counts[worker].holiday++;

      // Backup: exclude mustRest AND the worker; soft-avoid yesterday's backup
      const backup = pickPerson(counts, 'holidayBackup', [...mustRest, worker], softAvoid, reqWorkToday.filter(p => p !== worker));
      counts[backup].holidayBackup++;

      // Warn if soft constraint was unavoidably violated
      if (softAvoid.includes(worker)) warnings[worker] = 'backup-next-day';
      if (softAvoid.includes(backup)) warnings[backup] = 'backup-next-day';

      // Update streaks:
      // - worker → streak++
      // - backup → NOT working, streak resets (they're on standby, not on shift)
      // - everyone else → not working, streak resets
      PEOPLE.forEach(p => {
        if (p === worker) {
          streak[p]++;
          if (streak[p] >= MAX_CONSECUTIVE)     warnings[p] = warnings[p] || 'streak6';
          else if (streak[p] === MAX_CONSECUTIVE - 1) warnings[p] = warnings[p] || 'streak5';
        } else {
          streak[p] = 0;
        }
      });

      yesterdayBackup = backup;
      result.push({ day, dow, isHoliday: true, worker, backup, warnings,
                    streakAfter: { ...streak } });

    } else {
      // ── Weekday ──────────────────────────────────────────────────────────
      // Assignment order: s1 → s2 → s4 → off → s3 = leftovers
      // Rationale: s3 has 3 spots and naturally balances as the residual group.
      // Picking s4 before s3 ensures slot4 gets a fair choice from the full pool,
      // preventing the "last pick" imbalance that occurred when s3 consumed 3 people first.
      const assigned = [];

      const s1 = pickPerson(counts, 'slot1', [...mustRest, ...assigned], softAvoid, reqWorkToday);
      if (softAvoid.includes(s1)) warnings[s1] = 'backup-next-day';
      assigned.push(s1); counts[s1].slot1++;

      const s2 = pickPerson(counts, 'slot2', [...mustRest, ...assigned], softAvoid, reqWorkToday);
      if (softAvoid.includes(s2)) warnings[s2] = 'backup-next-day';
      assigned.push(s2); counts[s2].slot2++;

      const s4 = pickPerson(counts, 'slot4', [...mustRest, ...assigned], softAvoid, reqWorkToday);
      if (softAvoid.includes(s4)) warnings[s4] = 'backup-next-day';
      assigned.push(s4); counts[s4].slot4++;

      // Pool of people not yet assigned and not forced to rest
      const offPool = PEOPLE.filter(p => !mustRest.includes(p) && !assigned.includes(p));

      // Pick "off": prefer whoever has the most slot3 count (give them relief from slot3),
      // then min off count for balance, then alphabetical. Avoid reqWorkToday if possible.
      let off;
      if (mustRest.length >= 1) {
        // Someone is forced to rest — they take the off spot
        off = mustRest[0];
      } else {
        const offCandidates = offPool.filter(p => !reqWorkToday.includes(p));
        const pickFrom      = offCandidates.length > 0 ? offCandidates : offPool;
        off = pickFrom.reduce((best, p) => {
          // 1. Highest slot3 count → give them a break from slot3
          if (counts[p].slot3 > counts[best].slot3) return p;
          if (counts[p].slot3 < counts[best].slot3) return best;
          // 2. Lowest off count → balance off days
          if (counts[p].off < counts[best].off) return p;
          if (counts[p].off > counts[best].off) return best;
          // 3. Alphabetical
          return p < best ? p : best;
        }, pickFrom[0]);
      }
      counts[off].off++;

      // s3 = everyone left in offPool who isn't the off person
      const s3 = offPool.filter(p => p !== off);
      s3.forEach(p => {
        if (softAvoid.includes(p)) warnings[p] = warnings[p] || 'backup-next-day';
        counts[p].slot3++;
        assigned.push(p);
      });

      // Update streaks (assigned now contains s1,s2,s4,s3 but NOT off)
      PEOPLE.forEach(p => {
        if (p !== off && !mustRest.includes(p)) {
          streak[p]++;
          if (streak[p] >= MAX_CONSECUTIVE)               warnings[p] = warnings[p] || 'streak6';
          else if (streak[p] === MAX_CONSECUTIVE - 1)     warnings[p] = warnings[p] || 'streak5';
        } else {
          streak[p] = 0;
        }
      });

      yesterdayBackup = null;
      result.push({ day, dow, isHoliday: false,
                    slot1: s1, slot2: s2, slot3: s3, slot4: s4, off,
                    warnings, streakAfter: { ...streak } });
    }
  }

  return { schedule: result, counts };
}

// ─── Generate handler ─────────────────────────────────────────────────────────

function handleGenerate() {
  const year   = parseInt(document.getElementById('year-select').value);
  const month  = parseInt(document.getElementById('month-select').value);
  const extras = parseHolidays(document.getElementById('extra-holidays').value);
  const { reqOff, reqWork } = parseRequests();

  currentYear     = year;
  currentMonth    = month;
  currentHolidays = extras;

  // 1. Validate requests
  const validWarnings = validateRequests(year, month, extras, reqOff, reqWork);

  // 2. Generate
  try {
    currentSchedule = generateSchedule(year, month, extras, reqOff, reqWork);
  } catch (e) {
    showMsg('排班失敗：' + e.message, 'error');
    return;
  }

  // 3. Check distribution fairness
  const days  = getDaysInMonth(year, month);
  const toCol = dow => (dow === 0 ? 6 : dow - 1);
  let workDays = 0, holDays = 0;
  for (let d = 1; d <= days; d++) {
    const dow = new Date(year, month - 1, d).getDay();
    if (toCol(dow) >= 5 || extras.includes(d)) holDays++; else workDays++;
  }
  const distWarnings = checkDistribution(currentSchedule.counts, workDays, holDays);

  // 4. Render
  renderCalendar(year, month, currentSchedule.schedule, extras);
  renderStats(currentSchedule.counts);
  document.getElementById('push-btn').disabled = false;

  // 5. Show warnings or success
  const allWarnings = [...validWarnings, ...distWarnings];
  if (allWarnings.length > 0) {
    const el = document.getElementById('msg-area');
    el.className = 'warning';
    el.innerHTML = `<div style="margin-bottom:4px;font-weight:600">排班已產生，但有以下提示：</div>` +
      allWarnings.map(w => `<div>${w}</div>`).join('');
  } else {
    showMsg(`${year} 年 ${month} 月排班已產生`, 'success');
  }
}

// ─── Calendar Rendering ───────────────────────────────────────────────────────

function renderCalendar(year, month, schedule, extraHolidays) {
  const map = {};
  schedule.forEach(s => { map[s.day] = s; });

  const days  = getDaysInMonth(year, month);
  const toCol = dow => (dow === 0 ? 6 : dow - 1); // Mon=0 … Sun=6

  // Build week arrays
  const weeks = [];
  let week = new Array(7).fill(null);
  for (let d = 1; d <= days; d++) {
    const col = toCol(new Date(year, month - 1, d).getDay());
    week[col] = d;
    if (col === 6 || d === days) { weeks.push([...week]); week = new Array(7).fill(null); }
  }

  const isHolidayDay = d =>
    d !== null && (toCol(new Date(year, month - 1, d).getDay()) >= 5 || extraHolidays.includes(d));

  // Warning CSS class for a person on a given day entry
  function warnClass(dayEntry, person) {
    if (!dayEntry || !dayEntry.warnings) return '';
    const w = dayEntry.warnings[person];
    if (!w) return '';
    return ' warn-' + w; // e.g. 'warn-streak5', 'warn-streak6', 'warn-backup-next-day'
  }

  const rows = [];

  // Legend row
  rows.push(
    '<tr class="legend-row">' +
    '<td colspan="8" class="legend-cell">' +
    '<span class="legend-item warn-streak5-sample">連續第 5 天</span>' +
    '<span class="legend-item warn-streak6-sample">連續第 6 天（明日強制休）</span>' +
    '<span class="legend-item warn-backup-next-day-sample">昨日備援，今日仍排班</span>' +
    '</td></tr>'
  );

  // Header
  rows.push(
    '<tr>' +
    '<th style="min-width:28px;width:28px"></th>' +
    ['一','二','三','四','五'].map(d => `<th>${d}</th>`).join('') +
    '<th class="weekend-header">六</th>' +
    '<th class="weekend-header">日</th>' +
    '</tr>'
  );

  weeks.forEach(w => {
    // Date row
    let dateRow = '<tr><td class="slot-label" style="background:#e5e7eb"></td>';
    for (let c = 0; c < 7; c++) {
      const d   = w[c];
      const cls = d === null ? 'empty' : (isHolidayDay(d) ? 'holiday' : '');
      dateRow += `<td class="date-cell ${cls}">${d ?? ''}</td>`;
    }
    dateRow += '</tr>';
    rows.push(dateRow);

    // Slot rows 1–4
    for (let slot = 1; slot <= 4; slot++) {
      let row = `<tr><td class="slot-label">${SLOT_LABELS[slot - 1]}</td>`;
      for (let c = 0; c < 7; c++) {
        const d       = w[c];
        const holiday = d !== null && isHolidayDay(d);
        const baseCls = holiday ? 'holiday' : (c >= 5 ? 'weekend' : '');
        let content   = '';

        if (d !== null && map[d]) {
          const s = map[d];

          if (s.isHoliday) {
            if (slot === 1) {
              const ww = warnClass(s, s.worker);
              const bw = warnClass(s, s.backup);
              content =
                `<span class="holiday-worker${ww}">${s.worker}</span> ` +
                `<span class="holiday-backup${bw}">(${s.backup})</span>`;
            }
          } else {
            if (slot === 1) {
              content = `<span class="${warnClass(s, s.slot1).trim()}">${s.slot1}</span>`;
            } else if (slot === 2) {
              content = `<span class="${warnClass(s, s.slot2).trim()}">${s.slot2}</span>`;
            } else if (slot === 3) {
              content = s.slot3.map(p =>
                `<span class="${warnClass(s, p).trim()}">${p}</span>`
              ).join(', ');
            } else if (slot === 4) {
              content = `<span class="${warnClass(s, s.slot4).trim()}">${s.slot4}</span>`;
            }
          }
        }

        row += `<td class="slot-cell ${baseCls}">${content}</td>`;
      }
      row += '</tr>';
      rows.push(row);
    }
  });

  document.getElementById('calendar-table').innerHTML = rows.join('');
  document.getElementById('calendar-title').textContent = `${year} 年 ${month} 月`;
  document.getElementById('calendar-section').style.display = '';
}

// ─── Stats Rendering ──────────────────────────────────────────────────────────

function renderStats(counts) {
  const slots  = ['slot1', 'slot2', 'slot3', 'slot4'];
  const labels = { slot1: SLOT_LABELS[0], slot2: SLOT_LABELS[1], slot3: SLOT_LABELS[2], slot4: SLOT_LABELS[3] };

  let html = '<table class="stats-table"><thead><tr>';
  html += '<th>人員</th>';
  slots.forEach(s => { html += `<th>${labels[s]}</th>`; });
  html += '<th class="holiday-col">假日上班</th><th class="holiday-col">假日備援</th><th>休假日上班天數</th>';
  html += '</tr></thead><tbody>';

  const totals = { slot1:0, slot2:0, slot3:0, slot4:0, holiday:0, holidayBackup:0, off:0 };

  PEOPLE.forEach(p => {
    const c = counts[p];
    html += '<tr>';
    html += `<td class="person-name">${p}</td>`;
    slots.forEach(s => { totals[s] += c[s]; html += `<td>${c[s]}</td>`; });
    totals.holiday       += c.holiday;
    totals.holidayBackup += c.holidayBackup;
    totals.off           += c.off;
    html += `<td>${c.holiday}</td><td>${c.holidayBackup}</td><td>${c.off}</td>`;
    html += '</tr>';
  });

  html += '</tbody><tfoot><tr><td>合計</td>';
  slots.forEach(s => { html += `<td>${totals[s]}</td>`; });
  html += `<td>${totals.holiday}</td><td>${totals.holidayBackup}</td><td>${totals.off}</td>`;
  html += '</tr></tfoot></table>';

  document.getElementById('stats-container').innerHTML = html;
  document.getElementById('stats-section').style.display = '';
}

// ─── Load from Sheets ─────────────────────────────────────────────────────────

async function handleLoad() {
  if (!isAuthorized()) { showMsg('請先完成 Google 授權', 'error'); return; }
  const year  = parseInt(document.getElementById('year-select').value);
  const month = parseInt(document.getElementById('month-select').value);
  const sid   = document.getElementById('sheet-id').value.trim();
  if (!sid) { showMsg('請輸入 Google Sheet ID', 'error'); return; }

  showMsg('載入中…', 'info');
  try {
    const data = await loadFromSheet(sid, year, month);
    if (!data) { showMsg('找不到該月份資料', 'error'); return; }
    currentYear     = year;
    currentMonth    = month;
    currentHolidays = data.extraHolidays;
    currentSchedule = { schedule: data.schedule, counts: data.counts };
    document.getElementById('extra-holidays').value = data.extraHolidays.join(', ');
    renderCalendar(year, month, data.schedule, data.extraHolidays);
    renderStats(data.counts);
    document.getElementById('push-btn').disabled = false;
    showMsg(`${year} 年 ${month} 月資料已從 Google Sheet 載入`, 'success');
  } catch (e) {
    showMsg('載入失敗：' + e.message, 'error');
  }
}

// ─── Push to Sheets ───────────────────────────────────────────────────────────

async function handlePush() {
  if (!currentSchedule) { showMsg('請先產生排班', 'error'); return; }
  if (!isAuthorized())  { showMsg('請先完成 Google 授權', 'error'); return; }
  const sid = document.getElementById('sheet-id').value.trim();
  if (!sid) { showMsg('請輸入 Google Sheet ID', 'error'); return; }

  showMsg('推送中…', 'info');
  try {
    await pushToSheet(sid, currentYear, currentMonth, currentSchedule.schedule, currentHolidays);
    showMsg('成功推送到 Google Sheet！', 'success');
  } catch (e) {
    showMsg('推送失敗：' + e.message, 'error');
  }
}
