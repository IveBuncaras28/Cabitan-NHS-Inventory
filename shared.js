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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  }

  function renderSidebarAuth() {
    const el = $('sidebarAuth');
    if (!el) return;
    if (session) {
      el.innerHTML = `<span class="who">${escapeHtml(session.email)}</span><button id="signOutBtn">Sign out</button>`;
      $('signOutBtn').addEventListener('click', clearSession);
    } else {
      el.innerHTML = '';
    }
  }

  function showSignIn() {
    renderSidebarAuth();
    if ($('signinScreen')) $('signinScreen').style.display = 'flex';
    if ($('newPasswordScreen')) $('newPasswordScreen').style.display = 'none';
    if ($('appContent')) $('appContent').style.display = 'none';
  }

  function showNewPasswordScreen() {
    $('newPasswordError').style.display = 'none';
    $('newPassword1').value = ''; $('newPassword2').value = '';
    $('signinScreen').style.display = 'none';
    $('newPasswordScreen').style.display = 'flex';
    $('appContent').style.display = 'none';
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

  async function doSignIn() {
    const email = $('signinEmail').value.trim();
    const password = $('signinPassword').value;
    $('signinError').style.display = 'none';
    if (!email || !password) return;

    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign in failed');

      session = { access_token: data.access_token, refresh_token: data.refresh_token, email, isAdmin: data.user?.app_metadata?.is_admin === true };
      await persistSession();
      $('signinEmail').value = ''; $('signinPassword').value = '';

      if (data.user?.user_metadata?.must_change_password === true) {
        showNewPasswordScreen();
        return;
      }
      await showApp();
    } catch (e) {
      $('signinError').textContent = e.message;
      $('signinError').style.display = 'block';
    }
  }

  async function doSetNewPassword() {
    const p1 = $('newPassword1').value;
    const p2 = $('newPassword2').value;
    $('newPasswordError').style.display = 'none';

    if (!p1 || p1.length < 8) {
      $('newPasswordError').textContent = 'Password must be at least 8 characters.';
      $('newPasswordError').style.display = 'block';
      return;
    }
    if (p1 !== p2) {
      $('newPasswordError').textContent = 'Passwords do not match.';
      $('newPasswordError').style.display = 'block';
      return;
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: p1, data: { must_change_password: false } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.msg || data.error_description || 'Could not set new password');
      await showApp();
    } catch (e) {
      $('newPasswordError').textContent = e.message;
      $('newPasswordError').style.display = 'block';
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
      session = { access_token: data.access_token, refresh_token: data.refresh_token, email: session.email, isAdmin: session.isAdmin };
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

  function statusFor(qty) {
    if (qty < 4) return { cls: 'critical', label: 'Critical' };
    if (qty <= 5) return { cls: 'low', label: 'Low' };
    return { cls: 'ok', label: 'OK' };
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
    wireSidebarToggle();
    if ($('signinSubmit')) $('signinSubmit').addEventListener('click', doSignIn);
    if ($('newPasswordSubmit')) $('newPasswordSubmit').addEventListener('click', doSetNewPassword);
    const pw = $('signinPassword');
    if (pw) pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignIn(); });

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
    authHeaders,
    refreshIfNeeded,
    escapeHtml,
    statusFor,
    $,
  };
})();
