# -*- coding: utf-8 -*-
"""
Cascade Bridge - ponte bidirezionale tra "Diagramma Cascata" e Fusion 360.

Cosa fa:
  * carica il diagramma da Supabase (stesso progetto dell'app web) o da un
    file "ponte" JSON esportato dall'app;
  * crea/aggiorna i parametri utente di Fusion con i 5 parametri globali;
  * se un parametro viene rinominato, rinomina il parametro Fusion: Fusion
    aggiorna automaticamente tutte le espressioni che lo usano;
  * legge i valori da Fusion e li riscrive nel diagramma (e su Supabase);
  * collega i file delle varianti e li inserisce nel modello (STEP, IGES,
    SAT, SMT, F3D, DXF).

L'add-in non contiene chiavi segrete: usa la chiave publishable/anon gia'
pubblica nel progetto Supabase.
"""

import adsk.core
import adsk.fusion

import csv
import io
import json
import math
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

# --------------------------------------------------------------------------
# Costanti
# --------------------------------------------------------------------------

ADDIN_DIR = os.path.dirname(os.path.realpath(__file__))
PALETTE_DIR = os.path.join(ADDIN_DIR, 'palette')
DATA_DIR = os.path.join(os.path.expanduser('~'), 'CascadeBridge')
SETTINGS_FILE = os.path.join(DATA_DIR, 'settings.json')
CACHE_FILE = os.path.join(DATA_DIR, 'last_bridge.json')
EXPORT_DIR = os.path.join(DATA_DIR, 'exports')

PALETTE_ID = 'CascadeBridgePalette'
PALETTE_NAME = 'Cascade Bridge'
CMD_ID = 'CascadeBridgeShow'
CMD_NAME = 'Cascade Bridge'
PANEL_ID = 'SolidScriptsAddinsPanel'

DEFAULT_DIAGRAM_ID = '00000000-0000-0000-0000-000000000000'
DEFAULT_NAMES = ['Parametro A', 'Parametro B', 'Parametro C', 'Parametro D', 'Parametro E']
SYNC_GROUP = 'CascadeBridge'
SYNC_ATTR = 'param_map'

DEFAULT_SETTINGS = {
    'project_dir': '',
    'supabase_url': '',
    'supabase_key': '',
    'diagram_id': DEFAULT_DIAGRAM_ID,
    'unit': 'mm',
    'auto_rename': True,
    'auto_refresh': True,
    'variant_files': {},
    'last_page_id': '',
    'last_part_id': ''
}

_handlers = []
_app = None
_ui = None
_settings = None
_bridge = None
_selected_page = None
_selected_part = None
_last_log = []
_clock = {'wall': 0, 'counter': 0}


# --------------------------------------------------------------------------
# Utilità generali
# --------------------------------------------------------------------------

def _ensure_dirs():
    for folder in (DATA_DIR, EXPORT_DIR):
        try:
            if not os.path.isdir(folder):
                os.makedirs(folder)
        except Exception:
            pass


def _log(text, level='info'):
    entry = {
        'time': time.strftime('%H:%M:%S'),
        'level': level,
        'text': str(text)
    }
    _last_log.append(entry)
    if len(_last_log) > 60:
        del _last_log[:-60]
    try:
        print('[Cascade Bridge] {}'.format(text))
    except Exception:
        pass


def _now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _next_stamp():
    now = int(time.time() * 1000)
    if now > _clock['wall']:
        _clock['wall'] = now
        _clock['counter'] = 0
    else:
        _clock['counter'] += 1
    return [_clock['wall'], _clock['counter'], 'fusion_addin']


def _deep_copy(value):
    try:
        return json.loads(json.dumps(value))
    except Exception:
        return value


def _read_json_file(path):
    with io.open(path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def _write_json_file(path, value):
    folder = os.path.dirname(path)
    if folder and not os.path.isdir(folder):
        os.makedirs(folder)
    with io.open(path, 'w', encoding='utf-8') as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2))


# --------------------------------------------------------------------------
# Impostazioni e configurazione
# --------------------------------------------------------------------------

def _load_settings():
    global _settings
    _ensure_dirs()
    data = dict(DEFAULT_SETTINGS)
    try:
        if os.path.isfile(SETTINGS_FILE):
            saved = _read_json_file(SETTINGS_FILE)
            if isinstance(saved, dict):
                data.update(saved)
    except Exception:
        _log('Impostazioni non leggibili: {}'.format(traceback.format_exc()), 'warn')
    if not isinstance(data.get('variant_files'), dict):
        data['variant_files'] = {}
    if not isinstance(data.get('diagram_id'), str) or not data.get('diagram_id'):
        data['diagram_id'] = DEFAULT_DIAGRAM_ID
    _settings = data


def _save_settings():
    try:
        _write_json_file(SETTINGS_FILE, _settings)
    except Exception:
        _log('Impostazioni non salvate: {}'.format(traceback.format_exc()), 'warn')


def _project_config(folder):
    info = {}
    folder = (folder or '').strip()
    if not folder:
        return info
    config_path = os.path.join(folder, 'supabase-config.js')
    try:
        if os.path.isfile(config_path):
            text = io.open(config_path, 'r', encoding='utf-8', errors='ignore').read()
            match = re.search(r"url\s*:\s*['\"]([^'\"]+)['\"]", text)
            if match:
                info['url'] = match.group(1).strip().rstrip('/')
            match = re.search(r"(?:anonKey|anon_key|key)\s*:\s*['\"]([^'\"]+)['\"]", text)
            if match:
                info['key'] = match.group(1).strip()
    except Exception:
        pass
    app_path = os.path.join(folder, 'app.js')
    try:
        if os.path.isfile(app_path):
            text = io.open(app_path, 'r', encoding='utf-8', errors='ignore').read()
            match = re.search(r"CLOUD_DIAGRAM_ID\s*=\s*['\"]([^'\"]+)['\"]", text)
            if match:
                info['diagram_id'] = match.group(1).strip()
    except Exception:
        pass
    return info


def _cloud_settings():
    url = (_settings.get('supabase_url') or '').strip().rstrip('/')
    key = (_settings.get('supabase_key') or '').strip()
    diagram_id = (_settings.get('diagram_id') or '').strip()
    info = {}
    if not url or not key or not diagram_id or diagram_id == DEFAULT_DIAGRAM_ID:
        info = _project_config(_settings.get('project_dir'))
    url = url or info.get('url', '')
    key = key or info.get('key', '')
    if not diagram_id or diagram_id == DEFAULT_DIAGRAM_ID:
        diagram_id = info.get('diagram_id') or diagram_id or DEFAULT_DIAGRAM_ID
    return url, key, diagram_id


def _cloud_ready():
    url, key, _diagram_id = _cloud_settings()
    return bool(url and key)


