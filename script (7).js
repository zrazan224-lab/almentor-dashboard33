/**
 * ================================================================
 * Almentor Quality Dashboard — script.js
 * ================================================================
 *
 * DATA SOURCE (live CSV — auto-updates every 10 seconds):
 * https://docs.google.com/spreadsheets/d/e/
 * 2PACX-1vQTzkpvNPk3uixskvJIghPuoKOt13uu2aTOMo8kD7tNyzwVmhyu0F86mEq7u2q9bw/
 * pub?output=csv
 *
 * FEATURES:
 *  ✓ Live CSV fetch with cache-busting (?t=Date.now()) every 10 s
 *  ✓ Multi-table parser: detects empty rows / new header blocks
 *  ✓ KPI cards: Total, Critical, Minor, Best Team, Worst Team
 *  ✓ Pie chart (Critical vs Minor) + Bar chart (by team/project)
 *  ✓ Sortable columns + Pagination (15 rows/page)
 *  ✓ Global project selector + employee search
 *  ✓ PDF export via jsPDF + autoTable
 *  ✓ Graceful handling of #DIV/0!, empty cells, broken data
 * ================================================================
 */

// ── ① CONFIGURATION ─────────────────────────────────────────────
// Live Google Sheets CSV link (cache-busted on every request)
const CSV_URL    = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQTzkpvNPk3uixskvJIghPuoKOt13uu2aTOMo8kD7tNyzwVmhyu0F86mEq7u2q9bw/pub?gid=90567248&single=true&output=csv';
const REFRESH_MS = 10_000;   // Auto-refresh interval in milliseconds
const PAGE_SIZE  = 15;       // Rows shown per table page

// ── ② GLOBAL STATE ───────────────────────────────────────────────
let allTables  = [];    // All parsed tables from the sheet
let filtered   = [];    // Filtered view (post-filter application)
let chartPie   = null;  // Chart.js pie instance
let chartBar   = null;  // Chart.js bar instance
let syncTimer  = null;  // setInterval handle

// Per-table UI state: { sortCol, sortDir, page }
const tState = {};

// ── ③ BOOT ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  fetchData();
  syncTimer = setInterval(fetchData, REFRESH_MS);

  document.getElementById('filterProject').addEventListener('change', applyFilters);
  document.getElementById('filterEmployee').addEventListener('input', debounce(applyFilters, 280));
});

// ── ④ FETCH & PARSE ──────────────────────────────────────────────

/**
 * fetchData
 * Fetches the live CSV from Google Sheets, parses it into multiple
 * tables, and re-renders the entire dashboard.
 */
async function fetchData() {
  setSyncState('syncing', 'Syncing…');

  try {
    // Cache-busting: appending ?t= forces Google Sheets to return fresh data
    const liveURL = `${CSV_URL}&t=${Date.now()}`;
    const res     = await fetch(liveURL);

    if (!res.ok) throw new Error(`HTTP error: ${res.status}`);

    const text = await res.text();

    // Parse CSV → 2D array
    const parsed = Papa.parse(text, { skipEmptyLines: false });

    // Split into multiple tables
    allTables = splitIntoTables(parsed.data);
    filtered  = deepClone(allTables);

    populateProjectFilter();
    applyFilters();

    setSyncState('ok', 'Synced');
    document.getElementById('lastUpdated').textContent =
      'Updated ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    document.getElementById('emptyState').style.display = 'none';

  } catch (err) {
    console.error('[Dashboard] Fetch error:', err);
    setSyncState('error', 'Connection error');

    if (!allTables.length) {
      showEmpty('Could not load data. Check your internet connection or verify the Google Sheet is published.');
    }
  }
}

/**
 * splitIntoTables
 * ─────────────────
 * Parses a flat 2D CSV array into multiple logical tables.
 *
 * Rules:
 *  1. A fully empty row signals the end of a table block.
 *  2. A row where ≥ 60% of non-empty cells are non-numeric is treated
 *     as a new header row → starts a new table.
 *  3. Rows between headers are data rows.
 */
