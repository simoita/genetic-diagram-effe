// ===== SUPABASE COLLABORATION =====
// Documento condiviso con merge per campo (stile Google Docs).
// Ogni campo ha un orologio logico: due persone possono modificare
// contemporaneamente parti diverse dello stesso diagramma senza sovrascriversi.
const CLOUD_DIAGRAM_ID = '00000000-0000-0000-0000-000000000000';
const CLOUD_DIAGRAM_NAME = 'Diagramma Cascata';
const CLOUD_HEARTBEAT_MS = 10000;
const CLOUD_ACTIVE_WINDOW_MS = 60000;
const CLOUD_SYNC_VERSION = 1;
const CLOUD_ENTITY_KEYS = new Set(['pages', 'phases', 'levels', 'boxes', 'connections']);
const CLOUD_DERIVED_KEYS = new Set(['_multiIndex', 'file']);
const SYNC_MISSING = Symbol('sync-missing');

let supabaseClient = null;          // client Supabase (evita il globale "supabase" del CDN)
let supabaseConfig = null;          // { url, key }
let cloudChannel = null;
let presenceChannel = null;
let heartbeatTimer = null;
let cloudSaveTimer = null;
let remoteApplyTimer = null;
let presenceRefreshTimer = null;
let pendingRemoteState = null;
let isApplyingRemote = false;
let activeUsers = [];
let cloudGeneration = 0;
let cloudConnectToken = 0;
let lastLocalChangeAt = Date.parse(localStorage.getItem('cascade_local_updated_at') || '') || 0;

// Metadati di sincronizzazione: non fanno parte del documento visibile.
let syncShadow = null;              // ultima fotografia confrontata con appState
let cloudSyncRunning = false;
let cloudSyncQueued = false;
let realtimeWasSubscribed = false;
let realtimeReconcileTimer = null;
let localDocWasBlank = false;      // true finche' l'utente non modifica il documento locale

// Orologio ibrido logico (HLC): ordina causalmente le modifiche
// e usa l'id del client come spareggio deterministico.
let hlcWall = 0;
let hlcCounter = 0;

const CLOUD_USER_ID = (() => {
  try {
    let id = sessionStorage.getItem('cascade_user_id');
    if (!id) {
      id = 'user_' + Math.random().toString(36).slice(2, 9);
      sessionStorage.setItem('cascade_user_id', id);
    }
    return id;
  } catch (e) {
    return 'user_' + Math.random().toString(36).slice(2, 9);
  }
})();

function getDisplayName() {
  const stored = (localStorage.getItem('user_display_name') || '').trim();
  return stored || ('Utente ' + CLOUD_USER_ID.slice(-4));
}