def _http_json(method, url, headers, body=None):
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    request = urllib.request.Request(url, data=data, method=method)
    for name, value in headers.items():
        request.add_header(name, value)
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            raw = response.read().decode('utf-8')
    except urllib.error.HTTPError as exc:
        detail = ''
        try:
            detail = exc.read().decode('utf-8')[:500]
        except Exception:
            pass
        raise RuntimeError('Supabase HTTP {}: {}'.format(exc.code, detail or exc.reason))
    except urllib.error.URLError as exc:
        raise RuntimeError('Connessione a Supabase non riuscita: {}'.format(exc.reason))
    if not raw.strip():
        return []
    return json.loads(raw)


def _fetch_cloud_row():
    url, key, diagram_id = _cloud_settings()
    if not url or not key:
        raise RuntimeError('Supabase non configurato: apri Impostazioni e inserisci URL e anon key (oppure scegli la cartella del progetto).')
    endpoint = '{}/rest/v1/diagrams?id=eq.{}&select=name,state,updated_at'.format(
        url, urllib.parse.quote(diagram_id, safe=''))
    rows = _http_json('GET', endpoint, {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Accept': 'application/json'
    })
    if not rows:
        raise RuntimeError('Diagramma non trovato nel cloud (id {}). Controlla l\'ID diagramma.'.format(diagram_id))
    row = rows[0]
    if not _valid_state(row.get('state')):
        raise RuntimeError('Il diagramma nel cloud e\' vuoto o non valido. Aprilo nell\'app web e salva almeno una pagina.')
    return row


def _patch_cloud_row(state, expected_updated_at, name):
    url, key, diagram_id = _cloud_settings()
    endpoint = '{}/rest/v1/diagrams?id=eq.{}&updated_at=eq.{}'.format(
        url,
        urllib.parse.quote(diagram_id, safe=''),
        urllib.parse.quote(str(expected_updated_at or ''), safe=''))
    rows = _http_json('PATCH', endpoint, {
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Prefer': 'return=representation'
    }, {
        'name': name or 'Diagramma Cascata',
        'state': state,
        'updated_at': _now_iso()
    })
    if not rows:
        return None
    return rows[0]


# --------------------------------------------------------------------------
# Stato del diagramma
# --------------------------------------------------------------------------

def _valid_state(state):
    if not isinstance(state, dict):
        return False
    pages = state.get('pages')
    if not isinstance(pages, list) or not pages:
        return False
    for page in pages:
        if not isinstance(page, dict):
            return False
        if not isinstance(page.get('phases'), list) or not isinstance(page.get('connections'), list):
            return False
    return True


def _global_names(state):
    names = state.get('tableParamNames') if isinstance(state, dict) else None
    out = []
    for index in range(5):
        value = ''
        if isinstance(names, list) and index < len(names) and names[index] is not None:
            value = str(names[index]).strip()
        out.append(value or DEFAULT_NAMES[index])
    return out


def _find_page(state, page_id):
    pages = (state or {}).get('pages') or []
    for page in pages:
        if page.get('id') == page_id:
            return page
    return pages[0] if pages else None


def _find_conn(page, part_id):
    if not page:
        return None
    for conn in page.get('connections') or []:
        if conn.get('id') == part_id:
            return conn
    return None


def _box_index(page):
    index = {}
    for phase in (page or {}).get('phases') or []:
        for level in phase.get('levels') or []:
            for box in level.get('boxes') or []:
                index[box.get('id')] = {
                    'box': box,
                    'phase': phase,
                    'level': level
                }
    return index


def _conn_values(conn, names):
    values = []
    table = conn.get('tableValues') if isinstance(conn, dict) else None
    for index in range(5):
        item = table[index] if isinstance(table, list) and index < len(table) else None
        values.append(str(item.get('value', '')) if isinstance(item, dict) else '')
    return values


def _part_summary(page, conn, index):
    target = index.get(conn.get('targetBoxId')) or {}
    source = index.get(conn.get('srcBoxId')) or {}
    target_box = target.get('box') or {}
    source_box = source.get('box') or {}
    target_phase = target.get('phase') or {}
    target_level = target.get('level') or {}
    return {
        'id': conn.get('id'),
        'file': conn.get('file') or '',
        'title': target_box.get('title') or 'Parte',
        'source': source_box.get('title') or '',
        'phase': target_phase.get('name') or '',
        'zone': target_level.get('name') or '',
        'priority': 'FAIL' if conn.get('failed') else str(conn.get('priority') or 'p1').upper(),
        'failed': bool(conn.get('failed')),
        'score': conn.get('score', 0),
        'notes': conn.get('notes') or '',
        'disconnected': bool(conn.get('disconnected'))
    }


def _ensure_selection():
    global _selected_page, _selected_part
    state = _bridge.get('state') if _bridge else None
    if not _valid_state(state):
        _selected_page = None
        _selected_part = None
        return
    pages = state.get('pages') or []
    page_ids = [page.get('id') for page in pages]
    if _selected_page not in page_ids:
        saved = _settings.get('last_page_id')
        _selected_page = saved if saved in page_ids else page_ids[0]
    page = _find_page(state, _selected_page)
    connections = [c for c in (page.get('connections') or []) if not c.get('disconnected')]
    if not connections:
        connections = page.get('connections') or []
    part_ids = [c.get('id') for c in connections]
    if _selected_part not in part_ids:
        saved = _settings.get('last_part_id')
        _selected_part = saved if saved in part_ids else (part_ids[0] if part_ids else None)
    if _selected_page != _settings.get('last_page_id'):
        _settings['last_page_id'] = _selected_page or ''
        _save_settings()
    if _selected_part != _settings.get('last_part_id'):
        _settings['last_part_id'] = _selected_part or ''
        _save_settings()


def _variant_key(page_id, part_id):
    return '{}/{}'.format(page_id or '', part_id or '')


def _variant_path():
    if not _selected_page or not _selected_part:
        return ''
    return _settings.get('variant_files', {}).get(_variant_key(_selected_page, _selected_part), '')


# --------------------------------------------------------------------------
# Ponte: caricamento, cache, scrittura
# --------------------------------------------------------------------------

