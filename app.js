/**
 * @file app.js
 * @description CRduty v2 — Supabase Realtime Logic App
 */

'use strict';

/* ══════════════════════════════════════════════════════════════
   GLOBAL STATE & REFERENCES
══════════════════════════════════════════════════════════════ */
let currentUser = null;
let userDocData = null; // { email, name, class_id, division_id, is_admin, is_super_admin }
let activeClass = ''; // e.g., 'Class13'
let activeDiv   = 'A'; // 'A', 'B', 'C'

let tasksData   = []; // Original canonical tasks
let userOverrides = {}; // Personal edits: { taskId: { title, desc, done } }
let noticesData = [];
let allUsers    = []; // For admin panel

let realtimeChannel = null;

const DIVISIONS = ['A', 'B', 'C'];
const CLASSES   = Array.from({length: 13}, (_, i) => `Class${i+1}`);

// Check if Supabase SDK is initialized
if (typeof supabaseClient === 'undefined') {
  console.error("Supabase client not initialized. Check supabase-config.js.");
}

/* ══════════════════════════════════════════════════════════════
   UTILITIES & UI HELPERS
══════════════════════════════════════════════════════════════ */
const getEl = id => document.getElementById(id);

function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  getEl(`page-${page}`).classList.add('active');
}

/** 
 * Displays a toast notification 
 * @param {string} msg 
 * @param {'info'|'success'|'error'} type 
 */
function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(16px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

/** Escapes HTML */
const escapeHTML = str => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Format Date strings */
function formatDue(dateStr) {
  if (!dateStr) return { label: '', state: 'normal' };
  const due = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  now.setHours(0,0,0,0);
  const diff = Math.floor((due - now) / 86400000);
  if (diff < 0)  return { label: `${Math.abs(diff)}d overdue`, state: 'overdue' };
  if (diff === 0) return { label: 'Due today', state: 'due-soon' };
  if (diff === 1) return { label: 'Due tomorrow', state: 'due-soon' };
  return { label: `Due ${due.toLocaleDateString('en-IN', { day:'numeric', month:'short' })}`, state: 'normal' };
}

/* ══════════════════════════════════════════════════════════════
   GLOBAL LOADER
══════════════════════════════════════════════════════════════ */
function showGlobalLoader(text = 'Loading…') {
  let loader = document.querySelector('.global-loader');
  if (!loader) {
    loader = document.createElement('div');
    loader.className = 'global-loader';
    loader.innerHTML = `<div class="loader-ring"></div><div class="loader-text">${escapeHTML(text)}</div>`;
    document.body.appendChild(loader);
  } else {
    loader.querySelector('.loader-text').textContent = text;
    loader.style.display = 'flex';
  }
}
function hideGlobalLoader() {
  const loader = document.querySelector('.global-loader');
  if (loader) loader.style.display = 'none';
}

/* ══════════════════════════════════════════════════════════════
   AUTH FLOW (Login / Signup)
══════════════════════════════════════════════════════════════ */
const authTabs = document.querySelectorAll('.auth-tab');
authTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    // UI toggle
    authTabs.forEach(t => t.classList.remove('active', 'aria-selected'));
    tab.classList.add('active');
    tab.setAttribute('aria-selected', 'true');
    
    // Slidy indicator
    const indicator = getEl('auth-tab-indicator');
    const bRect = tab.getBoundingClientRect();
    const cRect = tab.parentElement.getBoundingClientRect();
    indicator.style.left  = `${bRect.left - cRect.left}px`;
    indicator.style.top   = `${bRect.top - cRect.top}px`;
    indicator.style.width = `${bRect.width}px`;
    indicator.style.height= `${bRect.height}px`;

    // Form toggle
    document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
    getEl(tab.dataset.target).classList.remove('hidden');
  });
});
// Init tab indicator position on load
setTimeout(() => authTabs[0].click(), 50);

// Eye button toggles
document.querySelectorAll('.eye-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = getEl(btn.dataset.target);
    const isTxt = input.type === 'text';
    input.type = isTxt ? 'password' : 'text';
    btn.style.opacity = isTxt ? '0.5' : '1';
  });
});

