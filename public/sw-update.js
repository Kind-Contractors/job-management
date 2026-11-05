/* eslint-disable */
// Loaded by the generated service worker (vite.config.ts -> workbox.importScripts). Runs in the NEW service worker.
//
// WHY: a page already open when a new version is deployed keeps running the old code until it is reloaded - nothing in the old code
// listens for the new version. Pages of this version and later update themselves (src/lib/appUpdate.ts) and answer this worker's
// "who handles updates?" question. A page that does NOT answer runs an older version, and this worker reloads it - but only where a
// reload can't cost anything:
//   * "/" - the sign-in page, or the "Not set up for access" / checking screens an old version shows there. No work exists there.
//   * "/waste..." - the waste reporter's screens: typing is saved on the phone as it happens and drafts and files live in IndexedDB,
//     so a reload loses nothing. It happens only while NO file is being uploaded or checked (read from that IndexedDB, read-only);
//     otherwise the page is left alone and is looked at again on its next request, so an upload is never cut off.
// Manager and technician pages are never reloaded from here (someone may be typing there); they update when they are next opened.
//
// NO LOOPS: each page is reloaded at most once by a worker, never within a minute of the previous reload by it, and a page that answers
// is never touched. A reloaded page loads the new version, which answers.

var KC_UPDATE = (function () {
  var WASTE_DB = 'kind-contractors-waste-reports';
  var t = { ask: 5000, recheck: 20000, minGap: 60000, followUp: 10000 };
  var reloaded = new Set(); // client ids this worker reloaded
  var aware = new Set(); // client ids that answered (they update themselves)
  var lastLook = new Map(); // client id -> time of the last look
  var busyPages = new Set(); // old waste pages last seen with an upload running
  var followUps = new Set(); // client ids with a follow-up look already scheduled
  var lastReloadAt = 0;

  /** Where an old page may be reloaded: 'now' (sign-in address), 'if-idle' (waste screens), 'never' (manager / technician). */
  function legacyPolicy(url) {
    var path;
    try {
      path = new URL(url).pathname;
    } catch (e) {
      return 'never';
    }
    if (path === '/' || path === '/index.html') return 'now';
    if (path === '/waste' || path.indexOf('/waste/') === 0) return 'if-idle';
    return 'never';
  }

  /** True while the waste reporter's queue has a file being uploaded or checked. Unknown (error) counts as busy. */
  function wasteUploadBusy() {
    return new Promise(function (resolve) {
      try {
        var list = self.indexedDB.databases ? self.indexedDB.databases() : Promise.resolve(null);
        list.then(
          function (dbs) {
            // Never create the database by opening it: if it is not there, nothing can be uploading.
            if (dbs && !dbs.some(function (d) { return d.name === WASTE_DB; })) return resolve(false);
            var req = self.indexedDB.open(WASTE_DB);
            req.onupgradeneeded = function () {
              // It did not exist after all: abort so nothing is created.
              req.transaction.abort();
              resolve(false);
            };
            req.onerror = function () { resolve(true); };
            req.onsuccess = function () {
              var db = req.result;
              try {
                if (!db.objectStoreNames.contains('media')) { db.close(); return resolve(false); }
                var all = db.transaction('media', 'readonly').objectStore('media').getAll();
                all.onsuccess = function () {
                  db.close();
                  resolve((all.result || []).some(function (m) { return m && (m.status === 'uploading' || m.status === 'checking'); }));
                };
                all.onerror = function () { db.close(); resolve(true); };
              } catch (e) {
                db.close();
                resolve(true);
              }
            };
          },
          function () { resolve(true); }
        );
      } catch (e) {
        resolve(true);
      }
    });
  }

  /** Asks a page whether it handles updates itself (this version and later answer at once). */
  function answers(client) {
    return new Promise(function (resolve) {
      var done = false;
      var channel = new MessageChannel();
      var finish = function (value) {
        if (done) return;
        done = true;
        channel.port1.close();
        resolve(value);
      };
      channel.port1.onmessage = function (event) {
        if (event.data && event.data.type === 'KC_UPDATE_AWARE') finish(true);
      };
      setTimeout(function () { finish(false); }, t.ask);
      try {
        client.postMessage({ type: 'KC_WHO_HANDLES_UPDATES' }, [channel.port2]);
      } catch (e) {
        finish(false);
      }
    });
  }

  /** Resolves 'busy' when the page is an old waste page with an upload running (left alone for now), otherwise undefined. */
  function look(client) {
    if (!client || client.type !== 'window' || aware.has(client.id) || reloaded.has(client.id)) return Promise.resolve();
    var now = Date.now();
    if (now - (lastLook.get(client.id) || 0) < t.recheck) return Promise.resolve();
    lastLook.set(client.id, now);
    var policy = legacyPolicy(client.url);
    if (policy === 'never') return Promise.resolve();
    return answers(client).then(function (isAware) {
      if (isAware) { aware.add(client.id); return; }
      var busy = policy === 'if-idle' ? wasteUploadBusy() : Promise.resolve(false);
      return busy.then(function (isBusy) {
        if (isBusy) {
          busyPages.add(client.id);
          return 'busy'; // left alone: looked at again shortly (see the fetch listener)
        }
        busyPages.delete(client.id);
        if (lastReloadAt !== 0 && Date.now() - lastReloadAt < t.minGap) return;
        if (reloaded.has(client.id)) return;
        reloaded.add(client.id);
        lastReloadAt = Date.now();
        return client.navigate(client.url).catch(function () {});
      });
    });
  }

  /**
   * An old waste page that was busy is looked at once more a little later: its last upload or check may have been its last request,
   * so without this it would only update when next opened. At most one follow-up per page at a time, each started by one of the page's
   * own requests - bounded, never a loop.
   */
  function lookAgainLater(client) {
    if (followUps.has(client.id)) return Promise.resolve();
    followUps.add(client.id);
    return new Promise(function (resolve) { setTimeout(resolve, t.followUp); }).then(function () {
      followUps.delete(client.id);
      lastLook.delete(client.id);
      return look(client);
    });
  }

  /** Whether this page's request should start a follow-up look: it was busy last time (however recently it was looked at). */
  function wasBusy(client) {
    return !!client && busyPages.has(client.id);
  }

  /** Tests only: shorter waits. */
  function configureForTests(next) {
    t = Object.assign({}, t, next);
  }

  return { legacyPolicy: legacyPolicy, wasteUploadBusy: wasteUploadBusy, look: look, lookAgainLater: lookAgainLater, wasBusy: wasBusy, configureForTests: configureForTests };
})();