function splitIntoTables(rows) {
  const tables   = [];
  let curHeader  = null;
  let curRows    = [];
  let tableIndex = 0;

  const flush = () => {
    if (curHeader && curRows.length > 0) {
      tables.push({
        index:   tableIndex++,
        title:   inferTitle(curHeader, tableIndex - 1),
        headers: curHeader,
        rows:    curRows
      });
    }
    curRows = [];
  };

  for (const raw of rows) {
    const cells = raw.map(cleanCell);

    // Empty separator row → flush current table
    if (cells.every(c => c === '')) {
      flush();
      curHeader = null;
      continue;
    }

    if (isHeaderRow(cells)) {
      flush();
      curHeader = cells;
    } else if (curHeader) {
      // Align row length to header length
      const aligned = curHeader.map((_, i) => cells[i] ?? '');
      curRows.push(aligned);
    }
    // Rows before any header are silently ignored
  }

  flush();
  return tables.filter(t => t.rows.length > 0);
}

/**
 * isHeaderRow
 * Returns true when the majority of non-empty cells look like labels
 * (i.e., are not parseable as numbers and not error strings).
 */
function isHeaderRow(cells) {
  const nonEmpty = cells.filter(c => c !== '');
  if (nonEmpty.length === 0) return false;
  const numericCount = nonEmpty.filter(c => !isNaN(parseFloat(c))).length;
  return (nonEmpty.length - numericCount) / nonEmpty.length >= 0.6;
}

/**
 * inferTitle
 * Derives a human-readable table title from the first header cell.
 */
function inferTitle(headers, idx) {
  const first = headers.find(h => h && h.length > 1);
  const fallbacks = ['Table One', 'Table Two', 'Table Three', 'Table Four', 'Table Five', 'Table Six'];
  return first ? `Data: ${first}` : (fallbacks[idx] ?? `Table ${idx + 1}`);
}

/**
 * cleanCell
 * Strips spreadsheet error values and trims whitespace.
 */
function cleanCell(val = '') {
  const s = String(val).trim();
  if (['#DIV/0!', '#N/A', '#REF!', '#VALUE!', '#NAME?', '#NULL!', '#NUM!'].includes(s)) return '';
  return s;
}

// ── ⑤ FILTERS ────────────────────────────────────────────────────

/**
 * populateProjectFilter
 * Scans all table data to build a unique list of text values
 * that could represent project names (non-numeric, len > 1).
 */