// Set error helper
function showAuthError(formPrefix, msg) {
  const el = getEl(`${formPrefix}-error`);
  el.textContent = msg;
  el.classList.add('visible');
}

// Signup
getEl('form-signup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = getEl('signup-name').value.trim();
  const email = getEl('signup-email').value.trim();
  const pwd = getEl('signup-password').value;
  const cls = getEl('signup-class').value;
  const div = getEl('signup-division').value;

  if (!name || !email || !pwd || !cls || !div) return showAuthError('signup', 'All fields are required.');
  
  const btn = getEl('signup-btn');
  btn.disabled = true;
  btn.querySelector('.btn-loader').classList.remove('hidden');
  btn.querySelector('.btn-text').classList.add('hidden');

  try {
    // 1. Sign up standard auth user
    const { data: authData, error: authErr } = await supabaseClient.auth.signUp({
      email, password: pwd
    });
    if (authErr) throw authErr;
    if (!authData.user) throw new Error("Could not create user account.");
    if (!authData.session) throw new Error("Account already exists (try Signing In) OR Email Confirmation is still turned ON in Supabase.");

    const uid = authData.user.id;
    let isSuperAdmin = false;
    let isAdmin = false;

    // 2. Check how many users exist. (User is now authenticated so they can read users)
    const { count, error: countErr } = await supabaseClient.from('users').select('*', { count: 'exact', head: true });
    
    if (count === 0) {
      isSuperAdmin = true;
      isAdmin = true;
    }

    // 3. Create public user doc matching the Auth id
    const { error: dbErr } = await supabaseClient.from('users').insert([{
      id: uid, name, email, class_id: cls, division_id: div,
      is_admin: isAdmin, is_super_admin: isSuperAdmin
    }]);

    if (dbErr) throw dbErr;

  } catch(err) {
    showAuthError('signup', err.message);
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-loader').classList.add('hidden');
    btn.querySelector('.btn-text').classList.remove('hidden');
  }
});

// Login
getEl('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = getEl('login-email').value.trim();
  const pwd = getEl('login-password').value;
  
  if (!email || !pwd) return showAuthError('login', 'Provide email and password.');
  
  const btn = getEl('login-btn');
  btn.disabled = true;
  btn.querySelector('.btn-loader').classList.remove('hidden');
  btn.querySelector('.btn-text').classList.add('hidden');

  const { error } = await supabaseClient.auth.signInWithPassword({ email, password: pwd });
  
  if (error) {
    showAuthError('login', error.message);
    btn.disabled = false;
    btn.querySelector('.btn-loader').classList.add('hidden');
    btn.querySelector('.btn-text').classList.remove('hidden');
  }
});

// Logout
getEl('logout-btn').addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
});

// Forgot Password Modal UI Toggle
getEl('forgot-password-link').addEventListener('click', () => {
  openModal('modal-forgot-password');
});

// Submit Forgot Password Email
getEl('form-forgot-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = getEl('forgot-email').value.trim();
  const btn = getEl('forgot-btn');
  btn.disabled = true;
  
  try {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin
    });
    if (error) throw error;
    
    closeModal('modal-forgot-password');
    showToast('Password reset link sent to your email.', 'success');
  } catch(err) {
    showToast(err.message, 'error');
  }
  btn.disabled = false;
});

// Submit New Password after Recovery
getEl('form-update-password').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newPwd = getEl('update-password').value;
  const btn = getEl('update-pwd-btn');
  btn.disabled = true;
  
  try {
    const { error } = await supabaseClient.auth.updateUser({ password: newPwd });
    if (error) throw error;
    
    closeModal('modal-update-password');
    showToast('Password updated successfully!', 'success');
  } catch(err) {
    showToast(err.message, 'error');
  }
  btn.disabled = false;
});


