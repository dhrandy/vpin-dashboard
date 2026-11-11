"""Local Game night state and conservative, previewable theme imports."""
import json
import re
import secrets
import time
from auth import AuthError
from toplist import normalize_name, normalize_maker

THEMES = [f'decade-{y}' for y in range(1960, 2030, 10)] + [
    'old-school', 'random', 'maker', 'originals', 'score-chase', 'overlooked', 'favorites',
    'fresh', 'no-score', 'color', 'top100', 'game-shows', 'movie', 'tv',
    'sci-fi', 'sports', 'music', 'horror']


def init(db):
    db.executescript('''CREATE TABLE IF NOT EXISTS game_nights
        (user_id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS night_themes
        (id TEXT PRIMARY KEY, payload TEXT NOT NULL);''')


def theme_id(value):
    return isinstance(value, str) and (value in THEMES or re.fullmatch(r'custom-[a-f0-9]{16}|maker-[a-z0-9-]{1,80}', value))


def default():
    return {'revision': 0, 'cap': 10, 'enabled': True, 'showImports': True, 'hiddenThemes': [], 'night': None}


def read(store, user):
    with store.db() as db:
        row = db.execute('SELECT payload FROM game_nights WHERE user_id=?', (user,)).fetchone()
    return {**default(), **json.loads(row[0])} if row else default()


def update(store, user, body):
    if not isinstance(body, dict) or type(body.get('revision')) is not int:
        raise AuthError('A saved revision is required.')
    with store.lock, store.db() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT payload FROM game_nights WHERE user_id=?', (user,)).fetchone()
        data = {**default(), **json.loads(row[0])} if row else default()
        if body['revision'] != data['revision']:
            raise AuthError('Game night changed on another tab or device. Reloaded the saved list; try again.', 409)
        action = body.get('action')
        if action == 'settings' and set(body) == {'revision', 'action', 'enabled', 'showImports', 'hiddenThemes'}:
            hidden = body['hiddenThemes']
            if (type(body['enabled']) is not bool or type(body['showImports']) is not bool
                    or not isinstance(hidden, list) or len(hidden) > 60
                    or any(not theme_id(x) for x in hidden) or len(set(hidden)) != len(hidden)):
                raise AuthError('Valid Game night settings required.')
            data.update({k: body[k] for k in ('enabled', 'showImports', 'hiddenThemes')})
        elif action == 'cap' and set(body) == {'revision', 'action', 'cap'}:
            if type(body['cap']) is not int or body['cap'] not in (10, 15, 20):
                raise AuthError('Choose a cap of 10, 15 or 20 tables.')
            data['cap'] = body['cap']
        elif action == 'new' and set(body) == {'revision', 'action', 'theme', 'maker', 'ids'}:
            ids = body['ids']
            if (not theme_id(body['theme']) or not isinstance(body['maker'], str) or len(body['maker']) > 160
                    or not isinstance(ids, list) or not 1 <= len(ids) <= data['cap']
                    or any(type(i) is not int or not 0 < i <= 2147483647 for i in ids)
                    or len(set(ids)) != len(ids)):
                raise AuthError('Choose distinct tables within your selected cap from a valid theme.')
            data['night'] = {'theme': body['theme'], 'maker': body['maker'], 'ids': ids, 'checked': [], 'cap': data['cap'], 'createdAt': int(time.time())}
        elif action == 'check' and set(body) == {'revision', 'action', 'id', 'checked'}:
            night = data['night']
            if (not night or type(body['id']) is not int or body['id'] not in night['ids']
                    or type(body['checked']) is not bool):
                raise AuthError('Choose a table in the saved night.')
            checks = set(night['checked'])
            (checks.add if body['checked'] else checks.discard)(body['id'])
            night['checked'] = [i for i in night['ids'] if i in checks]
        else:
            raise AuthError('Valid Game night action required.')
        data['revision'] += 1
        db.execute('INSERT INTO game_nights VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload', (user, json.dumps(data)))
    return data


def text(value, limit):
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or re.search(r'[<>\x00-\x1f\x7f\ud800-\udfff]', value)):
        raise AuthError('Use plain text names without HTML or control characters.')
    return value.strip()