function populateProjectFilter() {
  const sel     = document.getElementById('filterProject');
  const current = sel.value;
  const options = new Set();

  allTables.forEach(t => {
    t.rows.forEach(row => {
      row.forEach(cell => {
        if (cell && cell.length > 1 && isNaN(parseFloat(cell))) {
          options.add(cell);
        }
      });
    });
  });

  sel.innerHTML = '<option value="">All Projects</option>';
  [...options].sort().slice(0, 80).forEach(val => {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = val;
    if (val === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

/**
 * applyFilters
 * Applies the project and employee filters to all tables,
 * then re-renders the entire dashboard.
 */
function applyFilters() {
  const proj = document.getElementById('filterProject').value.toLowerCase();
  const emp  = document.getElementById('filterEmployee').value.toLowerCase().trim();

  filtered = allTables
    .map(t => ({
      ...t,
      rows: t.rows.filter(row => {
        const str = row.join(' ').toLowerCase();
        return (!proj || str.includes(proj)) && (!emp || str.includes(emp));
      })
    }))
    .filter(t => t.rows.length > 0);

  renderKPIs();
  renderCharts();
  renderTables();
}

function resetFilters() {
  document.getElementById('filterProject').value  = '';
  document.getElementById('filterEmployee').value = '';
  applyFilters();
}

// ── ⑥ KPI CARDS ──────────────────────────────────────────────────

/**
 * renderKPIs
 * Scans all filtered tables to compute aggregate KPI numbers
 * and identify the best/worst performing teams.
 */
function renderKPIs() {
  let total = 0, critical = 0, minor = 0;
  const teamMap = {};

  filtered.forEach(t => {
    const h  = t.headers.map(x => x.toLowerCase());

    // Heuristic column detection
    const iCr = findCol(h, ['critical', 'حرج']);
    const iMn = findCol(h, ['minor', 'ثانو', 'بسيط']);
    const iTm = findCol(h, ['team', 'فريق', 'project', 'مشروع']);
    const iTk = findCol(h, ['task', 'comment', 'total', 'مهم']);

    t.rows.forEach(row => {
      const cr = toNum(row[iCr]);
      const mn = toNum(row[iMn]);
      critical += cr;
      minor    += mn;
      total    += cr + mn;

      if (iTm >= 0 && row[iTm]) {
        const team = row[iTm];
        if (!teamMap[team]) teamMap[team] = { cr: 0, mn: 0, tasks: 0 };
        teamMap[team].cr    += cr;
        teamMap[team].mn    += mn;
        teamMap[team].tasks += toNum(row[iTk]) || 1;
      }
    });
  });

  setText('valTotal',    total    > 0 ? total    : '—');
  setText('valCritical', critical > 0 ? critical : '—');
  setText('valMinor',    minor    > 0 ? minor    : '—');

  setText('subTotal',    total    > 0 ? 'across all tables'  : ' ');
  setText('subCritical', critical > 0 ? `${pct(critical, total)}% of total` : ' ');
  setText('subMinor',    minor    > 0 ? `${pct(minor, total)}% of total`    : ' ');

  // Rank teams by error ratio (errors / tasks)
  const ranked = Object.entries(teamMap)
    .filter(([, v]) => v.tasks > 0)
    .map(([name, v])  => ({ name, ratio: (v.cr + v.mn) / v.tasks }))
    .sort((a, b) => a.ratio - b.ratio);

  setText('valBest',  ranked.length ? ranked[0].name                : '—');
  setText('valWorst', ranked.length ? ranked[ranked.length - 1].name : '—');
}

// ── ⑦ CHARTS ─────────────────────────────────────────────────────

function renderCharts() {
  let critical = 0, minor = 0;
  const teamData = {};

  filtered.forEach(t => {
    const h  = t.headers.map(x => x.toLowerCase());
    const iCr = findCol(h, ['critical', 'حرج']);
    const iMn = findCol(h, ['minor', 'ثانو', 'بسيط']);
    const iTm = findCol(h, ['team', 'فريق', 'project', 'مشروع']);

    t.rows.forEach(row => {
      const cr = toNum(row[iCr]);
      const mn = toNum(row[iMn]);
      critical += cr;
      minor    += mn;
      if (iTm >= 0 && row[iTm]) {
        const team = row[iTm];
        if (!teamData[team]) teamData[team] = { cr: 0, mn: 0 };
        teamData[team].cr += cr;
        teamData[team].mn += mn;
      }
    });
  });

  // --- Pie Chart ---
  const pieCtx = document.getElementById('chartPie').getContext('2d');
  if (chartPie) chartPie.destroy();
  chartPie = new Chart(pieCtx, {
    type: 'doughnut',
    data: {
      labels: ['Critical', 'Minor'],
      datasets: [{
        data: [critical, minor],
        backgroundColor: ['#E31E24', '#d97706'],
        hoverBackgroundColor: ['#c41920', '#b45309'],
        borderWidth: 0,
        hoverOffset: 8
      }]
    },
    options: {
      cutout: '70%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { family: 'DM Sans', size: 12 }, color: '#2a2a2a', padding: 18, usePointStyle: true }
        },
        tooltip: {
          callbacks: {
            label: ctx => `  ${ctx.label}: ${ctx.parsed.toLocaleString()} (${pct(ctx.parsed, critical + minor)}%)`
          }
        }
      }
    }
  });

  // --- Bar Chart ---
  const labels   = Object.keys(teamData).slice(0, 14);
  const critBars = labels.map(k => teamData[k].cr);
  const minBars  = labels.map(k => teamData[k].mn);

  const barCtx = document.getElementById('chartBar').getContext('2d');
  if (chartBar) chartBar.destroy();
  chartBar = new Chart(barCtx, {
    type: 'bar',
    data: {
      labels: labels.length ? labels : ['No team data'],
      datasets: [
        { label: 'Critical', data: critBars, backgroundColor: '#E31E24', borderRadius: 4, borderSkipped: false },
        { label: 'Minor',    data: minBars,  backgroundColor: '#d97706', borderRadius: 4, borderSkipped: false }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          labels: { font: { family: 'DM Sans', size: 12 }, color: '#2a2a2a', padding: 16, usePointStyle: true }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { family: 'DM Sans', size: 11 }, color: '#5a5a6a', maxRotation: 35 }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f3f3f7' },
          ticks: { font: { family: 'DM Mono', size: 11 }, color: '#9898a8' }
        }
      }
    }
  });
}