def _load_payload(payload, source, path=''):
    global _bridge, _selected_page, _selected_part
    if not isinstance(payload, dict):
        raise RuntimeError('File JSON non valido.')
    if isinstance(payload.get('state'), dict):
        state = payload.get('state')
        envelope = payload
    elif payload.get('pages'):
        state = payload
        envelope = None
    else:
        raise RuntimeError('Il file non contiene un diagramma (manca "state" o "pages").')
    if not _valid_state(state):
        raise RuntimeError('Il diagramma non e\' valido: servono almeno una pagina con fasi e strade.')

    supabase = payload.get('supabase') if isinstance(payload.get('supabase'), dict) else {}
    diagram_id = payload.get('diagramId') or _settings.get('diagram_id') or DEFAULT_DIAGRAM_ID

    _bridge = {
        'format': 'cascade-fusion-bridge',
        'version': payload.get('version') or 1,
        'diagramId': diagram_id,
        'supabase': {
            'url': (supabase.get('url') or '').strip(),
            'anonKey': (supabase.get('anonKey') or supabase.get('key') or '').strip()
        },
        'state': state,
        'updatedAt': payload.get('updatedAt') or payload.get('exportedAt') or '',
        'source': source,
        'path': path or '',
        'envelope': envelope,
        'name': payload.get('name') or _page_name(state)
    }

    # Un file ponte contiene le coordinate del progetto da cui e' stato
    # esportato: usale quando si carica un file o si aggiorna dal cloud.
    use_payload_cloud = source in ('file', 'cloud')
    if _bridge['supabase']['url'] and (use_payload_cloud or not _settings.get('supabase_url')):
        _settings['supabase_url'] = _bridge['supabase']['url']
    if _bridge['supabase']['anonKey'] and (use_payload_cloud or not _settings.get('supabase_key')):
        _settings['supabase_key'] = _bridge['supabase']['anonKey']
    incoming_id = str(payload.get('diagramId') or '').strip()
    if incoming_id and (not _settings.get('diagram_id') or _settings.get('diagram_id') == DEFAULT_DIAGRAM_ID):
        _settings['diagram_id'] = incoming_id
    _save_settings()

    _selected_page = None
    _selected_part = None
    _ensure_selection()
    _save_cache()
    if _settings.get('auto_rename'):
        try:
            renamed = _auto_rename_fusion()
            if renamed:
                _log('Rinominati in Fusion: {}'.format(', '.join(renamed)))
        except Exception:
            _log('Rinomina automatica non eseguita: {}'.format(traceback.format_exc()), 'warn')


def _page_name(state):
    pages = (state or {}).get('pages') or []
    if pages and isinstance(pages[0], dict):
        return pages[0].get('name') or 'Diagramma Cascata'
    return 'Diagramma Cascata'


def _save_cache():
    if not _bridge:
        return
    try:
        _write_json_file(CACHE_FILE, {
            'format': 'cascade-fusion-bridge',
            'version': _bridge.get('version') or 1,
            'app': 'Diagramma Cascata',
            'diagramId': _bridge.get('diagramId'),
            'supabase': _bridge.get('supabase'),
            'state': _bridge.get('state'),
            'updatedAt': _bridge.get('updatedAt'),
            'savedAt': _now_iso()
        })
    except Exception:
        _log('Cache non salvata: {}'.format(traceback.format_exc()), 'warn')


def _read_cache():
    try:
        if os.path.isfile(CACHE_FILE):
            return _read_json_file(CACHE_FILE)
    except Exception:
        pass
    return None


def _write_bridge_file():
    if not _bridge or not _bridge.get('path'):
        return
    path = _bridge['path']
    envelope = _bridge.get('envelope')
    if isinstance(envelope, dict) and isinstance(envelope.get('state'), dict):
        envelope['state'] = _bridge.get('state')
        envelope['diagramId'] = _bridge.get('diagramId')
        envelope['version'] = _bridge.get('version') or 1
        envelope['exportedAt'] = envelope.get('exportedAt') or _now_iso()
        if _bridge.get('supabase'):
            envelope['supabase'] = _bridge.get('supabase')
        _write_json_file(path, envelope)
    else:
        _write_json_file(path, _bridge.get('state'))


def _sync_meta(state):
    meta = state.get('__sync')
    if not isinstance(meta, dict):
        meta = {'v': 1, 'clocks': {}, 'tombs': {}}
        state['__sync'] = meta
    if not isinstance(meta.get('clocks'), dict):
        meta['clocks'] = {}
    if not isinstance(meta.get('tombs'), dict):
        meta['tombs'] = {}
    if not meta.get('v'):
        meta['v'] = 1
    return meta


def _bump(state, path):
    meta = _sync_meta(state)
    meta['clocks'][path] = _next_stamp()


def _apply_changes(state, page_id, part_id, names, values):
    """Applica rinomine globali e valori della parte selezionata allo stato.

    Ritorna (numero modifiche, parte_trovata).
    """
    changed = 0
    page = _find_page(state, page_id)
    conn = _find_conn(page, part_id)
    part_found = conn is not None
    current_names = _global_names(state)

    clean_names = {}
    for key, value in (names or {}).items():
        try:
            index = int(key)
        except Exception:
            continue
        if 0 <= index < 5:
            text = str(value if value is not None else '').strip()
            if text:
                clean_names[index] = text

    if clean_names:
        new_names = list(current_names)
        name_changed = False
        for index, value in clean_names.items():
            if new_names[index] != value:
                new_names[index] = value
                name_changed = True
        if name_changed:
            state['tableParamNames'] = new_names
            _bump(state, 'tableParamNames')
            changed += 1
            for pg in state.get('pages') or []:
                for connection in pg.get('connections') or []:
                    table = connection.get('tableValues')
                    if not isinstance(table, list):
                        table = []
                        connection['tableValues'] = table
                    for index in range(5):
                        while len(table) <= index:
                            filler = new_names[len(table)] if len(table) < 5 else ''
                            table.append({'name': filler, 'value': ''})
                        item = table[index]
                        if not isinstance(item, dict):
                            item = {'name': new_names[index], 'value': ''}
                            table[index] = item
                        if item.get('name') != new_names[index]:
                            item['name'] = new_names[index]
                            _bump(state, 'pages/{}/connections/{}/tableValues'.format(
                                pg.get('id'), connection.get('id')))

    # Dopo una rinomina i nomi correnti sono quelli nuovi: non ripristinare
    # i vecchi nomi sulla parte selezionata.
    effective_names = _global_names(state)
    if conn is not None and values:
        table = conn.get('tableValues')
        if not isinstance(table, list):
            table = []
            conn['tableValues'] = table
        part_changed = False
        for index in range(5):
            while len(table) <= index:
                filler = effective_names[len(table)] if len(table) < 5 else ''
                table.append({'name': filler, 'value': ''})
            item = table[index]
            if not isinstance(item, dict):
                item = {'name': effective_names[index], 'value': ''}
                table[index] = item
            if item.get('name') != effective_names[index]:
                item['name'] = effective_names[index]
                part_changed = True
        for key, value in values.items():
            try:
                index = int(key)
            except Exception:
                continue
            if 0 <= index < 5:
                text = str(value if value is not None else '')
                if table[index].get('value') != text:
                    table[index]['value'] = text
                    part_changed = True
        if part_changed:
            _bump(state, 'pages/{}/connections/{}/tableValues'.format(
                page.get('id'), conn.get('id')))
            changed += 1

    return changed, part_found