/* ══════════════════════════════════════════════════════════════
   AUTH STATE LISTENER
══════════════════════════════════════════════════════════════ */
supabaseClient.auth.onAuthStateChange(async (event, session) => {
  // If the user clicked a password reset link in their email
  if (event === 'PASSWORD_RECOVERY') {
    openModal('modal-update-password');
  }

  if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
    if (!session) return;
    currentUser = session.user;
    
    showGlobalLoader('Loading dashboard…');
    
    // Optimize speed: Perform the user profile check AND all table data fetches concurrently!
    const [userDoc, resTasks, resNotices, resOverrides] = await Promise.all([
      (async () => {
        for(let i=0; i<6; i++) {
            const { data } = await supabaseClient.from('users').select('*').eq('id', currentUser.id).single();
            if (data) return data;
            await new Promise(r => setTimeout(r, 500));
        }
        return null;
      })(),
      supabaseClient.from('tasks').select('*').order('created_at', { ascending: false }),
      supabaseClient.from('notices').select('*').order('created_at', { ascending: false }),
      supabaseClient.from('user_task_data').select('*').eq('user_id', currentUser.id)
    ]);
    
    if (userDoc) {
      userDocData = userDoc;
      activeClass = userDocData.class_id || 'Class1';
      activeDiv   = userDocData.division_id || 'A';
      
      // Inject global data
      if (!resTasks.error) tasksData = resTasks.data;
      if (!resNotices.error) noticesData = resNotices.data;
      if (!resOverrides.error) {
        userOverrides = {};
        resOverrides.data.forEach(d => { userOverrides[d.task_id] = d; });
      }

      setupDashboardUI();
      renderAllTasks();
      renderNotices();
      startRealtimeListeners();
      showPage('dashboard');
    } else {
      showToast('Error setting up user context. Try refreshing.', 'error');
      supabaseClient.auth.signOut();
    }
    hideGlobalLoader();
  } else if (event === 'SIGNED_OUT') {
    currentUser = null;
    userDocData = null;
    stopRealtimeListeners();
    showPage('auth');
    
    // reset UI
    getEl('login-btn').disabled = false;
    getEl('login-btn').querySelector('.btn-loader').classList.add('hidden');
    getEl('login-btn').querySelector('.btn-text').classList.remove('hidden');
  }
});

/* ══════════════════════════════════════════════════════════════
   DASHBOARD INITIALIZATION
══════════════════════════════════════════════════════════════ */
function setupDashboardUI() {
  // Topbar
  getEl('user-avatar').textContent = (userDocData.name || 'U').charAt(0).toUpperCase();
  getEl('user-name-disp').textContent = userDocData.name;
  
  const roleDisp = getEl('user-role-disp');
  if (userDocData.is_super_admin) { roleDisp.textContent = 'SUPER ADMIN'; roleDisp.className = 'user-role is-super'; }
  else if (userDocData.is_admin) { roleDisp.textContent = 'ADMIN'; roleDisp.className = 'user-role is-admin'; }
  else { roleDisp.textContent = `Student · ${userDocData.division_id}`; roleDisp.className = 'user-role'; }

  // Admin Elements
  if (userDocData.is_admin || userDocData.is_super_admin) {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
  } else {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
  }

  if (userDocData.is_super_admin) {
    getEl('admin-panel-btn').classList.remove('hidden');
  } else {
    getEl('admin-panel-btn').classList.add('hidden');
  }

  // Generate Class selector pills
  const cr = getEl('class-scroll-row');
  cr.innerHTML = '';
  CLASSES.forEach(cls => {
    const btn = document.createElement('button');
    btn.className = `class-pill ${cls === activeClass ? 'active' : ''}`;
    btn.textContent = cls.replace('Class', 'Class ');
    btn.onclick = () => selectClass(cls);
    cr.appendChild(btn);
  });
  
  updateBreadcrumb();
  switchTab(activeDiv, false);
}

function selectClass(cls) {
  activeClass = cls;
  document.querySelectorAll('.class-pill').forEach(p => {
    p.classList.toggle('active', p.textContent.replace(' ', '') === cls);
  });
  updateBreadcrumb();
  renderAllTasks(); // Filter applied
}

function updateBreadcrumb() {
  getEl('nav-breadcrumb').textContent = `${activeClass.replace('Class', 'Class ')}`;
}

// Division Tabs
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.div, true));
});