// ── ⑧ TABLES ─────────────────────────────────────────────────────

function renderTables() {
  const container = document.getElementById('tablesContainer');
  container.innerHTML = '';

  if (!filtered.length) {
    showEmpty('No data matches the selected filters.');
    return;
  }
  document.getElementById('emptyState').style.display = 'none';

  filtered.forEach((table, ti) => {
    // Initialize sort/page state for this table
    if (!tState[ti]) tState[ti] = { sortCol: -1, sortDir: 1, page: 0 };
    const ts = tState[ti];

    // Sort rows
    let rows = [...table.rows];
    if (ts.sortCol >= 0) {
      rows.sort((a, b) => {
        const av = a[ts.sortCol] ?? '', bv = b[ts.sortCol] ?? '';
        const an = parseFloat(av),        bn = parseFloat(bv);
        if (!isNaN(an) && !isNaN(bn)) return (an - bn) * ts.sortDir;
        return av.localeCompare(bv, 'en') * ts.sortDir;
      });
    }

    // Paginate
    const totalPages = Math.ceil(rows.length / PAGE_SIZE);
    ts.page = Math.min(ts.page, Math.max(0, totalPages - 1));
    const pageRows = rows.slice(ts.page * PAGE_SIZE, (ts.page + 1) * PAGE_SIZE);

    // Build section
    const section = document.createElement('div');
    section.className = 'table-section';
    section.id = `ts-${ti}`;

    section.innerHTML = `
      <div class="table-section-head">
        <span class="table-section-title">${esc(table.title)}</span>
        <span class="row-count">${rows.length} rows</span>
      </div>

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              ${table.headers.map((h, ci) => `
                <th onclick="sortTable(${ti}, ${ci})">
                  ${esc(h)}
                  <span class="sort-arrow" data-ti="${ti}" data-ci="${ci}">
                    ${ts.sortCol === ci ? (ts.sortDir === 1 ? '▲' : '▼') : '⇅'}
                  </span>
                </th>
              `).join('')}
            </tr>
          </thead>
          <tbody>
            ${pageRows.map(row => `
              <tr>
                ${table.headers.map((_, ci) => `<td>${formatCell(row[ci] ?? '')}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="table-pagination">
        <span class="pg-info">
          Showing ${ts.page * PAGE_SIZE + 1}–${Math.min((ts.page + 1) * PAGE_SIZE, rows.length)} of ${rows.length} rows
        </span>
        <div class="pg-btns" id="pg-${ti}"></div>
      </div>
    `;

    container.appendChild(section);
    buildPageButtons(ti, totalPages, ts.page);
  });
}

function buildPageButtons(ti, totalPages, cur) {
  const wrap = document.getElementById(`pg-${ti}`);
  if (!wrap) return;
  wrap.innerHTML = '';

  const btn = (label, page, disabled, active) => {
    const el = document.createElement('button');
    el.className = 'btn-page' + (active ? ' active' : '');
    el.textContent = label;
    el.disabled = disabled;
    el.onclick = () => goPage(ti, page);
    wrap.appendChild(el);
  };

  btn('‹', cur - 1, cur === 0, false);
  const start = Math.max(0, cur - 2);
  const end   = Math.min(totalPages, start + 5);
  for (let p = start; p < end; p++) btn(p + 1, p, false, p === cur);
  btn('›', cur + 1, cur >= totalPages - 1, false);
}

function goPage(ti, page) {
  tState[ti].page = page;
  renderTables();
  document.getElementById(`ts-${ti}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function sortTable(ti, ci) {
  const ts = tState[ti];
  if (ts.sortCol === ci) ts.sortDir *= -1;
  else { ts.sortCol = ci; ts.sortDir = 1; }
  ts.page = 0;
  renderTables();
}

/**
 * formatCell
 * Applies visual formatting based on cell value type.
 */
function formatCell(val) {
  if (val === '' || val === null || val === undefined) {
    return '<span class="cell-empty">—</span>';
  }

  const n = parseFloat(String(val).replace(/,/g, ''));

  if (!isNaN(n)) {
    if (n === 0) return `<span class="badge-zero">0</span>`;
    // Color coding based on magnitude — adjust thresholds as needed
    if (n > 0 && n <= 3)  return `<span class="badge-minor">${n}</span>`;
    if (n > 3)            return `<span class="badge-critical">${n}</span>`;
    return `<span class="cell-num">${n.toLocaleString()}</span>`;
  }

  return esc(val);
}

// ── ⑨ PDF EXPORT ─────────────────────────────────────────────────

function exportPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  // Cover header
  doc.setFillColor(227, 30, 36);
  doc.rect(0, 0, 297, 22, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(255, 255, 255);
  doc.text('Almentor — Quality Dashboard Report', 14, 14);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text(`Generated: ${new Date().toLocaleString('en-GB')}`, 230, 14);

  let y = 30;

  filtered.forEach((table, ti) => {
    if (y > 175) { doc.addPage(); y = 14; }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(17, 17, 17);
    doc.text(table.title, 14, y);
    y += 5;

    doc.autoTable({
      startY: y,
      head: [table.headers],
      body: table.rows.map(r => r.map(c => c || '—')),
      styles: {
        font: 'helvetica',
        fontSize: 8,
        cellPadding: 2.5,
        textColor: [17, 17, 17]
      },
      headStyles: {
        fillColor: [227, 30, 36],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        fontSize: 8
      },
      alternateRowStyles: { fillColor: [249, 249, 251] },
      tableLineColor: [228, 228, 237],
      tableLineWidth: 0.1,
      margin: { left: 14, right: 14 }
    });

    y = doc.lastAutoTable.finalY + 12;
  });

  doc.save(`almentor-dashboard-${new Date().toISOString().slice(0, 10)}.pdf`);
}

// ── ⑩ UTILITIES ──────────────────────────────────────────────────

/** Find the first column index whose header matches any keyword */
function findCol(headers, keywords) {
  return headers.findIndex(h => keywords.some(k => h.includes(k)));
}

/** Safely parse a number from a cell value */
function toNum(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isNaN(n) || n < 0 ? 0 : n;
}

/** Percentage helper */
function pct(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

/** Set text content of an element by ID */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/** HTML-escape a string */
function esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Deep-clone via JSON (safe for plain data arrays) */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Debounce helper */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Set the sync pill state */
function setSyncState(state, label) {
  const pill = document.getElementById('syncPill');
  pill.className = `sync-pill ${state}`;
  document.getElementById('syncLabel').textContent = label;
  document.getElementById('syncIcon').textContent =
    state === 'ok' ? '✓' : state === 'error' ? '✕' : '⟳';
}

/** Show the empty / error state */
function showEmpty(msg) {
  const el = document.getElementById('emptyState');
  el.style.display = 'flex';
  document.getElementById('emptyMsg').textContent = msg;
  document.getElementById('tablesContainer').innerHTML = '';
}