def _push_updates(names, values):
    """Scrive rinomine/valori nella sorgente attiva (cloud, file o cache)."""
    if not _bridge or not _valid_state(_bridge.get('state')):
        raise RuntimeError('Nessun diagramma caricato. Carica un file ponte o collegati al cloud.')
    source = _bridge.get('source')
    if source == 'cloud' and _cloud_ready():
        last_error = None
        for _attempt in range(3):
            row = _fetch_cloud_row()
            state = _deep_copy(row.get('state'))
            if not _valid_state(state):
                raise RuntimeError('Il diagramma cloud non e\' valido.')
            changed, part_found = _apply_changes(state, _selected_page, _selected_part, names, values)
            if changed == 0:
                _bridge['state'] = state
                _bridge['updatedAt'] = row.get('updated_at') or _now_iso()
                _save_cache()
                return {'changed': 0, 'source': 'cloud', 'partFound': part_found}
            updated = _patch_cloud_row(state, row.get('updated_at'), _page_name(state))
            if updated is None:
                last_error = 'conflitto di sincronizzazione'
                continue
            _bridge['state'] = state
            _bridge['updatedAt'] = updated.get('updated_at') or _now_iso()
            _bridge['source'] = 'cloud'
            _save_cache()
            _ensure_selection()
            return {'changed': changed, 'source': 'cloud', 'partFound': part_found}
        raise RuntimeError('Impossibile salvare sul cloud ({}). Riprova.'.format(last_error or 'errore sconosciuto'))

    state = _deep_copy(_bridge.get('state'))
    changed, part_found = _apply_changes(state, _selected_page, _selected_part, names, values)
    _bridge['state'] = state
    _bridge['updatedAt'] = _now_iso()
    if _bridge.get('path'):
        _write_bridge_file()
        source = 'file'
    else:
        source = 'cache'
    _save_cache()
    _ensure_selection()
    return {'changed': changed, 'source': source, 'partFound': part_found}


# --------------------------------------------------------------------------
# Fusion: parametri
# --------------------------------------------------------------------------

def _get_design(required=True):
    if not _app:
        raise RuntimeError('Fusion non disponibile.')
    design = adsk.fusion.Design.cast(_app.activeProduct)
    if not design and required:
        raise RuntimeError('Apri un modello Fusion (Design) prima di sincronizzare i parametri.')
    return design


def _sanitize_name(raw, fallback):
    text = str(raw if raw is not None else '').strip()
    text = re.sub(r'[^0-9A-Za-z_]', '_', text)
    text = re.sub(r'_+', '_', text).strip('_')
    if not text:
        text = fallback
    if not text:
        text = 'Parametro'
    if text[0].isdigit():
        text = 'P_' + text
    return text[:120]


def _all_parameter_names(design):
    names = set()
    try:
        params = design.allParameters
        for index in range(params.count):
            try:
                names.add(params.item(index).name)
            except Exception:
                pass
    except Exception:
        pass
    return names


def _param_token(param):
    try:
        return str(param.entityToken or '')
    except Exception:
        return ''


def _read_mapping(design):
    result = {}
    try:
        attr = design.rootComponent.attributes.itemByName(SYNC_GROUP, SYNC_ATTR)
        if not attr:
            return result
        data = json.loads(attr.value)
        slots = data.get('slots') if isinstance(data, dict) else data
        if not isinstance(slots, list):
            return result
        for item in slots:
            if not isinstance(item, dict):
                continue
            try:
                slot = int(item.get('slot'))
            except Exception:
                continue
            if 0 <= slot < 5:
                result[slot] = {
                    'diagram': str(item.get('diagram') or ''),
                    'fusion': str(item.get('fusion') or ''),
                    'token': str(item.get('token') or '')
                }
    except Exception:
        pass
    return result


def _write_mapping(design, entries):
    try:
        payload = {
            'version': 1,
            'updatedAt': _now_iso(),
            'slots': [{
                'slot': entry.get('slot'),
                'diagram': entry.get('diagram') or '',
                'fusion': entry.get('fusion') or '',
                'token': entry.get('token') or ''
            } for entry in entries]
        }
        text_value = json.dumps(payload, ensure_ascii=False)
        attributes = design.rootComponent.attributes
        attr = attributes.itemByName(SYNC_GROUP, SYNC_ATTR)
        if attr:
            attr.value = text_value
        else:
            attributes.add(SYNC_GROUP, SYNC_ATTR, text_value)
    except Exception:
        _log('Mappa parametri non salvata nel modello: {}'.format(traceback.format_exc()), 'warn')


def _find_param(design, mapping, slot, name):
    """Trova il parametro di uno slot: prima per token, poi per nome."""
    info = mapping.get(slot) or {}
    token = info.get('token') or ''
    if token:
        try:
            user_params = design.userParameters
            for index in range(user_params.count):
                candidate = user_params.item(index)
                if _param_token(candidate) == token:
                    return candidate
        except Exception:
            pass
    mapped = info.get('fusion') or ''
    for candidate_name in (mapped, _sanitize_name(name, 'Parametro_' + chr(65 + slot))):
        if not candidate_name:
            continue
        try:
            param = design.userParameters.itemByName(candidate_name)
            if param is not None:
                return param
        except Exception:
            pass
    return None


def _resolve_slots(design, names, mapping):
    """Trova/decide il nome Fusion di ogni slot, evitando duplicati."""
    all_names = _all_parameter_names(design)
    claimed = set()
    entries = []
    for slot in range(5):
        raw = names[slot] if slot < len(names) else DEFAULT_NAMES[slot]
        base = _sanitize_name(raw, 'Parametro_' + chr(65 + slot))
        info = mapping.get(slot) or {}
        mapped = info.get('fusion') or ''
        token = info.get('token') or ''
        param = _find_param(design, mapping, slot, raw)
        if param is not None and param.name in claimed:
            param = None
        current_name = param.name if param else None
        target = base
        if target != current_name:
            while target in all_names or target in claimed:
                match = re.match(r'^(.*)_([0-9]+)$', target)
                if match and match.group(1) == base:
                    target = '{}_{}'.format(base, int(match.group(2)) + 1)
                else:
                    target = base + '_2'
        all_names.add(target)
        claimed.add(target)
        entries.append({
            'slot': slot,
            'diagram': str(raw or '').strip() or DEFAULT_NAMES[slot],
            'fusion': target,
            'mapped_fusion': mapped,
            'token': _param_token(param) if param else token,
            'param': param
        })
    return entries


def _expression_for(text, unit):
    value = str(text if text is not None else '').strip().replace(',', '.')
    if not value:
        return ''
    try:
        float(value)
        return (value + ' ' + unit).strip() if unit else value
    except ValueError:
        return value


def _param_value_text(param):
    expression = ''
    try:
        expression = str(param.expression or '').strip()
    except Exception:
        expression = ''
    try:
        number = float(expression.replace(',', '.'))
        return _format_number(number)
    except Exception:
        pass
    try:
        raw = float(param.value)
    except Exception:
        return expression
    unit = str(param.unit or '').strip().lower()
    try:
        if unit == 'mm':
            return _format_number(raw * 10.0)
        if unit == 'cm':
            return _format_number(raw)
        if unit == 'm':
            return _format_number(raw / 100.0)
        if unit == 'in':
            return _format_number(raw / 2.54)
        if unit == 'ft':
            return _format_number(raw / 30.48)
        if unit == 'deg':
            return _format_number(raw * 180.0 / math.pi)
        if unit == 'rad':
            return _format_number(raw)
        return _format_number(raw)
    except Exception:
        return expression


def _format_number(value):
    text = '{:.6f}'.format(float(value)).rstrip('0').rstrip('.')
    return text if text else '0'