function switchTab(div, doRender = true) {
  activeDiv = div;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const isActive = btn.dataset.div === div;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  const activeBtn = getEl(`tab-${div}`);
  const indicator = getEl('tab-indicator');
  const container = document.querySelector('.tabs-container');
  const cRect = container.getBoundingClientRect();
  const bRect = activeBtn.getBoundingClientRect();

  indicator.style.left  = `${bRect.left - cRect.left}px`;
  indicator.style.top   = `${bRect.top - cRect.top}px`;
  indicator.style.width = `${bRect.width}px`;
  indicator.style.height= `${bRect.height}px`;

  document.querySelectorAll('.task-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `task-panel-${div}`);
  });

  if (doRender) renderAllTasks();
}


/* ══════════════════════════════════════════════════════════════
   SUPABASE DATA FETCHING & REALTIME LISTENERS
══════════════════════════════════════════════════════════════ */
async function fetchInitialData() {
  // Now handled concurrently inside the onAuthStateChange initialization block!
  // This wrapper is kept if manual re-fetches are ever needed.
}

function startRealtimeListeners() {
  if (realtimeChannel) supabaseClient.removeChannel(realtimeChannel);

  realtimeChannel = supabaseClient.channel('public-db-changes')
    // Listen to TASKS
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, payload => {
      if (payload.eventType === 'INSERT') {
        tasksData.unshift(payload.new);
      } else if (payload.eventType === 'UPDATE') {
        const idx = tasksData.findIndex(t => t.id === payload.new.id);
        if (idx > -1) tasksData[idx] = payload.new;
      } else if (payload.eventType === 'DELETE') {
        tasksData = tasksData.filter(t => t.id !== payload.old.id);
      }
      renderAllTasks();
    })
    // Listen to NOTICES
    .on('postgres_changes', { event: '*', schema: 'public', table: 'notices' }, payload => {
      if (payload.eventType === 'INSERT') {
        noticesData.unshift(payload.new);
      } else if (payload.eventType === 'UPDATE') {
        const idx = noticesData.findIndex(n => n.id === payload.new.id);
        if (idx > -1) noticesData[idx] = payload.new;
      } else if (payload.eventType === 'DELETE') {
        noticesData = noticesData.filter(n => n.id !== payload.old.id);
      }
      renderNotices();
    })
    // Listen to OVERRIDES
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_task_data', filter: `user_id=eq.${currentUser.id}` }, payload => {
      if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
        userOverrides[payload.new.task_id] = payload.new;
      } else if (payload.eventType === 'DELETE') {
        delete userOverrides[payload.old.task_id];
      }
      renderAllTasks();
    })
    // Listen to USERS (Only if Super Admin)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, payload => {
      if (userDocData && userDocData.is_super_admin) {
        if (payload.eventType === 'INSERT') {
          allUsers.push(payload.new);
        } else if (payload.eventType === 'UPDATE') {
          const idx = allUsers.findIndex(u => u.id === payload.new.id);
          if (idx > -1) allUsers[idx] = payload.new;
        } else if (payload.eventType === 'DELETE') {
          allUsers = allUsers.filter(u => u.id !== payload.old.id);
        }
        renderUserList();
      }
    })
    .subscribe();
}

function stopRealtimeListeners() {
  if (realtimeChannel) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}


/* ══════════════════════════════════════════════════════════════
   TASK RENDERING & LOGIC
══════════════════════════════════════════════════════════════ */
function renderAllTasks() {
  DIVISIONS.forEach(div => renderTaskTab(div));
}

function renderTaskTab(div) {
  const list = getEl(`task-list-${div}`);
  const empty = getEl(`empty-${div}`);
  
  // Filter for currently active class AND (target division == div OR 'All')
  const filtered = tasksData.filter(t => t.class_id === activeClass && (t.division_id === div || t.division_id === 'All'));

  // Merge overrides
  const merged = filtered.map(t => {
    const over = userOverrides[t.id];
    return {
      ...t,
      displayTitle: over && over.title ? over.title : t.title,
      displayDesc: over && over.desc != null ? over.desc : t.description,
      isDone: over && over.done !== undefined ? over.done : t.done,
      hasOverride: !!over,
      overrideId: over ? over.id : null
    };
  });

  // Sort: pending first, then by date desc
  merged.sort((a, b) => {
    if (a.isDone !== b.isDone) return a.isDone ? 1 : -1;
    const dA = a.created_at ? new Date(a.created_at).getTime() : 0;
    const dB = b.created_at ? new Date(b.created_at).getTime() : 0;
    return dB - dA;
  });

  list.innerHTML = '';
  if (merged.length === 0) {
    empty.classList.remove('hidden');
    updateProgress(div, 0, 0);
    checkReminders(div, []);
    return;
  }
  empty.classList.add('hidden');

  let doneCount = 0;
  merged.forEach((task, i) => {
    if (task.isDone) doneCount++;
    list.appendChild(buildTaskCard(task, i));
  });

  updateProgress(div, doneCount, merged.length);
  checkReminders(div, merged.filter(t => !t.isDone));
}

