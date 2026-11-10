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


def _tokens(norm):
    return frozenset(t for t in norm.split() if t)


def _edition(raw_name, norm_maker):
    """His parenthetical edition tag, skipping maker/year parens like
    '(Bally 1995)' and '(Original 2026)'. '(Gold)' and '(Premium)' stay."""
    if not isinstance(raw_name, str):
        return ''
    for m in _PARENS.finditer(raw_name):
        group = m.group(0)
        inner = group[1:-1]
        if re.search(r'\b(19|20)\d{2}\b', inner):
            continue
        if normalize_maker(inner) and normalize_maker(inner) == norm_maker:
            continue
        return group
    return ''


def match(curated, tables):
    """Return curated entries matched to library tables, ordered by rank.

    Real cabinet names are messy: author tags, version tails and mod labels
    trail the actual title ('Shooting the Rapids Deluxe (Original 2026)
    TomBG v1.01'). Matching is token containment: every curated name token
    must appear in the table's normalized tokens, so extra author/version
    tokens cannot break a match. Maker or year then disambiguates. When the
    cabinet reports neither maker nor year, a match is allowed only when the
    containment is unique on both sides. Anything ambiguous is skipped.

    Each result: rank, name, maker, year, gameId, edition.
    """
    entries = []
    for e in curated:
        toks = _tokens(e.get('norm', ''))
        if toks:
            entries.append((e, toks))
    rows = []
    for t in tables if isinstance(tables, list) else []:
        if isinstance(t, dict) and type(t.get('gameId')) is int:
            rows.append((t, _tokens(normalize_name(t.get('name')))))

    # How many library tables contain each curated token set (fallback
    # uniqueness needs the whole library, not per-table candidates).
    containment = {}
    for _, ttoks in rows:
        for e, etoks in entries:
            if etoks <= ttoks:
                containment[e['rank']] = containment.get(e['rank'], 0) + 1

    used_ranks = set()
    results = []
    for t, ttoks in rows:
        cands = [(e, etoks) for e, etoks in entries if etoks <= ttoks and e['rank'] not in used_ranks]
        if not cands:
            continue
        maker = normalize_maker(t.get('maker'))
        year = t.get('year') if type(t.get('year')) is int else None

        def maker_ok(e):
            return not maker or not e['norm_maker'] or maker == e['norm_maker']

        pick = None
        strong = [e for e, _ in cands if _year_ok(year, e['year']) and maker_ok(e)]
        if len(strong) == 1:
            pick = strong[0]
        else:
            fair = [e for e, _ in cands if _year_ok(year, e['year']) or (maker and e['norm_maker'] and maker == e['norm_maker'])]
            if len(fair) == 1:
                pick = fair[0]
            elif year is None and not maker and len(cands) == 1:
                # Cabinet sent no maker and no year: allow only a
                # both-sides-unique containment.
                e = cands[0][0]
                if containment.get(e['rank']) == 1:
                    pick = e
        if pick is None:
            continue
        used_ranks.add(pick['rank'])
        results.append({
            'rank': pick['rank'],
            'name': pick['name'],
            'maker': pick['maker'],
            'year': pick['year'],
            'gameId': t['gameId'],
            'edition': _edition(t.get('name'), normalize_maker(t.get('maker'))),
        })
    results.sort(key=lambda r: r['rank'])
    return results
