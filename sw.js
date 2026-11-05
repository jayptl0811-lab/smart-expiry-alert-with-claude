/* ══════════════════════════════════════════════════════════════════
   ExpireGuard Service Worker  v3
   Sends expiry notifications even when the website tab is closed.

   HOW IT WORKS
   ─────────────────────────────────────────────────────────────────
   1. The main page sends item data here via postMessage (type STORE).
      We persist it in IndexedDB so it survives tab/browser restarts.
   2. setInterval(runCheck, 1h) fires while the browser process runs
      (even if every tab of the site is closed — the SW stays alive
       as long as the browser itself is open).
   3. PeriodicBackgroundSync fires runCheck() ~hourly even when the
      browser is fully closed (Chrome/Edge on Android + desktop PWA).
   4. One-shot BackgroundSync re-fires runCheck() the next time the
      browser comes online after being offline.
   5. The push event lets a future server trigger alerts remotely.
══════════════════════════════════════════════════════════════════ */

'use strict';

const SW_VERSION = 'expireguard-sw-v3';
const DB_NAME    = 'eg_sw_db';
const DB_VER     = 1;
const PBS_TAG    = 'eg-check';           // periodic background sync tag
const BS_TAG     = 'eg-check';           // one-shot background sync tag
const HEARTBEAT  = 60 * 60 * 1000;      // 1 hour in ms

const EG_ICON = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2285%22%3E%E2%8F%B0%3C/text%3E%3C/svg%3E';

/* ──────────────────────────────────────────────────────────────────
   INSTALL / ACTIVATE
────────────────────────────────────────────────────────────────── */
self.addEventListener('install', () => {
  console.log('[EG-SW] Installed', SW_VERSION);
  self.skipWaiting(); // become active immediately
});

self.addEventListener('activate', event => {
  console.log('[EG-SW] Activated', SW_VERSION);
  // Take control of all open clients without requiring a refresh
  event.waitUntil(self.clients.claim());
});

/* ──────────────────────────────────────────────────────────────────
   IndexedDB helpers
────────────────────────────────────────────────────────────────── */
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('store')) {
        db.createObjectStore('store');
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('store', 'readonly').objectStore('store').get(key);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function idbSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('store', 'readwrite').objectStore('store').put(value, key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

/* ──────────────────────────────────────────────────────────────────
   EXPIRY LOGIC
────────────────────────────────────────────────────────────────── */
function daysLeft(dateStr) {
  const exp = new Date(dateStr); exp.setHours(0, 0, 0, 0);
  const now = new Date();        now.setHours(0, 0, 0, 0);
  return Math.round((exp - now) / 86400000);
}

function buildNotification(item, alertDays) {
  const d = daysLeft(item.expiryDate);
  const name = item.name || 'Item';

  if (d < 0) {
    return {
      title: '🚨 Expired!',
      body:  `${name} expired ${Math.abs(d)} day${Math.abs(d) !== 1 ? 's' : ''} ago!`,
      tag:   item.id + '_exp',
      urgent: true
    };
  }
  if (d === 0) {
    return {
      title: '🔔 Expires TODAY!',
      body:  `${name} expires today — use it now!`,
      tag:   item.id + '_d0',
      urgent: true
    };
  }
  if (d <= 3) {
    return {
      title: '🔔 Expiring Very Soon!',
      body:  `${name} expires in ${d} day${d !== 1 ? 's' : ''}!`,
      tag:   item.id + '_d' + d,
      urgent: true
    };
  }
  if (d <= (alertDays || 7)) {
    return {
      title: '📅 Expiry Alert',
      body:  `${name} expires in ${d} days`,
      tag:   item.id + '_w',
      urgent: false
    };
  }
  return null; // not yet within alert window
}

/* ──────────────────────────────────────────────────────────────────
   CORE CHECK — reads payload from IDB and fires notifications
────────────────────────────────────────────────────────────────── */
async function runCheck() {
  console.log('[EG-SW] Running expiry check…', new Date().toLocaleTimeString());

  let db;
  try { db = await idbOpen(); } catch (e) {
    console.warn('[EG-SW] Could not open IDB:', e); return;
  }

  const payload = await idbGet(db, 'payload');
  if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
    console.log('[EG-SW] No payload in IDB — skipping.');
    return;
  }

  const { items, alertDays = 7 } = payload;
  const today = new Date().toDateString();

  // Load "already fired today" map to avoid duplicate notifications
  let fired = (await idbGet(db, 'fired_' + today)) || {};
  let count = 0;

  for (const item of items) {
    const notif = buildNotification(item, alertDays);
    if (!notif) continue;
    if (fired[item.id]) continue; // already notified today

    try {
      await self.registration.showNotification(notif.title, {
        body:              notif.body,
        tag:               notif.tag,
        icon:              EG_ICON,
        badge:             EG_ICON,
        requireInteraction: notif.urgent,
        vibrate:           notif.urgent ? [200, 100, 200, 100, 200] : [100],
        data:              { itemId: item.id, url: self.registration.scope }
      });
      fired[item.id] = true;
      count++;
      console.log('[EG-SW] Notification sent:', notif.title, '—', item.name);
    } catch (e) {
      console.warn('[EG-SW] showNotification failed:', e);
    }
  }

  // Persist updated fired map
  if (count > 0) {
    await idbSet(db, 'fired_' + today, fired);
  }

  // Tell any open clients so they can update the in-app notification list
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type: 'EG_NOTIFIED', count }));

  console.log(`[EG-SW] Check done. ${count} notification(s) sent.`);
}