// JSON stabile: ignora l'ordine delle chiavi (Postgres JSONB non lo conserva).
function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function safeClone(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isEntityRecord(value) {
  return isPlainObject(value) && typeof value.id === 'string' && value.id.length > 0;
}

function isValidDiagramState(state) {
  return !!state && Array.isArray(state.pages) && state.pages.length > 0 &&
    state.pages.every(p => p && Array.isArray(p.phases) && Array.isArray(p.connections));
}

function setSyncStatus(state, text) {
  const badge = document.getElementById('syncStatusIndicator');
  const label = document.getElementById('syncStatusText');
  const cloudText = document.getElementById('cloudStateText');
  const labels = { local: 'Locale', syncing: 'Sincronizzazione', online: 'Cloud', error: 'Errore' };
  const current = state || 'local';
  if (badge) {
    badge.classList.remove('hidden', 'local', 'syncing', 'online', 'error');
    badge.classList.add(current);
    badge.title = text ? ('Supabase: ' + text) : (current === 'error' ? 'Errore di sincronizzazione' : 'Stato sincronizzazione');
  }
  if (label) label.textContent = text || labels[current] || 'Locale';
  if (cloudText) cloudText.textContent = current === 'online' ? 'connesso' : current === 'error' ? 'errore' : current === 'syncing' ? 'connessione...' : 'locale';
}

function prefillSupabaseBar() {
  const urlEl = document.getElementById('html_supabase_url');
  const keyEl = document.getElementById('html_supabase_key');
  const nameEl = document.getElementById('html_display_name');
  const storedUrl = localStorage.getItem('supabase_url') || '';
  const storedKey = localStorage.getItem('supabase_key') || '';
  const storedName = localStorage.getItem('user_display_name') || '';
  if (urlEl && storedUrl) urlEl.value = storedUrl;
  if (keyEl && storedKey) keyEl.value = storedKey;
  if (nameEl && storedName) nameEl.value = storedName;
}

function teardownCloud() {
  cloudConnectToken++;
  stopHeartbeat();
  if (cloudSaveTimer) { clearTimeout(cloudSaveTimer); cloudSaveTimer = null; }
  if (remoteApplyTimer) { clearTimeout(remoteApplyTimer); remoteApplyTimer = null; }
  if (presenceRefreshTimer) { clearTimeout(presenceRefreshTimer); presenceRefreshTimer = null; }
  if (realtimeReconcileTimer) { clearTimeout(realtimeReconcileTimer); realtimeReconcileTimer = null; }
  pendingRemoteState = null;
  try { if (cloudChannel && supabaseClient) supabaseClient.removeChannel(cloudChannel); } catch (e) {}
  try { if (presenceChannel && supabaseClient) supabaseClient.removeChannel(presenceChannel); } catch (e) {}
  cloudChannel = null;
  presenceChannel = null;
  realtimeWasSubscribed = false;
  activeUsers = [];
  updatePresenceUI();
}

// ===== OROLOGIO LOGICO E PERCORSI =====

function compareStamps(a, b) {
  if (!Array.isArray(a)) return Array.isArray(b) ? -1 : 0;
  if (!Array.isArray(b)) return 1;
  if ((a[0] || 0) !== (b[0] || 0)) return (a[0] || 0) < (b[0] || 0) ? -1 : 1;
  if ((a[1] || 0) !== (b[1] || 0)) return (a[1] || 0) < (b[1] || 0) ? -1 : 1;
  const ac = a[2] || '';
  const bc = b[2] || '';
  return ac === bc ? 0 : (ac < bc ? -1 : 1);
}

function maxStamp(a, b) {
  return compareStamps(a, b) >= 0 ? a : b;
}

function observeStamp(stamp) {
  if (!Array.isArray(stamp)) return;
  const wall = Number(stamp[0]) || 0;
  const counter = Number(stamp[1]) || 0;
  if (wall > hlcWall) {
    hlcWall = wall;
    hlcCounter = counter;
  } else if (wall === hlcWall && counter > hlcCounter) {
    hlcCounter = counter;
  }
}

function observeMetaClocks(meta) {
  if (!meta) return;
  Object.keys(meta.clocks || {}).forEach(k => observeStamp(meta.clocks[k]));
  Object.keys(meta.tombs || {}).forEach(k => observeStamp(meta.tombs[k]));
}

function nextStamp() {
  const now = Date.now();
  if (now > hlcWall) {
    hlcWall = now;
    hlcCounter = 0;
  } else {
    hlcCounter++;
    if (hlcCounter > 999999) { hlcWall++; hlcCounter = 0; }
  }
  return [hlcWall, hlcCounter, CLOUD_USER_ID];
}

function isEntityArrayKey(key, value) {
  if (!CLOUD_ENTITY_KEYS.has(key)) return false;
  if (!Array.isArray(value)) return true;
  return value.every(isEntityRecord);
}

function pathKey(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

// Visita tutti i path sincronizzabili: entita' e foglie.
function walkSyncValue(value, path, key, visitor) {
  if (Array.isArray(value)) {
    if (isEntityArrayKey(key, value)) {
      value.forEach(entity => {
        if (!isEntityRecord(entity)) return;
        const entityPath = path + '/' + entity.id;
        visitor(entityPath, entity);
        Object.keys(entity).forEach(k => {
          if (k === 'id' || CLOUD_DERIVED_KEYS.has(k)) return;
          walkSyncValue(entity[k], entityPath + '/' + k, k, visitor);
        });
      });
      return;
    }
    visitor(path, value);
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (!keys.length) { visitor(path, value); return; }
    keys.forEach(k => {
      if (k === '__sync') return;
      if (path === '' && k === 'activePageIndex') return;
      if (CLOUD_DERIVED_KEYS.has(k)) return;
      walkSyncValue(value[k], path ? path + '/' + k : k, k, visitor);
    });
    return;
  }
  visitor(path, value);
}

function materializeMissingClocks(state, defaultStamp) {
  if (!state.__sync || typeof state.__sync !== 'object') {
    state.__sync = { v: CLOUD_SYNC_VERSION, clocks: {}, tombs: {} };
  }
  const meta = state.__sync;
  if (!meta.clocks) meta.clocks = {};
  if (!meta.tombs) meta.tombs = {};
  walkSyncValue(state, '', '', (path) => {
    if (path && !meta.clocks[path]) meta.clocks[path] = defaultStamp;
  });
  return meta;
}

function stampValue(value, path, key, stamp, clocks) {
  if (Array.isArray(value)) {
    if (isEntityArrayKey(key, value)) {
      value.forEach(entity => {
        if (!isEntityRecord(entity)) return;
        stampEntitySubtree(entity, path + '/' + entity.id, stamp, clocks);
      });
      return;
    }
    clocks[path] = stamp;
    return;
  }
  if (isPlainObject(value)) {
    Object.keys(value).forEach(k => {
      if (k === '__sync' || CLOUD_DERIVED_KEYS.has(k)) return;
      stampValue(value[k], path + '/' + k, k, stamp, clocks);
    });
    return;
  }
  clocks[path] = stamp;
}

function stampEntitySubtree(entity, entityPath, stamp, clocks) {
  clocks[entityPath] = stamp;
  Object.keys(entity).forEach(k => {
    if (k === 'id' || CLOUD_DERIVED_KEYS.has(k)) return;
    stampValue(entity[k], entityPath + '/' + k, k, stamp, clocks);
  });
}

// Diff tra due versioni dello stato: entita' aggiunte/rimosse e foglie cambiate.
function diffSyncValue(oldVal, newVal, path, key, ops) {
  const oldIsArray = Array.isArray(oldVal);
  const newIsArray = Array.isArray(newVal);
  const entityArray = (oldIsArray || newIsArray) &&
    isEntityArrayKey(key, oldIsArray ? oldVal : newVal);

  if (entityArray) {
    const oldList = oldIsArray ? oldVal.filter(isEntityRecord) : [];
    const newList = newIsArray ? newVal.filter(isEntityRecord) : [];
    const oldMap = new Map(oldList.map(e => [e.id, e]));
    const newMap = new Map(newList.map(e => [e.id, e]));

    oldMap.forEach((entity, id) => {
      if (!newMap.has(id)) ops.removals.push(path + '/' + id);
    });
    newMap.forEach((entity, id) => {
      const entityPath = path + '/' + id;
      if (!oldMap.has(id)) {
        ops.adds.push({ path: entityPath, value: safeClone(entity) });
        return;
      }
      const oldEntity = oldMap.get(id);
      const keys = new Set([...Object.keys(oldEntity), ...Object.keys(entity)]);
      keys.forEach(k => {
        if (k === 'id' || CLOUD_DERIVED_KEYS.has(k)) return;
        diffSyncValue(oldEntity[k], entity[k], entityPath + '/' + k, k, ops);
      });
    });
    return;
  }

  if (oldVal === undefined && newVal === undefined) return;
  if (isPlainObject(oldVal) && isPlainObject(newVal)) {
    const keys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
    keys.forEach(k => {
      if (CLOUD_DERIVED_KEYS.has(k)) return;
      diffSyncValue(oldVal[k], newVal[k], path + '/' + k, k, ops);
    });
    return;
  }
  if (stableStringify(oldVal) === stableStringify(newVal)) return;
  if (newVal === undefined) {
    ops.removals.push(path);
    return;
  }
  ops.changes.push({ path, value: safeClone(newVal) });
}

function captureLocalChanges() {
  if (!appState || !Array.isArray(appState.pages)) return 0;
  if (!appState.__sync || typeof appState.__sync !== 'object') {
    appState.__sync = { v: CLOUD_SYNC_VERSION, clocks: {}, tombs: {} };
  }
  const meta = appState.__sync;
  if (!meta.clocks) meta.clocks = {};
  if (!meta.tombs) meta.tombs = {};

  if (!syncShadow) {
    const stamp = [lastLocalChangeAt || Date.now(), 0, CLOUD_USER_ID];
    materializeMissingClocks(appState, stamp);
    observeMetaClocks(meta);
    syncShadow = safeClone(appState);
    return 0;
  }

  const ops = { adds: [], removals: [], changes: [] };
  const keys = new Set([...Object.keys(syncShadow), ...Object.keys(appState)]);
  keys.forEach(k => {
    if (k === '__sync' || k === 'activePageIndex') return;
    if (CLOUD_DERIVED_KEYS.has(k)) return;
    diffSyncValue(syncShadow[k], appState[k], k, k, ops);
  });

  let count = 0;
  ops.adds.forEach(({ path, value }) => {
    const stamp = nextStamp();
    delete meta.tombs[path];
    stampEntitySubtree(value, path, stamp, meta.clocks);
    count++;
  });
  ops.removals.forEach(path => {
    meta.tombs[path] = nextStamp();
    count++;
  });
  ops.changes.forEach(({ path }) => {
    delete meta.tombs[path];
    meta.clocks[path] = nextStamp();
    count++;
  });

  observeMetaClocks(meta);
  syncShadow = safeClone(appState);
  return count;
}

function prepareLocalStateAfterLoad() {
  if (!appState || !Array.isArray(appState.pages)) return;
  const hadMeta = !!appState.__sync;
  if (!appState.__sync) appState.__sync = { v: CLOUD_SYNC_VERSION, clocks: {}, tombs: {} };
  const meta = appState.__sync;
  const hasClocks = meta.clocks && Object.keys(meta.clocks).length > 0;
  const defaultStamp = (hadMeta && hasClocks)
    ? [0, 0, CLOUD_USER_ID]
    : [lastLocalChangeAt || Date.now(), 0, CLOUD_USER_ID];
  materializeMissingClocks(appState, defaultStamp);
  observeMetaClocks(meta);
  syncShadow = safeClone(appState);
}

function diagramForExport(state) {
  const copy = safeClone(state) || {};
  delete copy.__sync;
  return copy;
}

// ===== MERGE PER CAMPO =====

function prepareSyncStateForMerge(state, fallbackStamp, prefix) {
  const hadMeta = !!state.__sync;
  if (!state.__sync || typeof state.__sync !== 'object') {
    state.__sync = { v: CLOUD_SYNC_VERSION, clocks: {}, tombs: {} };
  }
  const meta = state.__sync;
  if (!meta.clocks) meta.clocks = {};
  if (!meta.tombs) meta.tombs = {};
  const hasClocks = Object.keys(meta.clocks).length > 0;
  const defaultStamp = (hadMeta && hasClocks) ? [0, 0, prefix] : fallbackStamp;
  materializeMissingClocks(state, defaultStamp);
  return { meta, defaultStamp };
}

function mergeClockMaps(a, b) {
  const out = {};
  if (a) Object.keys(a).forEach(k => { out[k] = a[k]; });
  if (b) Object.keys(b).forEach(k => { out[k] = out[k] ? maxStamp(out[k], b[k]) : b[k]; });
  return out;
}

function entityClockFromMeta(meta, entityPath, defaultStamp) {
  let stamp = meta.clocks[entityPath] || defaultStamp;
  const prefix = entityPath + '/';
  Object.keys(meta.clocks).forEach(k => {
    if (k.startsWith(prefix)) stamp = maxStamp(stamp, meta.clocks[k]);
  });
  return stamp;
}

function mergeDiagrams(localState, localUpdatedAt, remoteState, remoteUpdatedAt) {
  const localRaw = safeClone(localState);
  const remoteRaw = safeClone(remoteState);
  const local = safeClone(localState);
  const remote = safeClone(remoteState);

  const localFallback = [Date.parse(localUpdatedAt || '') || lastLocalChangeAt || Date.now(), 0, CLOUD_USER_ID];
  const remoteFallback = [Date.parse(remoteUpdatedAt || '') || 0, 0, 'remote'];
  const localPrepared = prepareSyncStateForMerge(local, localFallback, CLOUD_USER_ID);
  const remotePrepared = prepareSyncStateForMerge(remote, remoteFallback, 'remote');

  const localMeta = localPrepared.meta;
  const remoteMeta = remotePrepared.meta;
  const ctx = {
    localClocks: localMeta.clocks,
    remoteClocks: remoteMeta.clocks,
    localTombs: localMeta.tombs,
    remoteTombs: remoteMeta.tombs,
    localDefault: localPrepared.defaultStamp,
    remoteDefault: remotePrepared.defaultStamp,
    localClock(path) { return this.localClocks[path] || this.localDefault; },
    remoteClock(path) { return this.remoteClocks[path] || this.remoteDefault; },
    localEntityClock(path) { return entityClockFromMeta(localMeta, path, this.localDefault); },
    remoteEntityClock(path) { return entityClockFromMeta(remoteMeta, path, this.remoteDefault); }
  };

  const merged = mergeValue(local, remote, '', ctx);
  merged.__sync = {
    v: CLOUD_SYNC_VERSION,
    clocks: mergeClockMaps(localMeta.clocks, remoteMeta.clocks),
    tombs: mergeClockMaps(localMeta.tombs, remoteMeta.tombs)
  };

  return {
    state: merged,
    localChanged: syncComparable(merged) !== syncComparable(localRaw),
    remoteChanged: syncStorageComparable(merged) !== syncStorageComparable(remoteRaw)
  };
}

function mergeValue(localVal, remoteVal, path, ctx) {
  const hasLocal = localVal !== undefined;
  const hasRemote = remoteVal !== undefined;
  if (!hasLocal && !hasRemote) return SYNC_MISSING;

  const key = pathKey(path);

  if (CLOUD_ENTITY_KEYS.has(key)) {
    const localIsArray = Array.isArray(localVal);
    const remoteIsArray = Array.isArray(remoteVal);
    if ((!hasLocal || localIsArray) && (!hasRemote || remoteIsArray)) {
      return mergeEntityArray(localIsArray ? localVal : [], remoteIsArray ? remoteVal : [], path, ctx);
    }
  }

  if (!hasLocal) {
    const tomb = ctx.localTombs[path];
    if (tomb && compareStamps(tomb, ctx.remoteClock(path)) > 0) return SYNC_MISSING;
    return safeClone(remoteVal);
  }
  if (!hasRemote) {
    const tomb = ctx.remoteTombs[path];
    if (tomb && compareStamps(tomb, ctx.localClock(path)) > 0) return SYNC_MISSING;
    return safeClone(localVal);
  }

  if (isPlainObject(localVal) && isPlainObject(remoteVal)) {
    return mergeObject(localVal, remoteVal, path, ctx);
  }

  const localClock = ctx.localClock(path);
  const remoteClock = ctx.remoteClock(path);
  return compareStamps(localClock, remoteClock) >= 0 ? safeClone(localVal) : safeClone(remoteVal);
}

function mergeObject(localObj, remoteObj, path, ctx) {
  const out = {};
  const keys = new Set([...Object.keys(localObj), ...Object.keys(remoteObj)]);
  keys.forEach(k => {
    if (k === '__sync') return;
    if (path === '' && k === 'activePageIndex') {
      if (localObj[k] !== undefined) out[k] = localObj[k];
      else if (remoteObj[k] !== undefined) out[k] = remoteObj[k];
      return;
    }
    if (CLOUD_DERIVED_KEYS.has(k)) {
      if (localObj[k] !== undefined) out[k] = safeClone(localObj[k]);
      else if (remoteObj[k] !== undefined) out[k] = safeClone(remoteObj[k]);
      return;
    }
    const childPath = path ? path + '/' + k : k;
    const value = mergeValue(localObj[k], remoteObj[k], childPath, ctx);
    if (value !== SYNC_MISSING) out[k] = value;
  });
  return out;
}

function mergeEntityArray(localArr, remoteArr, path, ctx) {
  const localList = Array.isArray(localArr) ? localArr.filter(isEntityRecord) : [];
  const remoteList = Array.isArray(remoteArr) ? remoteArr.filter(isEntityRecord) : [];
  const localMap = new Map(localList.map(e => [e.id, e]));
  const remoteMap = new Map(remoteList.map(e => [e.id, e]));

  const order = [];
  const seen = new Set();
  localList.forEach(e => { if (!seen.has(e.id)) { seen.add(e.id); order.push(e.id); } });
  remoteList.forEach(e => { if (!seen.has(e.id)) { seen.add(e.id); order.push(e.id); } });

  const out = [];
  order.forEach(id => {
    const entityPath = path + '/' + id;
    const localEntity = localMap.get(id);
    const remoteEntity = remoteMap.get(id);

    if (localEntity && remoteEntity) {
      const merged = mergeValue(localEntity, remoteEntity, entityPath, ctx);
      if (merged !== SYNC_MISSING) out.push(merged);
      return;
    }
    if (localEntity) {
      const tomb = ctx.remoteTombs[entityPath];
      if (tomb && compareStamps(tomb, ctx.localEntityClock(entityPath)) > 0) return;
      out.push(safeClone(localEntity));
      return;
    }
    if (remoteEntity) {
      const tomb = ctx.localTombs[entityPath];
      if (tomb && compareStamps(tomb, ctx.remoteEntityClock(entityPath)) > 0) return;
      out.push(safeClone(remoteEntity));
    }
  });
  return out;
}

function stripDerivedForCompare(value) {
  if (Array.isArray(value)) return value.map(stripDerivedForCompare);
  if (isPlainObject(value)) {
    const out = {};
    Object.keys(value).sort().forEach(k => {
      if (k === '__sync' || CLOUD_DERIVED_KEYS.has(k)) return;
      out[k] = stripDerivedForCompare(value[k]);
    });
    return out;
  }
  return value;
}

function syncComparable(state) {
  const copy = stripDerivedForCompare(state);
  if (isPlainObject(copy)) delete copy.activePageIndex;
  return stableStringify(copy);
}

// Esposto per i test automatici del merge.
window.__cascadeMerge = mergeDiagrams;
window.__cascadeSyncMeta = () => appState && appState.__sync ? appState.__sync : null;

// ===== APPLICAZIONE DELLO STATO MERGIATO =====

function syncStorageComparable(state) {
  const copy = safeClone(state) || {};
  delete copy.activePageIndex;
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (isPlainObject(value)) {
      const out = {};
      Object.keys(value).sort().forEach(k => {
        if (CLOUD_DERIVED_KEYS.has(k)) return;
        out[k] = clean(value[k]);
      });
      return out;
    }
    return value;
  };
  return stableStringify(clean(copy));
}

function adoptLocalState(merged, options) {
  if (!merged || !Array.isArray(merged.pages) || merged.pages.length === 0) return false;
  const opts = options || {};
  const previousComparable = syncComparable(appState);
  appState = merged;

  if (!Number.isInteger(appState.activePageIndex) || appState.activePageIndex < 0 || appState.activePageIndex >= appState.pages.length) {
    appState.activePageIndex = 0;
  }
  if (!Array.isArray(appState.tableParamNames) || appState.tableParamNames.length < 5) {
    appState.tableParamNames = ['Parametro A', 'Parametro B', 'Parametro C', 'Parametro D', 'Parametro E'];
  }

  syncShadow = safeClone(appState);
  observeMetaClocks(appState.__sync);
  try {
    localStorage.setItem('cascade_diagram_app', JSON.stringify(appState));
    localStorage.setItem('cascade_local_updated_at', opts.updatedAt || new Date().toISOString());
  } catch (e) {}

  const changed = syncComparable(appState) !== previousComparable;
  if (changed) {
    renderTabs();
    renderDiagram();
  }
  if (opts.status) setSyncStatus('online', opts.status);
  if (opts.toast && changed) showToast('Diagramma aggiornato da un collaboratore', 'info');
  return changed;
}

// ===== CLOUD: CONNESSIONE E SCRITTURA =====

// Inizializzazione sincrona del client: nessun await qui dentro.
function initSupabase() {
  cloudGeneration++;
  cloudSyncQueued = false;
  teardownCloud();
  const urlEl = document.getElementById('html_supabase_url');
  const keyEl = document.getElementById('html_supabase_key');
  if ((!localStorage.getItem('supabase_url') || !localStorage.getItem('supabase_key')) && urlEl && keyEl && urlEl.value.trim() && keyEl.value.trim()) {
    localStorage.setItem('supabase_url', urlEl.value.trim().replace(/\/+$/, ''));
    localStorage.setItem('supabase_key', keyEl.value.trim());
  }
  const url = (localStorage.getItem('supabase_url') || '').trim().replace(/\/+$/, '');
  const key = (localStorage.getItem('supabase_key') || '').trim();
  prefillSupabaseBar();
  if (!url || !key) {
    supabaseClient = null;
    supabaseConfig = null;
    setSyncStatus('local', 'Locale');
    return false;
  }
  if (typeof window.supabase === 'undefined' || typeof window.supabase.createClient !== 'function') {
    supabaseClient = null;
    supabaseConfig = null;
    setSyncStatus('error', 'Libreria non caricata');
    console.error('Supabase JS non disponibile: controlla la connessione a Internet (CDN).');
    return false;
  }
  try {
    supabaseClient = window.supabase.createClient(url, key, {
      realtime: { params: { eventsPerSecond: 20 } }
    });
    supabaseConfig = { url, key };
    setSyncStatus('syncing', 'Connessione...');
    return true;
  } catch (e) {
    console.error('Creazione client Supabase fallita:', e);
    supabaseClient = null;
    supabaseConfig = null;
    setSyncStatus('error', 'Configurazione non valida');
    return false;
  }
}

function saveSupabaseFromHtml() {
  const urlEl = document.getElementById('html_supabase_url');
  const keyEl = document.getElementById('html_supabase_key');
  const nameEl = document.getElementById('html_display_name');
  const url = (urlEl ? urlEl.value : '').trim().replace(/\/+$/, '');
  const key = (keyEl ? keyEl.value : '').trim();
  const name = (nameEl ? nameEl.value : '').trim();
  if (!url || !key) {
    showToast('Inserisci Supabase URL e Anon Key', 'error');
    setSyncStatus('error', 'Credenziali mancanti');
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    showToast('URL non valido: deve iniziare con https://', 'error');
    return;
  }
  localStorage.setItem('supabase_url', url);
  localStorage.setItem('supabase_key', key);
  if (name) localStorage.setItem('user_display_name', name);
  if (initSupabase()) {
    connectCloud(true);
    showToast('Credenziali salvate. Connessione a Supabase...', 'info');
  } else {
    showToast('Impossibile inizializzare Supabase (libreria CDN non caricata?)', 'error');
  }
}

async function connectCloud(force) {
  if (!supabaseClient) return false;
  const token = ++cloudConnectToken;
  const generation = cloudGeneration;
  setSyncStatus('syncing', 'Connessione...');
  try {
    setupRealtime();
    setupPresence();
    const ok = await requestCloudSync(true);
    if (token !== cloudConnectToken || generation !== cloudGeneration) return false;
    if (!ok) throw new Error('Sincronizzazione iniziale non riuscita');
    await touchPresence();
    if (token !== cloudConnectToken || generation !== cloudGeneration) return false;
    startHeartbeat();
    await refreshActiveUsers();
    if (token !== cloudConnectToken || generation !== cloudGeneration) return false;
    setSyncStatus('online', 'Cloud connesso');
    return true;
  } catch (e) {
    if (token === cloudConnectToken && generation === cloudGeneration) {
      console.error('Connessione Cloud fallita:', e);
      setSyncStatus('error', 'Connessione fallita');
      showToast('Supabase: ' + (e && e.message ? e.message : e), 'error');
    }
    return false;
  }
}

async function insertCloudState(state) {
  const nowIso = new Date().toISOString();
  const { error } = await supabaseClient.from('diagrams').insert({
    id: CLOUD_DIAGRAM_ID,
    name: (getCurrentPage() && getCurrentPage().name) || CLOUD_DIAGRAM_NAME,
    state: state,
    updated_at: nowIso
  });
  if (error) {
    if (error.code === '23505') { cloudSyncQueued = true; return false; }
    throw error;
  }
  return true;
}

async function writeCloudStateCas(state, expectedUpdatedAt) {
  const nowIso = new Date().toISOString();
  let query = supabaseClient
    .from('diagrams')
    .update({
      name: (state.pages && state.pages[0] && state.pages[0].name) || CLOUD_DIAGRAM_NAME,
      state: state,
      updated_at: nowIso
    })
    .eq('id', CLOUD_DIAGRAM_ID);
  if (expectedUpdatedAt) query = query.eq('updated_at', expectedUpdatedAt);
  const { data, error } = await query.select('id,updated_at');
  if (error) throw error;
  return !!(data && data.length > 0);
}

async function cloudSyncOnce(force) {
  if (!supabaseClient || !supabaseConfig) return false;
  const generation = cloudGeneration;
  captureLocalChanges();

  const { data, error } = await supabaseClient
    .from('diagrams')
    .select('state,updated_at')
    .eq('id', CLOUD_DIAGRAM_ID)
    .maybeSingle();
  if (generation !== cloudGeneration) return false;
  if (error) throw error;

  if (!data) {
    const ok = await insertCloudState(appState);
    if (generation !== cloudGeneration) return false;
    if (!ok) return false;
    localDocWasBlank = false;
    setSyncStatus('online', 'Salvato');
    return true;
  }

  const remoteState = data.state;
  const remoteUpdatedAt = data.updated_at;

  if (!isValidDiagramState(remoteState)) {
    const ok = await writeCloudStateCas(appState, remoteUpdatedAt);
    if (generation !== cloudGeneration) return false;
    if (!ok) { cloudSyncQueued = true; return false; }
    localDocWasBlank = false;
    setSyncStatus('online', 'Salvato');
    return true;
  }

  // Un client appena aperto non ha un documento proprio: adotta quello remoto.
  if (localDocWasBlank) {
    const remoteCopy = safeClone(remoteState);
    prepareSyncStateForMerge(remoteCopy, [Date.parse(remoteUpdatedAt || '') || 0, 0, 'remote'], 'remote');
    adoptLocalState(remoteCopy, { updatedAt: remoteUpdatedAt, status: 'Aggiornato' });
    localDocWasBlank = false;
    if (syncStorageComparable(remoteCopy) !== syncStorageComparable(remoteState)) {
      const ok = await writeCloudStateCas(remoteCopy, remoteUpdatedAt);
      if (generation !== cloudGeneration) return false;
      if (!ok) { cloudSyncQueued = true; return false; }
    }
    setSyncStatus('online', 'Cloud connesso');
    return true;
  }

  const result = mergeDiagrams(appState, lastLocalChangeAt, remoteState, remoteUpdatedAt);
  if (generation !== cloudGeneration) return false;

  const changed = adoptLocalState(result.state, { updatedAt: remoteUpdatedAt });
  const remoteNeedsWrite = syncStorageComparable(result.state) !== syncStorageComparable(remoteState);

  if (remoteNeedsWrite) {
    const ok = await writeCloudStateCas(result.state, remoteUpdatedAt);
    if (generation !== cloudGeneration) return false;
    if (!ok) { cloudSyncQueued = true; return false; }
    setSyncStatus('online', 'Salvato');
    return true;
  }

  setSyncStatus('online', changed ? 'Aggiornato' : (force ? 'Cloud connesso' : 'Salvato'));
  return true;
}

let cloudSyncPromise = null;

function requestCloudSync(force) {
  if (!supabaseClient) return Promise.resolve(false);
  if (cloudSyncPromise) {
    cloudSyncQueued = true;
    return cloudSyncPromise;
  }
  cloudSyncPromise = (async () => {
    cloudSyncRunning = true;
    let ok = true;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        cloudSyncQueued = false;
        ok = await cloudSyncOnce(force && attempt === 0);
        if (!cloudSyncQueued) break;
      }
      return ok;
    } finally {
      cloudSyncRunning = false;
      cloudSyncPromise = null;
      const queued = cloudSyncQueued;
      cloudSyncQueued = false;
      if (queued && supabaseClient) setTimeout(() => requestCloudSync(false), 80);
    }
  })();
  return cloudSyncPromise;
}

