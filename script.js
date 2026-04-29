/* ════════════════════════════════════════════════════════════════
   Almentor QC Dashboard — script.js
   ════════════════════════════════════════════════════════════════

   SETUP INSTRUCTIONS:
   ─────────────────────────────────────────────────────────────
   Replace SHEET_CSV_URL below with your Google Sheet's public
   CSV export link. To get it:

   1. Open your Google Sheet.
   2. File → Share → Publish to web
   3. Choose "Comma-separated values (.csv)"
   4. Click Publish and copy the link.
   5. Paste it as the value of SHEET_CSV_URL below.
   ─────────────────────────────────────────────────────────────
*/

// ── Configuration ────────────────────────────────────────────────
const SHEET_CSV_URL =
  'YOUR_GOOGLE_SHEET_CSV_URL_HERE';
  // Example:
  // 'https://docs.google.com/spreadsheets/d/e/XXXX/pub?output=csv'

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds

// ── State ────────────────────────────────────────────────────────
let lastUpdated = null;
let refreshTimer = null;
let refreshCountdown = REFRESH_INTERVAL_MS / 1000;
let chartInstances = {};
let sortState = { col: null, dir: 'asc' };
let parsedData = null;

// ── Chart colour palette ─────────────────────────────────────────
const TEAM_COLORS = {
  VO:    { bg: '#E02020', border: '#B01818', pale: '#FDECEA', text: '#E02020' },
  QA:    { bg: '#2980B9', border: '#1F618D', pale: '#EAF4FD', text: '#2980B9' },
  Media: { bg: '#8E44AD', border: '#6C3483', pale: '#F4EAF9', text: '#8E44AD' },
};

// ── Keyword-based classification ─────────────────────────────────
function classifyTeam(comment) {
  const c = String(comment);
  const voKeywords    = ['Mispronounced','mispronounced','Voice changed','tone of voice',
                         'sound effect','Sound Effect','Remove sound','Add Sound','Add sound'];
  const mediaKeywords = ['alignment','Alignment','Movement','movement','Center','center',
                         'image','Image','Shaky','background music','right alignment',
                         'left alignment'];
  for (const k of voKeywords)    if (c.includes(k)) return 'VO';
  for (const k of mediaKeywords) if (c.includes(k)) return 'Media';
  return 'QA';
}

function isCritical(comment) {
  const c = String(comment);
  const criticalKeywords = ['Mispronounced','mispronounced','Voice changed','Remove',
                             'Tech Issue','background music','hyphens','script'];
  return criticalKeywords.some(k => c.includes(k));
}

// ── CSV Parsing & Analysis ───────────────────────────────────────
function parseAndAnalyse(csvText) {
  const result = Papa.parse(csvText, { skipEmptyLines: true });
  const rows = result.data;

  // Collect comment rows: col-index 3 contains QC comments,
  // col-index 1 has video number (M1.0, M2.3 etc.)
  const SKIP_TOKENS = new Set([
    'QC Comment','Media Specialist\'s Comment','Module 1','Module 2',
    'Module 3','Module 4','Module 5','Module 6','General Comments',
    'Analysis','Team','Critical Errors','Minor errors','Color Code','Video Number',
    'Duration',''
  ]);

  const comments  = [];
  let currentVideo = null;
  let currentModule = null;

  for (const row of rows) {
    const videoNum = (row[1] || '').trim();
    const comment  = (row[3] || '').trim();

    // Track current video
    if (/^M\d+\.\d+$/.test(videoNum)) currentVideo = videoNum;
    if (/^Module \d+$/.test(comment))  {
      currentModule = comment;
      continue;
    }

    if (!comment || SKIP_TOKENS.has(comment)) continue;

    comments.push({
      text:     comment,
      video:    currentVideo,
      module:   currentModule,
      team:     classifyTeam(comment),
      critical: isCritical(comment),
    });
  }

  // ── Aggregate ─────────────────────────────────────────────────
  const teamMap = {};
  for (const c of comments) {
    if (!teamMap[c.team]) teamMap[c.team] = { critical: 0, minor: 0, total: 0 };
    if (c.critical) teamMap[c.team].critical++;
    else            teamMap[c.team].minor++;
    teamMap[c.team].total++;
  }

  // Module counts
  const moduleMap = {};
  for (const c of comments) {
    const m = c.module || 'Unknown';
    moduleMap[m] = (moduleMap[m] || 0) + 1;
  }

  // Comment frequency
  const freqMap = {};
  for (const c of comments) {
    // Normalise mispronounced variants
    let key = c.text;
    if (/^Mispronounced/i.test(key)) key = 'Mispronounced (various)';
    if (/Voice changed/i.test(key))  key = 'Voice changed / tone of voice';
    freqMap[key] = freqMap[key] || { count: 0, team: c.team };
    freqMap[key].count++;
  }

  const freqEntries = Object.entries(freqMap)
    .map(([text, d]) => ({ text, count: d.count, team: d.team }))
    .sort((a, b) => b.count - a.count);

  const totalCritical = comments.filter(c => c.critical).length;
  const totalMinor    = comments.filter(c => !c.critical).length;

  // Videos
  const uniqueVideos = new Set(comments.map(c => c.video).filter(Boolean));

  return {
    comments,
    teamMap,
    moduleMap,
    freqEntries,
    totalComments: comments.length,
    totalCritical,
    totalMinor,
    totalVideos: uniqueVideos.size,
  };
}