function updateProgress(div, done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  getEl(`progress-fill-${div}`).style.width = `${pct}%`;
  getEl(`progress-text-${div}`).textContent = `${done} of ${total} completed`;
  getEl(`progress-pct-${div}`).textContent = `${pct}%`;
}

function checkReminders(div, pendingTasks) {
  const banner = getEl(`reminder-${div}`);
  let soonCount = 0;
  
  pendingTasks.forEach(t => {
    if (t.due_date) {
      const state = formatDue(t.due_date).state;
      if (state === 'due-soon' || state === 'overdue') soonCount++;
    }
  });

  if (soonCount > 0) {
    banner.innerHTML = `<span>⚠️ You have ${soonCount} task(s) due soon or overdue in this division!</span>`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function buildTaskCard(task, delayIndex) {
  const card = document.createElement('div');
  card.className = `task-card ${task.isDone ? 'done' : ''}`;
  card.style.animationDelay = `${delayIndex * 35}ms`;

  const dueInfo = formatDue(task.due_date);
  const dueHtml = dueInfo.label ? `<span class="task-due ${dueInfo.state}">📅 ${dueInfo.label}</span>` : '';
  const personalBadge = task.hasOverride ? `<span class="badge-personal-inline" title="You have personalized this task">Personalized</span>` : '';
  const globalTarget = task.division_id === 'All' ? '<span class="task-target">All Divisions</span>' : '';

  // Can the user edit the original? (Is Admin who created it, or Super Admin)
  const canEditOrig = (userDocData.is_super_admin) || (userDocData.is_admin && task.created_by === currentUser.id);
  const editCanonicalBtn = canEditOrig ? `<button class="icon-btn edit-canonical" data-id="${task.id}" title="Edit original task">✏️</button>` : '';
  const delBtn = canEditOrig ? `<button class="icon-btn del" data-id="${task.id}" title="Delete task">🗑</button>` : '';

  card.innerHTML = `
    <label class="task-checkbox" title="${task.isDone ? 'Mark as pending' : 'Mark as done'}">
      <input type="checkbox" ${task.isDone ? 'checked' : ''} data-id="${task.id}" />
      <span class="checkmark"></span>
    </label>
    <div class="task-body">
      <div class="task-title">${escapeHTML(task.displayTitle)} ${personalBadge}</div>
      ${task.displayDesc ? `<div class="task-desc">${escapeHTML(task.displayDesc)}</div>` : ''}
      <div class="task-meta">
        <span class="priority-badge ${task.priority}">${task.priority}</span>
        ${globalTarget}
        ${dueHtml}
      </div>
    </div>
    <div class="task-actions">
      <!-- Personal edit always available for any user -->
      <button class="icon-btn edit-personal" data-id="${task.id}" title="Personalize notes">👤</button>
      ${editCanonicalBtn}
      ${delBtn}
    </div>
  `;

  // Toggle done status (saves to personal override!)
  card.querySelector('input[type="checkbox"]').addEventListener('change', (e) => {
    toggleTaskStatus(task.id, e.target.checked, task.overrideId);
  });

  // Personal edit
  card.querySelector('.edit-personal').addEventListener('click', () => openPersonalEdit(task));

  // Canonical edit / Delete
  if (canEditOrig) {
    card.querySelector('.edit-canonical').addEventListener('click', () => openCanonicalEdit(task));
    card.querySelector('.del').addEventListener('click', () => prepareDelete('task', task.id));
  }

  return card;
}

// Write to user_task_data table for personal state
async function toggleTaskStatus(taskId, isDone, overrideId) {
  try {
    if (overrideId) {
      await supabaseClient.from('user_task_data').update({ done: isDone }).eq('id', overrideId);
    } else {
      await supabaseClient.from('user_task_data').insert([{
        user_id: currentUser.id,
        task_id: taskId,
        done: isDone
      }]);
    }
  } catch(err) {
    showToast('Failed to sync. ' + err.message, 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   NOTICES
══════════════════════════════════════════════════════════════ */
function renderNotices() {
  const list = getEl('notice-list');
  const empty = getEl('no-notices');

  list.innerHTML = '';
  if (noticesData.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const ICONS = { info: 'ℹ️', warning: '⚠️', urgent: '🚨' };

  noticesData.forEach((n, i) => {
    const card = document.createElement('div');
    card.className = `notice-card ${n.type}`;
    card.style.animationDelay = `${i * 30}ms`;

    const d = n.created_at ? new Date(n.created_at).toLocaleDateString('en-IN', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'}) : 'Just now';
    
    // Deletable by creator or super admin
    const canDel = userDocData.is_super_admin || (userDocData.is_admin && n.created_by === currentUser.id);
    const delHtml = canDel ? `<button class="notice-del" data-id="${n.id}" title="Delete notice">✕</button>` : '';

    card.innerHTML = `
      <span class="notice-icon">${ICONS[n.type] || 'ℹ️'}</span>
      <div class="notice-content">
        <div class="notice-title">${escapeHTML(n.title)}</div>
        <div class="notice-body">${escapeHTML(n.body)}</div>
        <div class="notice-meta">
          <span>By ${escapeHTML(n.author_name)}</span> • <span>${d}</span>
        </div>
      </div>
      ${delHtml}
    `;

    if (canDel) {
      card.querySelector('.notice-del').addEventListener('click', () => prepareDelete('notice', n.id));
    }
    list.appendChild(card);
  });
}

/* ══════════════════════════════════════════════════════════════
   ADMIN - CREATE TASK & NOTICE
══════════════════════════════════════════════════════════════ */
let taskCreationPriority = 'medium';
getEl('tc-priority').addEventListener('click', e => {
  if (!e.target.classList.contains('pill')) return;
  document.querySelectorAll('#tc-priority .pill').forEach(p => p.classList.remove('active'));
  e.target.classList.add('active');
  taskCreationPriority = e.target.dataset.val;
});

getEl('add-task-btn').addEventListener('click', () => {
  getEl('tc-class').value = activeClass;
  getEl('tc-div').value = activeDiv;
  openModal('modal-task-create');
});

getEl('form-task-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;

  const due_date = getEl('tc-due').value || null;

  try {
    const { error } = await supabaseClient.from('tasks').insert([{
      title: getEl('tc-title').value.trim(),
      description: getEl('tc-desc').value.trim(),
      class_id: getEl('tc-class').value,
      division_id: getEl('tc-div').value,
      due_date: due_date,
      priority: taskCreationPriority,
      done: false, // global default
      created_by: currentUser.id,
      created_by_name: userDocData.name
    }]);
    if (error) throw error;
    
    closeModal('modal-task-create');
    e.target.reset();
    showToast('Task published globally.', 'success');
  } catch(err) {
    showToast(err.message, 'error');
  }
  btn.disabled = false;
});

// Notice Creation
let noticeCreationType = 'info';
getEl('n-type').addEventListener('click', e => {
  if (!e.target.classList.contains('pill')) return;
  document.querySelectorAll('#n-type .pill').forEach(p => p.classList.remove('active'));
  e.target.classList.add('active');
  noticeCreationType = e.target.dataset.val;
});

getEl('add-notice-btn').addEventListener('click', () => openModal('modal-notice'));

getEl('form-notice').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const { error } = await supabaseClient.from('notices').insert([{
      title: getEl('n-title').value.trim(),
      body: getEl('n-body').value.trim(),
      type: noticeCreationType,
      created_by: currentUser.id,
      author_name: userDocData.name
    }]);
    if (error) throw error;

    closeModal('modal-notice');
    e.target.reset();
    showToast('Notice posted.', 'success');
  } catch(err) {
    showToast(err.message, 'error');
  }
  btn.disabled = false;
});

/* ══════════════════════════════════════════════════════════════
   TASK EDITING (Canonical vs Personal)
══════════════════════════════════════════════════════════════ */
// 1. CANONICAL
let editCanonicalPriority = 'medium';
getEl('tec-priority').addEventListener('click', e => {
  if (!e.target.classList.contains('pill')) return;
  document.querySelectorAll('#tec-priority .pill').forEach(p => p.classList.remove('active'));
  e.target.classList.add('active');
  editCanonicalPriority = e.target.dataset.val;
});

function openCanonicalEdit(t) {
  getEl('tec-id').value = t.id;
  getEl('tec-title').value = t.title;
  getEl('tec-desc').value = t.description || '';
  getEl('tec-due').value = t.due_date || '';
  
  editCanonicalPriority = t.priority;
  document.querySelectorAll('#tec-priority .pill').forEach(p => p.classList.toggle('active', p.dataset.val === t.priority));
  
  openModal('modal-task-edit-canonical');
}

getEl('form-task-edit-canonical').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = getEl('tec-id').value;
  try {
    const due_date = getEl('tec-due').value || null;
    const { error } = await supabaseClient.from('tasks').update({
      title: getEl('tec-title').value.trim(),
      description: getEl('tec-desc').value.trim(),
      due_date: due_date,
      priority: editCanonicalPriority
    }).eq('id', id);

    if (error) throw error;

    closeModal('modal-task-edit-canonical');
    showToast('Original task updated.', 'success');
  } catch(err) {
    showToast(err.message, 'error');
  }
});

// 2. PERSONAL
function openPersonalEdit(t) {
  getEl('tep-id').value = t.id;
  getEl('tep-title').value = t.displayTitle; // Pre-fill with current state
  getEl('tep-desc').value = t.displayDesc;
  // attach override id for reset if exists
  getEl('tep-reset-btn').dataset.overid = t.overrideId || '';
  openModal('modal-task-edit-personal');
}

getEl('form-task-edit-personal').addEventListener('submit', async (e) => {
  e.preventDefault();
  const taskId = getEl('tep-id').value;
  const title = getEl('tep-title').value.trim();
  const desc = getEl('tep-desc').value.trim();
  
  // Find if override exists
  const over = userOverrides[taskId];
  try {
    if (over) {
      const { error } = await supabaseClient.from('user_task_data').update({ title, desc: desc }).eq('id', over.id);
      if (error) throw error;
    } else {
      const { error } = await supabaseClient.from('user_task_data').insert([{
        user_id: currentUser.id,
        task_id: taskId,
        title, desc: desc
      }]);
      if (error) throw error;
    }
    closeModal('modal-task-edit-personal');
    showToast('Personal version saved.', 'info');
  } catch(err) { showToast(err.message, 'error'); }
});

getEl('tep-reset-btn').addEventListener('click', async (e) => {
  const overId = e.target.dataset.overid;
  if (!overId) return closeModal('modal-task-edit-personal'); // none existed
  try {
    const { error } = await supabaseClient.from('user_task_data').delete().eq('id', overId);
    if (error) throw error;

    closeModal('modal-task-edit-personal');
    showToast('Reset to original.', 'info');
  } catch(err) { showToast(err.message, 'error'); }
});

/* ══════════════════════════════════════════════════════════════
   DELETE LOGIC
══════════════════════════════════════════════════════════════ */
let deleteTarget = { type: null, id: null };
function prepareDelete(type, id) {
  deleteTarget = { type, id };
  openModal('modal-confirm');
}

getEl('confirm-ok-btn').addEventListener('click', async () => {
  const { type, id } = deleteTarget;
  if (!id) return;
  try {
    if (type === 'task') {
      const { error } = await supabaseClient.from('tasks').delete().eq('id', id);
      if (error) throw error;
    } else if (type === 'notice') {
      const { error } = await supabaseClient.from('notices').delete().eq('id', id);
      if (error) throw error;
    }
    closeModal('modal-confirm');
    showToast(`${type} deleted.`, 'success');
  } catch(err) {
    showToast(err.message, 'error');
  }
});


/* ══════════════════════════════════════════════════════════════
   SUPER ADMIN DRAWER (Promote / Demote users)
══════════════════════════════════════════════════════════════ */
const adminDrawerBtn = getEl('admin-panel-btn');
if(adminDrawerBtn) adminDrawerBtn.addEventListener('click', openAdminDrawer);
getEl('drawer-close-btn').addEventListener('click', closeAdminDrawer);
getEl('drawer-overlay').addEventListener('click', closeAdminDrawer);


async function openAdminDrawer() {
  getEl('drawer-overlay').classList.add('open');
  getEl('drawer-admin').classList.add('open');
  
  if (userDocData.is_super_admin) {
    const { data, error } = await supabaseClient.from('users').select('*');
    if (!error) {
      allUsers = data;
      renderUserList();
    }
  }
}
function closeAdminDrawer() {
  getEl('drawer-overlay').classList.remove('open');
  getEl('drawer-admin').classList.remove('open');
}

getEl('user-search').addEventListener('input', renderUserList);

function renderUserList() {
  const q = getEl('user-search').value.toLowerCase();
  const list = getEl('user-list');
  const empty = getEl('no-users');
  list.innerHTML = '';
  
  const filtered = allUsers.filter(u => {
    return (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q);
  });
  
  if (filtered.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  filtered.forEach(u => {
    const isMe = u.id === currentUser.id;
    let rankBadge = `<span class="role-badge user">Student</span>`;
    let btnHtml = '';
    
    if (u.is_super_admin) rankBadge = `<span class="role-badge super">Super Admin</span>`;
    else if (u.is_admin) rankBadge = `<span class="role-badge admin">Admin</span>`;

    // Only allow changing normal admins, not super admins, and not oneself
    if (!u.is_super_admin && !isMe) {
      if (u.is_admin) btnHtml = `<button class="promote-btn demote" data-id="${u.id}" data-val="false">Demote</button>`;
      else btnHtml = `<button class="promote-btn" data-id="${u.id}" data-val="true">Promote</button>`;
    }

    const item = document.createElement('div');
    item.className = 'user-item';
    item.innerHTML = `
      <div class="user-item-avatar ${u.is_super_admin ? 'super' : ''}">${(u.name||'U').charAt(0).toUpperCase()}</div>
      <div class="user-item-info">
        <div class="user-item-name">${escapeHTML(u.name)}${isMe ? ' (You)' : ''}</div>
        <div class="user-item-email">${escapeHTML(u.email)}</div>
        <div class="user-item-meta">
          ${rankBadge}
          <span class="class-badge-sm">${u.class_id} / ${u.division_id}</span>
        </div>
      </div>
      <div>${btnHtml}</div>
    `;

    const trigger = item.querySelector('.promote-btn');
    if (trigger) {
      trigger.addEventListener('click', async (e) => {
        const targetId = e.target.dataset.id;
        const makeAdmin = e.target.dataset.val === 'true';
        e.target.disabled = true;
        try {
          const { error } = await supabaseClient.from('users').update({ is_admin: makeAdmin }).eq('id', targetId);
          if (error) throw error;
          showToast(makeAdmin ? 'User is now an Admin.' : 'User demoted to Student.', 'success');

          // Trigger local state update manually for immediate feedback
          const localU = allUsers.find(au => au.id === targetId);
          if (localU) localU.is_admin = makeAdmin;
          renderUserList();

        } catch(err) { showToast(err.message, 'error'); }
      });
    }
    list.appendChild(item);
  });
}

/* ══════════════════════════════════════════════════════════════
   MODAL HELPERS
══════════════════════════════════════════════════════════════ */
function openModal(id) {
  getEl(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  getEl(id).classList.remove('open');
  document.body.style.overflow = '';
}
document.querySelectorAll('.modal-close, [data-modal]').forEach(el => {
  el.addEventListener('click', () => {
    const t = el.dataset.modal || el.closest('.modal-overlay')?.id;
    if (t) closeModal(t);
  });
});
document.querySelectorAll('.modal-overlay').forEach(over => {
  over.addEventListener('click', e => { if(e.target === over) closeModal(over.id); });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => closeModal(m.id));
});