def _apply_fusion_slots(slots):
    """Crea/rinomina/aggiorna i parametri Fusion per gli slot ricevuti."""
    design = _get_design()
    unit = str(_settings.get('unit') or 'mm')
    base_names = _global_names(_bridge.get('state')) if _bridge else list(DEFAULT_NAMES)
    names = list(base_names)
    values = {}
    for item in slots or []:
        try:
            slot = int(item.get('slot'))
        except Exception:
            continue
        if not 0 <= slot < 5:
            continue
        name = str(item.get('name') if item.get('name') is not None else '').strip()
        if name:
            names[slot] = name
        values[slot] = str(item.get('value') if item.get('value') is not None else '')

    mapping = _read_mapping(design)
    entries = _resolve_slots(design, names, mapping)
    actions = {}
    errors = {}
    for entry in entries:
        actions[entry['slot']] = []
        errors[entry['slot']] = []
    renamed = []
    zero = _expression_for('0', unit) or '0'

    # 1) crea prima tutti i parametri mancanti: cosi' le formule possono
    #    riferirsi anche a parametri di slot successivi.
    for entry in entries:
        if entry['param'] is None:
            try:
                entry['param'] = design.userParameters.add(
                    entry['fusion'],
                    adsk.core.ValueInput.createByString(zero),
                    unit,
                    'Cascade Bridge'
                )
                actions[entry['slot']].append('creato')
            except Exception as exc:
                errors[entry['slot']].append('creazione: {}'.format(exc))

    # 2) rinomina: Fusion aggiorna tutte le espressioni che usano il nome.
    for entry in entries:
        param = entry['param']
        if param is None:
            continue
        if param.name != entry['fusion']:
            previous = param.name
            try:
                param.name = entry['fusion']
            except Exception as exc:
                errors[entry['slot']].append('rinomina: {}'.format(exc))
            if param.name == entry['fusion']:
                actions[entry['slot']].append('rinominato')
                if previous != param.name:
                    renamed.append('{} -> {}'.format(previous, param.name))
            else:
                errors[entry['slot']].append('rinomina non applicata (nome gia\' usato?)')
        entry['fusion'] = param.name
        entry['token'] = _param_token(param)

    # 3) valori per la variante selezionata.
    for entry in entries:
        param = entry['param']
        if param is None:
            continue
        value_text = values.get(entry['slot'], '')
        if not str(value_text).strip():
            continue
        expression = _expression_for(value_text, unit)
        if not expression:
            continue
        try:
            param.expression = expression
            actions[entry['slot']].append('valore')
        except Exception as exc:
            errors[entry['slot']].append('valore "{}": {}'.format(value_text, exc))

    _write_mapping(design, entries)
    results = []
    for entry in entries:
        slot = entry['slot']
        param = entry['param']
        action = ' + '.join(actions[slot]) if actions[slot] else 'invariato'
        if param is None and errors[slot]:
            action = 'errore'
        results.append({
            'slot': slot,
            'diagramName': entry['diagram'],
            'fusionName': param.name if param is not None else entry['fusion'],
            'action': action,
            'error': '; '.join(errors[slot])
        })
    return {
        'results': results,
        'renamed': renamed,
        'designName': _design_name(design),
        'parameterCount': design.userParameters.count
    }


def _auto_rename_fusion():
    """Rinomina in Fusion i parametri gia' presenti, senza crearne di nuovi."""
    if not _bridge or not _valid_state(_bridge.get('state')):
        return []
    design = _get_design(required=False)
    if not design:
        return []
    names = _global_names(_bridge.get('state'))
    mapping = _read_mapping(design)
    entries = _resolve_slots(design, names, mapping)
    renamed = []
    for entry in entries:
        param = entry['param']
        if param is None:
            continue
        if param.name != entry['fusion']:
            previous = param.name
            try:
                param.name = entry['fusion']
            except Exception as exc:
                _log('Rinomina {} non riuscita: {}'.format(previous, exc), 'warn')
            if param.name == entry['fusion'] and previous != param.name:
                renamed.append('{} -> {}'.format(previous, param.name))
        entry['fusion'] = param.name
    _write_mapping(design, entries)
    return renamed


def _read_fusion_slots():
    design = _get_design()
    base_names = _global_names(_bridge.get('state')) if _bridge else list(DEFAULT_NAMES)
    mapping = _read_mapping(design)
    entries = _resolve_slots(design, base_names, mapping)
    slots = []
    renamed_slots = {}
    for entry in entries:
        param = entry['param']
        slot = entry['slot']
        diagram_name = entry['diagram']
        if param is not None:
            entry['fusion'] = param.name
            mapped_name = entry.get('mapped_fusion') or ''
            if mapped_name and param.name != mapped_name:
                diagram_name = param.name
                renamed_slots[slot] = diagram_name
            slots.append({
                'slot': slot,
                'diagramName': diagram_name,
                'fusionName': param.name,
                'value': _param_value_text(param),
                'exists': True,
                'unit': param.unit or ''
            })
        else:
            slots.append({
                'slot': slot,
                'diagramName': diagram_name,
                'fusionName': entry['fusion'],
                'value': '',
                'exists': False,
                'unit': ''
            })
    _write_mapping(design, entries)
    return {
        'slots': slots,
        'renamed': renamed_slots,
        'designName': _design_name(design)
    }


def _design_name(design):
    try:
        if _app and _app.activeDocument:
            return _app.activeDocument.name
    except Exception:
        pass
    try:
        return design.parentDocument.name
    except Exception:
        return 'Design attivo'


# --------------------------------------------------------------------------
# File delle varianti
# --------------------------------------------------------------------------

def _open_path(path):
    path = str(path or '')
    if not path or not os.path.exists(path):
        raise RuntimeError('Percorso non trovato: {}'.format(path))
    if sys.platform.startswith('win'):
        os.startfile(path)
    elif sys.platform == 'darwin':
        subprocess.Popen(['open', path])
    else:
        subprocess.Popen(['xdg-open', path])


def _pick_file(title, filter_text):
    dialog = _ui.createFileDialog()
    dialog.title = title
    if filter_text:
        dialog.filter = filter_text
    dialog.isMultiSelectEnabled = False
    if dialog.showOpen() != adsk.core.DialogResults.DialogOK:
        return ''
    return dialog.filename


def _pick_folder(title):
    try:
        dialog = _ui.createFolderDialog()
        dialog.title = title
        if dialog.showDialog() != adsk.core.DialogResults.DialogOK:
            return ''
        return dialog.folder
    except Exception:
        raise RuntimeError('Selettore cartelle non disponibile: scrivi il percorso a mano nelle impostazioni.')


def _insert_variant_file(path):
    design = _get_design()
    root = design.rootComponent
    manager = _app.importManager
    extension = os.path.splitext(path)[1].lower()
    options = None
    if extension in ('.step', '.stp'):
        options = manager.createSTEPImportOptions(path)
    elif extension in ('.iges', '.igs'):
        options = manager.createIGESImportOptions(path)
    elif extension == '.sat':
        options = manager.createSATImportOptions(path)
    elif extension == '.smt':
        options = manager.createSMTImportOptions(path)
    elif extension == '.f3d':
        options = manager.createFusionArchiveImportOptions(path)
    elif extension == '.dxf':
        options = manager.createDXF2DImportOptions(path, root.xZConstructionPlane)
    if options is None:
        raise RuntimeError('Formato non supportato. Usa STEP, IGES, SAT, SMT, F3D o DXF.')
    try:
        options.isViewFit = True
    except Exception:
        pass
    manager.importToTarget(options, root)