// ── Render KPI Cards ─────────────────────────────────────────────
function renderKPIs(data) {
  animateNumber('kpi-total',    data.totalComments);
  animateNumber('kpi-critical', data.totalCritical);
  animateNumber('kpi-minor',    data.totalMinor);
  animateNumber('kpi-videos',   data.totalVideos);
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  const duration = 700;
  const startTime = performance.now();
  function step(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (target - start) * ease);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Render Team Cards ────────────────────────────────────────────
function renderTeamCards(data) {
  const { teamMap } = data;
  const teams = Object.keys(teamMap);
  if (!teams.length) return;

  const maxTotal = Math.max(...Object.values(teamMap).map(t => t.total));
  const sorted   = teams.slice().sort((a, b) => teamMap[a].critical - teamMap[b].critical);
  const best     = sorted[0];
  const worst    = sorted[sorted.length - 1];

  const grid = document.getElementById('teamGrid');
  grid.innerHTML = '';

  for (const team of teams) {
    const stats = teamMap[team];
    const pct   = Math.round((stats.total / maxTotal) * 100);
    const isBest  = team === best;
    const isWorst = team === worst;

    let badgeHTML = '';
    let cardClass = 'team-card';
    if (isBest)  { badgeHTML = '<span class="team-badge team-badge--best">✓ Best Team</span>';  cardClass += ' team-card--best'; }
    if (isWorst) { badgeHTML = '<span class="team-badge team-badge--worst">⚠ Needs Focus</span>'; cardClass += ' team-card--worst'; }

    const card = document.createElement('div');
    card.className = cardClass;
    card.innerHTML = `
      ${badgeHTML}
      <div class="team-name">${team} Team</div>
      <div class="team-stats">
        <div class="team-stat">
          <span class="team-stat-val team-stat-val--critical">${stats.critical}</span>
          <span class="team-stat-lbl">Critical</span>
        </div>
        <div class="team-stat">
          <span class="team-stat-val team-stat-val--minor">${stats.minor}</span>
          <span class="team-stat-lbl">Minor</span>
        </div>
        <div class="team-stat">
          <span class="team-stat-val">${stats.total}</span>
          <span class="team-stat-lbl">Total</span>
        </div>
      </div>
      <div class="team-bar-wrap">
        <div class="team-bar team-bar--${team}" style="width:${pct}%"></div>
      </div>
    `;
    grid.appendChild(card);
  }
}

// ── Render Charts ────────────────────────────────────────────────
function renderCharts(data) {
  const { teamMap, totalCritical, totalMinor, moduleMap } = data;
  const teams = Object.keys(teamMap);

  // Destroy old instances
  Object.values(chartInstances).forEach(c => c.destroy());
  chartInstances = {};

  const chartDefaults = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {},
  };

  // 1. Bar — Errors per team (total)
  chartInstances.teamBar = new Chart(
    document.getElementById('chartTeamBar'), {
    type: 'bar',
    data: {
      labels: teams,
      datasets: [{
        label: 'Total Errors',
        data: teams.map(t => teamMap[t].total),
        backgroundColor: teams.map(t => TEAM_COLORS[t]?.bg || '#888'),
        borderColor:     teams.map(t => TEAM_COLORS[t]?.border || '#555'),
        borderWidth: 2,
        borderRadius: 6,
      }],
    },
    options: {
      ...chartDefaults,
      plugins: { legend: { display: false }, tooltip: { callbacks: {
        label: ctx => ` ${ctx.parsed.y} comments`
      }}},
      scales: {
        y: { beginAtZero: true, grid: { color: '#F0F0F0' },
             ticks: { font: { family: 'IBM Plex Mono', size: 11 } } },
        x: { grid: { display: false },
             ticks: { font: { family: 'IBM Plex Sans', size: 12, weight: '600' } } },
      },
    }
  });

  // 2. Pie — Critical vs Minor
  chartInstances.pie = new Chart(
    document.getElementById('chartPie'), {
    type: 'doughnut',
    data: {
      labels: ['Critical', 'Minor'],
      datasets: [{
        data: [totalCritical, totalMinor],
        backgroundColor: ['#E02020', '#F5A623'],
        borderColor: ['#B01818', '#C07800'],
        borderWidth: 2,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: { font: { family: 'IBM Plex Sans', size: 12 }, padding: 16 }
        },
        tooltip: { callbacks: {
          label: ctx => {
            const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
            const pct   = ((ctx.parsed / total) * 100).toFixed(1);
            return ` ${ctx.parsed} (${pct}%)`;
          }
        }},
      },
    }
  });

  // 3. Stacked bar — per team critical + minor
  chartInstances.stacked = new Chart(
    document.getElementById('chartStacked'), {
    type: 'bar',
    data: {
      labels: teams,
      datasets: [
        {
          label: 'Critical',
          data: teams.map(t => teamMap[t].critical),
          backgroundColor: '#E02020',
          borderRadius: { topLeft: 0, topRight: 0 },
        },
        {
          label: 'Minor',
          data: teams.map(t => teamMap[t].minor),
          backgroundColor: '#F5A623',
          borderRadius: { topLeft: 6, topRight: 6 },
        },
      ],
    },
    options: {
      ...chartDefaults,
      plugins: {
        legend: { display: true, position: 'top',
          labels: { font: { family: 'IBM Plex Sans', size: 12 }, padding: 14 } }
      },
      scales: {
        x: { stacked: true, grid: { display: false },
             ticks: { font: { family: 'IBM Plex Sans', size: 12, weight: '600' } } },
        y: { stacked: true, beginAtZero: true, grid: { color: '#F0F0F0' },
             ticks: { font: { family: 'IBM Plex Mono', size: 11 } } },
      },
    }
  });

  // 4. Line — Comments per module
  const modules = Object.keys(moduleMap).sort();
  chartInstances.modules = new Chart(
    document.getElementById('chartModules'), {
    type: 'bar',
    data: {
      labels: modules,
      datasets: [{
        label: 'Comments',
        data: modules.map(m => moduleMap[m]),
        backgroundColor: 'rgba(224,32,32,0.15)',
        borderColor: '#E02020',
        borderWidth: 2,
        borderRadius: 6,
        tension: 0.4,
        fill: true,
        pointBackgroundColor: '#E02020',
        pointRadius: 5,
      }],
    },
    options: {
      ...chartDefaults,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#F0F0F0' },
             ticks: { font: { family: 'IBM Plex Mono', size: 11 } } },
        x: { grid: { display: false },
             ticks: { font: { family: 'IBM Plex Sans', size: 11 },
                      maxRotation: 30 } },
      },
    }
  });
}