if (typeof self !== 'undefined' && self.addEventListener && typeof self.clients !== 'undefined') {
  self.addEventListener('activate', function (event) {
    // Activation only takes the pages over. The look at the pages runs AFTER it, never inside it: a page's reload is a request
    // this worker has to answer, and requests wait until activation has finished - waiting for the reload in here would deadlock.
    var claimed = self.clients.claim();
    event.waitUntil(claimed);
    claimed.then(function () {
      setTimeout(function () {
        self.clients.matchAll({ type: 'window' }).then(function (list) {
          list.forEach(function (c) { KC_UPDATE.look(c); });
        });
      }, 0);
    });
  });
  // A page's later requests (for example the next upload of an old waste page) are a chance to look at it again. Nothing is answered
  // here: the request goes on exactly as before.
  self.addEventListener('fetch', function (event) {
    if (!event.clientId) return;
    // waitUntil only keeps this worker awake for the short follow-up look; the request itself is not touched or delayed.
    event.waitUntil(
      self.clients
        .get(event.clientId)
        .then(function (c) {
          return KC_UPDATE.look(c).then(function (result) {
            return result === 'busy' || KC_UPDATE.wasBusy(c) ? KC_UPDATE.lookAgainLater(c) : undefined;
          });
        })
        .catch(function () {})
    );
  });
}