async function pushCloudState(force) {
  return requestCloudSync(!!force);
}

function scheduleCloudSave() {
  if (!supabaseClient || isApplyingRemote) return;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => {
    cloudSaveTimer = null;
    requestCloudSync(false);
  }, 450);
}

function receiveRemoteState(state, updatedAt, silent) {
  if (!isValidDiagramState(state)) return false;
  if (!supabaseClient) return false;
  captureLocalChanges();
  const result = mergeDiagrams(appState, lastLocalChangeAt, state, updatedAt);
  const changed = adoptLocalState(result.state, {
    updatedAt: updatedAt,
    status: result.localChanged ? 'Aggiornato' : null,
    toast: !silent
  });
  if (result.localChanged) setSyncStatus('online', 'Aggiornato');
  if (result.remoteChanged && !cloudSyncRunning && !cloudSaveTimer) {
    scheduleCloudSave();
  }
  return changed;
}

function queueRemoteState(state, updatedAt) {
  if (!isValidDiagramState(state)) return;
  pendingRemoteState = { state, updatedAt };
  if (remoteApplyTimer) clearTimeout(remoteApplyTimer);
  remoteApplyTimer = setTimeout(() => {
    remoteApplyTimer = null;
    const pending = pendingRemoteState;
    pendingRemoteState = null;
    if (pending) receiveRemoteState(pending.state, pending.updatedAt, false);
  }, 120);
}

function applyRemoteState(state, updatedAt, force, silent) {
  return receiveRemoteState(state, updatedAt, silent);
}

function setupRealtime() {
  if (!supabaseClient) return;
  try { if (cloudChannel) supabaseClient.removeChannel(cloudChannel); } catch (e) {}
  cloudChannel = supabaseClient
    .channel('diagram-doc-' + CLOUD_USER_ID)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'diagrams', filter: 'id=eq.' + CLOUD_DIAGRAM_ID },
      (payload) => {
        const row = payload && payload.new;
        if (row && row.id === CLOUD_DIAGRAM_ID && row.state) queueRemoteState(row.state, row.updated_at);
      })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setSyncStatus('online', 'Realtime attivo');
        if (realtimeWasSubscribed && supabaseClient) {
          if (realtimeReconcileTimer) clearTimeout(realtimeReconcileTimer);
          realtimeReconcileTimer = setTimeout(() => {
            realtimeReconcileTimer = null;
            if (supabaseClient) requestCloudSync(false);
          }, 500);
        }
        realtimeWasSubscribed = true;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setSyncStatus('error', 'Realtime non disponibile');
      }
    });
}

// ===== PRESENZA =====

function setupPresence() {
  if (!supabaseClient) return;
  try { if (presenceChannel) supabaseClient.removeChannel(presenceChannel); } catch (e) {}
  presenceChannel = supabaseClient
    .channel('active-users-' + CLOUD_USER_ID)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'active_users' }, () => {
      if (presenceRefreshTimer) clearTimeout(presenceRefreshTimer);
      presenceRefreshTimer = setTimeout(() => {
        presenceRefreshTimer = null;
        refreshActiveUsers();
      }, 300);
    })
    .subscribe();
}

async function touchPresence() {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient.from('active_users').upsert({
      user_id: CLOUD_USER_ID,
      display_name: getDisplayName(),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });
    if (error) console.warn('Presenza non aggiornata:', error.message);
  } catch (e) {
    console.warn('Presenza non aggiornata:', e);
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    touchPresence();
    refreshActiveUsers();
  }, CLOUD_HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function refreshActiveUsers() {
  if (!supabaseClient) {
    activeUsers = [];
    updatePresenceUI();
    return;
  }
  try {
    const { data, error } = await supabaseClient
      .from('active_users')
      .select('user_id,display_name,updated_at')
      .order('updated_at', { ascending: false });
    if (error) {
      console.warn('Lettura collaboratori fallita:', error.message);
      return;
    }
    const cutoff = Date.now() - CLOUD_ACTIVE_WINDOW_MS;
    activeUsers = (data || []).filter(u => {
      const t = new Date(u.updated_at).getTime();
      return !Number.isFinite(t) || t >= cutoff;
    });
    if (!activeUsers.some(u => u.user_id === CLOUD_USER_ID)) {
      activeUsers.push({ user_id: CLOUD_USER_ID, display_name: getDisplayName(), updated_at: new Date().toISOString() });
    }
    updatePresenceUI();
  } catch (e) {
    console.warn('Lettura collaboratori fallita:', e);
  }
}

function updatePresenceUI() {
  const indicator = document.getElementById('presenceIndicator');
  const countEl = document.getElementById('activeUsersCount');
  if (!indicator) return;
  if (!supabaseClient) {
    indicator.classList.add('hidden');
    return;
  }
  const count = activeUsers.length;
  if (countEl) countEl.textContent = String(count);
  indicator.classList.toggle('hidden', count === 0);
  indicator.title = count
    ? 'Collaboratori attivi: ' + activeUsers.map(u => u.display_name || u.user_id).join(', ')
    : 'Nessun collaboratore attivo';
}

function leavePresence() {
  if (!supabaseConfig) return;
  const endpoint = supabaseConfig.url + '/rest/v1/active_users?user_id=eq.' + encodeURIComponent(CLOUD_USER_ID);
  try {
    fetch(endpoint, {
      method: 'DELETE',
      keepalive: true,
      headers: {
        'apikey': supabaseConfig.key,
        'Authorization': 'Bearer ' + supabaseConfig.key
      }
    }).catch(() => {});
  } catch (e) {}
  try {
    if (supabaseClient) supabaseClient.from('active_users').delete().eq('user_id', CLOUD_USER_ID).then(() => {}).catch(() => {});
  } catch (e) {}
}

async function testConnection() {
  if (!supabaseClient && !initSupabase()) {
    showToast('Inserisci URL e Anon Key, poi premi Salva', 'info');
    return { error: 'Supabase non configurato' };
  }
  setSyncStatus('syncing', 'Test...');
  try {
    const { error: diagramsError } = await supabaseClient.from('diagrams').select('id').limit(1);
    if (diagramsError) throw diagramsError;
    const { error: usersError } = await supabaseClient.from('active_users').select('user_id').limit(1);
    if (usersError) throw usersError;
    setSyncStatus('online', 'Test OK');
    showToast('Connessione Supabase OK: tabelle raggiungibili', 'success');
    await connectCloud(true);
    return { ok: true };
  } catch (e) {
    console.error('Test Supabase fallito:', e);
    setSyncStatus('error', 'Test fallito');
    showToast('Supabase: ' + (e && e.message ? e.message : e), 'error');
    return { error: e && e.message ? e.message : String(e) };
  }
}
window.testSupabaseConnection = testConnection;

async function syncNow() {
  if (!supabaseClient) {
    showToast('Supabase non configurato: inserisci URL e Anon Key', 'info');
    return false;
  }
  setSyncStatus('syncing', 'Sincronizzazione...');
  const ok = await requestCloudSync(true);
  showToast(ok ? 'Sincronizzato con il Cloud' : 'Errore di sincronizzazione', ok ? 'success' : 'error');
  return ok;
}

// ===== STATE =====
let appState = {
  activePageIndex: 0,
  pages: [],
  tableParamNames: ["Parametro A","Parametro B","Parametro C","Parametro D","Parametro E"]
};
let fileHandle = null;
let activeHoverPath = [];

// ===== UTIL =====
const uid = (p='id') => p + '_' + Math.random().toString(36).substring(2,9);
const escapeHtml = s => !s ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
const getGlobalNames = () => { if(!appState.tableParamNames||appState.tableParamNames.length<5) appState.tableParamNames=["Parametro A","Parametro B","Parametro C","Parametro D","Parametro E"]; return appState.tableParamNames; };
const createDefaultTableValues = () => getGlobalNames().map(n=>({name:n,value:''}));
const getCurrentPage = () => appState.pages[appState.activePageIndex] || appState.pages[0];
const buildBoxIndex = pg => { const map=new Map(); if(!pg || !Array.isArray(pg.phases)) return map; pg.phases.forEach((ph,pi)=>(ph.levels||[]).forEach((lv,li)=>(lv.boxes||[]).forEach(b=>map.set(b.id,{box:b,phase:ph,phaseIdx:pi,level:lv,levelIdx:li})))); return map; };
const partScore = c => c.failed ? 0 : (Number(c.score)||0);
const saveAppState = () => {
  lastLocalChangeAt = Date.now();
  const changed = captureLocalChanges();
  if (changed > 0) localDocWasBlank = false;
  localStorage.setItem('cascade_local_updated_at', new Date(lastLocalChangeAt).toISOString());
  localStorage.setItem('cascade_diagram_app', JSON.stringify(appState));
  scheduleCloudSave();
};
const showToast = (msg,type='info') => { const t=document.getElementById('toast'); t.textContent=msg; t.className=type; t.classList.remove('hidden'); setTimeout(()=>{t.style.animation='slideOut .3s ease';setTimeout(()=>t.classList.add('hidden'),300)},2500); };

// ===== LOCALSTORAGE INIT =====
function initAppState(){
  const saved = localStorage.getItem('cascade_diagram_app');
  if(saved){
    try{ appState=JSON.parse(saved); if(!Array.isArray(appState.pages)||!appState.pages.length) throw new Error('stato locale non valido'); if(appState.activePageIndex>=appState.pages.length) appState.activePageIndex=0; localDocWasBlank=false; prepareLocalStateAfterLoad(); renderTabs(); renderDiagram(); return; }
    catch(e){ console.error(e); }
  }
  localDocWasBlank = true;
  appState = { activePageIndex:0, pages:[ createDefaultPage('Diagramma Principale') ] };
  prepareLocalStateAfterLoad();
  // Se c'è Supabase, non scrivere subito il default su localStorage: connectCloud adottera'
  // lo stato remoto (se esiste) o scrivera' il locale sul cloud. Scriviamo default solo
  // se non c'è cloud, per non perdere nulla in assenza di connessione.
  if (!supabaseClient) {
    saveAppState();
  }
  renderTabs(); renderDiagram();
}
function createDefaultPage(name){
  const p0=uid('box'), p1a=uid('box'), p1b=uid('box'), c1=uid('conn'), c2=uid('conn');
  return {
    id:uid('page'), name:name,
    connections:[
      {id:c1,srcBoxId:p0,srcSpaceIndex:0,targetBoxId:p1a,file:'variante_alpha.py',priority:'p1',score:95,notes:'Strada principale',disconnected:false,tableValues:createDefaultTableValues(),_multiIndex:0},
      {id:c2,srcBoxId:p0,srcSpaceIndex:0,targetBoxId:p1b,file:'variante_beta.py',priority:'p1',score:70,notes:'Strada secondaria',disconnected:false,tableValues:createDefaultTableValues(),_multiIndex:1}
    ],
    phases:[
      {id:uid('phase'),name:'Fase 0 (Partenza)',color:'#ff0000',status:'done',levels:[{id:uid('level'),name:'Zona 1',boxes:[{id:p0,title:'Radice Iniziale A0',priority:'p1'}]}]},
      {id:uid('phase'),name:'Fase 1',color:'#00ff00',status:'todo',levels:[{id:uid('level'),name:'Zona 1',boxes:[{id:p1a,title:'Modifica Alpha',priority:'p1'},{id:p1b,title:'Modifica Beta',priority:'p2'}]}]}
    ]
  };
}

