// ═══════════════════════════════════════════════════
//  NUDGE — shared.js
//  Single source of truth for state, calculations,
//  roasts, and helpers. Loaded by every page.
// ═══════════════════════════════════════════════════

const NUDGE_KEY = 'nudge_v1';

// ── Default state shape ──
const DEFAULT_STATE = {
  profile: null,
  subjects: [],
  logs: {},
  plannerSkips: {}
};

// ── Load / Save ──
function loadState() {
  try {
    const raw = localStorage.getItem(NUDGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const s = JSON.parse(raw);
    if (!s.logs)         s.logs = {};
    if (!s.plannerSkips) s.plannerSkips = {};
    if (!s.subjects)     s.subjects = [];
    return s;
  } catch (e) {
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState(state) {
  localStorage.setItem(NUDGE_KEY, JSON.stringify(state));
}

function isOnboarded() {
  const s = loadState();
  return !!(s.profile && s.subjects && s.subjects.length > 0);
}

// ── Date helpers ──
function todayStr() {
  return fmtDate(new Date());
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// day index: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
const DAY_LABELS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LABELS_FULL  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const DAY_MAP = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };

function datesInRange(start, end) {
  const dates = [];
  const s = parseDate(start);
  const e = parseDate(end);
  const cur = new Date(s);
  while (cur <= e) {
    dates.push(fmtDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

function humanDate(dateStr, opts = {}) {
  return parseDate(dateStr).toLocaleDateString('en-IN', {
    weekday: opts.weekday || undefined,
    day: 'numeric',
    month: 'short',
    year: opts.year || undefined,
    ...opts
  });
}

// ── Subject stats ──
// Returns: { attended, held, pct, bunkBudget, recovery, status, history }
function getSubjectStats(subject, state) {
  const threshold = state.profile?.threshold || 75;
  const allDates = state.profile
    ? datesInRange(state.profile.startDate, state.profile.endDate)
    : [];
  const today = todayStr();

  let attended = 0;
  let held = 0;
  const history = []; // { date, status: 'P'|'A'|'C'|'?' }

  for (const ds of allDates) {
    if (ds > today) continue;
    const dow = parseDate(ds).getDay();
    if (!subject.days.includes(dow)) continue;

    const log = state.logs[ds]?.[subject.id];
    if (log === 'P') {
      attended++;
      held++;
      history.push({ date: ds, status: 'P' });
    } else if (log === 'A') {
      held++;
      history.push({ date: ds, status: 'A' });
    } else if (log === 'C') {
      // cancelled — doesn't count toward held
      history.push({ date: ds, status: 'C' });
    } else {
      // scheduled but not logged yet — count as held, not attended
      held++;
      history.push({ date: ds, status: '?' });
    }
  }

  const pct = held > 0 ? Math.round((attended / held) * 100) : null;

  // Bunk budget: max n such that attended/(held+n) >= threshold/100
  // => n <= attended*100/threshold - held
  const bunkBudget = held > 0
    ? Math.max(0, Math.floor((attended * 100) / threshold - held))
    : 0;

  // Recovery: if below threshold, min n such that (attended+n)/(held+n) >= threshold/100
  // => n >= (threshold/100*held - attended) / (1 - threshold/100)
  let recovery = 0;
  if (pct !== null && pct < threshold) {
    const t = threshold / 100;
    recovery = Math.ceil((t * held - attended) / (1 - t));
    recovery = Math.max(0, recovery);
  }

  let status = 'unknown';
  if (pct !== null) {
    if (pct >= threshold)          status = 'safe';
    else if (pct >= threshold - 10) status = 'warning';
    else                            status = 'danger';
  }

  return { attended, held, pct, bunkBudget, recovery, status, history };
}

// ── Overall stats across all subjects ──
function getOverallStats(state) {
  if (!state.subjects.length) return { pct: null, bunkBudget: 0, recovery: 0 };
  const threshold = state.profile?.threshold || 75;
  let totAtt = 0, totHeld = 0;
  for (const s of state.subjects) {
    const st = getSubjectStats(s, state);
    totAtt  += st.attended;
    totHeld += st.held;
  }
  const pct = totHeld > 0 ? Math.round((totAtt / totHeld) * 100) : null;
  const bunkBudget = totHeld > 0
    ? Math.max(0, Math.floor((totAtt * 100) / threshold - totHeld))
    : 0;
  let recovery = 0;
  if (pct !== null && pct < threshold) {
    const t = threshold / 100;
    recovery = Math.ceil((t * totHeld - totAtt) / (1 - t));
    recovery = Math.max(0, recovery);
  }
  return { pct, bunkBudget, recovery, totAtt, totHeld };
}

// ── Today's scheduled subjects ──
function getTodaySubjects(state) {
  const dow = parseDate(todayStr()).getDay();
  return state.subjects.filter(s => s.days.includes(dow));
}

// ── Streak (consecutive days where all scheduled classes attended/cancelled) ──
function getStreak(state) {
  let streak = 0;
  const cur = new Date();
  cur.setDate(cur.getDate() - 1); // start from yesterday
  for (let i = 0; i < 90; i++) {
    const ds = fmtDate(cur);
    const dow = cur.getDay();
    const scheduled = state.subjects.filter(s => s.days.includes(dow));
    if (!scheduled.length) {
      cur.setDate(cur.getDate() - 1);
      continue;
    }
    const logs = state.logs[ds] || {};
    const allOk = scheduled.every(s => logs[s.id] === 'P' || logs[s.id] === 'C');
    if (!allOk) break;
    streak++;
    cur.setDate(cur.getDate() - 1);
  }
  return streak;
}

// ── Summary line ──
function getSummaryLine(state) {
  const { pct, bunkBudget, recovery } = getOverallStats(state);
  const threshold = state.profile?.threshold || 75;
  if (pct === null) return null;
  if (pct >= threshold) {
    return `You can skip ${bunkBudget} more class${bunkBudget === 1 ? '' : 'es'} overall.`;
  } else {
    return `Attend ${recovery} more class${recovery === 1 ? '' : 'es'} to reach ${threshold}%.`;
  }
}

// ── Roast messages ──
const ROASTS = {
  'top':     ["Your professor knows your name, your face, and probably your dad's number too.",
              "First bench energy. We respect it, we fear it."],
  'safe':    ["Safe. But don't get cocky, one sick week and you're cooked.",
              "Attendance is fine. Life choices, debatable."],
  'border':  ["Yaar, seriously. One more absence and the college calls home.",
              "You're not failing, you're just aggressively testing the system."],
  'low':     ["Your professor has genuinely forgotten what you look like.",
              "At this point your seat knows you better than your teacher does."],
  'critical':["You are paying fees to fund a college you have never visited.",
              "Bhai. Just. Come. To. Class."],
  'exact':   ["One class away from disaster. Living life on hard mode, respect.",
              "75% exactly. You planned this, didn't you."],
  'none':    ["Data nahi hai. Log karo pehle.", "Ek class log karo toh pata chalega."]
};

function getRoast(pct, threshold = 75) {
  if (pct === null) return pick(ROASTS.none);
  if (pct === threshold) return pick(ROASTS.exact);
  if (pct >= 90)         return pick(ROASTS.top);
  if (pct >= threshold)  return pick(ROASTS.safe);
  if (pct >= threshold - 10) return pick(ROASTS.border);
  if (pct >= 50)         return pick(ROASTS.low);
  return pick(ROASTS.critical);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Session-stable roast (stored in sessionStorage)
function getSessionRoast(state) {
  const cached = sessionStorage.getItem('nudge_roast');
  if (cached) return cached;
  const { pct } = getOverallStats(state);
  const roast = getRoast(pct, state.profile?.threshold || 75);
  sessionStorage.setItem('nudge_roast', roast);
  return roast;
}

// ── Status helpers ──
function pctColor(pct, threshold = 75) {
  if (pct === null) return 'var(--text-secondary)';
  if (pct >= threshold) return 'var(--success)';
  if (pct >= threshold - 10) return 'var(--warning-text)';
  return 'var(--danger)';
}

function statusBadgeClass(status) {
  return status === 'safe' ? 'badge-safe' : status === 'warning' ? 'badge-warning' : 'badge-danger';
}

function statusLabel(status) {
  return status === 'safe' ? 'Safe' : status === 'warning' ? 'Warning' : 'Danger';
}

// ── Nav redirect guard ──
// Call at top of every app page (not onboarding)
function requireOnboarded() {
  if (!isOnboarded()) {
    window.location.href = 'index.html';
  }
}

// ── Active nav highlight ──
function setActiveNav(pageId) {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageId);
  });
}

// ── Unique ID ──
function uid() {
  return 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}