// ── Render Table ─────────────────────────────────────────────────
function renderTable(data, sortCol = null, sortDir = 'asc') {
  const { teamMap } = data;
  const total = Object.values(teamMap).reduce((s, t) => s + t.total, 0);

  let rows = Object.entries(teamMap).map(([team, stats]) => ({
    team, ...stats, share: total > 0 ? stats.total / total : 0,
  }));

  if (sortCol) {
    rows.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      return sortDir === 'asc' ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
    });
  }

  const tbody = document.getElementById('teamTableBody');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><span class="team-pill team-pill--${r.team}">${r.team}</span></td>
      <td class="td-critical">${r.critical}</td>
      <td class="td-minor">${r.minor}</td>
      <td class="td-total">${r.total}</td>
      <td>
        <div class="share-bar-wrap">
          <div class="share-bar-bg">
            <div class="share-bar-fill" style="width:${(r.share * 100).toFixed(1)}%"></div>
          </div>
          <span class="share-pct">${(r.share * 100).toFixed(1)}%</span>
        </div>
      </td>
    </tr>
  `).join('');

  // Update sort icons
  document.querySelectorAll('.data-table th[data-col]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === sortCol) th.classList.add(`sort-${sortDir}`);
    th.querySelector('.sort-icon').textContent = '⇅';
  });
  if (sortCol) {
    const activeTh = document.querySelector(`.data-table th[data-col="${sortCol}"]`);
    if (activeTh) activeTh.querySelector('.sort-icon').textContent = sortDir === 'asc' ? '↑' : '↓';
  }
}

// ── Table sort click ─────────────────────────────────────────────
document.querySelectorAll('.data-table th.sortable').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortState.col === col) {
      sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      sortState.col = col;
      sortState.dir = 'asc';
    }
    if (parsedData) renderTable(parsedData, sortState.col, sortState.dir);
  });
});

// ── Render Insights ──────────────────────────────────────────────
function renderInsights(data) {
  const { teamMap, totalCritical, totalMinor, totalComments } = data;
  const teams = Object.entries(teamMap).sort((a, b) => b[1].critical - a[1].critical);
  const worstTeam = teams[0]?.[0];
  const bestTeam  = teams[teams.length - 1]?.[0];
  const critPct   = totalComments > 0 ? ((totalCritical / totalComments) * 100).toFixed(1) : 0;

  const insights = [
    `📌 A total of <strong>${totalComments}</strong> QC comments were logged across <strong>${data.totalVideos}</strong> reviewed videos.`,
    `🔴 <strong>${critPct}%</strong> of all errors are critical, requiring immediate attention from the relevant teams.`,
    `🏆 <strong>${bestTeam} Team</strong> has the fewest critical errors (${teamMap[bestTeam]?.critical}), indicating the strongest QC alignment.`,
    `⚠️ <strong>${worstTeam} Team</strong> carries the highest critical error load (${teamMap[worstTeam]?.critical}), suggesting a systematic review is overdue.`,
    `🎙️ Mispronunciation is the single largest error category, accounting for the majority of VO team flags — a pronunciation guide is recommended.`,
    `🎨 Media alignment and movement issues represent recurring, structurally preventable problems — a checklist would reduce recurrence.`,
    `📝 Voice tone consistency is a repeated QA flag across multiple modules, pointing to post-production standardisation gaps.`,
  ];

  const list = document.getElementById('insightList');
  list.innerHTML = insights.map((t, i) =>
    `<li style="animation-delay:${i * 0.07}s">${t}</li>`
  ).join('');
}

// ── Render Recommendations ───────────────────────────────────────
function renderRecommendations(data) {
  const { teamMap } = data;

  const recs = [
    `<strong>VO Team:</strong> Implement a mandatory pronunciation review process with a glossary of Arabic and English technical terms before final recording.`,
    `<strong>VO Team:</strong> Introduce a voice-tone consistency check — record all videos for a module in a single session or match reference clips.`,
    `<strong>QA Team:</strong> Create a script sign-off checklist before video production starts to eliminate post-production script corrections.`,
    `<strong>QA Team:</strong> Standardise Arabic punctuation guidelines in a shared style guide accessible to all team members.`,
    `<strong>Media Team:</strong> Adopt a slide alignment and movement-direction checklist (RTL-first) applied before every export.`,
    `<strong>Media Team:</strong> Conduct a calibration session on image positioning to align team standards before each new module.`,
    `<strong>All Teams:</strong> Schedule bi-weekly QC retrospectives per module to catch recurring errors before they compound.`,
  ];

  const list = document.getElementById('recList');
  list.innerHTML = recs.map((t, i) =>
    `<li style="animation-delay:${i * 0.07}s">${t}</li>`
  ).join('');
}

// ── Render Comments Analysis ─────────────────────────────────────
function renderCommentsAnalysis(data) {
  const { freqEntries } = data;

  const top5  = freqEntries.slice(0, 8);
  const bot5  = freqEntries.slice(-8).reverse();

  function makeItems(entries) {
    return entries.map(e => `
      <li>
        <span class="comment-text">${escapeHTML(e.text)}</span>
        <span class="comment-team comment-team--${e.team}">${e.team}</span>
        <span class="comment-count">×${e.count}</span>
      </li>
    `).join('');
  }

  document.getElementById('mostFreqList').innerHTML = makeItems(top5) || '<li>No data</li>';
  document.getElementById('leastFreqList').innerHTML = makeItems(bot5) || '<li>No data</li>';
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Refresh Indicator ────────────────────────────────────────────
function setRefreshStatus(status, text) {
  const dot  = document.getElementById('refreshDot');
  const span = document.getElementById('refreshText');
  dot.className = `refresh-dot ${status}`;
  span.textContent = text;
}

function startCountdown() {
  refreshCountdown = REFRESH_INTERVAL_MS / 1000;
  clearInterval(window._countdownTimer);
  window._countdownTimer = setInterval(() => {
    refreshCountdown--;
    if (refreshCountdown <= 0) refreshCountdown = REFRESH_INTERVAL_MS / 1000;
    const ago = REFRESH_INTERVAL_MS / 1000 - refreshCountdown;
    if (lastUpdated) {
      setRefreshStatus('active',
        `Updated ${ago}s ago • Next in ${refreshCountdown}s`);
    }
  }, 1000);
}

// ── Fetch & Render ───────────────────────────────────────────────
async function fetchAndRender() {
  setRefreshStatus('refreshing', 'Refreshing data…');

  // Use sample/demo data if no URL configured
  const url = SHEET_CSV_URL.includes('YOUR_GOOGLE_SHEET') ? null : SHEET_CSV_URL;

  try {
    let csvText;

    if (!url) {
      // ── DEMO MODE: use built-in sample data ──────────────────────
      csvText = DEMO_CSV;
    } else {
      // ── LIVE MODE: fetch from Google Sheets ──────────────────────
      const res = await fetch(url + (url.includes('?') ? '&' : '?') + `_t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      csvText = await res.text();
    }

    parsedData = parseAndAnalyse(csvText);
    renderKPIs(parsedData);
    renderTeamCards(parsedData);
    renderCharts(parsedData);
    renderTable(parsedData, sortState.col, sortState.dir);
    renderInsights(parsedData);
    renderRecommendations(parsedData);
    renderCommentsAnalysis(parsedData);

    lastUpdated = new Date();
    startCountdown();
    setRefreshStatus('active', `Updated just now`);

    if (!url) {
      setRefreshStatus('active', 'Demo mode — connect your Google Sheet in script.js');
    }

  } catch (err) {
    console.error('Dashboard fetch error:', err);
    setRefreshStatus('', `⚠ Error fetching data — retrying in ${REFRESH_INTERVAL_MS/1000}s`);
  }
}

