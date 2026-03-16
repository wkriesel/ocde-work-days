// ============================================================
// 225-Day Work Tracker V2 — Firebase Edition
// ============================================================

// ============================================================
// FIREBASE CONFIG
// Replace these values with your actual Firebase project config.
// Find them at: Firebase Console > Project Settings > General > Your apps
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyBC88OO98jm4C6Zxf2Y28X4U_uk_DUD12c",
  authDomain: "ocde-work-days.firebaseapp.com",
  projectId: "ocde-work-days",
  storageBucket: "ocde-work-days.firebasestorage.app",
  messagingSenderId: "578853590685",
  appId: "1:578853590685:web:d71458a8c1cbd41ada6674",
  measurementId: "G-MQSDW6X0S3"
};


// ============================================================
// FLEX CALENDAR IMPORT CONFIG
// Centralized assumptions about the spreadsheet format.
// Update these if the spreadsheet layout changes.
// ============================================================

const FLEX_IMPORT_CONFIG = {
    nameMatch: /Kriesel.*Wes|Wes.*Kriesel/i,
    headerRow: 1,                                   // 0-indexed row with date headers
    vacationPatterns: [/vac/i, /nonwork/i],
    offDayPatterns: [/o:\s*day off/i, /^o:$/i],
    flexPatterns: {
        'flex-8': [/flex.*8/i, /8.*hr.*flex/i, /12.*hr.*flex/i],
        'flex-4': [/flex.*4/i, /4.*hr.*flex/i],
        '9-hour (9/80)': [/9.*hr/i, /9-hour/i],
        '8-hour (9/80)': [/8.*hr.*\(9\/80\)/i, /8-hour.*9\/80/i]
    },
    fiscalYearStart: '2025-07-01',
    fiscalYearEnd: '2026-06-30',
    fiscalYearId: '2025-2026'
};

// ============================================================
// FEDERAL HOLIDAYS (for fiscal year 2025-2026)
// These are automatically marked as non-work days during import
// and when generating the baseline calendar.
// ============================================================

function getFederalHolidays(fiscalYearStart, fiscalYearEnd) {
    const holidays = {};

    // Helper: nth weekday of a month (e.g., 4th Thursday of November)
    function nthWeekdayOf(year, month, weekday, n) {
        const first = new Date(year, month, 1);
        let day = first;
        // Advance to the first occurrence of the weekday
        while (day.getDay() !== weekday) {
            day = new Date(year, month, day.getDate() + 1);
        }
        // Advance to the nth occurrence
        day = new Date(year, month, day.getDate() + (n - 1) * 7);
        return day;
    }

    // Helper: last weekday of a month
    function lastWeekdayOf(year, month, weekday) {
        const lastDay = new Date(year, month + 1, 0);
        let day = lastDay;
        while (day.getDay() !== weekday) {
            day = new Date(year, month, day.getDate() - 1);
        }
        return day;
    }

    function addHoliday(date, name) {
        // If holiday falls on Saturday, observed on Friday
        // If holiday falls on Sunday, observed on Monday
        const dow = date.getDay();
        let observed = new Date(date);
        if (dow === 6) observed.setDate(observed.getDate() - 1); // Saturday → Friday
        if (dow === 0) observed.setDate(observed.getDate() + 1); // Sunday → Monday

        const ds = toDateStr(observed);
        // Only include if within fiscal year range
        if (ds >= fiscalYearStart && ds <= fiscalYearEnd) {
            holidays[ds] = name;
        }
    }

    // Extract years from fiscal year range
    const startYear = parseInt(fiscalYearStart.substring(0, 4));
    const endYear = parseInt(fiscalYearEnd.substring(0, 4));

    // Iterate through all calendar years that overlap the fiscal year
    for (let year = startYear; year <= endYear; year++) {
        // Fixed-date holidays
        addHoliday(new Date(year, 0, 1),   'New Year\'s Day');
        addHoliday(new Date(year, 5, 19),  'Juneteenth');
        addHoliday(new Date(year, 6, 4),   'Independence Day');
        addHoliday(new Date(year, 10, 11), 'Veterans Day');
        addHoliday(new Date(year, 11, 25), 'Christmas Day');

        // Floating holidays
        addHoliday(nthWeekdayOf(year, 0, 1, 3),  'Martin Luther King Jr. Day');  // 3rd Monday of Jan
        addHoliday(nthWeekdayOf(year, 1, 1, 3),  'Presidents\' Day');            // 3rd Monday of Feb
        addHoliday(lastWeekdayOf(year, 4, 1),     'Memorial Day');                // Last Monday of May
        addHoliday(nthWeekdayOf(year, 8, 1, 1),  'Labor Day');                   // 1st Monday of Sep
        addHoliday(nthWeekdayOf(year, 9, 1, 2),  'Columbus Day');                // 2nd Monday of Oct
        addHoliday(nthWeekdayOf(year, 10, 4, 4), 'Thanksgiving Day');            // 4th Thursday of Nov
        addHoliday(new Date(year, 10, nthWeekdayOf(year, 10, 4, 4).getDate() + 1), 'Day After Thanksgiving'); // Friday after Thanksgiving

        // OCDE / California public agency holidays
        // Lincoln's Birthday: CA observes on the preceding Friday/Monday nearest Feb 12
        // For 2026, OCDE designates Feb 9 (Monday)
        if (year === 2026) {
            addHoliday(new Date(2026, 1, 9), 'Lincoln\'s Birthday (OCDE)');
        } else {
            addHoliday(new Date(year, 1, 12), 'Lincoln\'s Birthday');
        }
        addHoliday(new Date(year, 11, 24), 'Christmas Eve');
        addHoliday(new Date(year, 11, 26), 'Day After Christmas');
        addHoliday(new Date(year, 11, 31), 'New Year\'s Eve');
    }

    return holidays;
}

