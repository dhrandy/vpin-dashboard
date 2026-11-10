"""Public install metadata and network-only worker invariants."""
import base64
import json
from pathlib import Path
import struct
import unittest
ROOT=Path(__file__).resolve().parents[1]/'app'

class PWATests(unittest.TestCase):
    def test_manifest_and_icons(self):
        manifest=json.loads((ROOT/'manifest.webmanifest').read_text())
        self.assertEqual(manifest['display'],'standalone')
        self.assertEqual(manifest['start_url'],'/')
        self.assertEqual(manifest['scope'],'/')
        self.assertTrue(all('maskable' in icon['purpose'] for icon in manifest['icons']))
        self.assertTrue(all('?v=2' in icon['src'] for icon in manifest['icons']))
        for n in (192,512):
            data=base64.b64decode((ROOT/f'pwa-icon-{n}.png.b64').read_bytes(),validate=True)
            self.assertTrue(data.startswith(b'\x89PNG\r\n\x1a\n'))
            self.assertEqual(struct.unpack('>II',data[16:24]),(n,n))
    def test_no_private_service_worker_cache(self):
        worker=(ROOT/'sw.js').read_text()
        self.assertNotIn('caches.',worker)
        self.assertNotIn('respondWith',worker)
        self.assertNotIn("addEventListener('fetch'",worker)
    def test_install_metadata(self):
        html=(ROOT/'index.html').read_text()
        self.assertIn('rel="manifest" href="/manifest.webmanifest"',html)
        self.assertIn('apple-touch-icon',html)
        self.assertIn('src="/pwa.js"',html)
        # The Settings install panel was removed; browser Add to Home Screen
        # still works off the manifest and network-only worker.
        self.assertNotIn('id="install-app"',html)
if __name__=='__main__':unittest.main()
