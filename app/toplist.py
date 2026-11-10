"""Match the bundled curated top-tables list against the cabinet library.

Static data only: no network, no keys. Conservative: a table matches only
when its normalized name matches and maker or year agrees, so the section
never shows the wrong table.
"""
import json
import os
import re

MAKER_SYNONYMS = {
    'bally midway': 'bally',
    'midway': 'bally',
    'williams electronics': 'williams',
    'stern pinball': 'stern',
    'data east pinball': 'data east',
    'sega pinball': 'sega',
    'jersey jack pinball': 'jersey jack',
    'spooky pinball': 'spooky',
    'capcom pinball': 'capcom',
}

_VERSION_TAIL = re.compile(r'(?:\s+(?:v\d+(?:[ .]\d+)*|vpx|vpw|fs|ssf|dt|4k|b2s))+$', re.I)
_PARENS = re.compile(r'\([^)]*\)|\[[^\]]*\]')
_NON_ALNUM = re.compile(r'[^a-z0-9]+')


def normalize_name(name):
    if not isinstance(name, str):
        return ''
    text = name.lower().replace('&', ' and ')
    text = _PARENS.sub(' ', text)
    text = _NON_ALNUM.sub(' ', text).strip()
    text = re.sub(r'^jp s ', '', text)
    text = _VERSION_TAIL.sub('', text)
    return text.strip()


def normalize_maker(maker):
    if not isinstance(maker, str):
        return ''
    text = _NON_ALNUM.sub(' ', maker.lower()).strip()
    return MAKER_SYNONYMS.get(text, text)


def load_curated(path=None):
    path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'top_tables.json')
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    tables = data.get('tables') if isinstance(data, dict) else None
    if not isinstance(tables, list):
        return []
    out = []
    for entry in tables:
        if not isinstance(entry, dict):
            continue
        name, maker, year = entry.get('name'), entry.get('maker'), entry.get('year')
        if not isinstance(name, str) or not name.strip():
            continue
        out.append({
            'rank': entry.get('rank') if type(entry.get('rank')) is int else len(out) + 1,
            'name': name.strip(),
            'maker': maker if isinstance(maker, str) else '',
            'year': year if type(year) is int else None,
            'norm': normalize_name(name),
            'norm_maker': normalize_maker(maker),
        })
    return out


def _year_ok(a, b):
    return type(a) is int and type(b) is int and abs(a - b) <= 1


def match(curated, tables):
    """Return curated entries matched to library tables, ordered by rank.

    Each result: rank, name, maker, year, gameId, edition (his parenthetical
    edition tag, when he has one). Conservative on ambiguity.
    """
    by_name = {}
    for entry in curated:
        if entry['norm']:
            by_name.setdefault(entry['norm'], []).append(entry)
    used = set()
    results = []
    for table in tables if isinstance(tables, list) else []:
        if not isinstance(table, dict) or type(table.get('gameId')) is not int:
            continue
        norm = normalize_name(table.get('name'))
        candidates = [c for c in by_name.get(norm, []) if c['rank'] not in used]
        if not candidates:
            continue
        maker = normalize_maker(table.get('maker'))
        year = table.get('year') if type(table.get('year')) is int else None
        exact = [c for c in candidates if _year_ok(year, c['year']) and (not maker or not c['norm_maker'] or maker == c['norm_maker'])]
        if len(exact) == 1:
            pick = exact[0]
        elif len(candidates) == 1 and (_year_ok(year, candidates[0]['year']) or (maker and maker == candidates[0]['norm_maker'])):
            # Name matches; maker or year agrees. Never match when both disagree.
            pick = candidates[0]
        else:
            continue
        used.add(pick['rank'])
        edition = ''
        if isinstance(table.get('name'), str):
            m = _PARENS.search(table['name'])
            edition = m.group(0) if m else ''
        results.append({
            'rank': pick['rank'],
            'name': pick['name'],
            'maker': pick['maker'],
            'year': pick['year'],
            'gameId': table['gameId'],
            'edition': edition,
        })
    results.sort(key=lambda r: r['rank'])
    return results