// ============================================================
// APP CONSTANTS
// ============================================================

const TARGET_DAYS = 225;
const DEADLINE = new Date('2026-06-30');
const FISCAL_YEAR_ID = FLEX_IMPORT_CONFIG.fiscalYearId;

// ============================================================
// APP STATE
// ============================================================

let db, auth, currentUser;
let yearDocRef = null;
let days = {};          // { "2025-07-01": { type, approved, notes, source, locked }, ... }
let undoStack = [];     // loaded from Firestore logs subcollection
const MAX_UNDO = 10;

let pendingImportDays = null;   // holds parsed data before user confirms
let isOnline = true;
let saveTimeout = null;

// ============================================================
// INITIALIZATION
// ============================================================

firebase.initializeApp(firebaseConfig);
db = firebase.firestore();
auth = firebase.auth();

// Enable offline persistence
db.enablePersistence({ synchronizeTabs: true })
    .catch(err => {
        if (err.code === 'failed-precondition') {
            console.warn('Offline persistence unavailable: multiple tabs open.');
        } else if (err.code === 'unimplemented') {
            console.warn('Offline persistence not supported in this browser.');
        }
    });

// Monitor online/offline status
window.addEventListener('online', () => { isOnline = true; updateSyncStatus('saved'); });
window.addEventListener('offline', () => { isOnline = false; updateSyncStatus('offline'); });

// Auth state listener — the main entry point
auth.onAuthStateChanged(user => {
    if (user) {
        currentUser = user;
        showApp();
        initUserData();
    } else {
        currentUser = null;
        showAuth();
    }
});

// ============================================================
// AUTH
// ============================================================

document.getElementById('btn-sign-in').addEventListener('click', signIn);
document.getElementById('btn-sign-out').addEventListener('click', () => auth.signOut());

function signIn() {
    const provider = new firebase.auth.GoogleAuthProvider();
    // Hint to use OCDE domain; doesn't hard-block, but suggests it
    provider.setCustomParameters({ hd: 'ocde.us' });
    auth.signInWithPopup(provider)
        .catch(err => {
            const el = document.getElementById('auth-error');
            el.textContent = err.message;
            el.style.display = 'block';
        });
}

function showAuth() {
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('app').classList.remove('active');
}

function showApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.add('active');

    // Populate user info in header
    const userInfo = document.getElementById('user-info');
    const photo = currentUser.photoURL
        ? `<img src="${currentUser.photoURL}" alt="" referrerpolicy="no-referrer">`
        : '';
    userInfo.innerHTML = `${photo}<span>${currentUser.displayName || currentUser.email}</span>`;
}

// ============================================================
// FIRESTORE DATA LAYER
// ============================================================

