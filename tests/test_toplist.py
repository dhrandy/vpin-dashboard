"""Matcher checks for the bundled top-tables list."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import toplist


def entry(rank, name, maker, year):
    return {'rank': rank, 'name': name, 'maker': maker, 'year': year,
            'norm': toplist.normalize_name(name), 'norm_maker': toplist.normalize_maker(maker)}


CURATED = [
    entry(1, 'The Addams Family', 'Bally', 1992),
    entry(2, 'Godzilla', 'Stern', 2021),
    entry(3, 'The Lord of the Rings', 'Stern', 2003),
    entry(4, 'Centaur', 'Bally', 1981),
    entry(5, 'Centaur II', 'Bally', 1983),
]


def table(game_id, name, maker=None, year=None):
    return {'gameId': game_id, 'name': name, 'maker': maker, 'year': year}


class NormalizeTests(unittest.TestCase):
    def test_edition_tags_and_punctuation(self):
        self.assertEqual(toplist.normalize_name('Godzilla (Premium)'), 'godzilla')
        self.assertEqual(toplist.normalize_name('AC/DC (LUCI Premium)'), 'ac dc')
        self.assertEqual(toplist.normalize_name("JP's The Lord of the Rings"), 'the lord of the rings')
        self.assertEqual(toplist.normalize_name('Fish Tales VPX v1.2'), 'fish tales')
        self.assertEqual(toplist.normalize_name('Elvira and the Party Monsters'), 'elvira and the party monsters')

    def test_maker_synonyms(self):
        self.assertEqual(toplist.normalize_maker('Bally Midway'), 'bally')
        self.assertEqual(toplist.normalize_maker('Williams Electronics'), 'williams')
        self.assertEqual(toplist.normalize_maker('Stern Pinball'), 'stern')


class MatchTests(unittest.TestCase):
    def test_exact_match(self):
        got = toplist.match(CURATED, [table(7, 'The Addams Family', 'Bally', 1992)])
        self.assertEqual([g['gameId'] for g in got], [7])
        self.assertEqual(got[0]['rank'], 1)

    def test_edition_variant_matches_and_keeps_label(self):
        got = toplist.match(CURATED, [table(9, 'Godzilla (Premium)', 'Stern', 2021)])
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]['edition'], '(Premium)')

    def test_author_prefix_matches(self):
        got = toplist.match(CURATED, [table(4, "JP's The Lord of the Rings", 'Stern', 2003)])
        self.assertEqual([g['rank'] for g in got], [3])

    def test_year_tolerance_one(self):
        self.assertEqual(len(toplist.match(CURATED, [table(1, 'The Addams Family', 'Bally', 1991)])), 1)
        self.assertEqual(toplist.match(CURATED, [table(1, 'The Addams Family', 'Gottlieb', 1995)]), [])

    def test_maker_and_year_disagree_stays_unmatched(self):
        self.assertEqual(toplist.match(CURATED, [table(1, 'The Addams Family', 'Stern', 2021)]), [])

    def test_maker_synonym_match(self):
        got = toplist.match(CURATED, [table(2, 'The Addams Family', 'Bally Midway', 1992)])
        self.assertEqual(len(got), 1)

    def test_ambiguous_name_picks_exact_year(self):
        got = toplist.match(CURATED, [table(5, 'Centaur', 'Bally', 1981)])
        self.assertEqual([g['rank'] for g in got], [4])
        dup = CURATED + [entry(6, 'Centaur', 'Bally', 1983)]
        self.assertEqual(toplist.match(dup, [table(5, 'Centaur', 'Bally', 1990)]), [])
        self.assertEqual([g['rank'] for g in toplist.match(dup, [table(5, 'Centaur', 'Bally', 1983)])], [6])

    def test_single_candidate_maker_agrees_matches(self):
        # Name matches and the maker agrees: a wrong year alone does not block.
        self.assertEqual([g['rank'] for g in toplist.match(CURATED, [table(5, 'Centaur', 'Bally', 1990)])], [4])

    def test_duplicate_curated_entries_match_once(self):
        tables = [table(1, 'The Addams Family', 'Bally', 1992), table(2, 'The Addams Family', 'Bally', 1992)]
        got = toplist.match(CURATED, tables)
        self.assertEqual(len(got), 1)

    def test_missing_and_junk_fields(self):
        self.assertEqual(toplist.match(CURATED, [{'gameId': 1}, {'name': 'Godzilla'}, None, 'x']), [])

    def test_results_sorted_by_rank(self):
        tables = [table(1, 'Godzilla', 'Stern', 2021), table(2, 'The Addams Family', 'Bally', 1992)]
        self.assertEqual([g['rank'] for g in toplist.match(CURATED, tables)], [1, 2])


class BundledListTests(unittest.TestCase):
    def test_bundled_file_loads_100_unique(self):
        curated = toplist.load_curated()
        self.assertEqual(len(curated), 100)
        norms = [c['norm'] for c in curated]
        self.assertEqual(len(set(norms)), 100)
        self.assertTrue(all(c['norm'] and c['norm_maker'] for c in curated))
        self.assertEqual([c['rank'] for c in curated], list(range(1, 101)))

    def test_bundled_file_is_ascii(self):
        raw = (Path(__file__).resolve().parents[1] / 'app' / 'top_tables.json').read_text(encoding='utf-8')
        self.assertTrue(all(ord(c) < 128 for c in raw))


if __name__ == '__main__':
    unittest.main()

class MessyNames(unittest.TestCase):
    def setUp(self):
        self.curated = toplist.load_curated()
        self.by = {e['name']: e for e in self.curated}

    def match_one(self, table):
        return toplist.match(self.curated, [table])

    def test_author_version_tail(self):
        got = self.match_one({'gameId': 1, 'name': 'Attack from Mars (Bally Midway 1995) g5k 1.0', 'maker': None, 'year': None})
        self.assertEqual([r['name'] for r in got], ['Attack from Mars'])

    def test_filename_style_with_labels(self):
        got = self.match_one({'gameId': 1, 'name': 'FunHouse (Williams 1990) SLAMT1LT v1.2 VPX', 'maker': 'Williams', 'year': 1990})
        self.assertEqual([r['name'] for r in got], ['Funhouse'])

    def test_word_order_inverted(self):
        got = self.match_one({'gameId': 1, 'name': 'Addams Family, The (Bally 1992)', 'maker': 'Bally', 'year': 1992})
        self.assertEqual([r['name'] for r in got], ['The Addams Family'])

    def test_edition_skips_maker_year_parens(self):
        got = toplist.match(self.curated, [{'gameId': 1, 'name': 'Medieval Madness (Remake) (Williams 1997)', 'maker': 'Williams', 'year': 1997}])
        self.assertEqual(got[0]['edition'], '(Remake)')

    def test_ambiguous_fallback_skipped(self):
        tables = [
            {'gameId': 1, 'name': 'Attack from Mars g5k', 'maker': None, 'year': None},
            {'gameId': 2, 'name': 'Attack from Mars VPX dozer', 'maker': None, 'year': None},
        ]
        self.assertEqual(toplist.match(self.curated, tables), [])

    def test_maker_year_disagree_still_skipped(self):
        got = self.match_one({'gameId': 1, 'name': 'FunHouse (Williams 1990) VPX', 'maker': 'Stern', 'year': 2015})
        self.assertEqual(got, [])

    def test_missing_year_matches_on_unique_plus_maker(self):
        got = self.match_one({'gameId': 1, 'name': 'Fish Tales VPX Dozer316', 'maker': 'Williams', 'year': None})
        self.assertEqual([r['name'] for r in got], ['Fish Tales'])