// ===== TABS =====
function renderTabs(){
  const bar=document.getElementById('tabsBar'); bar.innerHTML='';
  appState.pages.forEach((pg,i)=>{
    const act=i===appState.activePageIndex;
    const btn=document.createElement('button');
    btn.className='tab'+(act?' active':'');
    btn.innerHTML=`<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>${escapeHtml(pg.name)}</span>`;
    btn.onclick=()=>switchPage(i);
    bar.appendChild(btn);
  });
}
function switchPage(i){ if(i>=0&&i<appState.pages.length){ appState.activePageIndex=i; saveAppState(); renderTabs(); renderDiagram(); } }
function addNewPage(){ const n=appState.pages.length; const dn='Diagramma '+(n+1); const pn=prompt('Nome nuova pagina:',dn); const fn=(pn&&pn.trim())?pn.trim():dn; appState.pages.push(createDefaultPage(fn)); appState.activePageIndex=n; saveAppState(); renderTabs(); renderDiagram(); }
function renameCurrentPage(){ const pg=getCurrentPage(); const nn=prompt('Nuovo nome:',pg.name); if(nn&&nn.trim()){ pg.name=nn.trim(); saveAppState(); renderTabs(); } }
function deleteCurrentPage(){ if(appState.pages.length<=1){ alert('Almeno una pagina necessaria'); return } if(confirm('Eliminare "'+getCurrentPage().name+'"?')){ appState.pages.splice(appState.activePageIndex,1); if(appState.activePageIndex>=appState.pages.length) appState.activePageIndex=appState.pages.length-1; saveAppState(); renderTabs(); renderDiagram(); } }

