/* =======================================================================
   shared.js — Cabitan NHS Inventory System
   Session, sign-in, and sidebar wiring shared by every dashboard page.
   Keep this file identical across pages. A page only needs to:
     1. Include shared.css + this file.
     2. Have the standard sidebar/topbar/auth markup (copy from an
        existing page such as supplies.html) with <body data-page="...">
        set and the matching data-nav on the active sidebar link.
     3. Call App.init(onReady) at the bottom of its own <script>, where
        onReady is an async function that loads that page's data and
        (optionally) sets up a refresh interval.
   ======================================================================= */
const App = (function () {
  // ===================== CONFIG =====================
  // Anon/public key only — this is safe to ship client-side. Every table
  // it touches is locked down with RLS policies (see dashboard.html's
  // top comment for the SQL) so the key alone can't read or write
  // anything a signed-in staff account shouldn't be able to.
  const SUPABASE_URL = "https://yzsnhoqxbmbuuibillch.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_L7ObwFnG5dI1VhyfTgZmZw_sZSKn8FA";
  const REFRESH_MS = 30000;
  // ====================================================

  const $ = (id) => document.getElementById(id);
  let session = null; // { access_token, refresh_token, email, isAdmin }
  let onReadyCb = null;

  // ---------- localStorage-backed session shim ----------
  // Same 'supabase-session' key as index.html (Stock Check), so staff
  // signed in there are automatically signed in across every page here.
  window.storage = {
    async get(key) {
      const v = localStorage.getItem(key);
      return v === null ? null : { value: v };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return { key, value };
    },
    async delete(key) {
      localStorage.removeItem(key);
      return { key, deleted: true };
    },
  };

  async function persistSession() {
    try { await window.storage.set('supabase-session', JSON.stringify(session)); }
    catch (e) { console.error('Could not save session', e); }
  }

  async function loadSession() {
    try {
      const res = await window.storage.get('supabase-session');
      if (res && res.value) session = JSON.parse(res.value);
    } catch (e) { /* not signed in */ }
  }

  async function clearSession() {
    session = null;
    try { await window.storage.delete('supabase-session'); } catch (e) {}
    showSignIn();
  }

  // Confirms with the user before actually signing them out -- wraps
  // clearSession() rather than living inside it, since clearSession()
  // is also called internally (e.g. when a token refresh fails) where
  // an "are you sure?" prompt would be the wrong UX -- that's a forced
  // logout, not a user-initiated one.
  async function confirmSignOut() {
    const ok = await confirmDialog('Are you sure you want to log out?', {
      title: 'Log out?', okLabel: 'Log out', danger: true,
    });
    if (!ok) return;
    await clearSession();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  // Turns "ivy.buncaras@deped.gov.ph" into "Ivy Buncaras". Splits the
  // local part on ., _, - or digits, title-cases each piece, and drops
  // empty fragments (stray numbers, double separators). Falls back to
  // the raw local part if nothing usable comes out of it.
  function deriveNameFromEmail(email) {
    if (!email) return '';
    const local = email.split('@')[0];
    const parts = local.split(/[._\-0-9]+/).filter(Boolean);
    const words = parts.length ? parts : [local];
    return words
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  // Prefer a real name if Supabase ever has one set (user_metadata.full_name
  // or .name), otherwise derive one from the email's local part.
  function displayNameFor(user, email) {
    const stored = user?.user_metadata?.full_name || user?.user_metadata?.name;
    return (stored && stored.trim()) || deriveNameFromEmail(email);
  }

  function renderSidebarAuth() {
    const el = $('sidebarAuth');
    if (!el) return;
    if (session) {
      el.innerHTML = `
        <span class="who-name">Hello, ${escapeHtml(session.name || deriveNameFromEmail(session.email))}</span>
        <span class="who-email">${escapeHtml(session.email)}</span>
        <button id="signOutBtn">Sign out</button>`;
      $('signOutBtn').addEventListener('click', confirmSignOut);
    } else {
      el.innerHTML = '';
    }
  }

  // index.html is the only sign-in screen in the system -- every other
  // page just redirects here instead of showing its own login form, so
  // there's never more than one place someone can type a password into.
  function showSignIn() {
    window.location.href = 'index.html';
  }

  async function showApp() {
    renderSidebarAuth();
    if ($('signinScreen')) $('signinScreen').style.display = 'none';
    if ($('newPasswordScreen')) $('newPasswordScreen').style.display = 'none';
    if ($('appContent')) $('appContent').style.display = 'block';
    if (typeof onReadyCb === 'function') {
      try {
        await onReadyCb();
      } catch (e) {
        if ($('globalStatus')) {
          $('globalStatus').style.display = 'block';
          $('globalStatus').textContent = `Couldn't load data: ${e.message}.`;
        }
      }
    }
  }

  async function refreshIfNeeded() {
    if (!session || !session.refresh_token) return false;
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error('expired');
      session = { access_token: data.access_token, refresh_token: data.refresh_token, email: session.email, isAdmin: session.isAdmin, name: session.name };
      await persistSession();
      return true;
    } catch (e) {
      await clearSession();
      return false;
    }
  }

  function authHeaders() {
    return {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    };
  }

  // GET helper with automatic 401 -> refresh -> retry, used by every
  // page's data loaders.
  async function supaGet(path) {
    const attempt = () => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
    });
    let res = await attempt();
    if (res.status === 401) {
      const ok = await refreshIfNeeded();
      if (!ok) throw new Error('Your session expired. Please sign in again.');
      res = await attempt();
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || body.hint || `${path} failed (${res.status})`);
    }
    return res.json();
  }

  // Generic write helper (POST/PATCH/etc) with the same 401 retry.
  async function supaFetch(path, options) {
    const attempt = () => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      ...options,
      headers: { ...authHeaders(), ...(options && options.headers) },
    });
    let res = await attempt();
    if (res.status === 401) {
      const ok = await refreshIfNeeded();
      if (!ok) throw new Error('Your session expired. Please sign in again.');
      res = await attempt();
    }
    return res;
  }

  // ---------- Supabase Storage (file uploads/downloads) ----------
  // Mirrors the supaGet/supaFetch 401-retry pattern above, but against
  // the Storage API instead of PostgREST. Bucket must already exist and
  // have RLS/storage policies set up in Supabase.
  function storageHeaders() {
    return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` };
  }

  async function storageUpload(bucket, path, file) {
    const attempt = () => fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: { ...storageHeaders(), 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    let res = await attempt();
    if (res.status === 401) {
      const ok = await refreshIfNeeded();
      if (!ok) throw new Error('Your session expired. Please sign in again.');
      res = await attempt();
    }
    return res;
  }

  // Bucket is assumed private, so downloads go through a short-lived
  // signed URL rather than a public link.
  async function storageSignedUrl(bucket, path, expiresIn = 60) {
    const attempt = () => fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: { ...storageHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });
    let res = await attempt();
    if (res.status === 401) {
      const ok = await refreshIfNeeded();
      if (!ok) throw new Error('Your session expired. Please sign in again.');
      res = await attempt();
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `Couldn't get a download link (${res.status})`);
    }
    const data = await res.json();
    return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
  }

  async function storageDelete(bucket, path) {
    const attempt = () => fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeURIComponent(path)}`, {
      method: 'DELETE',
      headers: storageHeaders(),
    });
    let res = await attempt();
    if (res.status === 401) {
      const ok = await refreshIfNeeded();
      if (!ok) throw new Error('Your session expired. Please sign in again.');
      res = await attempt();
    }
    return res;
  }

  // ---------- Supabase Edge Functions ----------
  // Same 401-retry pattern as supaFetch, but against /functions/v1/<name>
  // instead of PostgREST. Used for privileged server-side actions (e.g.
  // create-staff-account) that need the service role and can't be done
  // directly from the client with the anon key.
  async function supaFunction(name, body) {
    const attempt = () => fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    let res = await attempt();
    if (res.status === 401) {
      const ok = await refreshIfNeeded();
      if (!ok) throw new Error('Your session expired. Please sign in again.');
      res = await attempt();
    }
    return res;
  }

  function statusFor(qty) {
    if (qty < 4) return { cls: 'critical', label: 'Critical' };
    if (qty <= 5) return { cls: 'low', label: 'Low' };
    return { cls: 'ok', label: 'OK' };
  }

  // ---------- Toasts ----------
  // Non-blocking feedback for actions that used to use alert(). Auto-injects
  // its container the first time it's needed, so no page markup is required.
  function ensureToastRoot() {
    let root = $('toastRoot');
    if (!root) {
      root = document.createElement('div');
      root.id = 'toastRoot';
      document.body.appendChild(root);
    }
    return root;
  }

  const TOAST_ICONS = { success: '\u2713', error: '\u2715', info: '\u2139' };

  function toast(message, type = 'info', ms = 4000) {
    const root = ensureToastRoot();
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="t-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span><span class="t-msg"></span>`;
    el.querySelector('.t-msg').textContent = message; // textContent, not innerHTML — message may be untrusted (e.g. server error text)
    root.appendChild(el);
    const remove = () => {
      el.classList.add('leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    };
    const timer = setTimeout(remove, ms);
    el.addEventListener('click', () => { clearTimeout(timer); remove(); });
    return el;
  }

  // ---------- Confirm dialog ----------
  // Promise-based replacement for confirm(), styled to match the app instead
  // of popping a native browser dialog. Usage: if (!await App.confirmDialog('...')) return;
  function ensureConfirmRoot() {
    let root = $('confirmRoot');
    if (!root) {
      root = document.createElement('div');
      root.id = 'confirmRoot';
      root.innerHTML = `
        <div class="confirm-card">
          <h3 id="confirmTitle">Are you sure?</h3>
          <p id="confirmMsg"></p>
          <div class="confirm-actions">
            <button class="confirm-cancel" id="confirmCancelBtn" type="button">Cancel</button>
            <button class="confirm-ok" id="confirmOkBtn" type="button">Confirm</button>
          </div>
        </div>`;
      document.body.appendChild(root);
    }
    return root;
  }

  function confirmDialog(message, { title = 'Are you sure?', okLabel = 'Confirm', danger = false } = {}) {
    const root = ensureConfirmRoot();
    $('confirmTitle').textContent = title;
    $('confirmMsg').textContent = message;
    const okBtn = $('confirmOkBtn');
    const cancelBtn = $('confirmCancelBtn');
    okBtn.textContent = okLabel;
    okBtn.className = danger ? 'confirm-ok danger' : 'confirm-ok';

    return new Promise((resolve) => {
      const cleanup = (result) => {
        root.classList.remove('open');
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        root.removeEventListener('click', onBackdrop);
        resolve(result);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onBackdrop = (e) => { if (e.target === root) cleanup(false); };
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      root.addEventListener('click', onBackdrop);
      root.classList.add('open');
    });
  }

  // ---------- Empty states ----------
  // Friendlier than a bare line of text — icon + message, matches the
  // dashed-border language used elsewhere (e.g. the coming-soon card).
  function emptyState(icon, message) {
    return `<div class="empty-state"><div class="es-icon">${icon}</div><div class="es-text">${escapeHtml(message)}</div></div>`;
  }

  // ---------- Sidebar mobile toggle ----------
  function wireSidebarToggle() {
    const sidebar = $('sidebar');
    const backdrop = $('sidebarBackdrop');
    const toggle = $('menuToggle');
    if (!sidebar || !backdrop || !toggle) return;
    const open = () => { sidebar.classList.add('open'); backdrop.classList.add('open'); };
    const close = () => { sidebar.classList.remove('open'); backdrop.classList.remove('open'); };
    toggle.addEventListener('click', () => sidebar.classList.contains('open') ? close() : open());
    backdrop.addEventListener('click', close);
    sidebar.querySelectorAll('.nav-link').forEach(a => a.addEventListener('click', close));
  }

  async function init(onReady) {
    onReadyCb = onReady;
    ensureToastRoot();
    ensureConfirmRoot();
    wireSidebarToggle();

    await loadSession();
    if (session && session.access_token) {
      await showApp();
    } else {
      showSignIn();
    }

    if (REFRESH_MS) {
      setInterval(() => { if (session && document.visibilityState === 'visible') onReadyCb && onReadyCb(); }, REFRESH_MS);
    }
  }

  return {
    init,
    get session() { return session; },
    supaGet,
    supaFetch,
    storageUpload,
    storageSignedUrl,
    storageDelete,
    supaFunction,
    authHeaders,
    refreshIfNeeded,
    escapeHtml,
    statusFor,
    toast,
    confirmDialog,
    emptyState,
    $,
  };
})();
