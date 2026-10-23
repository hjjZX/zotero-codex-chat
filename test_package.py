import json
from pathlib import Path
import unittest
from urllib.parse import urlparse


class PackageTests(unittest.TestCase):
    def test_startup_does_not_read_jar_resources_through_deprecated_http_helper(self):
        root = Path(__file__).resolve().parent
        source = (root / 'extension' / 'bootstrap.js').read_text(encoding='utf-8')
        self.assertNotIn('Zotero.File.getContentsAsync', source)

    def test_zotero_required_manifest_fields_are_present(self):
        root = Path(__file__).resolve().parent
        manifest = json.loads((root / 'extension' / 'manifest.json').read_text(encoding='utf-8'))
        application = manifest['applications']['zotero']
        for key in ('id', 'update_url', 'strict_min_version', 'strict_max_version'):
            self.assertTrue(application.get(key), 'Zotero requires applications.zotero.' + key)
        self.assertEqual(urlparse(application['update_url']).hostname, '127.0.0.1')
        self.assertEqual(urlparse(application['update_url']).scheme, 'https')


if __name__ == '__main__':
    unittest.main()