def parse_import(source):
    try:
        size = len(source.encode('utf-8')) if isinstance(source, str) else 32769
    except UnicodeError:
        raise AuthError('Use valid UTF-8 text.')
    if size > 32768:
        raise AuthError('Use a text or JSON list under 32 KB.')
    if source.lstrip().startswith('{'):
        try:
            data = json.loads(source)
        except (ValueError, RecursionError):
            raise AuthError('That JSON list could not be read.')
        if not isinstance(data, dict) or set(data) != {'name', 'tables'}:
            raise AuthError('JSON needs only name and tables.')
    else:
        lines = [x.strip() for x in source.splitlines() if x.strip()]
        if len(lines) < 2:
            raise AuthError('Put the theme name first, then one table title per line.')
        data = {'name': lines[0], 'tables': lines[1:]}
    name = text(data['name'], 80)
    if not isinstance(data['tables'], list) or not 1 <= len(data['tables']) <= 100:
        raise AuthError('Use between 1 and 100 table titles.')
    entries = []
    for raw in data['tables']:
        if isinstance(raw, str):
            entry = {'name': text(raw, 240), 'maker': '', 'year': None}
        elif isinstance(raw, dict) and set(raw) <= {'name', 'maker', 'year'} and 'name' in raw:
            if not isinstance(raw.get('maker', ''), str):
                raise AuthError('Maker must be plain text.')
            maker = text(raw['maker'], 120) if raw.get('maker') else ''
            year = raw.get('year')
            if year is not None and (type(year) is not int or not 1800 <= year <= 2199):
                raise AuthError('Table years must be numbers from 1800 to 2199.')
            entry = {'name': text(raw['name'], 240), 'maker': maker, 'year': year}
        else:
            raise AuthError('Each table needs a title or name/maker/year object.')
        if not normalize_name(entry['name']):
            raise AuthError('Each table needs a readable title.')
        if entry in entries:
            raise AuthError('Remove duplicate table entries before importing.')
        entries.append(entry)
    return {'name': name, 'tables': entries}


def resolve(theme, tables):
    """Same normalized token containment as toplist; skip all ambiguity.

    Title-only imports are accepted only for a unique library candidate.
    Optional maker/year narrows candidates, never picks the first duplicate.
    """
    reports, ids = [], []
    for e in theme['tables']:
        tokens = set(normalize_name(e['name']).split())
        candidates = []
        for t in tables:
            if not tokens <= set(normalize_name(t.get('name')).split()):
                continue
            if e['maker'] and normalize_maker(e['maker']) != normalize_maker(t.get('maker')):
                continue
            if e['year'] is not None and (type(t.get('year')) is not int or abs(t['year'] - e['year']) > 1):
                continue
            candidates.append(t)
        if len(candidates) == 1:
            t = candidates[0]
            status = 'matched' if t['gameId'] not in ids else 'duplicate match'
            if status == 'matched':
                ids.append(t['gameId'])
            reports.append({'title': e['name'], 'status': status, 'gameId': t['gameId'], 'matchedTitle': t['name']})
        else:
            reports.append({'title': e['name'], 'status': 'ambiguous' if candidates else 'not found'})
    return {'name': theme['name'], 'gameIds': ids, 'report': reports}


def custom(store):
    with store.db() as db:
        return [{'id': r[0], **json.loads(r[1])} for r in db.execute('SELECT id,payload FROM night_themes ORDER BY id')]


def save_custom(store, body, tables):
    if not isinstance(body, dict) or set(body) != {'action', 'id', 'revision', 'source'}:
        raise AuthError('Valid theme import required.')
    if body['action'] not in ('preview', 'save') or type(body['revision']) is not int:
        raise AuthError('Valid theme action required.')
    theme = parse_import(body['source'])
    result = resolve(theme, tables)
    if body['action'] == 'preview':
        return result
    ident = body['id']
    if ident is not None and (not theme_id(ident) or not ident.startswith('custom-')):
        raise AuthError('Valid imported theme ID required.')
    with store.lock, store.db() as db:
        db.execute('BEGIN IMMEDIATE')
        if ident:
            row = db.execute('SELECT payload FROM night_themes WHERE id=?', (ident,)).fetchone()
            if not row:
                raise AuthError('Theme not found.', 404)
            revision = json.loads(row[0]).get('revision', 0)
            if body['revision'] != revision:
                raise AuthError('This theme changed. Close and reopen the editor.', 409)
        else:
            if db.execute('SELECT count(*) FROM night_themes').fetchone()[0] >= 20:
                raise AuthError('Keep at most 20 imported themes. Delete one first.')
            ident, revision = 'custom-' + secrets.token_hex(8), 0
        theme.update(source=body['source'], revision=revision + 1)
        db.execute('INSERT INTO night_themes VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload', (ident, json.dumps(theme)))
    return {'id': ident, **result}


def delete_custom(store, body):
    if (not isinstance(body, dict) or set(body) != {'action', 'id', 'revision'}
            or not theme_id(body['id']) or not body['id'].startswith('custom-') or type(body['revision']) is not int):
        raise AuthError('Valid imported theme required.')
    with store.lock, store.db() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT payload FROM night_themes WHERE id=?', (body['id'],)).fetchone()
        if not row:
            raise AuthError('Theme not found.', 404)
        if json.loads(row[0]).get('revision') != body['revision']:
            raise AuthError('This theme changed. Reload before deleting it.', 409)
        db.execute('DELETE FROM night_themes WHERE id=?', (body['id'],))
