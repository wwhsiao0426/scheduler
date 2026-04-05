// ─── Sheets Proxy（透過 Netlify Function，不需要使用者授權）────────────────────

async function sheetsProxy(action, params) {
  const spreadsheetId = document.getElementById('sheet-id').value.trim();
  if (!spreadsheetId) throw new Error('請先填入 Google Sheet ID');

  const res = await fetch('/.netlify/functions/sheets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, spreadsheetId, ...params }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── Auth stub（不需要 OAuth，保留函式名稱供 app.js 呼叫）──────────────────────

function isAuthorized() { return true; }
function handleAuth()   { showMsg('此版本不需要授權，直接使用即可', 'success'); }

// ─── Sheet name helper ────────────────────────────────────────────────────────

function sheetName(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

// ─── Ensure sheet tab exists ──────────────────────────────────────────────────

async function ensureSheet(spreadsheetId, title) {
  const meta   = await sheetsProxy('getMetadata', {});
  const sheets = meta.sheets || [];
  const found  = sheets.find(s => s.properties.title === title);
  if (found) return found.properties.sheetId;

  const res = await sheetsProxy('addSheet', { title });
  return res.replies[0].addSheet.properties.sheetId;
}

// ─── Push schedule to Google Sheet ───────────────────────────────────────────

async function pushToSheet(spreadsheetId, year, month, schedule, extraHolidays) {
  const tabName = sheetName(year, month);
  await ensureSheet(spreadsheetId, tabName);
  await sheetsProxy('clear', { range: `${tabName}!A1:Z200` });

  const headers = [
    '日期', '星期', '假日',
    '14:00-22:00', '15:00-23:00',
    '16:00-00:00(1)', '16:00-00:00(2)', '16:00-00:00(3)',
    '20:00-04:00',
    '假日上班', '假日備援', '額外假日設定'
  ];

  const rows = [headers];

  schedule.forEach((s, idx) => {
    const dateStr   = `${year}/${String(month).padStart(2,'0')}/${String(s.day).padStart(2,'0')}`;
    const dowZh     = DOW_ZH[s.dow];
    const isHolMark = s.isHoliday ? 'Y' : 'N';
    const extrasStr = idx === 0 ? extraHolidays.join(',') : '';

    if (s.isHoliday) {
      rows.push([dateStr, dowZh, isHolMark, '', '', '', '', '', '', s.worker, s.backup, extrasStr]);
    } else {
      rows.push([
        dateStr, dowZh, isHolMark,
        s.slot1, s.slot2,
        s.slot3[0] || '', s.slot3[1] || '', s.slot3[2] || '',
        s.slot4,
        '', '', extrasStr
      ]);
    }
  });

  await sheetsProxy('update', { range: `${tabName}!A1`, values: rows });
  await writeStatsToSheet(spreadsheetId, tabName, computeCountsFromSchedule(schedule));
}

// ─── Write stats block ────────────────────────────────────────────────────────

async function writeStatsToSheet(spreadsheetId, tabName, counts) {
  const statsHeader = [
    '人員', '14:00-22:00', '15:00-23:00', '16:00-00:00', '20:00-04:00',
    '假日上班', '假日備援', '休假日上班天數'
  ];
  const rows = [statsHeader];
  PEOPLE.forEach(p => {
    const c = counts[p];
    rows.push([p, c.slot1, c.slot2, c.slot3, c.slot4, c.holiday, c.holidayBackup, c.off]);
  });
  await sheetsProxy('update', { range: `${tabName}!N1`, values: rows });
}

// ─── Recompute counts from schedule ──────────────────────────────────────────

function computeCountsFromSchedule(schedule) {
  const counts = {};
  PEOPLE.forEach(p => {
    counts[p] = { slot1:0, slot2:0, slot3:0, slot4:0, holiday:0, holidayBackup:0, off:0 };
  });
  schedule.forEach(s => {
    if (s.isHoliday) {
      counts[s.worker].holiday++;
      counts[s.backup].holidayBackup++;
    } else {
      counts[s.slot1].slot1++;
      counts[s.slot2].slot2++;
      s.slot3.forEach(p => { counts[p].slot3++; });
      counts[s.slot4].slot4++;
      if (s.off) counts[s.off].off++;
    }
  });
  return counts;
}

// ─── Load schedule from Google Sheet ─────────────────────────────────────────

async function loadFromSheet(spreadsheetId, year, month) {
  const tabName = sheetName(year, month);
  let data;
  try {
    data = await sheetsProxy('get', { range: `${tabName}!A1:L200` });
  } catch {
    return null;
  }

  const rows = data.values;
  if (!rows || rows.length < 2) return null;

  const schedule    = [];
  let extraHolidays = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    const parts     = r[0].split('/');
    const day       = parseInt(parts[2]);
    const dow       = DOW_ZH.indexOf(r[1] || '');
    const isHoliday = r[2] === 'Y';
    if (i === 1 && r[11]) {
      extraHolidays = r[11].split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    }
    if (isHoliday) {
      schedule.push({ day, dow, isHoliday: true, worker: r[9] || '', backup: r[10] || '' });
    } else {
      schedule.push({
        day, dow, isHoliday: false,
        slot1: r[3] || '', slot2: r[4] || '',
        slot3: [r[5]||'', r[6]||'', r[7]||''].filter(Boolean),
        slot4: r[8] || '', off: '',
      });
    }
  }

  return { schedule, counts: computeCountsFromSchedule(schedule), extraHolidays };
}