async function initUserData() {
    const userDocRef = db.collection('users').doc(currentUser.uid);
    yearDocRef = userDocRef.collection('years').doc(FISCAL_YEAR_ID);

    // Ensure user profile doc exists
    const userSnap = await userDocRef.get();
    if (!userSnap.exists) {
        await userDocRef.set({
            displayName: currentUser.displayName || '',
            email: currentUser.email || '',
            photoURL: currentUser.photoURL || '',
            settings: {
                targetDays: TARGET_DAYS,
                deadline: '2026-06-30',
                scheduleType: '980',
                fiscalYearStart: FLEX_IMPORT_CONFIG.fiscalYearStart,
                fiscalYearEnd: FLEX_IMPORT_CONFIG.fiscalYearEnd
            },
            supervisors: [],
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }

    // Load year document
    const yearSnap = await yearDocRef.get();
    if (yearSnap.exists) {
        days = yearSnap.data().days || {};
    } else {
        days = {};
    }

    // Load recent logs for undo
    const logsSnap = await yearDocRef.collection('logs')
        .orderBy('timestamp', 'desc')
        .limit(MAX_UNDO)
        .get();
    undoStack = [];
    logsSnap.forEach(doc => undoStack.push({ id: doc.id, ...doc.data() }));

    // Render everything
    updateAllDisplays();
    renderCalendar();
    renderInspector();
    renderUndoStack();
    populateLockMonthSelect();
    populateFilterMonths();

    updateSyncStatus('saved');
}

async function saveDaysToFirestore() {
    updateSyncStatus('saving');
    try {
        await yearDocRef.set({
            days: days,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        updateSyncStatus('saved');
    } catch (err) {
        console.error('Save failed:', err);
        updateSyncStatus('error');
    }
}

// Debounced save — batches rapid changes into one write
function debouncedSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    updateSyncStatus('saving');
    saveTimeout = setTimeout(() => saveDaysToFirestore(), 800);
}

async function addLogEntry(entry) {
    try {
        const docRef = await yearDocRef.collection('logs').add({
            ...entry,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        undoStack.unshift({ id: docRef.id, ...entry, timestamp: new Date() });
        if (undoStack.length > MAX_UNDO) undoStack.pop();
        renderUndoStack();
    } catch (err) {
        console.error('Log write failed:', err);
    }
}

// ============================================================
// SYNC STATUS UI
// ============================================================

function updateSyncStatus(state) {
    const dot = document.querySelector('#sync-status .sync-dot');
    const text = document.querySelector('#sync-status .sync-text');

    dot.className = 'sync-dot';
    switch (state) {
        case 'saving':
            dot.classList.add('saving');
            text.textContent = 'Saving...';
            break;
        case 'saved':
            text.textContent = 'All changes saved';
            break;
        case 'offline':
            dot.classList.add('offline');
            text.textContent = 'Offline — changes cached';
            break;
        case 'error':
            dot.classList.add('error');
            text.textContent = 'Save failed — will retry';
            break;
    }
}

// ============================================================
// CALCULATIONS (reused from V1 logic)
// ============================================================

function countApproved() {
    let count = 0;
    for (const d of Object.values(days)) {
        if (d.approved === true) count++;
    }
    return count;
}

function getDaysBreakdown() {
    const breakdown = {};
    for (const d of Object.values(days)) {
        if (d.approved === true) {
            breakdown[d.type] = (breakdown[d.type] || 0) + 1;
        }
    }
    return breakdown;
}

function calculateMetrics() {
    const approved = countApproved();
    const remaining = TARGET_DAYS - approved;
    const percent = Math.round((approved / TARGET_DAYS) * 100);

    const today = new Date();
    const daysUntilDeadline = Math.max(0, Math.ceil((DEADLINE - today) / (1000 * 60 * 60 * 24)));
    const daysNeededPerDay = remaining > 0
        ? (remaining / Math.max(1, daysUntilDeadline)).toFixed(2)
        : 0;

    let status, statusColor;
    if (remaining <= 0) {
        status = 'Complete';
        statusColor = 'var(--success)';
    } else if (daysNeededPerDay > 1.25) {
        status = 'Behind';
        statusColor = 'var(--error)';
    } else if (daysNeededPerDay > 1) {
        status = 'Keep Pace';
        statusColor = 'var(--warning)';
    } else {
        status = 'On Track';
        statusColor = 'var(--success)';
    }

    return { approved, remaining, percent, daysUntilDeadline, daysNeededPerDay, status, statusColor };
}

// ============================================================
// PROGRESS STRIP & DASHBOARD
// ============================================================

function updateAllDisplays() {
    const m = calculateMetrics();
    const breakdown = getDaysBreakdown();

    document.getElementById('days-worked').textContent = m.approved;
    document.getElementById('days-remaining').textContent = Math.max(0, m.remaining);
    document.getElementById('progress-percent').textContent = m.percent + '%';
    document.getElementById('days-until-deadline').textContent = m.daysUntilDeadline;

    const statusEl = document.getElementById('status-display');
    statusEl.textContent = m.status;
    statusEl.style.color = m.statusColor;

    // Progress bar
    const bar = document.getElementById('progress-bar');
    bar.style.width = Math.min(m.percent, 100) + '%';
    bar.textContent = m.percent + '%';
    bar.className = 'progress-bar';
    if (m.remaining <= 0) bar.classList.add('ahead');
    else if (m.daysNeededPerDay > 1.25) bar.classList.add('behind');
    else bar.classList.add('on-track');

    // Warning banner
    const warn = document.getElementById('warning-banner');
    if (m.daysNeededPerDay > 1.25 && m.remaining > 0) {
        warn.innerHTML = `You're behind pace. Need ~${m.daysNeededPerDay} work days per calendar day to hit 225 by June 30. ${m.daysUntilDeadline} days remaining.`;
        warn.classList.add('show');
    } else {
        warn.classList.remove('show');
    }

    // Dashboard breakdown
    const typeLabels = {
        'weekday': 'Weekdays (auto)',
        'work-day': 'Work Days',
        '9-hour (9/80)': '9-hr (9/80)',
        '8-hour (9/80)': '8-hr (9/80)',
        'flex-8': 'Flex 8-hr',
        'flex-4': 'Flex 4-hr',
        'weekend-work': 'Weekend Work',
        'holiday': 'Federal Holidays',
        'vacation': 'Vacation/Non-work',
        'off-day': '9/80 Off Days'
    };

    const grid = document.getElementById('summary-grid');
    let gridHtml = '';
    for (const [key, label] of Object.entries(typeLabels)) {
        const val = breakdown[key] || 0;
        if (val > 0) {
            gridHtml += `
                <div class="summary-item">
                    <div class="label">${label}</div>
                    <div class="value">${val}</div>
                </div>`;
        }
    }
    // Always show total
    gridHtml = `
        <div class="summary-item">
            <div class="label">Total Approved</div>
            <div class="value">${m.approved}</div>
        </div>` + gridHtml;
    grid.innerHTML = gridHtml;
}

// ============================================================
// CALENDAR RENDERING — Single month with prev/next navigation
// ============================================================

// Track which month is displayed (0 = current month)
let calendarMonthOffset = 0;

function renderCalendar() {
    renderCalendarFromOffset();
}

function navigateCalendar(delta) {
    // Clamp to fiscal year: July 2025 (idx 0) through June 2026 (idx 11)
    const today = new Date();
    const proposed = new Date(today.getFullYear(), today.getMonth() + calendarMonthOffset + delta, 1);
    if (proposed < new Date(2025, 6, 1) || proposed > new Date(2026, 5, 1)) return;
    calendarMonthOffset += delta;
    renderCalendarFromOffset();
}

function navigateCalendarToToday() {
    calendarMonthOffset = 0;
    renderCalendarFromOffset();
}

function jumpToMonth(targetYear, targetMonth) {
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth();
    calendarMonthOffset = (targetYear - currentYear) * 12 + (targetMonth - currentMonth);
    renderCalendarFromOffset();
}

function renderCalendarFromOffset() {
    const container = document.getElementById('calendar-container');
    if (!container) return;

    const today = new Date();
    const todayStr = toDateStr(today);
    const displayDate = new Date(today.getFullYear(), today.getMonth() + calendarMonthOffset, 1);

    // Clamp
    if (displayDate < new Date(2025, 6, 1)) displayDate.setFullYear(2025, 6, 1);
    if (displayDate > new Date(2026, 5, 1)) displayDate.setFullYear(2026, 5, 1);

    const year = displayDate.getFullYear();
    const month = displayDate.getMonth();
    const monthName = displayDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const firstDayOfWeek = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Check if prev/next are within fiscal year bounds
    const canGoPrev = new Date(year, month - 1, 1) >= new Date(2025, 6, 1);
    const canGoNext = new Date(year, month + 1, 1) <= new Date(2026, 5, 1);

    // Pre-compute month work day counts for the header summary
    let preWorkDays = 0;
    let preTotalEligible = 0;
    for (let d = 1; d <= daysInMonth; d++) {
        const dt = new Date(year, month, d);
        const ds = toDateStr(dt);
        const dd = days[ds];
        const isWe = dt.getDay() === 0 || dt.getDay() === 6;
        if (!isWe) {
            const isHol = dd && dd.type === 'holiday';
            if (!isHol) preTotalEligible++;
            if (dd && dd.approved === true) preWorkDays++;
        }
    }

    // Build mini month-jump grid (Jul 2025 – Jun 2026)
    const miniMonthNames = ['Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun'];
    const miniMonthData = [
        [2025,6],[2025,7],[2025,8],[2025,9],[2025,10],[2025,11],
        [2026,0],[2026,1],[2026,2],[2026,3],[2026,4],[2026,5]
    ];
    let miniGrid = '<div class="mini-month-grid">';
    miniMonthData.forEach(([my, mm], idx) => {
        const isCurrent = my === year && mm === month;
        const cls = isCurrent ? 'mini-month active' : 'mini-month';
        miniGrid += `<button class="${cls}" onclick="jumpToMonth(${my}, ${mm})">${miniMonthNames[idx]}</button>`;
    });
    miniGrid += '</div>';

    let html = `
        <div class="calendar-month">
            <div class="calendar-header">
                <h3 class="calendar-month-title">${monthName}</h3>
                <div class="month-summary">
                    Work Days: <span class="month-summary-fraction">${preWorkDays} / ${preTotalEligible}</span>
                </div>
                <div class="calendar-nav">
                    <button onclick="navigateCalendar(-1)" ${canGoPrev ? '' : 'disabled'}>&#8592; Prev</button>
                    <button onclick="navigateCalendarToToday()">Today</button>
                    <button onclick="navigateCalendar(1)" ${canGoNext ? '' : 'disabled'}>Next &#8594;</button>
                </div>
            </div>
            ${miniGrid}
            <div class="weekdays">
                <div class="weekday-label">Sun</div>
                <div class="weekday-label">Mon</div>
                <div class="weekday-label">Tue</div>
                <div class="weekday-label">Wed</div>
                <div class="weekday-label">Thu</div>
                <div class="weekday-label">Fri</div>
                <div class="weekday-label">Sat</div>
            </div>
            <div class="days">`;

    // Empty leading cells
    for (let i = 0; i < firstDayOfWeek; i++) {
        html += '<div class="day-cell empty"></div>';
    }

    // Day cells + count work days for the month summary
    let monthWorkDays = 0;
    let monthTotalWeekdays = 0;

    for (let day = 1; day <= daysInMonth; day++) {
        const dateObj = new Date(year, month, day);
        const dateStr = toDateStr(dateObj);
        const dayData = days[dateStr];
        const isToday = dateStr === todayStr;
        const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;

        // Count weekdays, but exclude federal holidays from the denominator
        if (!isWeekend) {
            const isHoliday = dayData && dayData.type === 'holiday';
            if (!isHoliday) monthTotalWeekdays++;
        }

        let classes = 'day-cell';
        let badge = '';
        let typeLabel = '';

        if (dayData) {
            if (dayData.locked) classes += ' locked';
            if (isToday) classes += ' today';

            if (dayData.approved === true) {
                classes += ' approved';
                badge = '<div class="check">&#10003;</div>';
                monthWorkDays++;
            } else if (dayData.approved === false) {
                classes += ' off-day';
                if (dayData.type === 'holiday') classes += ' holiday';
            } else if (dayData.approved === null) {
                classes += ' pending';
            }

            // Type-specific styling (only for approved/pending)
            if (dayData.approved === true || dayData.approved === null) {
                if (dayData.type === 'flex-4') classes += ' flex-4';
                else if (dayData.type === 'flex-8') classes += ' flex-8';
                else if (dayData.type === 'weekend-work') classes += ' weekend-work';
            }

            typeLabel = getTypeShortLabel(dayData.type);
        } else {
            if (isToday) classes += ' today';
            if (isWeekend) classes += ' empty';
        }

        const onclick = (dayData && dayData.locked) ? '' : `onclick="cycleDay('${dateStr}')"`;

        // Show note snippet on weekend-work cells
        let noteSnippet = '';
        if (dayData && dayData.type === 'weekend-work' && dayData.notes && dayData.approved === true) {
            const truncated = dayData.notes.length > 12 ? dayData.notes.substring(0, 12) + '…' : dayData.notes;
            noteSnippet = `<div class="day-note">${truncated}</div>`;
        }

        const titleAttr = dayData
            ? `${dateStr} | ${dayData.type}${dayData.notes ? ' | ' + dayData.notes : ''}`
            : dateStr;

        html += `
            <div class="${classes}" ${onclick} title="${titleAttr}">
                ${badge}
                <div class="day-number">${day}</div>
                ${typeLabel ? `<div class="day-type-label">${typeLabel}</div>` : ''}
                ${noteSnippet}
            </div>`;
    }

    html += `</div>
        </div>`;

    container.innerHTML = html;
}

function getTypeShortLabel(type) {
    const labels = {
        'weekday': '',
        'work-day': '',
        'flex-8': 'F8',
        'flex-4': 'F4',
        '9-hour (9/80)': '9h',
        '8-hour (9/80)': '8h',
        'weekend-work': 'WE',
        'off-day': 'Off',
        'vacation': 'Vac',
        'holiday': 'FH'
    };
    return labels[type] || '';
}

// ============================================================
// DAY CYCLING (calendar click)
// ============================================================

function cycleDay(dateStr) {
    const dayData = days[dateStr];

    if (dayData && dayData.locked) return;

    const dateObj = new Date(dateStr + 'T00:00:00');
    const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;

    let oldApproved;

    if (!dayData) {
        if (isWeekend) {
            // Weekend — prompt for note, then create as weekend-work
            const note = prompt(`Adding weekend work for ${dateStr}.\nWhat is this day for?`);
            if (note === null) return; // user cancelled
            days[dateStr] = { type: 'weekend-work', approved: true, notes: note.trim(), source: 'manual', locked: false };
        } else {
            days[dateStr] = { type: 'work-day', approved: true, notes: '', source: 'manual', locked: false };
        }
        oldApproved = undefined;
    } else {
        oldApproved = dayData.approved;

        // Weekend-work days get a special flow: click to edit note or remove
        if (isWeekend && dayData.type === 'weekend-work') {
            if (dayData.approved === true) {
                // Already approved weekend-work — let user edit note or remove
                const currentNote = dayData.notes || '';
                const result = prompt(
                    `Weekend work: ${dateStr}\nCurrent note: "${currentNote}"\n\nEdit note below, or clear it and click OK to remove this day:`,
                    currentNote
                );
                if (result === null) return; // cancelled — no change
                if (result.trim() === '') {
                    // Empty note = remove the weekend work day
                    dayData.approved = false;
                } else {
                    // Update the note, stay approved
                    dayData.notes = result.trim();
                }
            } else {
                // Re-approving a previously removed weekend-work day
                const note = prompt(`Re-adding weekend work for ${dateStr}.\nWhat is this day for?`, dayData.notes || '');
                if (note === null) return;
                dayData.approved = true;
                dayData.notes = note.trim();
            }
        } else {
            // Normal weekday cycle: null -> true -> false -> null
            if (dayData.approved === null) dayData.approved = true;
            else if (dayData.approved === true) dayData.approved = false;
            else dayData.approved = null;
        }
    }

    addLogEntry({
        action: 'cycle',
        date: dateStr,
        oldValue: oldApproved,
        newValue: days[dateStr].approved
    });

    debouncedSave();
    updateAllDisplays();
    renderCalendarFromOffset();
    renderInspector();
}

// ============================================================
// MANUAL DAY ENTRY
// ============================================================

document.getElementById('btn-add-day').addEventListener('click', () => {
    const dateStr = document.getElementById('manual-date').value;
    const type = document.getElementById('manual-type').value;

    if (!dateStr) {
        alert('Please select a date.');
        return;
    }

    if (days[dateStr] && days[dateStr].locked) {
        alert('That day is locked and cannot be modified.');
        return;
    }

    const oldValue = days[dateStr] ? { ...days[dateStr] } : null;

    days[dateStr] = {
        type: type,
        approved: true,
        notes: 'Manual entry',
        source: 'manual',
        locked: false
    };

    addLogEntry({
        action: 'manual-add',
        date: dateStr,
        oldValue: oldValue,
        newValue: { type, approved: true }
    });

    debouncedSave();
    updateAllDisplays();
    renderCalendarFromOffset();
    renderInspector();

    document.getElementById('manual-date').value = '';
});

// ============================================================
// XLSX IMPORT WITH PREVIEW
// ============================================================

document.getElementById('btn-import').addEventListener('click', () => {
    document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', handleFileUpload);
document.getElementById('btn-confirm-import').addEventListener('click', confirmImport);
document.getElementById('btn-cancel-import').addEventListener('click', cancelImport);

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            pendingImportDays = parseFlexCalendar(workbook);
            showImportPreview(pendingImportDays);
        } catch (err) {
            alert('Error parsing file: ' + err.message);
            console.error(err);
        }
    };
    reader.readAsArrayBuffer(file);
    // Reset so the same file can be re-selected
    event.target.value = '';
}

function parseFlexCalendar(workbook) {
    const cfg = FLEX_IMPORT_CONFIG;
    const parsed = {};

    // STEP 1: Generate all weekdays in the fiscal year
    const start = new Date(cfg.fiscalYearStart + 'T00:00:00');
    const end = new Date(cfg.fiscalYearEnd + 'T00:00:00');
    let cur = new Date(start);

    while (cur <= end) {
        const dow = cur.getDay();
        if (dow >= 1 && dow <= 5) {
            const ds = toDateStr(cur);
            parsed[ds] = { type: 'weekday', approved: true, notes: 'Auto-counted weekday', source: 'auto_weekdays', locked: false };
        }
        cur.setDate(cur.getDate() + 1);
    }

    // STEP 2: Parse the spreadsheet for exceptions
    const exceptions = new Map();     // dateStr -> type

    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        // Find the row matching the user's name
        let nameRowIdx = null;
        for (let i = 0; i < rows.length; i++) {
            if (rows[i] && rows[i].some(cell => typeof cell === 'string' && cfg.nameMatch.test(cell))) {
                nameRowIdx = i;
                break;
            }
        }
        if (nameRowIdx === null) continue;

        const datesRow = rows[cfg.headerRow] || [];
        const valuesRow = rows[nameRowIdx] || [];

        for (let col = 1; col < datesRow.length; col++) {
            const dateVal = datesRow[col];
            const workVal = valuesRow[col];
            if (!dateVal || workVal === undefined || workVal === null) continue;

            let dateObj;
            if (typeof dateVal === 'number') {
                dateObj = new Date((dateVal - 25569) * 86400 * 1000);
            } else if (typeof dateVal === 'string') {
                dateObj = new Date(dateVal);
            } else continue;

            if (isNaN(dateObj.getTime())) continue;
            const ds = toDateStr(dateObj);
            const valStr = String(workVal).trim();

            // Check vacation
            if (cfg.vacationPatterns.some(p => p.test(valStr))) {
                exceptions.set(ds, 'vacation');
                continue;
            }
            // Check off-day
            if (cfg.offDayPatterns.some(p => p.test(valStr))) {
                exceptions.set(ds, 'off-day');
                continue;
            }
            // Check specific flex/work types
            for (const [type, patterns] of Object.entries(cfg.flexPatterns)) {
                if (patterns.some(p => p.test(valStr))) {
                    exceptions.set(ds, type);
                    break;
                }
            }
        }
    }

    // STEP 3: Apply exceptions
    for (const [ds, type] of exceptions) {
        if (type === 'vacation' || type === 'off-day') {
            if (parsed[ds]) {
                parsed[ds].type = type;
                parsed[ds].approved = false;
                parsed[ds].notes = type === 'vacation' ? 'Vacation/nonwork' : '9/80 day off';
                parsed[ds].source = 'flex_calendar';
            }
        } else {
            // flex-8, flex-4, 9-hour, 8-hour — still approved, just typed
            if (parsed[ds]) {
                parsed[ds].type = type;
                parsed[ds].source = 'flex_calendar';
                parsed[ds].notes = '';
            }
        }
    }

    // STEP 4: Apply federal holidays LAST — these always win over spreadsheet data
    const holidays = getFederalHolidays(cfg.fiscalYearStart, cfg.fiscalYearEnd);
    for (const [ds, name] of Object.entries(holidays)) {
        if (parsed[ds]) {
            parsed[ds].type = 'holiday';
            parsed[ds].approved = false;
            parsed[ds].notes = name;
            parsed[ds].source = 'federal_holidays';
            parsed[ds].locked = false;
        }
    }

    return parsed;
}

function showImportPreview(parsedDays) {
    const preview = document.getElementById('import-preview');
    const tableDiv = document.getElementById('import-preview-table');

    // Show first 10 non-weekday entries (exceptions are more interesting)
    const entries = Object.entries(parsedDays);
    const exceptions = entries.filter(([, d]) => d.source === 'flex_calendar' || d.source === 'federal_holidays');
    const sample = exceptions.length > 0 ? exceptions.slice(0, 15) : entries.slice(0, 10);

    let html = `<table>
        <tr>
            <th>Date</th>
            <th>Day</th>
            <th>Type</th>
            <th>Approved</th>
            <th>Source</th>
        </tr>`;

    for (const [dateStr, d] of sample) {
        const dayName = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });
        const approvedText = d.approved === true ? 'Yes' : d.approved === false ? 'No' : 'Pending';
        html += `<tr>
            <td>${dateStr}</td>
            <td>${dayName}</td>
            <td>${d.type}</td>
            <td>${approvedText}</td>
            <td>${d.source}</td>
        </tr>`;
    }

    html += '</table>';

    const totalDays = entries.length;
    const approvedCount = entries.filter(([, d]) => d.approved === true).length;
    const exceptionCount = exceptions.length;

    html += `<p style="font-size: 13px; margin-top: var(--sp-sm); color: #666;">
        Total days: <strong>${totalDays}</strong> |
        Auto-approved: <strong>${approvedCount}</strong> |
        Exceptions from calendar: <strong>${exceptionCount}</strong>
    </p>`;

    tableDiv.innerHTML = html;
    preview.classList.add('show');
}

function confirmImport() {
    if (!pendingImportDays) return;

    // Merge: preserve locked days, overwrite unlocked
    for (const [ds, newDay] of Object.entries(pendingImportDays)) {
        if (days[ds] && days[ds].locked) continue; // don't overwrite locked
        days[ds] = newDay;
    }

    addLogEntry({
        action: 'import',
        date: null,
        oldValue: null,
        newValue: { totalDays: Object.keys(pendingImportDays).length }
    });

    pendingImportDays = null;
    document.getElementById('import-preview').classList.remove('show');

    saveDaysToFirestore();
    updateAllDisplays();
    renderCalendarFromOffset();
    renderInspector();
}

function cancelImport() {
    pendingImportDays = null;
    document.getElementById('import-preview').classList.remove('show');
}

// ============================================================
// EXPORT
// ============================================================

document.getElementById('btn-export').addEventListener('click', () => {
    const data = {
        exportDate: new Date().toISOString(),
        user: currentUser.email,
        fiscalYear: FISCAL_YEAR_ID,
        days: days,
        summary: calculateMetrics(),
        breakdown: getDaysBreakdown()
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `work-tracker-${FISCAL_YEAR_ID}-${toDateStr(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
});

// ============================================================
// APPLY FEDERAL HOLIDAYS (to existing data, no re-import needed)
// ============================================================

document.getElementById('btn-apply-holidays').addEventListener('click', async () => {
    try {
        if (!yearDocRef) {
            alert('Please sign in first.');
            return;
        }

        const cfg = FLEX_IMPORT_CONFIG;
        const holidays = getFederalHolidays(cfg.fiscalYearStart, cfg.fiscalYearEnd);
        const applied = [];

        console.log('Federal holidays found:', Object.keys(holidays).length, holidays);

        for (const [ds, name] of Object.entries(holidays)) {
            const existing = days[ds];
            if (existing && existing.type !== 'holiday' && !existing.locked) {
                const oldType = existing.type;
                existing.type = 'holiday';
                existing.approved = false;
                existing.notes = name;
                existing.source = 'federal_holidays';
                applied.push(ds);

                addLogEntry({
                    action: 'apply-holiday',
                    date: ds,
                    oldValue: oldType,
                    newValue: 'holiday'
                });
            } else if (!existing) {
                // Holiday falls on a weekday not yet in data — add it
                const d = new Date(ds + 'T00:00:00');
                const dow = d.getDay();
                if (dow >= 1 && dow <= 5) {
                    days[ds] = { type: 'holiday', approved: false, notes: name, source: 'federal_holidays', locked: false };
                    applied.push(ds);
                }
            }
        }

        console.log('Holidays applied:', applied.length, applied);

        if (applied.length === 0) {
            alert('All federal holidays are already marked. No changes needed.');
            return;
        }

        updateSyncStatus('saving');
        await yearDocRef.set({
            days: days,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        updateAllDisplays();
        renderCalendarFromOffset();
        renderInspector();
        renderUndoStack();
        updateSyncStatus('saved');

        alert(`Applied ${applied.length} federal holiday(s):\n\n${applied.map(ds => `${ds} — ${holidays[ds]}`).join('\n')}`);
    } catch (err) {
        console.error('Error applying holidays:', err);
        alert('Error applying holidays: ' + err.message);
    }
});

// ============================================================
// CLEAR ALL DATA
// ============================================================

document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!confirm('Clear ALL work tracking data for this fiscal year? This cannot be undone.')) return;
    if (!confirm('Are you sure? This will delete all days and logs.')) return;

    days = {};
    undoStack = [];

    await yearDocRef.set({ days: {}, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

    // Delete logs
    const logSnap = await yearDocRef.collection('logs').get();
    const batch = db.batch();
    logSnap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    updateAllDisplays();
    renderCalendarFromOffset();
    renderInspector();
    renderUndoStack();
    updateSyncStatus('saved');
});

// ============================================================
// LOCK / UNLOCK MONTH
// ============================================================

function populateLockMonthSelect() {
    const select = document.getElementById('lock-month-select');
    select.innerHTML = '';
    const months = [
        { label: 'July 2025', start: '2025-07-01', end: '2025-07-31' },
        { label: 'August 2025', start: '2025-08-01', end: '2025-08-31' },
        { label: 'September 2025', start: '2025-09-01', end: '2025-09-30' },
        { label: 'October 2025', start: '2025-10-01', end: '2025-10-31' },
        { label: 'November 2025', start: '2025-11-01', end: '2025-11-30' },
        { label: 'December 2025', start: '2025-12-01', end: '2025-12-31' },
        { label: 'January 2026', start: '2026-01-01', end: '2026-01-31' },
        { label: 'February 2026', start: '2026-02-01', end: '2026-02-28' },
        { label: 'March 2026', start: '2026-03-01', end: '2026-03-31' },
        { label: 'April 2026', start: '2026-04-01', end: '2026-04-30' },
        { label: 'May 2026', start: '2026-05-01', end: '2026-05-31' },
        { label: 'June 2026', start: '2026-06-01', end: '2026-06-30' }
    ];

    for (const m of months) {
        const opt = document.createElement('option');
        opt.value = JSON.stringify(m);
        opt.textContent = m.label;
        select.appendChild(opt);
    }
}

document.getElementById('btn-lock-month').addEventListener('click', () => toggleMonthLock(true));
document.getElementById('btn-unlock-month').addEventListener('click', () => toggleMonthLock(false));

function toggleMonthLock(lock) {
    const val = JSON.parse(document.getElementById('lock-month-select').value);
    const verb = lock ? 'lock' : 'unlock';

    if (!confirm(`${lock ? 'Lock' : 'Unlock'} all days in ${val.label}? ${lock ? 'Locked days cannot be edited.' : ''}`)) return;

    let count = 0;
    for (const [ds, d] of Object.entries(days)) {
        if (ds >= val.start && ds <= val.end) {
            d.locked = lock;
            count++;
        }
    }

    addLogEntry({
        action: 'lock-month',
        date: val.label,
        oldValue: !lock,
        newValue: lock
    });

    debouncedSave();
    renderCalendarFromOffset();
    renderInspector();
}

// ============================================================
// UNDO
// ============================================================

document.getElementById('btn-undo').addEventListener('click', undoLastAction);

async function undoLastAction() {
    if (undoStack.length === 0) return;

    const entry = undoStack.shift();

    if (entry.action === 'cycle' || entry.action === 'approve') {
        if (days[entry.date]) {
            days[entry.date].approved = entry.oldValue;
        }
    } else if (entry.action === 'manual-add') {
        if (entry.oldValue) {
            days[entry.date] = entry.oldValue;
        } else {
            delete days[entry.date];
        }
    }
    // For import and lock-month, undo is not straightforward — skip

    // Delete the log entry from Firestore
    if (entry.id) {
        try {
            await yearDocRef.collection('logs').doc(entry.id).delete();
        } catch (err) {
            console.error('Failed to delete log entry:', err);
        }
    }

    debouncedSave();
    updateAllDisplays();
    renderCalendarFromOffset();
    renderInspector();
    renderUndoStack();
}

function renderUndoStack() {
    const container = document.getElementById('undo-stack');
    const btn = document.getElementById('btn-undo');

    if (undoStack.length === 0) {
        container.innerHTML = '<p style="color: #999; font-size: 13px;">No recent actions to undo</p>';
        btn.style.display = 'none';
        return;
    }

    let html = '<ul style="margin-left: var(--sp-md); font-size: 13px; list-style: none;">';
    for (const entry of undoStack) {
        html += `<li style="padding: 4px 0;">${formatLogAction(entry)}</li>`;
    }
    html += '</ul>';
    container.innerHTML = html;
    btn.style.display = 'block';
}

function formatLogAction(entry) {
    switch (entry.action) {
        case 'cycle': return `Toggled ${entry.date} (${entry.oldValue} → ${entry.newValue})`;
        case 'approve': return `Set ${entry.date} to ${entry.newValue ? 'approved' : 'rejected'}`;
        case 'manual-add': return `Added ${entry.newValue?.type || 'day'} on ${entry.date}`;
        case 'import': return `Imported ${entry.newValue?.totalDays || '?'} days from flex calendar`;
        case 'lock-month': return `${entry.newValue ? 'Locked' : 'Unlocked'} ${entry.date}`;
        default: return `${entry.action} on ${entry.date || '—'}`;
    }
}

// ============================================================
// DATA INSPECTOR
// ============================================================

function populateFilterMonths() {
    const select = document.getElementById('filter-month');
    // Keep the "All Months" option, add fiscal year months
    const months = [
        'July 2025', 'August 2025', 'September 2025', 'October 2025',
        'November 2025', 'December 2025', 'January 2026', 'February 2026',
        'March 2026', 'April 2026', 'May 2026', 'June 2026'
    ];
    for (const m of months) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        select.appendChild(opt);
    }
}

// Filter change listeners
document.getElementById('filter-month').addEventListener('change', renderInspector);
document.getElementById('filter-type').addEventListener('change', renderInspector);
document.getElementById('filter-status').addEventListener('change', renderInspector);

function renderInspector() {
    const tbody = document.getElementById('inspector-body');
    if (!tbody) return;

    const monthFilter = document.getElementById('filter-month').value;
    const typeFilter = document.getElementById('filter-type').value;
    const statusFilter = document.getElementById('filter-status').value;

    const sortedDates = Object.keys(days).sort();
    let html = '';
    let count = 0;

    for (const ds of sortedDates) {
        const d = days[ds];

        // Month filter
        if (monthFilter !== 'all') {
            const dateObj = new Date(ds + 'T00:00:00');
            const monthStr = dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            if (monthStr !== monthFilter) continue;
        }

        // Type filter
        if (typeFilter !== 'all' && d.type !== typeFilter) continue;

        // Status filter
        if (statusFilter !== 'all') {
            if (statusFilter === 'approved' && d.approved !== true) continue;
            if (statusFilter === 'pending' && d.approved !== null) continue;
            if (statusFilter === 'rejected' && d.approved !== false) continue;
        }

        count++;
        const dayName = new Date(ds + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });

        let statusBadge;
        if (d.approved === true) statusBadge = '<span class="badge badge-approved">Approved</span>';
        else if (d.approved === false) statusBadge = '<span class="badge badge-rejected">Rejected</span>';
        else statusBadge = '<span class="badge badge-pending">Pending</span>';

        const lockedBadge = d.locked ? '<span class="badge badge-locked">Locked</span>' : '';

        html += `<tr>
            <td>${ds}</td>
            <td>${dayName}</td>
            <td>${d.type}</td>
            <td>${statusBadge}</td>
            <td><input class="editable-note" value="${escapeHtml(d.notes || '')}" data-date="${ds}" onchange="updateNote(this)"></td>
            <td>${lockedBadge}</td>
        </tr>`;
    }

    tbody.innerHTML = html || '<tr><td colspan="6" style="text-align: center; color: #999; padding: 24px;">No days match the current filters</td></tr>';
    document.getElementById('inspector-count').textContent = `Showing ${count} day${count !== 1 ? 's' : ''}`;
}

function updateNote(input) {
    const ds = input.dataset.date;
    if (days[ds]) {
        if (days[ds].locked) {
            alert('This day is locked.');
            input.value = days[ds].notes || '';
            return;
        }
        days[ds].notes = input.value;
        debouncedSave();
    }
}

// ============================================================
// TAB SWITCHING
// ============================================================

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
});

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function toDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML.replace(/"/g, '&quot;');
}