// ── Auto-refresh ─────────────────────────────────────────────────
function startAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(fetchAndRender, REFRESH_INTERVAL_MS);
}

// ── Bootstrap ────────────────────────────────────────────────────
fetchAndRender();
startAutoRefresh();

// ════════════════════════════════════════════════════════════════
//  DEMO CSV DATA (mirrors your uploaded sheet structure)
//  This is used when SHEET_CSV_URL is not configured.
//  Replace SHEET_CSV_URL at the top of this file with your
//  Google Sheets public CSV URL to use live data.
// ════════════════════════════════════════════════════════════════
const DEMO_CSV = `
,Video Number,Duration,QC Comment,Media Specialist's Comment,QC Comment,Analysis,,, Color Code,,,
,,,,,, Team, Critical Errors, Minor errors,,,
,General Comments,,Use Arabic Punctuation: Use (?) not (,),,,VO,,,, Error in Editing - Must Fix.,
,,,,,,QA,,,,Preferred Improvement.,
,,,,,,Media,,,,Suggestion - Not abiding.,
,,,Movement should be from right to left.,,,,,,, Slides replacement.,
,,,Voice changed\, unify the tone of voice.,,,,,,,,
,,,,,,,,,,, 
,,, Module 1,,,,,,,, 
,,,,,,,,,,,
,M1.0,0:55,The last two lines did not mention in script.,,,,,,,, 
,,1:13,the last step should appear at 1:17.,,,,,,,, 
,,1:23 / 1:28,Center the text.,,,,,,,, 
,,1:50,Unify alignment\, image Left.,,,,,,,, 
,,2:20,Mispronounced (تحليل),,,,,,,, 
,,2:53,Point 3 highlight suddenly: edit it.,,,,,,,, 
,,2:55,Unify alignment\, image Left.,,,,,,,, 
,,,,,,,,,,,
,M1.1,0:51,The last step should appear at 0:49.,,,,,,,, 
,,1:16,Add Sound Effect,,,,,,,, 
,,1:41,Mispronounced (البيانات),,,,,,,, 
,,1:46,Mispronounced (إدارة),,,,,,,, 
,,2:19,مصطلح (في النهاية),,,,,,,, 
,,,,,,,,,,,
,M1.2,1:19,Mispronounced (الأنماط),,,,,,,, 
,,2:39,Mispronounced (Structure),,,,,,,, 
,,,,,,,,,,,
,M1.3,0:11,Mispronounced (البيانات),,,,,,,, 
,,From 0:30 to 0:34, Voice changed\, unify the tone of voice.,,,,,,,, 
,,0:33,Remove sound effect,,,,,,,, 
,,1:20,Mispronounced (SQL),,,,,,,, 
,,2:15,Add Space (في Google),,,,,,,, 
,,2:47,Mispronounced (تحليل),,,,,,,, 
,,,,,,,,,,,
,,,Module 2,,,,,,,, 
,,,,,,,,,,,
,M2.0,0:04,Remove background music,,,,,,,, 
,,0:30,Center the text.,,,,,,,, 
,,1:22,Mispronounced (البيانات),,,,,,,, 
,,2:10, Voice changed\, unify the tone of voice.,,,,,,,, 
,,,,,,,,,,,
,M2.1,1:17,Mispronounced (إدارة),,,,,,,, 
,,1:55,Mispronounced (الأنماط),,,,,,,, 
,,2:31,Mispronounced (البيانات),,,,,,,, 
,,2:56,Add Space (في Google),,,,,,,, 
,,2:56,Put the last phrase right alignment.,,,,,,,, 
,,,,,,,,,,,
,M2.2,1:22,Mispronounced (البيانات),,,,,,,, 
,,1:25,Movement should be from right to left,,,,,,,, 
,,2:10,Movement should be from right to left,,,,,,,, 
,,2:48,Movement should be from right to left,,,,,,,, 
,,2:48,مصطلح: البيانات,,,,,,,, 
,,2:57,Mispronounced (دقة),,,,,,,, 
,,3:16,Mispronounced (البيانات),,,,,,,, 
,,From 3:23 to 3:27, Voice changed\, unify the tone of voice.,,,,,,,, 
,,,,,,,,,,,
,M2.3,1:50,Mispronounced (البيانات),,,,,,,, 
,,3:25,Mispronounced (البيانات),,,,,,,, 
,,3:29,Mispronounced (البيانات),,,,,,,, 
,,,,,,,,,,,
,M2.4,0:09,Mispronounced (SQL),,,,,,,, 
,,1:41,Put the last phrase right alignment.,,,,,,,, 
,,2:53,Add Space (في Google),,,,,,,, 
,,2:59,Mispronounced (SQL),,,,,,,, 
,,,,,,,,,,,
,M2.5,0:12,Mispronounced (SQL),,,,,,,, 
,,0:07,Add Space (في Google),,,,,,,, 
,,1:25,Add Space (في CSV),,,,,,,, 
,,1:58, Voice changed\, unify the tone of voice.,,,,,,,, 
,,2:44, Voice changed\, unify the tone of voice.,,,,,,,, 
,,,,,,,,,,,
,,,Module 3,,,,,,,, 
,,,,,,,,,,,
,M3.0,0:36,Remove hyphens (-) from title,,,,,,,, 
,,,,,,,,,,,
,M3.1,From 0:26 to 0:30, Voice changed\, unify the tone of voice.,,,,,,,, 
,,1:03,Mispronounced (من هم هنا),,,,,,,, 
,,2:30,Mispronounced (خطأ ما),,,,,,,, 
,,2:34,Mispronounced (البيانات),,,,,,,, 
,,2:38,Mispronounced (البيانات),,,,,,,, 
,,from 2:56 to the end, Voice changed\, unify the tone of voice.,,,,,,,, 
,,,,,,,,,,,
,M3.2,0:26,Mispronounced (الأنماط),,,,,,,, 
,,2:41,Mispronounced (البيانات),,,,,,,, 
,,,,,,,,,,,
,M3.3,2:01,Mispronounced (في نهاية),,,,,,,, 
,,2:26,Mispronounced (البيانات),,,,,,,, 
,,,,,,,,,,,
,M3.4,1:59,Add Sound Effect,,,,,,,, 
,,2:13, Voice changed\, unify the tone of voice.,,,,,,,, 
,,2:29,Tech Issue on the screen,,,,,,,, 
,,2:53,Mispronounced (الأنماط),,,,,,,, 
,,,,,,,,,,,
,,,Module 4,,,,,,,, 
,,,,,,,,,,,
,M4.0,0:15,Mispronounced (SQL),,,,,,,, 
,,1:10, Voice changed\, unify the tone of voice.,,,,,,,, 
,,2:05,Unify alignment\, image Left.,,,,,,,, 
,,,,,,,,,,,
,M4.1,0:30,Mispronounced (البيانات),,,,,,,, 
,,1:45, Voice changed\, unify the tone of voice.,,,,,,,, 
,,2:20,Add Space (في Google),,,,,,,, 
,,3:00,Mispronounced (Precision),,,,,,,, 
,,,,,,,,,,,
,M4.2,0:45,Mispronounced (البيانات),,,,,,,, 
,,1:30,Movement should be from right to left,,,,,,,, 
,,2:15,Mispronounced (البيانات),,,,,,,, 
,,2:50, Voice changed\, unify the tone of voice.,,,,,,,, 
,,,,,,,,,,,
,M4.3,0:20,Mispronounced (SQL),,,,,,,, 
,,1:00,Shaky Frame,,,,,,,, 
,,2:30,Mispronounced (Precision),,,,,,,, 
,,,,,,,,,,,
,M4.4,0:10,Mispronounced (البيانات),,,,,,,, 
,,0:55, Voice changed\, unify the tone of voice.,,,,,,,, 
,,1:40,Mispronounced (Formats),,,,,,,, 
,,2:25,Shaky Frame,,,,,,,, 
,,,,,,,,,,,
,,,Module 5,,,,,,,, 
,,,,,,,,,,,
,M5.0,0:08,Mispronounced (SQL),,,,,,,, 
,,0:55,Mispronounced (البيانات),,,,,,,, 
,,1:30,Add Space (في CSV),,,,,,,, 
,,,,,,,,,,,
,M5.1,0:20,Mispronounced (البيانات),,,,,,,, 
,,0:50, Voice changed\, unify the tone of voice.,,,,,,,, 
,,1:25,Mispronounced (البيانات),,,,,,,, 
,,2:00,Center the text.,,,,,,,, 
,,,,,,,,,,,
,M5.2,0:15,Mispronounced (Precision),,,,,,,, 
,,0:45,Mispronounced (البيانات),,,,,,,, 
,,1:20, Voice changed\, unify the tone of voice.,,,,,,,, 
,,,,,,,,,,,
,M5.3,0:30,Mispronounced (Formats),,,,,,,, 
,,1:10,Mispronounced (البيانات),,,,,,,, 
,,1:50, Voice changed\, unify the tone of voice.,,,,,,,, 
,,,,,,,,,,,
,M5.4,0:25,Mispronounced (البيانات),,,,,,,, 
,,1:00,Add Sound Effect,,,,,,,, 
,,1:35, Voice changed\, unify the tone of voice.,,,,,,,, 
,,2:10,Unify alignment\, image Left.,,,,,,,, 
`.trim();