/* ──────────────────────────────────────────────────────────────────
   HEARTBEAT — fires every hour while browser process is running.
   This is the key mechanism for "tab closed but browser open".
────────────────────────────────────────────────────────────────── */
setInterval(() => runCheck(), HEARTBEAT);

/* ──────────────────────────────────────────────────────────────────
   PERIODIC BACKGROUND SYNC
   Fires ~hourly even when the browser is fully closed (requires
   the app to be installed as a PWA and permission granted).
────────────────────────────────────────────────────────────────── */
self.addEventListener('periodicsync', event => {
  if (event.tag === PBS_TAG) {
    console.log('[EG-SW] Periodic Background Sync fired');
    event.waitUntil(runCheck());
  }
});

/* ──────────────────────────────────────────────────────────────────
   ONE-SHOT BACKGROUND SYNC
   Fires once when browser next comes online after being offline.
────────────────────────────────────────────────────────────────── */
self.addEventListener('sync', event => {
  if (event.tag === BS_TAG) {
    console.log('[EG-SW] One-shot Background Sync fired');
    event.waitUntil(runCheck());
  }
});

/* ──────────────────────────────────────────────────────────────────
   PUSH  (server-push support for future use)
────────────────────────────────────────────────────────────────── */
self.addEventListener('push', event => {
  let data = { title: 'ExpireGuard', body: 'Check your expiring items!' };
  try { data = Object.assign(data, event.data.json()); } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:  data.body,
      icon:  EG_ICON,
      badge: EG_ICON,
      tag:   data.tag || 'eg-push',
      data:  { url: data.url || self.registration.scope }
    })
  );
});

/* ──────────────────────────────────────────────────────────────────
   NOTIFICATION CLICK — focus or open the app
────────────────────────────────────────────────────────────────── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(clients => {
        // Focus any existing window
        const existing = clients.find(c => c.url.startsWith(self.registration.scope));
        if (existing) return existing.focus();
        // Otherwise open a new window
        return self.clients.openWindow(targetUrl);
      })
  );
});

/* ──────────────────────────────────────────────────────────────────
   MESSAGES FROM MAIN PAGE
────────────────────────────────────────────────────────────────── */
self.addEventListener('message', async event => {
  if (!event.data) return;

  // Main page is sending fresh item data → persist to IDB and run check
  if (event.data.type === 'STORE') {
    try {
      const db = await idbOpen();
      await idbSet(db, 'payload', {
        items:     event.data.items     || [],
        alertDays: event.data.alertDays || 7
      });
      console.log('[EG-SW] Payload stored in IDB —', (event.data.items || []).length, 'items');
      runCheck(); // run a check immediately after storing
    } catch (e) {
      console.warn('[EG-SW] Failed to store payload:', e);
    }
  }

  // Manual check trigger from the page
  if (event.data.type === 'CHECK' || event.data.type === 'CHECK_NOW') {
    runCheck();
  }
});