// ===== AUTO CONNECTIONS =====
// Una modifica (box) che non ha nessuna strada che arriva dentro da sinistra
// (da una modifica della zona/livello precedente) non deve esistere.
// Fase 0 (radice) è esente. Rimuove ricorsivamente le box orfane a valle.
function pruneOrphanBoxes(pg){
  const phase0 = pg.phases[0];
  const rootBoxIds = new Set();
  if(phase0 && Array.isArray(phase0.levels)){
    phase0.levels.forEach(lv => (lv.boxes||[]).forEach(b => rootBoxIds.add(b.id)));
  }
  
  let changed = true;
  while(changed){
    changed = false;
    const incoming = {};
    pg.connections.forEach(c => {
      if(!c.disconnected){
        incoming[c.targetBoxId] = (incoming[c.targetBoxId] || 0) + 1;
      }
    });
    for(let pi = 1; pi < pg.phases.length; pi++){
      const ph = pg.phases[pi];
      if(!Array.isArray(ph.levels)) continue;
      for(let li = 0; li < ph.levels.length; li++){
        const lv = ph.levels[li];
        if(!Array.isArray(lv.boxes)) continue;
        for(let bi = lv.boxes.length - 1; bi >= 0; bi--){
          const b = lv.boxes[bi];
          if(rootBoxIds.has(b.id)) continue;
          if(!incoming[b.id]){
            pg.connections = pg.connections.filter(c => c.srcBoxId !== b.id && c.targetBoxId !== b.id);
            lv.boxes.splice(bi, 1);
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

// Una strada non puo' saltare zone o fasi: solo zona N -> N+1, e solo
// l'ultima zona di una fase -> la prima zona della fase successiva.
function isValidLevelStep(pg, index, c){
  const srcInfo=index.get(c.srcBoxId);
  const tgtInfo=index.get(c.targetBoxId);
  if(!srcInfo || !tgtInfo) return false;
  const srcPhaseIdx=srcInfo.phaseIdx, srcLevelIdx=srcInfo.levelIdx;
  const tgtPhaseIdx=tgtInfo.phaseIdx, tgtLevelIdx=tgtInfo.levelIdx;
  if(tgtPhaseIdx === 0) return false;
  if(srcPhaseIdx === tgtPhaseIdx){
    if(tgtLevelIdx !== srcLevelIdx + 1) return false;
  } else {
    if(tgtPhaseIdx !== srcPhaseIdx + 1 || srcLevelIdx !== pg.phases[srcPhaseIdx].levels.length - 1 || tgtLevelIdx !== 0) return false;
  }
  return true;
}

// REGOLA: il numero di parti di una modifica deve essere sempre uguale al
// numero di parti non fallite del livello precedente.
// Le due cifre cambiano insieme: qui si aggiungono le strade mancanti (una
// per ogni uscita valida del livello precedente) e se ne rimuovono quelle che
// non hanno piu' un'uscita valida alla sinistra (parte sorgente fallita o
// disconnessa). Restituisce true se ha cambiato qualcosa.
function syncPartsWithPreviousLevel(pg){
  let changed=false;
  const boxById=new Map();
  pg.phases.forEach(ph=>ph.levels.forEach(lv=>lv.boxes.forEach(b=>boxById.set(b.id,b))));

  reindexAllBoxParts(pg);

  // 1) via le strade senza un'uscita valida a sinistra o verso modifica inesistenti
  const n0=pg.connections.length;
  pg.connections=pg.connections.filter(c=>{
    if(!boxById.has(c.srcBoxId) || !boxById.has(c.targetBoxId)) return false;
    return outletIndexes(pg, c.srcBoxId).includes(c.srcSpaceIndex||0);
  });
  if(pg.connections.length!==n0) changed=true;

  // 2) una strada per ogni uscita valida di ogni modifica del livello precedente
  pg.phases.forEach((ph,pi)=>{
    if(pi===0) return;
    ph.levels.forEach((lv,li)=>{
      const prev = li>0 ? ph.levels[li-1]
        : (pg.phases[pi-1] && pg.phases[pi-1].levels[pg.phases[pi-1].levels.length-1]) || null;
      if(!prev || !prev.boxes.length) return;
      const n1=pg.connections.length;
      lv.boxes.forEach(b=>connectLevelToBox(pg, prev, b, true));
      if(pg.connections.length!==n1) changed=true;
    });
  });
  return changed;
}

function ensureAutomaticCombinations(){
  const pg=getCurrentPage(); if(!pg.connections) pg.connections=[];

  const countBoxes=()=>pg.phases.reduce((n,ph)=>n+ph.levels.reduce((m,lv)=>m+lv.boxes.length,0),0);

  // CICLO DI STABILITA': riallinea parti e livello precedente, elimina le
  // modifica senza nessuna strada in ingresso e ripeti finche' un giro non
  // produce piu' alcun cambiamento.
  let changed=false, guard=0, index=buildBoxIndex(pg);
  while(guard++<50){
    let iterChanged=false;

    const nC=pg.connections.length;
    pg.connections=pg.connections.filter(c=>index.has(c.srcBoxId) && index.has(c.targetBoxId));
    pg.connections=pg.connections.filter(c=>isValidLevelStep(pg,index,c));
    if(pg.connections.length!==nC) iterChanged=true;

    if(syncPartsWithPreviousLevel(pg)) iterChanged=true;
    if(pruneOrphanBoxes(pg)) iterChanged=true;

    index=buildBoxIndex(pg);
    if(!iterChanged) break;
    changed=true;
  }
  if(changed) saveAppState();

  // Normalizza l'indice di ogni parte all'interno della sua modifica (0..n-1)
  reindexAllBoxParts(pg);
  renameAllPartFiles(pg);
}
function findBoxTitle(id){ for(const ph of getCurrentPage().phases) for(const lv of ph.levels){ const b=lv.boxes.find(x=>x.id===id); if(b) return b.title; } return 'Sconosciuto'; }

// ===== PHASE/LEVEL/BOX CRUD =====
function addNewPhase(){ const pg=getCurrentPage(); const colors=['#ff0000','#ff7f00','#ffff00','#00ff00','#0000ff','#4b0082','#9400d3']; const newPhaseId=uid('phase'); pg.phases.push({id:newPhaseId,name:'Fase '+pg.phases.length,color:colors[pg.phases.length%colors.length],status:'todo',levels:[]}); saveAppState(); renderTabs(); renderDiagram(); }
function addLevelToPhase(pid){ const pg=getCurrentPage(); const p=pg.phases.find(x=>x.id===pid); const phaseIdx=pg.phases.indexOf(p); if(!p||phaseIdx===0){ alert('Fase 0 ha 1 sola zona'); return } if(phaseIdx < pg.phases.length-1){ alert('Puoi aggiungere zone solo all\'ultima fase'); return } const n=p.levels.length+1; const newLevel={id:uid('level'),name:'Zona '+n,boxes:[]}; p.levels.push(newLevel); saveAppState(); renderDiagram(); }
function createBidirectionalConnectionsForLevel(pg, phase, newLevel){
  if(!pg.connections) pg.connections=[];
  const li=phase.levels.indexOf(newLevel);
  if(li>0) newLevel.boxes.forEach(nb=>connectLevelToBox(pg, phase.levels[li-1], nb));
  if(li<phase.levels.length-1) newLevel.boxes.forEach(nb=>connectBoxToLevel(pg, nb, phase.levels[li+1]));
}
function addBoxToLevel(pid,lid){ const pg=getCurrentPage(); const p=pg.phases.find(x=>x.id===pid); const phaseIdx=pg.phases.indexOf(p); if(!p||phaseIdx===0){ alert('Fase 0 ha 1 sola modifica'); return } const lv=p.levels.find(x=>x.id===lid); if(!lv) return; const li=p.levels.indexOf(lv); let prevBoxes=[]; if(li>0) prevBoxes=p.levels[li-1].boxes; else { const pp=pg.phases[phaseIdx-1]; if(pp&&pp.levels.length) prevBoxes=pp.levels[pp.levels.length-1].boxes; } if(prevBoxes.length===0){ alert('Impossibile creare la modifica: la zona precedente non ha modifiche, quindi non esisterebbero parti da collegare.'); return } const n=lv.boxes.length+1; const newBox={id:uid('box'),title:'Nodo #'+n,priority:'p1'}; lv.boxes.push(newBox); createBidirectionalConnectionsWithinPhase(pg, p, lv, newBox); if(li===0) createConnectionsFromPreviousPhases(pg, newBox.id); connectBoxToNextPhase(pg, p, lv, newBox); ensureAutomaticCombinations(); showToast('Modifica creata con '+pg.connections.filter(c=>c.targetBoxId===newBox.id&&!c.disconnected).length+' parti','success'); saveAppState(); renderDiagram(); }
// Numero di parti attivi (strade in entrata) di una modifica
// Una modifica fallita non produce parti: le sue uscite non contano
function failedBoxIds(pg){
  const s=new Set();
  pg.phases.forEach(ph=>ph.levels.forEach(lv=>lv.boxes.forEach(b=>{ if((b.priority||'p1')==='failed') s.add(b.id); })));
  return s;
}
function isRootBox(pg, boxId){
  const root=pg.phases[0];
  return !!(root && root.levels.some(l=>l.boxes.some(b=>b.id===boxId)));
}
function boxSpaceCount(pg, boxId){
  const failed=failedBoxIds(pg);
  return pg.connections.filter(c=>c.targetBoxId===boxId && !c.disconnected && !failed.has(c.srcBoxId)).length;
}

// Parti della modifica nell'ordine visualizzato (indice = uscita)
function boxSpaces(pg, boxId){
  return pg.connections.filter(c=>c.targetBoxId===boxId && !c.disconnected)
    .sort((a,b)=>(a._multiIndex||0)-(b._multiIndex||0));
}
// Ogni parte è un'uscita verso la zona successiva; una modifica radice vale 1 uscita
function outletIndexes(pg, boxId){
  const spaces=boxSpaces(pg, boxId);
  if(!spaces.length) return isRootBox(pg, boxId) ? [0] : [];
  const failed=failedBoxIds(pg);
  const idx=[];
  spaces.forEach((c,i)=>{ if(!c.failed && !c.disconnected && !failed.has(c.srcBoxId)) idx.push(i); });
  return idx;
}
function boxOutletCount(pg, boxId){
  return outletIndexes(pg, boxId).length;
}
function autoRoadFileName(srcBox, tgtBox){
  const slug=s=>String(s||'nodo').toLowerCase().trim().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')||'nodo';
  return 'auto_'+slug(srcBox.title)+'_to_'+slug(tgtBox.title)+'.py';
}
// Lettera progressiva della parte nella zona: 0->a, 1->b, ... 26->aa
function partLetter(i){
  let s='', n=Math.max(0, i|0);
  do { s=String.fromCharCode(97+(n%26))+s; n=Math.floor(n/26)-1; } while(n>=0);
  return s;
}
// Nome file gerarchico: Macchina_zonaParte.zonaParte_zonaParte
// Es: Macchina A_1b.2d_1c (1/2 = zona nella fase, a/b/c = ordine della parte nella zona)
function renameAllPartFiles(pg){
  const partsByBox=new Map();
  pg.connections.forEach(c=>{
    let arr=partsByBox.get(c.targetBoxId);
    if(!arr){ arr=[]; partsByBox.set(c.targetBoxId,arr); }
    arr.push(c);
  });
  partsByBox.forEach(arr=>arr.sort((a,b)=>(a._multiIndex||0)-(b._multiIndex||0)));
  const boxIndex=buildBoxIndex(pg);

  // Ordine della parte all'interno della sua zona (la zona e il livello della fase)
  const ordinal=new Map();
  pg.phases.forEach(ph=>ph.levels.forEach(lv=>{
    const parts=[];
    lv.boxes.forEach(b=>{
      (partsByBox.get(b.id)||[]).forEach(c=>{ if(!c.disconnected) parts.push(c); });
    });
    parts.forEach((c,i)=>ordinal.set(c.id,i));
  }));

  // Risale la catena delle parti fino alla macchina di Fase 0 (memo per parte)
  const memo=new Map();
  const pathOf=conn=>{
    if(memo.has(conn.id)) return memo.get(conn.id);
    const tInfo=boxIndex.get(conn.targetBoxId);
    if(!tInfo){ const empty={root:'Macchina', blocks:[]}; memo.set(conn.id,empty); return empty; }
    const srcParts=partsByBox.get(conn.srcBoxId)||[];
    let base;
    if(srcParts.length){
      base=pathOf(srcParts[(conn.srcSpaceIndex||0)%srcParts.length]);
    } else {
      const sInfo=boxIndex.get(conn.srcBoxId);
      base={root:sInfo?sInfo.box.title:'Macchina', blocks:[]};
    }
    const seg=(tInfo.levelIdx+1)+partLetter(ordinal.get(conn.id)||0);
    const blocks=base.blocks.map(b=>({phaseIdx:b.phaseIdx, segs:b.segs.slice()}));
    const last=blocks[blocks.length-1];
    if(last && last.phaseIdx===tInfo.phaseIdx) last.segs.push(seg);
    else blocks.push({phaseIdx:tInfo.phaseIdx, segs:[seg]});
    const res={root:base.root, blocks};
    memo.set(conn.id,res);
    return res;
  };

  pg.connections.forEach(c=>{
    const p=pathOf(c);
    const tail=p.blocks.map(b=>b.segs.join('.')).filter(Boolean).join('_');
    c.file=tail ? p.root+'_'+tail : p.root;
  });
}
// Collega OGNI parte della zona precedente a una parte della modifica di destinazione
function connectLevelToBox(pg, prevLevel, targetBox, onlyMissing){
  if(!prevLevel || !targetBox) return;
  prevLevel.boxes.forEach(srcBox=>{
    if((srcBox.priority||'p1')==='failed') return;
    outletIndexes(pg, srcBox.id).forEach(outlet=>{
      const existing=pg.connections.find(c=>c.srcBoxId===srcBox.id && (c.srcSpaceIndex||0)===outlet && c.targetBoxId===targetBox.id);
      if(existing){ if(!onlyMissing) existing.disconnected=false; return; }
      pg.connections.push({
        id:uid('conn'), srcBoxId:srcBox.id, srcSpaceIndex:outlet, targetBoxId:targetBox.id,
        file:autoRoadFileName(srcBox,targetBox), priority:srcBox.priority||'p1',
        score:50, notes:'', disconnected:false,
        tableValues:createDefaultTableValues(),
        _multiIndex:boxSpaceCount(pg,targetBox.id)
      });
    });
  });
}
// Il modifica alimenta ogni parte delle modifiche della zona successiva
function connectBoxToLevel(pg, srcBox, nextLevel){
  if(!srcBox || !nextLevel) return;
  const outlets=outletIndexes(pg, srcBox.id);
  nextLevel.boxes.forEach(tgtBox=>{
    outlets.forEach(outlet=>{
      const existing=pg.connections.find(c=>c.srcBoxId===srcBox.id && (c.srcSpaceIndex||0)===outlet && c.targetBoxId===tgtBox.id);
      if(existing){ existing.disconnected=false; return; }
      pg.connections.push({
        id:uid('conn'), srcBoxId:srcBox.id, srcSpaceIndex:outlet, targetBoxId:tgtBox.id,
        file:autoRoadFileName(srcBox,tgtBox), priority:srcBox.priority||'p1',
        score:50, notes:'', disconnected:false,
        tableValues:createDefaultTableValues(),
        _multiIndex:boxSpaceCount(pg,tgtBox.id)
      });
    });
  });
}
function createBidirectionalConnectionsWithinPhase(pg, phase, level, newBox){
  if(!pg.connections) pg.connections=[];
  const li=phase.levels.indexOf(level);
  if(li>0) connectLevelToBox(pg, phase.levels[li-1], newBox);
  if(li<phase.levels.length-1) connectBoxToLevel(pg, newBox, phase.levels[li+1]);
}
// Una modifica aggiunta nell'ultima zona di una fase alimenta la fase successiva
function connectBoxToNextPhase(pg, phase, level, box){
  const pi=pg.phases.indexOf(phase);
  const li=phase.levels.indexOf(level);
  if(pi<0 || li!==phase.levels.length-1) return;
  const next=pg.phases[pi+1];
  if(!next || !next.levels.length) return;
  connectBoxToLevel(pg, box, next.levels[0]);
}
function createConnectionsFromPreviousPhases(pg, targetBoxId){
  // Solo il primo zona di una fase riceve strade dalla fase precedente:
  // altrimenti la strada salterebbe i zone intermedi della fase.
  let targetLevelIdx=-1, tgtPhaseIdx=-1, tgtBox=null;
  for(let pi=0; pi<pg.phases.length; pi++){
    for(let li=0; li<pg.phases[pi].levels.length; li++){
      const found=pg.phases[pi].levels[li].boxes.find(b=>b.id===targetBoxId);
      if(found){ targetLevelIdx=li; tgtPhaseIdx=pi; tgtBox=found; break; }
    }
    if(tgtBox) break;
  }
  if(!tgtBox || targetLevelIdx!==0 || tgtPhaseIdx<=0) return;
  const prevPhase=pg.phases[tgtPhaseIdx-1];
  if(!prevPhase || !prevPhase.levels.length) return;
  connectLevelToBox(pg, prevPhase.levels[prevPhase.levels.length-1], tgtBox);
}
function deleteBox(bid){ const pg=getCurrentPage(); for(let pi=1;pi<pg.phases.length;pi++){ const ph=pg.phases[pi]; for(const lv of ph.levels){ const i=lv.boxes.findIndex(b=>b.id===bid); if(i!==-1){ lv.boxes.splice(i,1); pg.connections=pg.connections.filter(c=>c.srcBoxId!==bid&&c.targetBoxId!==bid); pruneAndRebuild(pg); saveAppState(); renderDiagram(); return } } } }
function openLevelModal(pid,lid){
  const pg=getCurrentPage();
  const ph=pg.phases.find(p=>p.id===pid);
  const lv=ph&&ph.levels.find(l=>l.id===lid);
  if(!lv) return;
  document.getElementById('zonePhaseId').value=pid;
  document.getElementById('zoneId').value=lid;
  document.getElementById('zoneName').value=lv.name||'';
  document.getElementById('zoneDesc').value=lv.description||'';
  const m=document.getElementById('zoneModal');
  m.classList.remove('hidden'); m.classList.add('open');
}
function closeLevelModal(){
  const m=document.getElementById('zoneModal');
  if(!m) return;
  m.classList.remove('open');
  setTimeout(()=>{ m.classList.add('hidden'); }, 200);
}
function saveLevelDetails(e){
  e.preventDefault();
  const pg=getCurrentPage();
  const ph=pg.phases.find(p=>p.id===document.getElementById('zonePhaseId').value);
  const lv=ph&&ph.levels.find(l=>l.id===document.getElementById('zoneId').value);
  if(!lv) return;
  lv.name=document.getElementById('zoneName').value;
  lv.description=document.getElementById('zoneDesc').value;
  closeLevelModal();
  saveAppState();
  renderDiagram();
}
// Ordine delle parti: punteggio piu alto in cima, parti fallite in fondo (0 punti)
function orderedBoxParts(pg, boxId){
  return boxSpaces(pg, boxId).slice().sort((a,b)=>{
    if(!!a.failed !== !!b.failed) return a.failed?1:-1;
    const d=partScore(b)-partScore(a);
    if(d) return d;
    return (a._multiIndex||0)-(b._multiIndex||0);
  });
}
// Rimappa le uscite sul nuovo ordine dopo un cambio di priorita o di punteggio
function reindexAllBoxParts(pg){
  pg.phases.forEach(ph=>ph.levels.forEach(lv=>lv.boxes.forEach(box=>{
    const parts=boxSpaces(pg, box.id);
    if(!parts.length) return;
    const ordered=orderedBoxParts(pg, box.id);
    const newIndex=new Map(ordered.map((c,i)=>[c.id,i]));
    pg.connections.forEach(c=>{
      if(c.srcBoxId!==box.id) return;
      const oldPart=parts[c.srcSpaceIndex||0];
      if(oldPart && newIndex.has(oldPart.id)) c.srcSpaceIndex=newIndex.get(oldPart.id);
    });
    ordered.forEach((c,i)=>{ c._multiIndex=i; });
  })));
}
function pruneAndRebuild(pg){
  reindexAllBoxParts(pg);
  pg.connections=pg.connections.filter(c=>{
    const srcBox=pg.phases.flatMap(p=>p.levels).flatMap(l=>l.boxes).find(b=>b.id===c.srcBoxId);
    if(!srcBox) return false;
    return outletIndexes(pg, c.srcBoxId).includes(c.srcSpaceIndex||0);
  });
  pg.phases.forEach((ph,pi)=>{
    if(pi===0) return;
    ph.levels.forEach((lv,li)=>{
      const prev = li>0 ? ph.levels[li-1] : (pg.phases[pi-1].levels[pg.phases[pi-1].levels.length-1]||null);
      if(!prev) return;
      lv.boxes.forEach(b=>connectLevelToBox(pg, prev, b, true));
    });
  });
  ensureAutomaticCombinations();
}
// Ricalcola le parti a valle dopo un cambio di priorita (le fallite non contano)
function applyPriorityCascade(pg, box){
  if((box.priority||'p1')==='failed') pg.connections=pg.connections.filter(c=>c.srcBoxId!==box.id);
  pruneAndRebuild(pg);
}
// Una parte fallita non si collega piu alle parti delle zone successive
function applySpaceFailureCascade(pg, part){
  pruneAndRebuild(pg);
}
function deleteLevel(pid,lid){ const pg=getCurrentPage(); const p=pg.phases.find(x=>x.id===pid); const phaseIdx=pg.phases.indexOf(p); if(!p||phaseIdx===0){ alert('Fase 0 immutabile'); return } if(phaseIdx < pg.phases.length-1){ alert('Puoi eliminare zone solo dall\'ultima fase'); return } const lv=p.levels.find(x=>x.id===lid); if(lv){ lv.boxes.forEach(b=>pg.connections=pg.connections.filter(c=>c.srcBoxId!==b.id&&c.targetBoxId!==b.id)); } p.levels=p.levels.filter(x=>x.id!==lid); p.levels.forEach((l,i)=>l.name='Zona '+(i+1)); saveAppState(); renderDiagram(); }
function deletePhase(pid){ const pg=getCurrentPage(); const i=pg.phases.findIndex(x=>x.id===pid); if(i===0){ alert('Fase 0 non eliminabile'); return } if(pg.phases.length<=1){ alert('Almeno una fase'); return } const ph=pg.phases.find(x=>x.id===pid); if(ph){ ph.levels.forEach(l=>l.boxes.forEach(b=>pg.connections=pg.connections.filter(c=>c.srcBoxId!==b.id&&c.targetBoxId!==b.id))); } pg.phases=pg.phases.filter(x=>x.id!==pid); saveAppState(); renderDiagram(); }
function updatePhaseName(pid,val){ const pg=getCurrentPage(); const ph=pg.phases.find(x=>x.id===pid); const phaseIdx=pg.phases.indexOf(ph); if(ph&&phaseIdx===pg.phases.length-1){ ph.name=val; saveAppState(); } }
function updatePhaseColor(pid,col){ const pg=getCurrentPage(); const ph=pg.phases.find(x=>x.id===pid); const phaseIdx=pg.phases.indexOf(ph); if(ph&&phaseIdx===pg.phases.length-1){ ph.color=col; saveAppState(); renderDiagram(); } }
function togglePhaseStatus(pid){ const pg=getCurrentPage(); const ph=pg.phases.find(x=>x.id===pid); const phaseIdx=pg.phases.indexOf(ph); if(!ph||phaseIdx===0||phaseIdx < pg.phases.length-1) return; const ord=['todo','in-progress','done']; ph.status=ord[(ord.indexOf(ph.status||'todo')+1)%3]; saveAppState(); renderDiagram(); }
function toggleColorMenu(pid){ document.getElementById('color-menu-'+pid)?.classList.toggle('hidden'); }
function toggleSpaceTable(btn,id){ const el=document.getElementById(id); if(!el||!btn) return; const nowHidden=el.classList.toggle('hidden'); btn.textContent=nowHidden?'Mostra altro':'Nascondi'; btn.classList.toggle('expanded',!nowHidden); }

// ===== BOX DETAIL MODAL =====
function openBoxTitleModal(bid){ const pg=getCurrentPage(); let box=null; for(const ph of pg.phases) for(const lv of ph.levels){ const b=lv.boxes.find(x=>x.id===bid); if(b){ box=b; break } } if(!box) return; document.getElementById('editBoxId').value=bid; document.getElementById('editBoxTitle').value=box.title||''; document.getElementById('editBoxDesc').value=box.description||''; document.getElementById('editBoxPriority').value=box.priority||'p1'; 
  const m=document.getElementById('boxModal'); m.classList.remove('hidden'); m.classList.add('open'); }
function closeBoxModal(){ const m=document.getElementById('boxModal'); m.classList.remove('open'); setTimeout(()=>{ m.classList.add('hidden'); }, 200); }
function saveBoxTitle(e){ e.preventDefault(); const pg=getCurrentPage(); const bid=document.getElementById('editBoxId').value; const nt=document.getElementById('editBoxTitle').value; const nd=document.getElementById('editBoxDesc').value; const np=document.getElementById('editBoxPriority').value; let box=null, before='p1'; for(const ph of pg.phases) for(const lv of ph.levels){ const b=lv.boxes.find(x=>x.id===bid); if(b){ before=b.priority||'p1'; b.title=nt; b.description=nd; b.priority=np; box=b; break } } if(box && before!==np) applyPriorityCascade(pg, box); closeBoxModal(); saveAppState(); renderDiagram(); }

// ===== SPACE MODAL =====
function openSpaceModal(cid){ const pg=getCurrentPage(); const c=pg.connections.find(x=>x.id===cid); if(!c) return; document.getElementById('spaceConnId').value=cid; document.getElementById('spaceFailed').checked=!!c.failed; document.getElementById('spaceFile').value=c.file||''; document.getElementById('spaceScore').value=c.score??0; document.getElementById('spaceNotes').value=c.notes||''; document.getElementById('spaceModalSrc').textContent=findBoxTitle(c.srcBoxId); document.getElementById('spaceModalTarget').textContent=findBoxTitle(c.targetBoxId); if(!c.tableValues||c.tableValues.length<5) c.tableValues=createDefaultTableValues(); const cont=document.getElementById('tableInputs'); cont.innerHTML=''; c.tableValues.forEach((tv,i)=>{ cont.innerHTML+=`<div class="table-input-row"><input type="text" value="${escapeHtml(tv.name)}" placeholder="Nome ${i+1}" onchange="updateTableField('${cid}',${i},'name',this.value)" class="input"><input type="text" value="${escapeHtml(tv.value)}" placeholder="Valore ${i+1}" onchange="updateTableField('${cid}',${i},'value',this.value)" class="input"></div>`; }); const m=document.getElementById('spaceModal'); m.classList.remove('hidden'); m.classList.add('open'); }
function closeSpaceModal(){ const m=document.getElementById('spaceModal'); m.classList.remove('open'); setTimeout(()=>{ m.classList.add('hidden'); }, 200); }
function updateTableField(cid,i,field,val){ const c=getCurrentPage().connections.find(x=>x.id===cid); if(c&&c.tableValues[i]) c.tableValues[i][field]=val; }
function updateTableFieldDirect(cid,i,field,val){ const c=getCurrentPage().connections.find(x=>x.id===cid); if(c&&c.tableValues[i]){ c.tableValues[i][field]=val; saveAppState(); } }
function saveSpaceForm(e){
  e.preventDefault();
  const cid=document.getElementById('spaceConnId').value;
  const pg=getCurrentPage();
  const c=pg.connections.find(x=>x.id===cid);
  if(!c) return;
  const wasFailed=!!c.failed;
  c.failed=document.getElementById('spaceFailed').checked;
  c.score=parseFloat(document.getElementById('spaceScore').value)||0;
  c.notes=document.getElementById('spaceNotes').value;
  if(wasFailed!==!!c.failed) applySpaceFailureCascade(pg, c);
  closeSpaceModal(); saveAppState(); renderDiagram();
}
function toggleConnectionState(cid){ const c=getCurrentPage().connections.find(x=>x.id===cid); if(c){ c.disconnected=!c.disconnected; saveAppState(); renderDiagram(); } }
function cycleBoxPriority(bid){ const pg=getCurrentPage(); for(const ph of pg.phases) for(const lv of ph.levels){ const b=lv.boxes.find(x=>x.id===bid); if(b){ const ord=['p1','p2','p3','p4','failed']; let i=ord.indexOf(b.priority||'p1'); i=(i+1)%5; b.priority=ord[i]; saveAppState(); renderDiagram(); return; } } }
function toggleConnFailed(cid){ const pg=getCurrentPage(); const c=pg.connections.find(x=>x.id===cid); if(c){ c.failed=!c.failed; saveAppState(); const el=document.getElementById('space-'+cid); if(el){ el.classList.add('failed-part'); setTimeout(()=>el.classList.remove('failed-part'),600); } renderDiagram(); } }
function togglePriorityMenu(bid, ev){ ev.stopPropagation(); document.querySelectorAll('.prio-menu').forEach(m=>m.classList.remove('open')); const btn=ev.currentTarget; const menu=btn.nextElementSibling; if(menu&&menu.classList.contains('prio-menu')) menu.classList.toggle('open'); }
function setBoxPriority(bid,p){
  const pg=getCurrentPage();
  for(const ph of pg.phases) for(const lv of ph.levels){
    const b=lv.boxes.find(x=>x.id===bid);
    if(b){
      b.priority=p;
      if(p==='failed'){
        pg.connections.forEach(c=>{
          if((c.srcBoxId===bid||c.targetBoxId===bid) && !c.failed){
            c.failed=true; c.priority='failed';
          }
        });
      }
      // CASCATA: le parti a valle senza una strada valida in ingresso non esistono
      pruneAndRebuild(pg);
      saveAppState();
      renderDiagram();
      document.querySelectorAll('.prio-menu').forEach(m=>m.classList.remove('open'));
      return;
    }
  }
}
function setPartPriority(cid,p){
  const pg=getCurrentPage();
  const c=pg.connections.find(x=>x.id===cid);
  if(c){
    const wasFailed=c.failed;
    if(p==='failed'){ c.failed=true; c.priority='failed'; }
    else { c.failed=false; c.priority=p; }
    // CASCATA: una parte che resta senza una strada che arriva da sinistra
    // (perche' la parte a monte e' fallita) non deve esistere.
    if(wasFailed!==!!c.failed) applySpaceFailureCascade(pg, c);
    saveAppState();
    const el=document.getElementById('space-'+cid);
    if(el && p==='failed' && !wasFailed){ el.classList.add('failed-part'); setTimeout(()=>el.classList.remove('failed-part'),600); }
    renderDiagram();
  }
  document.querySelectorAll('.prio-menu').forEach(m=>m.classList.remove('open'));
}
function togglePartPriorityMenu(cid, ev){
  ev.stopPropagation();
  document.querySelectorAll('.prio-menu').forEach(m=>m.classList.remove('open'));
  const btn=ev.currentTarget;
  const menu=btn.nextElementSibling;
  if(menu&&menu.classList.contains('prio-menu')) menu.classList.toggle('open');
}

// ===== MANAGE CONNECTIONS MODAL =====
let activeBoxForConn=null;
function openManageConnModal(bid){
  activeBoxForConn=bid;
  const pg=getCurrentPage();
  const cont=document.getElementById('manageConnList'); cont.innerHTML='';
  const openModal=()=>{ const m=document.getElementById('manageConnModal'); m.classList.remove('hidden'); m.classList.add('open'); };
  let targetPhase=null, targetLevelIdx=-1;
  for(const ph of pg.phases){
    for(let i=0;i<ph.levels.length;i++){
      if(ph.levels[i].boxes.some(b=>b.id===bid)){ targetPhase=ph; targetLevelIdx=i; break; }
    }
    if(targetPhase) break;
  }
  if(!targetPhase){ cont.innerHTML='<p class="conn-message">Nessun zona trovato.</p>'; openModal(); return; }
  const targetPhaseIdx=pg.phases.findIndex(p=>p.id===targetPhase.id);
  const possibleSources=[];
  if(targetLevelIdx>0){
    targetPhase.levels[targetLevelIdx-1].boxes.forEach(pb=>possibleSources.push(pb));
  } else if(targetPhaseIdx>0){
    const prevPhase=pg.phases[targetPhaseIdx-1];
    if(prevPhase.levels && prevPhase.levels.length){
      prevPhase.levels[prevPhase.levels.length-1].boxes.forEach(pb=>possibleSources.push(pb));
    }
  }
  if(possibleSources.length===0){
    cont.innerHTML='<p class="conn-message">Nessun modifica nella zona precedente.</p>';
    openModal(); return;
  }
  possibleSources.forEach(pb=>{
    const outlets=boxOutletCount(pg, pb.id);
    const roads=pg.connections.filter(c=>c.srcBoxId===pb.id && c.targetBoxId===bid);
    const active=roads.filter(c=>!c.disconnected).length;
    const full=active>=outlets;
    const div=document.createElement('div');
    div.className='conn-source-item';
    div.innerHTML=`<div class="conn-indicator ${full?'active':''}"></div><div class="conn-source-main"><span class="conn-title">${escapeHtml(pb.title)}</span><span class="conn-meta">${active}/${outlets} parti collegate</span></div><button onclick="toggleConnectionFromManager('${pb.id}','${bid}')" class="conn-toggle ${full?'disconnect':'connect'}">${full?'Scollega':'Collega'}</button>`;
    cont.appendChild(div);
  });
  openModal();
}
function closeManageConnModal(){ const m=document.getElementById('manageConnModal'); m.classList.remove('open'); setTimeout(()=>{ m.classList.add('hidden'); }, 200); }
function toggleConnectionFromManager(sid,tid){
  const pg=getCurrentPage();
  const srcBox=pg.phases.flatMap(p=>p.levels).flatMap(l=>l.boxes).find(b=>b.id===sid);
  const tgtBox=pg.phases.flatMap(p=>p.levels).flatMap(l=>l.boxes).find(b=>b.id===tid);
  if(!srcBox || !tgtBox){ alert('Modifiche non trovati'); return; }

  // Posizioni di sorgente e destinazione
  let srcPhaseIdx=-1, srcLevelIdx=-1, tgtPhaseIdx=-1, tgtLevelIdx=-1;
  for(let pi=0; pi<pg.phases.length; pi++){
    const ph=pg.phases[pi];
    for(let li=0; li<ph.levels.length; li++){
      if(ph.levels[li].boxes.some(b=>b.id===sid)){ srcPhaseIdx=pi; srcLevelIdx=li; }
      if(ph.levels[li].boxes.some(b=>b.id===tid)){ tgtPhaseIdx=pi; tgtLevelIdx=li; }
    }
  }

  if(tgtPhaseIdx===0){ alert('Non puoi collegare alla Fase 0'); return; }
  if(srcPhaseIdx===tgtPhaseIdx){
    if(tgtLevelIdx!==srcLevelIdx+1){
      alert('Le strade possono andare solo dalla zona N alla zona N+1: non si possono saltare zone');
      return;
    }
  } else {
    const srcLevelsCount=pg.phases[srcPhaseIdx].levels.length;
    if(srcPhaseIdx!==tgtPhaseIdx-1 || srcLevelIdx!==srcLevelsCount-1 || tgtLevelIdx!==0){
      alert('Le strade non possono saltare fasi o zone: solo dall\'ultimo zona della fase precedente al primo zona della fase successiva');
      return;
    }
  }

  // Collega o scollega TUTTI le parti (uscite) della modifica sorgente
  const outlets=boxOutletCount(pg, sid);
  const roads=pg.connections.filter(c=>c.srcBoxId===sid && c.targetBoxId===tid);
  const active=roads.filter(c=>!c.disconnected).length;
  if(active>=outlets){
    roads.forEach(c=>{ c.disconnected=true; });
  } else {
    for(let outlet=0; outlet<outlets; outlet++){
      const road=roads.find(c=>(c.srcSpaceIndex||0)===outlet);
      if(road){ road.disconnected=false; }
      else {
        pg.connections.push({
          id:uid('conn'), srcBoxId:sid, srcSpaceIndex:outlet, targetBoxId:tid,
          file:autoRoadFileName(srcBox,tgtBox), 
          score:50, notes:'', disconnected:false,
          tableValues:createDefaultTableValues(),
          _multiIndex:boxSpaceCount(pg,tid)
        });
      }
    }
  }
  ensureAutomaticCombinations(); saveAppState(); renderDiagram(); openManageConnModal(tid);
}

// ===== SETTINGS MODAL =====
function openSettingsModal(){ const cont=document.getElementById('settingsParamInputs'); cont.innerHTML=''; getGlobalNames().forEach((n,i)=>{ cont.innerHTML+=`<div class="table-input-row"><span style="display:flex;align-items:center;width:2rem;font-size:.65rem;color:var(--muted);justify-content:flex-end">${i+1}.</span><input type="text" value="${escapeHtml(n)}" onchange="updateGlobalParamName(${i},this.value)" class="input" style="flex:1"></div>`; }); const modal=document.getElementById('settingsModal'); modal.classList.remove('hidden'); modal.classList.add('open'); }
function closeSettingsModal(){ const modal=document.getElementById('settingsModal'); modal.classList.remove('open'); setTimeout(()=>{ modal.classList.add('hidden'); }, 200); }
function updateGlobalParamName(i,v){ if(!appState.tableParamNames) appState.tableParamNames=[]; appState.tableParamNames[i]=v||'Parametro '+String.fromCharCode(65+i); }
function saveSettings(e){ e.preventDefault(); while(appState.tableParamNames.length<5) appState.tableParamNames.push('Parametro '+String.fromCharCode(65+appState.tableParamNames.length)); appState.tableParamNames=appState.tableParamNames.slice(0,5); saveAppState(); closeSettingsModal(); showToast('Impostazioni salvate!','success'); }
function resetSettingsToDefault(){ appState.tableParamNames=['Parametro A','Parametro B','Parametro C','Parametro D','Parametro E']; const c=document.getElementById('settingsParamInputs'); c.innerHTML=''; appState.tableParamNames.forEach((n,i)=>{ c.innerHTML+=`<div class="table-input-row"><span style="display:flex;align-items:center;width:2rem;font-size:.65rem;color:var(--muted);justify-content:flex-end">${i+1}.</span><input type="text" value="${escapeHtml(n)}" onchange="updateGlobalParamName(${i},this.value)" class="input" style="flex:1"></div>`; }); }

// ===== FILE SYSTEM ACCESS API =====
async function saveFile(){ const data=JSON.stringify(diagramForExport(appState),null,2); try{ if(!fileHandle){ fileHandle=await window.showSaveFilePicker({suggestedName:'diagramma_cascata_'+new Date().toISOString().slice(0,10)+'.json',types:[{description:'Diagramma Cascata JSON',accept:{'application/json':['.json']}}]}); } const w=await fileHandle.createWritable(); await w.write(data); await w.close(); saveAppState(); showToast('Salvato su file!','success'); } catch(err){ if(err.name!=='AbortError'){ console.error(err); fallbackDownload(data); } } }
function fallbackDownload(data){ const a=document.createElement('a'); a.href='data:text/json;charset=utf-8,'+encodeURIComponent(data); a.download='diagramma_cascata_'+new Date().toISOString().slice(0,10)+'.json'; document.body.appendChild(a); a.click(); a.remove(); }
async function loadFile(ev){ if(ev&&ev.target&&ev.target.files){ const f=ev.target.files[0]; if(!f) return; tryLoad(await f.text()); return } try{ const [h]=await window.showOpenFilePicker({types:[{description:'Diagramma Cascata JSON',accept:{'application/json':['.json']}}]}); fileHandle=h; tryLoad(await (await h.getFile()).text()); } catch(err){ if(err.name!=='AbortError') alert('Errore caricamento. Usa pulsante Carica classico.'); } }
function tryLoad(txt){ try{ const imp=JSON.parse(txt); if(imp&&Array.isArray(imp.pages)){ appState=imp; saveAppState(); renderTabs(); renderDiagram(); showToast('Diagramma caricato!','success'); } else alert('JSON non valido'); } catch(err){ alert('Errore: '+err.message); } }
function clearAll(){ if(confirm('Reset pagina corrente?')){ appState.pages[appState.activePageIndex]=createDefaultPage(getCurrentPage().name); saveAppState(); renderDiagram(); } }

// ===== SEARCH =====
// Cerca in modifiche, zone (nome e descrizione), file delle parti, note e parametri.
// Evidenzia i risultati, attenua il resto e con Invio salta al risultato successivo.
let searchQuery='';
let searchJump=0;
function setSearchCount(n,q){
  const el=document.getElementById('searchCount');
  if(!el) return;
  el.textContent=q?String(n):'';
  el.classList.toggle('no-results', !!q && n===0);
}
function applySearch(){
  const q=(searchQuery||'').trim().toLowerCase();
  const boxEls=document.querySelectorAll('.box-card');
  const partEls=document.querySelectorAll('.space-card[data-conn-id]');
  const levelEls=document.querySelectorAll('.level-block');
  if(!q){
    boxEls.forEach(el=>el.classList.remove('search-miss','search-hit'));
    partEls.forEach(el=>el.classList.remove('search-hit'));
    levelEls.forEach(el=>el.classList.remove('search-hit'));
    setSearchCount(0,'');
    return;
  }
  const pg=getCurrentPage();
  const has=s=>String(s||'').toLowerCase().includes(q);
  const levelHit=new Set(), boxHit=new Set(), partHit=new Set();
  pg.phases.forEach(ph=>{
    const phHit=has(ph.name);
    ph.levels.forEach(lv=>{
      if(phHit||has(lv.name)||has(lv.description)) levelHit.add(lv.id);
      lv.boxes.forEach(b=>{ if(has(b.title)||has(b.description)) boxHit.add(b.id); });
    });
  });
  pg.connections.forEach(c=>{
    let hit=has(c.file)||has(c.notes);
    if(!hit && c.tableValues) hit=c.tableValues.some(tv=>has(tv.name)||has(tv.value));
    if(hit){ partHit.add(c.id); boxHit.add(c.targetBoxId); }
  });
  boxEls.forEach(el=>{
    const boxId=el.dataset.boxId;
    const lvEl=el.closest('.level-block');
    const zoneMatch=!!lvEl&&levelHit.has(lvEl.dataset.levelId);
    el.classList.toggle('search-hit', boxHit.has(boxId));
    el.classList.toggle('search-miss', !boxHit.has(boxId) && !zoneMatch);
  });
  partEls.forEach(el=>el.classList.toggle('search-hit', partHit.has(el.dataset.connId)));
  levelEls.forEach(el=>el.classList.toggle('search-hit', levelHit.has(el.dataset.levelId)));
  setSearchCount(boxHit.size+levelHit.size, q);
}
function handleSearch(q){
  searchQuery=q||'';
  searchJump=0;
  document.getElementById('searchClear').style.display=searchQuery.trim()?'block':'none';
  applySearch();
}
function clearSearch(){ const el=document.getElementById('searchInput'); if(el) el.value=''; searchQuery=''; document.getElementById('searchClear').style.display='none'; applySearch(); }
function searchKeydown(e){
  if(e.key==='Enter'){ e.preventDefault(); focusNextSearchMatch(); }
  else if(e.key==='Escape'){ e.preventDefault(); clearSearch(); }
}
function focusNextSearchMatch(){
  const hits=[...document.querySelectorAll('.box-card.search-hit')];
  const zones=[...document.querySelectorAll('.level-block.search-hit')];
  const all=hits.concat(zones);
  if(!all.length) return;
  const el=all[searchJump % all.length];
  searchJump++;
  centerOnElement(el);
}
// Centra l'elemento nel viewport (pan personalizzato, niente scroll nativo)
function centerOnElement(el){
  const vp=document.getElementById('viewport');
  if(!vp||!el) return;
  const vr=vp.getBoundingClientRect(), r=el.getBoundingClientRect();
  panX+=(vr.left+vr.width/2)-(r.left+r.width/2);
  panY+=(vr.top+vr.height/2)-(r.top+r.height/2);
  updateTransform();
  scheduleConnectionsRedraw();
}

// ===== RENDER DIAGRAM (HORIZONTAL) =====
function renderDiagram(){
  ensureAutomaticCombinations();
  const cont=document.getElementById('diagramContainer'); cont.innerHTML='';
  const pg=getCurrentPage();
  let totalBoxes=0, totalLevels=0, failedSpaces=0;

  // build level order for connections
  window._levelOrder=[];
  let gIdx=0; pg.phases.forEach((ph,pi)=>{ ph.levels.forEach((lv,li)=>{ window._levelOrder.push({phase:ph,phaseIdx:pi,level:lv,levelIdx:li,globalIdx:gIdx++}); }); });

  // Indici precalcolati: evita una ricerca su tutte le modifiche per ogni parte
  const boxIndex=buildBoxIndex(pg);
  const titleOf=id=>{ const e=boxIndex.get(id); return e?e.box.title:'Sconosciuto'; };
  const partsByBox=new Map();
  pg.connections.forEach(c=>{ if(c.disconnected) return; let arr=partsByBox.get(c.targetBoxId); if(!arr){ arr=[]; partsByBox.set(c.targetBoxId,arr); } arr.push(c); });
  partsByBox.forEach(arr=>arr.sort((a,b)=>(a._multiIndex||0)-(b._multiIndex||0)));
  const spacesOf=id=>partsByBox.get(id)||[];

  const phasesDiv=document.createElement('div'); phasesDiv.className='phases-container';
  pg.phases.forEach((ph,pi)=>{
    const phBlock=document.createElement('div'); phBlock.className='phase-block'; phBlock.dataset.phaseId=ph.id; phBlock.style.borderColor=ph.color||'#3b82f6';
    const ps=ph.status||'todo'; let sb='';
    if(ps==='in-progress') sb='<span class="badge badge-in"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> In Corso</span>';
    else if(ps==='done') sb='<span class="badge badge-done"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Completata</span>';
    else sb='<span class="badge badge-todo"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/></svg> Da Fare</span>';

    // phase header
    const phHeader=document.createElement('div'); phHeader.className='phase-header';
    phHeader.innerHTML=`<div class="phase-header-top"><div class="flex items-center gap-2"><span class="phase-color-dot" style="background:${ph.color||'#22c55e'}"></span><input type="text" value="${escapeHtml(ph.name)}" onchange="updatePhaseName('${ph.id}',this.value)" class="phase-name-input">${sb}</div>${pi!==0?`<div class="phase-actions"><div class="relative" title="Cambia colore"><button class="icon-btn" onclick="toggleColorMenu('${ph.id}')" style="width:1.8rem;height:1.8rem;background:${ph.color||'#22c55e'};border:none;border-radius:.5rem"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg></button><div id="color-menu-${ph.id}" class="color-menu hidden">${['#ff0000','#ff7f00','#ffff00','#00ff00','#0000ff','#4b0082','#9400d3'].map(c=>`<button class="color-btn${c===(ph.color||'#22c55e')?' active':''}" onclick="updatePhaseColor('${ph.id}','${c}');toggleColorMenu('${ph.id}')" style="background:${c}" title="${c}"></button>`).join('')}</div></div><button class="btn btn-sm ${ps==='in-progress'?'btn-primary':ps==='done'?'btn-primary':'btn-ghost'}" onclick="togglePhaseStatus('${ph.id}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${ps==='in-progress'?'<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16">':ps==='done'?'<polyline points="20 6 9 17 4 12">':'<polygon points="5 3 19 12 5 21 5 3">'}</svg> ${ps==='in-progress'?'In Corso':ps==='done'?'Riapri':'Inizia'}</button><button class="btn btn-secondary btn-sm" onclick="addLevelToPhase('${ph.id}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Zona</button><button class="btn btn-danger btn-sm" onclick="deletePhase('${ph.id}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg> Elimina</button></div>`:''}</div>`;
    phBlock.appendChild(phHeader);

    // levels container
    const lvCont=document.createElement('div'); lvCont.className='levels-container';
    ph.levels.forEach((lv,li)=>{
      totalLevels++;
      const lvBlock=document.createElement('div'); lvBlock.className='level-block'; lvBlock.dataset.levelId=lv.id; lvBlock.dataset.phaseId=ph.id;
      lvBlock.style.background=`linear-gradient(180deg, ${(ph.color||'#22c55e')+'22'}, ${(ph.color||'#22c55e')+'08'})`;
      lvBlock.innerHTML=`<div class="level-header"><button type="button" class="level-title" onclick="event.stopPropagation();openLevelModal('${ph.id}','${lv.id}')" title="Dettagli zona"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg> ${escapeHtml(lv.name)}</button>${pi!==0?`<div class="flex items-center gap-1"><button class="btn btn-secondary btn-sm" onclick="addBoxToLevel('${ph.id}','${lv.id}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Modifica</button><button class="btn btn-ghost btn-sm" onclick="deleteLevel('${ph.id}','${lv.id}')" title="Elimina Zona"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>`:''}</div>`;
      if(lv.description) lvBlock.insertAdjacentHTML('beforeend', `<div class="level-desc">${escapeHtml(lv.description)}</div>`);
      const boxesDiv=document.createElement('div'); boxesDiv.className='boxes-container';
      [...lv.boxes].sort((a,b)=>(a.priority==='failed'?1:0)-(b.priority==='failed'?1:0)).forEach(bx=>{
        totalBoxes++;
        const inc=spacesOf(bx.id);
        const act=inc.filter(()=>true);
        const bp=bx.priority||'p1';
        if(bp==='p1') bc='#22c55e'; else if(bp==='p2') bc='#3b82f6'; else if(bp==='p3') bc='#a855f7'; else if(bp==='p4') bc='#eab308'; else if(bp==='failed') bc='#ef4444';

        let spHTML='';
        if(act.length===0){
          spHTML=`<div class="conn-message">Radice / Nessuna connessione attiva</div>`;
        }
        else{
          act.forEach((cn,si)=>{
            // La priorita della parte stessa (non della box che la contiene)
            const cp=cn.failed?'failed':(cn.priority||'p1');
            let pb='p1-border', pbc='#22c55e', sopacity=1;
            if(cp==='p2'){ pb='p2-border'; pbc='#3b82f6'; sopacity=0.85; }
            else if(cp==='p3'){ pb='p3-border'; pbc='#a855f7'; sopacity=0.7; }
            else if(cp==='p4'){ pb='p4-border'; pbc='#eab308'; sopacity=0.55; }
            else if(cp==='failed'){ failedSpaces++; pb='failed-border'; pbc='#ef4444'; sopacity=0.6; }
            let tpv='';
            if(cn.tableValues&&cn.tableValues.length){
              const visible=cn.tableValues.slice(0,2);
              const hidden=cn.tableValues.slice(2);
              const rowHTML=(tv,idx)=>`<div class="space-table-row"><span class="space-table-name" title="${escapeHtml(tv.name)}">${escapeHtml(tv.name)}:</span><input type="text" class="space-table-value-input" value="${escapeHtml(tv.value)}" title="${escapeHtml(tv.value)}" oninput="updateTableFieldDirect('${cn.id}',${idx},'value',this.value)" onclick="event.stopPropagation()"></div>`;
              tpv='<div class="space-table">'+visible.map(rowHTML).join('');
              if(hidden.length>0){
                const hid=uid('hid');
                tpv+=`<button type="button" class="table-toggle-btn space-table-btn" onclick="event.stopPropagation();toggleSpaceTable(this,'${hid}')">Mostra altro</button><div id="${hid}" class="space-table-more hidden">`+hidden.map(rowHTML).join('')+'</div>';
              }
              tpv+='</div>';
            }
            spHTML+=`<div id="space-${cn.id}" data-conn-id="${cn.id}" data-space-index="${si}" onmouseenter="hoverConn('${cn.id}')" onmouseleave="leaveConn()" onclick="event.stopPropagation();openSpaceModal('${cn.id}')" class="space-card ${pb} space-card-modern${activeHoverPath.includes(cn.id)?' space-active':''}" style="opacity:${sopacity}"><span class="space-number" style="background:${pbc}">${si+1}</span><div id="dot-in-${cn.id}" class="connector-dot connector-in" title="Ingresso"></div><div id="dot-out-${cn.id}" class="connector-dot connector-out" title="Uscita"></div><div class="space-header"><div class="space-file"><span class="truncate" title="${escapeHtml(cn.file)}">${escapeHtml(cn.file||'script.py')}</span></div><div class="part-prio-wrap"><button class="prio-btn-small prio-${cn.failed?'failed':(cn.priority||'p1')}" onclick="event.stopPropagation();togglePartPriorityMenu('${cn.id}',event)" title="Priorità parte">${cn.failed?'FAIL':(cn.priority||'p1').toUpperCase()}</button><div class="prio-menu part-prio-menu"><button class="prio-opt" onclick="event.stopPropagation();setPartPriority('${cn.id}','p1')">P1</button><button class="prio-opt" onclick="event.stopPropagation();setPartPriority('${cn.id}','p2')">P2</button><button class="prio-opt" onclick="event.stopPropagation();setPartPriority('${cn.id}','p3')">P3</button><button class="prio-opt" onclick="event.stopPropagation();setPartPriority('${cn.id}','p4')">P4</button><button class="prio-opt" onclick="event.stopPropagation();setPartPriority('${cn.id}','failed')">FAIL</button></div></div></div><div class="space-source"><span>Da: <b>${escapeHtml(titleOf(cn.srcBoxId))}</b></span><span class="space-score" title="Punteggio">${cn.failed?0:(Number(cn.score)||0)} pt</span></div>${cn.notes?`<p class="space-notes">"${escapeHtml(cn.notes)}"</p>`:''}${tpv}</div>`;
          });
        }
        const iz=pi===0;
        const hb=iz?'':`<div class="box-actions"><button class="icon-btn" onclick="event.stopPropagation();openManageConnModal('${bx.id}')" title="Gestisci collegamenti"><svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg></button><button class="icon-btn icon-btn-danger" onclick="event.stopPropagation();deleteBox('${bx.id}')" title="Elimina modifica"><svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg></button></div>`;
        const dh=bx.description?`<div class="box-desc">${escapeHtml(bx.description)}</div>`:'';
        // Parti visibili su tutte le fasi; azioni di modifica su tutte tranne la Fase 0
        const ss=iz ? '' : `<div class="spaces-section"><div class="spaces-header">Parti (${act.length})</div><div class="spaces-grid">${spHTML}</div></div>`;
        const boxDiv=document.createElement('div'); boxDiv.className='box-card'; boxDiv.id='card-'+bx.id; boxDiv.dataset.boxId=bx.id; boxDiv.style.borderColor=bc; boxDiv.innerHTML=`<div class="box-header"><div class="box-title-row" onclick="openBoxTitleModal('${bx.id}')"><span class="box-title">${escapeHtml(bx.title)}</span><div class="box-prio-wrap"><button class="prio-btn prio-${bp}" onclick="event.stopPropagation();togglePriorityMenu('${bx.id}',event)" title="Priorità">${bp==='failed'?'FAIL':bp.toUpperCase()}</button><div class="prio-menu"><button class="prio-opt" onclick="event.stopPropagation();setBoxPriority('${bx.id}','p1')">P1</button><button class="prio-opt" onclick="event.stopPropagation();setBoxPriority('${bx.id}','p2')">P2</button><button class="prio-opt" onclick="event.stopPropagation();setBoxPriority('${bx.id}','p3')">P3</button><button class="prio-opt" onclick="event.stopPropagation();setBoxPriority('${bx.id}','p4')">P4</button><button class="prio-opt" onclick="event.stopPropagation();setBoxPriority('${bx.id}','failed')">FAIL</button></div></div></div>${hb}</div>${dh}${ss}`;
        boxesDiv.appendChild(boxDiv);
      });
      if(lv.boxes.length===0) boxesDiv.innerHTML='<div class="conn-message">Nessun modifica presente</div>';
      lvBlock.appendChild(boxesDiv);
      lvCont.appendChild(lvBlock);
    });
    phBlock.appendChild(lvCont);
    phasesDiv.appendChild(phBlock);
  });
  cont.appendChild(phasesDiv);

  // stats
  document.getElementById('statPhases').textContent=pg.phases.length;
  document.getElementById('statLevels').textContent=totalLevels;
  document.getElementById('statBoxes').textContent=totalBoxes;
  updateProgressBar(pg.phases.length,totalBoxes,failedSpaces);
  if(searchQuery) applySearch();
  requestAnimationFrame(drawSVGConnections);
}
function updateProgressBar(pc,tb,fs){ const fl=document.getElementById('progressFill'), tx=document.getElementById('progressText'); if(pc<=1){ fl.style.width='100%'; tx.textContent='Fase 0 (Base)'; return } const p=Math.min(100,Math.round(((pc-1)/Math.max(pc,1))*100)); fl.style.width=p+'%'; tx.textContent=p+'% ('+pc+' Fasi)'; }

// ===== SVG CONNECTIONS (HORIZONTAL) =====
function drawSVGConnections(){
  const svg=document.getElementById('svg-canvas'), vp=document.getElementById('viewport');
  if(!svg || !vp) return;
  const vr=vp.getBoundingClientRect();

  // Set SVG bounds to match viewport
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.innerHTML='';

  const pg=getCurrentPage();
  if(!pg || !Array.isArray(pg.phases) || !Array.isArray(pg.connections)){
    const stat=document.getElementById('statPaths');
    if(stat) stat.textContent='0';
    return;
  }
  const index=buildBoxIndex(pg);

  // Parti ordinate per modifica di destinazione (una sola scansione)
  const partsByBox=new Map();
  pg.connections.forEach(c=>{
    if(c.disconnected) return;
    let arr=partsByBox.get(c.targetBoxId);
    if(!arr){ arr=[]; partsByBox.set(c.targetBoxId,arr); }
    arr.push(c);
  });
  partsByBox.forEach(arr=>arr.sort((a,b)=>(a._multiIndex||0)-(b._multiIndex||0)));

  // Letture di layout raggruppate: un solo reflow invece di uno per strada
  const rectCache=new Map();
  const rectOf=id=>{
    if(rectCache.has(id)) return rectCache.get(id);
    const el=document.getElementById(id);
    const r=el?el.getBoundingClientRect():null;
    rectCache.set(id,r);
    return r;
  };

  const segs=[];
  pg.connections.forEach(cn=>{
    if(cn.disconnected) return;
    const info=index.get(cn.srcBoxId);
    if(!info) return;
    const srcCard=rectOf('card-'+cn.srcBoxId);
    if(!srcCard) return;

    const parts=partsByBox.get(cn.srcBoxId)||[];
    const outPart=parts.length ? parts[(cn.srcSpaceIndex||0)%parts.length] : null;
    // il colore della strada dipende ESCLUSIVAMENTE dalla priorita della parte da cui parte (a sinistra)
    const cp = outPart ? (outPart.failed ? 'failed' : (outPart.priority||'p1')) : 'p1';
    if(cp==='failed') return;
    const outRect=outPart ? rectOf('dot-out-'+outPart.id) : null;
    let x1,y1;
    if(outRect){
      x1=outRect.left+outRect.width/2-vr.left;
      y1=outRect.top+outRect.height/2-vr.top;
    } else {
      x1=srcCard.right-vr.left;
      y1=srcCard.top+srcCard.height/2-vr.top;
    }

    const inRect=rectOf('dot-in-'+cn.id);
    let x2,y2;
    if(inRect){
      x2=inRect.left+inRect.width/2-vr.left;
      y2=inRect.top+inRect.height/2-vr.top;
    } else {
      const tc=rectOf('card-'+cn.targetBoxId);
      if(!tc) return;
      x2=tc.left-vr.left;
      y2=tc.top+tc.height/2-vr.top;
    }
    segs.push({id:cn.id,x1,y1,x2,y2,cp});
  });

  const activeSet=(activeHoverPath&&activeHoverPath.length)?new Set(activeHoverPath):null;
  const frag=document.createDocumentFragment();
  segs.forEach(s=>{
    const dx=Math.max(Math.abs(s.x2-s.x1)*.4,40);
    const p=document.createElementNS('http://www.w3.org/2000/svg','path');
    p.setAttribute('d',`M ${Math.round(s.x1)} ${Math.round(s.y1)} C ${Math.round(s.x1+dx)} ${Math.round(s.y1)}, ${Math.round(s.x2-dx)} ${Math.round(s.y2)}, ${Math.round(s.x2)} ${Math.round(s.y2)}`);
    const pcolor=s.cp==='p2'?'#3b82f6':s.cp==='p3'?'#a855f7':s.cp==='p4'?'#eab308':s.cp==='failed'?'#ef4444':'#22c55e';
    const popacity=s.cp==='p1'?1:s.cp==='p2'?0.8:s.cp==='p3'?0.6:s.cp==='p4'?0.4:s.cp==='failed'?0.5:1;
    p.setAttribute('class','connection-line'+(activeSet?(activeSet.has(s.id)?' highlighted':' dimmed'):''));
    p.setAttribute('stroke',pcolor);
    p.setAttribute('stroke-opacity',popacity);
    p.setAttribute('data-conn-id',s.id);
    frag.appendChild(p);
  });
  svg.appendChild(frag);

  document.getElementById('statPaths').textContent=segs.length;
  updateSpaceHighlight();
}
// Illumina strade e schede coinvolte: nessun ridisegno completo a ogni passaggio
function updateSpaceHighlight(){
  const set=new Set(activeHoverPath||[]);
  document.querySelectorAll('.space-card[data-conn-id]').forEach(el=>{
    const on=set.has(el.dataset.connId);
    if(el.classList.contains('space-active')!==on) el.classList.toggle('space-active',on);
  });
}
function applyHoverHighlight(){
  const set=(activeHoverPath&&activeHoverPath.length)?new Set(activeHoverPath):null;
  document.querySelectorAll('#svg-canvas path.connection-line').forEach(p=>{
    const on=!!set && set.has(p.getAttribute('data-conn-id'));
    p.classList.toggle('highlighted', on);
    p.classList.toggle('dimmed', !!set && !on);
  });
  updateSpaceHighlight();
}
let hoverFrame=0;
function scheduleHoverHighlight(){
  if(hoverFrame) return;
  hoverFrame=requestAnimationFrame(()=>{ hoverFrame=0; applyHoverHighlight(); });
}
function hoverConn(cid){ const pg=getCurrentPage(); activeHoverPath=tracePathToRoot(cid,pg); scheduleHoverHighlight(); }
function leaveConn(){ activeHoverPath=[]; scheduleHoverHighlight(); }

function tracePathToRoot(start,pg){
  const path=[start];
  let cur=pg.connections.find(c=>c.id===start);
  while(cur){
    // risale dallo parte di uscita giusto, non sempre dal primo della modifica
    const srcSpaces=boxSpaces(pg,cur.srcBoxId);
    if(!srcSpaces.length) break;
    const inc=srcSpaces[(cur.srcSpaceIndex||0)%srcSpaces.length];
    if(!inc) break;
    path.push(inc.id);
    cur=inc;
  }
  return path;
}

// ===== ZOOM & PAN =====
let scale = 1;
let panX = 0;
let panY = 0;
let isPanning = false;
let startX = 0, startY = 0;
let pendingRedraw = false;
let panDeltaX = 0, panDeltaY = 0;

// Limiti e sensibilità dello zoom
const MIN_SCALE = 0.2;
const MAX_SCALE = 3.0;
const ZOOM_FACTOR = 1.12;

function clampScale(value){ return Math.min(Math.max(MIN_SCALE, value), MAX_SCALE); }

function updateTransform(){
  const cont = document.getElementById('diagramContainer');
  if(cont) cont.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
}

// Ridisegna le strade al massimo una volta per frame (pan e zoom fluidi)
function scheduleConnectionsRedraw(){
  if(pendingRedraw) return;
  pendingRedraw = true;
  requestAnimationFrame(()=>{ pendingRedraw = false; drawSVGConnections(); });
}

// Zoom mantenendo sotto il puntatore lo stesso punto del diagramma
function zoomAt(newScale, clientX, clientY){
  const target = clampScale(newScale);
  if(Math.abs(target - scale) < 0.0001) return;
  const rect = document.getElementById('viewport').getBoundingClientRect();
  const mouseX = clientX - rect.left;
  const mouseY = clientY - rect.top;
  const factor = target / scale;
  panX = mouseX - (mouseX - panX) * factor;
  panY = mouseY - (mouseY - panY) * factor;
  scale = target;
  const svg = document.getElementById('svg-canvas');
  if(svg) svg.style.transform = '';
  panDeltaX = 0; panDeltaY = 0;
  updateTransform();
  scheduleConnectionsRedraw();
}

function resetZoom(){
  scale = 1;
  panX = 0;
  panY = 0;
  panDeltaX = 0; panDeltaY = 0;
  const svgReset = document.getElementById('svg-canvas');
  if(svgReset) svgReset.style.transform = '';
  updateTransform();
  scheduleConnectionsRedraw();
}

function startPan(e){
  if(e.button !== 0) return;
  if(e.target.closest('.box-card') || e.target.closest('.space-card') || e.target.closest('.modal-overlay') || e.target.closest('button') || e.target.closest('input')) return;
  isPanning = true;
  startX = e.clientX;
  startY = e.clientY;
  panDeltaX = 0;
  panDeltaY = 0;
  const svg = document.getElementById('svg-canvas');
  if(svg) svg.style.transform = 'translate(0px, 0px)';
  document.getElementById('viewport').classList.add('panning');
}

function doPan(e){
  if(!isPanning) return;
  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  // Direzioni invertite: il diagramma segue il puntatore
  panX = panX + dx;
  panY = panY + dy;
  panDeltaX += dx;
  panDeltaY += dy;
  startX = e.clientX;
  startY = e.clientY;
  updateTransform();
  // Le strade seguono il puntatore con la stessa traslazione: nessun ridisegno per frame
  const svg = document.getElementById('svg-canvas');
  if(svg) svg.style.transform = `translate(${panDeltaX}px, ${panDeltaY}px)`;
}

function endPan(){
  if(!isPanning) return;
  isPanning = false;
  document.getElementById('viewport').classList.remove('panning');
  const svg = document.getElementById('svg-canvas');
  if(svg) svg.style.transform = '';
  drawSVGConnections();
}

// Lo zoom avviene con la rotella del mouse (e col pinch del trackpad)
document.getElementById('viewport').addEventListener('wheel', function(e){
  e.preventDefault();
  const factor = e.deltaY > 0 ? 1 / ZOOM_FACTOR : ZOOM_FACTOR;
  zoomAt(scale * factor, e.clientX, e.clientY);
}, {passive:false});

// Pan con Pointer Events + cattura: il movimento resta agganciato al cursore
const viewportEl = document.getElementById('viewport');
viewportEl.addEventListener('pointerdown', function(e){
  startPan(e);
  if(isPanning){ try{ viewportEl.setPointerCapture(e.pointerId); }catch(err){} }
});
viewportEl.addEventListener('pointermove', doPan);
viewportEl.addEventListener('pointerup', endPan);
viewportEl.addEventListener('pointercancel', endPan);

// Doppio click sullo sfondo: reimposta la vista
document.getElementById('viewport').addEventListener('dblclick', function(e){
  if(e.target.closest('.box-card') || e.target.closest('.space-card') || e.target.closest('button') || e.target.closest('input') || e.target.closest('.modal-overlay')) return;
  resetZoom();
});

// ===== STICKY LAYOUT =====
function syncStickyOffsets(){
  const toolbar=document.querySelector('.toolbar');
  const tabBar=document.querySelector('.tab-bar');
  const progress=document.querySelector('.progress-bar');
  if(!toolbar||!tabBar||!progress) return;
  const toolbarHeight=toolbar.getBoundingClientRect().height;
  tabBar.style.top=toolbarHeight+'px';
  progress.style.top=(toolbarHeight+tabBar.getBoundingClientRect().height)+'px';
}

// ===== EVENTS =====
window.addEventListener('resize', ()=>{ drawSVGConnections(); syncStickyOffsets(); });
document.addEventListener('DOMContentLoaded', ()=>{
  initSupabase();
  initAppState();
  if (supabaseClient) connectCloud(true);
  syncStickyOffsets();
  // Auto-salvataggio continuo ogni 30 secondi (backup di sicurezza)
  setInterval(() => {
    try { saveAppState(); } catch (e) {}
  }, 30000);
});

// Salva in locale e rimuove la presenza alla chiusura della pagina.
window.addEventListener('pagehide', ()=>{
  try { captureLocalChanges(); localStorage.setItem('cascade_diagram_app', JSON.stringify(appState)); } catch (e) {}
  leavePresence();
});