def _export_variants_csv():
    state = _bridge.get('state') if _bridge else None
    if not _valid_state(state):
        raise RuntimeError('Nessun diagramma caricato.')
    page = _find_page(state, _selected_page)
    if not page:
        raise RuntimeError('Pagina non trovata.')
    index = _box_index(page)
    names = _global_names(state)
    filename = 'varianti_{}_{}.csv'.format(
        re.sub(r'[^0-9A-Za-z]+', '_', page.get('name') or 'diagramma').strip('_') or 'diagramma',
        time.strftime('%Y%m%d_%H%M'))
    path = os.path.join(EXPORT_DIR, filename)
    with io.open(path, 'w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.writer(handle, delimiter=';')
        header = ['Pagina', 'Fase', 'Zona', 'Modifica', 'File variante', 'Priorita', 'Punteggio', 'Note']
        header += ['{} (nome)'.format(name) for name in names]
        header += ['{} (valore)'.format(name) for name in names]
        writer.writerow(header)
        for conn in page.get('connections') or []:
            summary = _part_summary(page, conn, index)
            values = _conn_values(conn, names)
            writer.writerow([
                page.get('name') or '',
                summary['phase'],
                summary['zone'],
                summary['title'],
                summary['file'],
                summary['priority'],
                summary['score'],
                summary['notes']
            ] + names + values)
    return path


# --------------------------------------------------------------------------
# UI state per la palette
# --------------------------------------------------------------------------

def _ui_state():
    state = _bridge.get('state') if _bridge else None
    valid = _valid_state(state)
    url, key, diagram_id = _cloud_settings()
    payload = {
        'ok': True,
        'hasBridge': valid,
        'source': _bridge.get('source') if _bridge else '',
        'updatedAt': _bridge.get('updatedAt') if _bridge else '',
        'diagramId': diagram_id,
        'diagramName': _page_name(state) if valid else '',
        'cloudConfigured': bool(url and key),
        'projectDir': _settings.get('project_dir') or '',
        'dataFolder': DATA_DIR,
        'settings': {
            'projectDir': _settings.get('project_dir') or '',
            'supabaseUrl': (url or ''),
            'supabaseKey': (key or ''),
            'diagramId': diagram_id,
            'unit': _settings.get('unit') or 'mm',
            'autoRename': bool(_settings.get('auto_rename')),
            'autoRefresh': bool(_settings.get('auto_refresh'))
        },
        'hasDesign': False,
        'designName': '',
        'parameterCount': 0,
        'mappingCount': 0,
        'pages': [],
        'pageId': _selected_page,
        'partId': _selected_part,
        'parts': [],
        'selectedPart': None,
        'params': [],
        'tree': [],
        'messages': list(reversed(_last_log[-14:])),
        'variantPath': '',
        'variantExists': False
    }

    design = None
    mapping = {}
    try:
        design = _get_design(required=False)
        if design:
            payload['hasDesign'] = True
            payload['designName'] = _design_name(design)
            payload['parameterCount'] = design.userParameters.count
            mapping = _read_mapping(design)
            payload['mappingCount'] = len(mapping)
    except Exception:
        _log('Lettura design non riuscita: {}'.format(traceback.format_exc()), 'warn')

    if valid:
        pages = state.get('pages') or []
        payload['pages'] = [{'id': page.get('id'), 'name': page.get('name') or 'Senza nome',
                             'parts': len([c for c in (page.get('connections') or []) if not c.get('disconnected')])}
                            for page in pages]
        try:
            _ensure_selection()
            page = _find_page(state, _selected_page)
            index = _box_index(page)
            names = _global_names(state)
            connections = [c for c in (page.get('connections') or []) if not c.get('disconnected')]
            payload['parts'] = [_part_summary(page, conn, index) for conn in connections]
            conn = _find_conn(page, _selected_part)
            if conn is not None:
                payload['selectedPart'] = _part_summary(page, conn, index)
                values = _conn_values(conn, names)
                for slot in range(5):
                    param = None
                    mapped_name = ''
                    if design:
                        entry = mapping.get(slot) or {}
                        mapped_name = entry.get('fusion') or ''
                        param = _find_param(design, mapping, slot, names[slot])
                    payload['params'].append({
                        'slot': slot,
                        'name': names[slot],
                        'value': values[slot],
                        'fusionName': param.name if param else (
                            mapped_name or _sanitize_name(names[slot], 'Parametro_' + chr(65 + slot))),
                        'exists': param is not None,
                        'unit': (param.unit if param else _settings.get('unit') or 'mm') or ''
                    })
                variant = _variant_path()
                payload['variantPath'] = variant
                payload['variantExists'] = bool(variant and os.path.exists(variant))

            tree = []
            for phase in page.get('phases') or []:
                levels = []
                for level in phase.get('levels') or []:
                    boxes = []
                    for box in level.get('boxes') or []:
                        box_parts = []
                        for conn in page.get('connections') or []:
                            if conn.get('targetBoxId') == box.get('id') and not conn.get('disconnected'):
                                box_parts.append(_part_summary(page, conn, index))
                        boxes.append({
                            'id': box.get('id'),
                            'title': box.get('title') or '',
                            'priority': box.get('priority') or 'p1',
                            'parts': box_parts
                        })
                    levels.append({'id': level.get('id'), 'name': level.get('name') or '', 'boxes': boxes})
                tree.append({
                    'id': phase.get('id'),
                    'name': phase.get('name') or '',
                    'color': phase.get('color') or '#22c55e',
                    'levels': levels
                })
            payload['tree'] = tree
        except Exception:
            payload['ok'] = False
            payload['error'] = traceback.format_exc()
            _log('Stato palette non costruito: {}'.format(traceback.format_exc()), 'warn')

    return payload


# --------------------------------------------------------------------------
# Azioni dalla palette
# --------------------------------------------------------------------------

def _flash(level, text):
    return {'flash': {'level': level, 'text': text}}


def _require_bridge():
    if not _bridge or not _valid_state(_bridge.get('state')):
        raise RuntimeError('Nessun diagramma caricato. Usa "Carica JSON" o configura il cloud.')
    return _bridge


def _select_from_payload(payload):
    global _selected_page, _selected_part
    page_id = payload.get('pageId')
    part_id = payload.get('partId')
    if page_id:
        _selected_page = page_id
        _selected_part = None
    if part_id:
        _selected_part = part_id
    _ensure_selection()
    _save_settings()


def _handle_action(action, payload):
    global _selected_page, _selected_part

    if action == 'ready':
        if _bridge is None:
            cached = _read_cache()
            if cached:
                try:
                    _load_payload(cached, 'cache')
                except Exception:
                    _log('Cache non caricata: {}'.format(traceback.format_exc()), 'warn')
        if _bridge:
            _ensure_selection()
        return _flash('info', 'Ponte pronto.')

    if action == 'refreshCloud':
        if not _cloud_ready():
            if _bridge and _bridge.get('path'):
                _load_payload(_read_json_file(_bridge['path']), 'file', _bridge['path'])
                return {} if payload.get('silent') else _flash('success', 'File ponte ricaricato.')
            raise RuntimeError('Cloud non configurato: apri Impostazioni o carica un file ponte.')
        row = _fetch_cloud_row()
        payload_state = {
            'format': 'cascade-fusion-bridge',
            'version': 1,
            'diagramId': _cloud_settings()[2],
            'supabase': {'url': _cloud_settings()[0], 'anonKey': _cloud_settings()[1]},
            'state': row.get('state'),
            'updatedAt': row.get('updated_at'),
            'name': row.get('name')
        }
        _load_payload(payload_state, 'cloud')
        if payload.get('silent'):
            return {}
        return _flash('success', 'Diagramma aggiornato dal cloud.')

    if action == 'loadJson':
        path = _pick_file('Apri diagramma o ponte Fusion', 'JSON (*.json)')
        if not path:
            return {}
        _load_payload(_read_json_file(path), 'file', path)
        message = 'Caricato: {}'.format(os.path.basename(path))
        if _cloud_ready():
            message += ' Premi Aggiorna per collegarti al cloud.'
        return _flash('success', message)

    if action == 'selectPage':
        _select_from_payload(payload)
        return {}

    if action == 'selectPart':
        _select_from_payload(payload)
        return {}

    if action == 'saveSettings':
        data = payload.get('settings') if isinstance(payload.get('settings'), dict) else payload
        _settings['project_dir'] = str(data.get('projectDir') or '').strip()
        _settings['supabase_url'] = str(data.get('supabaseUrl') or '').strip().rstrip('/')
        _settings['supabase_key'] = str(data.get('supabaseKey') or '').strip()
        diagram_id = str(data.get('diagramId') or '').strip()
        _settings['diagram_id'] = diagram_id or DEFAULT_DIAGRAM_ID
        unit = str(data.get('unit') if data.get('unit') is not None else 'mm').strip()
        _settings['unit'] = unit
        _settings['auto_rename'] = bool(data.get('autoRename'))
        _settings['auto_refresh'] = bool(data.get('autoRefresh'))
        info = _project_config(_settings.get('project_dir'))
        if not _settings['supabase_url'] and info.get('url'):
            _settings['supabase_url'] = info['url']
        if not _settings['supabase_key'] and info.get('key'):
            _settings['supabase_key'] = info['key']
        if _settings['diagram_id'] == DEFAULT_DIAGRAM_ID and info.get('diagram_id'):
            _settings['diagram_id'] = info['diagram_id']
        _save_settings()
        if _settings.get('auto_rename'):
            try:
                _auto_rename_fusion()
            except Exception:
                pass
        return _flash('success', 'Impostazioni salvate.')

    if action == 'pickProjectFolder':
        folder = _pick_folder('Scegli la cartella del progetto Diagramma Cascata')
        if not folder:
            return {}
        _settings['project_dir'] = folder
        info = _project_config(folder)
        if info.get('url'):
            _settings['supabase_url'] = info['url']
        if info.get('key'):
            _settings['supabase_key'] = info['key']
        if info.get('diagram_id'):
            _settings['diagram_id'] = info['diagram_id']
        _save_settings()
        return _flash('success', 'Cartella collegata. Configurazione Supabase letta dal progetto.')

    if action == 'applyFusion':
        _require_bridge()
        slots = payload.get('slots') or []
        result = _apply_fusion_slots(slots)
        renamed = result.get('renamed') or []
        text = 'Fusion aggiornato ({} parametri).'.format(len(result.get('results') or []))
        if renamed:
            text += ' Rinominati: {}.'.format(', '.join(renamed))
        errors = [r for r in result.get('results') or [] if r.get('error')]
        if errors:
            return _flash('warn', text + ' Alcuni parametri hanno errori: ' + '; '.join(
                '{}: {}'.format(item.get('fusionName'), item.get('error')) for item in errors))
        return _flash('success', text)

    if action == 'saveDiagram':
        _require_bridge()
        slots = payload.get('slots') or []
        names = {}
        values = {}
        for item in slots:
            try:
                slot = int(item.get('slot'))
            except Exception:
                continue
            names[slot] = item.get('name')
            values[slot] = item.get('value')
        result = _push_updates(names, values)
        _save_settings()
        where = 'cloud' if result.get('source') == 'cloud' else (
            'file ponte' if result.get('source') == 'file' else 'cache locale')
        text = 'Diagramma salvato ({}).'.format(where)
        if not result.get('partFound'):
            text += ' Attenzione: la parte selezionata non esiste piu\' nel diagramma.'
        return _flash('success', text)

    if action == 'applyBoth':
        _require_bridge()
        slots = payload.get('slots') or []
        names = {}
        values = {}
        for item in slots:
            try:
                slot = int(item.get('slot'))
            except Exception:
                continue
            names[slot] = item.get('name')
            values[slot] = item.get('value')
        push_result = _push_updates(names, values)
        where = 'cloud' if push_result.get('source') == 'cloud' else (
            'file ponte' if push_result.get('source') == 'file' else 'cache locale')
        try:
            fusion_result = _apply_fusion_slots(slots)
        except Exception as exc:
            return _flash('warn', 'Diagramma salvato ({}), ma Fusion non aggiornato: {}'.format(where, exc))
        errors = [r for r in fusion_result.get('results') or [] if r.get('error')]
        renamed = fusion_result.get('renamed') or []
        text = 'Diagramma salvato ({}) e Fusion aggiornato.'.format(where)
        if renamed:
            text += ' Rinominati: {}.'.format(', '.join(renamed))
        if errors:
            return _flash('warn', text + ' Errori: ' + '; '.join(
                '{}: {}'.format(item.get('fusionName'), item.get('error')) for item in errors))
        return _flash('success', text)

    if action == 'readFusion':
        _require_bridge()
        data = _read_fusion_slots()
        slots = data.get('slots') or []
        names = {}
        values = {}
        for item in slots:
            try:
                slot = int(item.get('slot'))
            except Exception:
                continue
            names[slot] = item.get('diagramName')
            values[slot] = item.get('value')
        actual = [item for item in slots if item.get('exists')]
        if not actual:
            return _flash('warn', 'Nessun parametro Fusion trovato. Premi prima "Solo Fusion" per crearli.')
        result = _push_updates(names, values)
        _write_mapping_from_state()
        where = 'cloud' if result.get('source') == 'cloud' else (
            'file ponte' if result.get('source') == 'file' else 'cache locale')
        return _flash('success', 'Letti {} parametri da Fusion e salvati nel diagramma ({}).'.format(
            len(actual), where))

    if action == 'pickVariantFile':
        _require_bridge()
        path = _pick_file('Scegli il file della variante', 'File supportati (*.step;*.stp;*.iges;*.igs;*.sat;*.smt;*.f3d;*.dxf;*.py;*.json;*.txt);;Tutti i file (*.*)')
        if not path:
            return {}
        if not _selected_page or not _selected_part:
            raise RuntimeError('Seleziona prima una parte.')
        _settings.setdefault('variant_files', {})[_variant_key(_selected_page, _selected_part)] = path
        _save_settings()
        return _flash('success', 'File collegato: {}'.format(os.path.basename(path)))

    if action == 'openVariantFile':
        path = _variant_path()
        if not path:
            raise RuntimeError('Nessun file collegato a questa parte.')
        _open_path(path)
        return {}

    if action == 'insertVariantFile':
        path = _variant_path()
        if not path:
            raise RuntimeError('Nessun file collegato a questa parte.')
        _insert_variant_file(path)
        return _flash('success', 'File inserito nel modello: {}'.format(os.path.basename(path)))

    if action == 'exportVariants':
        path = _export_variants_csv()
        return _flash('success', 'Elenco esportato: {}'.format(path))

    if action == 'openDataFolder':
        _ensure_dirs()
        _open_path(DATA_DIR)
        return {}

    if action == 'pickBridgeFile':
        path = _pick_file('Apri il ponte Fusion (.json)', 'JSON (*.json)')
        if not path:
            return {}
        _load_payload(_read_json_file(path), 'file', path)
        message = 'Ponte caricato: {}'.format(os.path.basename(path))
        if _cloud_ready():
            message += ' Premi Aggiorna per collegarti al cloud.'
        return _flash('success', message)

    if action == 'refreshNames':
        _require_bridge()
        renamed = _auto_rename_fusion()
        if renamed:
            return _flash('success', 'Rinominati in Fusion: {}.'.format(', '.join(renamed)))
        return _flash('info', 'Nomi gia\' allineati.')

    return _flash('warn', 'Azione sconosciuta: {}'.format(action))


def _require_cloud_or_file():
    if _cloud_ready():
        return
    if _bridge and _bridge.get('path'):
        return
    raise RuntimeError('Cloud non configurato e nessun file ponte caricato. Apri Impostazioni o carica un JSON.')


def _write_mapping_from_state():
    design = _get_design(required=False)
    if not design or not _bridge:
        return
    names = _global_names(_bridge.get('state'))
    mapping = _read_mapping(design)
    entries = _resolve_slots(design, names, mapping)
    for entry in entries:
        if entry['param'] is not None:
            entry['fusion'] = entry['param'].name
    _write_mapping(design, entries)


# --------------------------------------------------------------------------
# Palette ed eventi
# --------------------------------------------------------------------------

class _HtmlHandler(adsk.core.HTMLEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        try:
            html_args = adsk.core.HTMLEventArgs.cast(args)
            payload = {}
            if html_args.data:
                try:
                    payload = json.loads(html_args.data)
                except Exception:
                    payload = {}
            extra = _handle_action(html_args.action, payload)
            if not isinstance(extra, dict):
                extra = {}
        except Exception:
            error_text = traceback.format_exc()
            _log(error_text, 'error')
            extra = {'ok': False, 'error': error_text, 'flash': {'level': 'error', 'text': str(sys.exc_info()[1])}}
        _send_state(extra)


class _PaletteClosedHandler(adsk.core.UserInterfaceGeneralEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        try:
            _send_state({'flash': {'level': 'info', 'text': 'Palette chiusa.'}})
        except Exception:
            pass


class _ShowCommandExecuteHandler(adsk.core.CommandEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        try:
            _show_palette()
        except Exception:
            if _ui:
                _ui.messageBox('Cascade Bridge:\n{}'.format(traceback.format_exc()))


class _ShowCommandCreatedHandler(adsk.core.CommandCreatedEventHandler):
    def __init__(self):
        super().__init__()

    def notify(self, args):
        try:
            command = args.command
            on_execute = _ShowCommandExecuteHandler()
            command.execute.add(on_execute)
            _handlers.append(on_execute)
        except Exception:
            if _ui:
                _ui.messageBox('Cascade Bridge:\n{}'.format(traceback.format_exc()))


def _send_state(extra=None):
    payload = {}
    try:
        payload = _ui_state()
    except Exception:
        payload = {
            'ok': False,
            'error': traceback.format_exc(),
            'pages': [],
            'params': [],
            'messages': list(reversed(_last_log[-14:]))
        }
    if isinstance(extra, dict):
        payload.update(extra)
    try:
        palette = _ui.palettes.itemById(PALETTE_ID) if _ui else None
        if palette:
            palette.sendInfoToHTML('state', json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


def _show_palette():
    html_path = os.path.join(PALETTE_DIR, 'index.html')
    if not os.path.isfile(html_path):
        raise RuntimeError('File palette mancante: {}'.format(html_path))
    palette = _ui.palettes.itemById(PALETTE_ID)
    if not palette:
        palette = _ui.palettes.add(PALETTE_ID, PALETTE_NAME, html_path, True, True, True, 480, 760, True)
        try:
            palette.dockingState = adsk.core.PaletteDockingStates.PaletteDockStateRight
        except Exception:
            pass
        on_html = _HtmlHandler()
        palette.incomingFromHTML.add(on_html)
        _handlers.append(on_html)
        on_closed = _PaletteClosedHandler()
        palette.closed.add(on_closed)
        _handlers.append(on_closed)
    palette.isVisible = True


# --------------------------------------------------------------------------
# Start / stop
# --------------------------------------------------------------------------

def run(context):
    global _app, _ui
    try:
        _app = adsk.core.Application.get()
        _ui = _app.userInterface
        _load_settings()

        command_definition = _ui.commandDefinitions.itemById(CMD_ID)
        if not command_definition:
            command_definition = _ui.commandDefinitions.addButtonDefinition(
                CMD_ID, CMD_NAME,
                'Apre il ponte tra il Diagramma Cascata e Fusion: parametri, valori e file delle varianti.',
                ''
            )
            on_created = _ShowCommandCreatedHandler()
            command_definition.commandCreated.add(on_created)
            _handlers.append(on_created)

        panel = _ui.allToolbarPanels.itemById(PANEL_ID)
        if panel and not panel.controls.itemById(CMD_ID):
            panel.controls.addCommand(command_definition)

        _log('Cascade Bridge avviato. Clicca "Cascade Bridge" nel pannello Script e Add-in.')
    except Exception:
        if _ui:
            _ui.messageBox('Cascade Bridge non avviato:\n{}'.format(traceback.format_exc()))


def stop(context):
    try:
        if _ui:
            palette = _ui.palettes.itemById(PALETTE_ID)
            if palette:
                palette.deleteMe()
            panel = _ui.allToolbarPanels.itemById(PANEL_ID)
            if panel:
                control = panel.controls.itemById(CMD_ID)
                if control:
                    control.deleteMe()
            command_definition = _ui.commandDefinitions.itemById(CMD_ID)
            if command_definition:
                command_definition.deleteMe()
    except Exception:
        pass
