import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'scripts/dev_sync_playwright_seed.py'
spec = importlib.util.spec_from_file_location('dev_sync_playwright_seed', MODULE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DevSeedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source = root / 'source'
        self.seed = root / 'RuntimeSeed'
        dest = self.seed / 'playwright'
        dest.mkdir(parents=True)
        self.source.mkdir()
        for name, content in [
            ('package.json', json.dumps({'dependencies': {'@playwright/mcp': '0.0.85'}})),
            ('package-lock.json', '{}'),
            ('patch-playwright.mjs', 'export const ok=true;')]:
            (self.source/name).write_text(content)
        dep = self.source/'node_modules/@playwright/mcp/package.json'
        dep.parent.mkdir(parents=True)
        dep.write_text(json.dumps({'version': '0.0.85'}))
        core = self.source/'node_modules/playwright-core/lib/coreBundle.js'
        core.parent.mkdir(parents=True)
        core.write_text('const last = !shared || !clientCount;')
        old = dest/'node_modules/@playwright/mcp/package.json'
        old.parent.mkdir(parents=True)
        old.write_text(json.dumps({'version': '0.0.83'}))

    def test_replaces_only_dev_seed_deps_with_pinned_version(self):
        self.assertEqual(module.sync_seed(self.source, self.seed), '0.0.85')
        out = self.seed/'playwright/node_modules/@playwright/mcp/package.json'
        self.assertEqual(json.loads(out.read_text())['version'], '0.0.85')
        self.assertFalse((self.seed/'playwright/.mcpgo-playwright-previous').exists())
        self.assertEqual(module.sync_seed(self.source, self.seed), '0.0.85')

    def test_version_mismatch_is_rejected_without_changing_seed(self):
        (self.source/'node_modules/@playwright/mcp/package.json').write_text(json.dumps({'version': '0.0.86'}))
        with self.assertRaisesRegex(RuntimeError, 'differs'):
            module.sync_seed(self.source, self.seed)
        old = self.seed/'playwright/node_modules/@playwright/mcp/package.json'
        self.assertEqual(json.loads(old.read_text())['version'], '0.0.83')

    def test_invasive_group_patch_is_rejected(self):
        (self.source/'node_modules/playwright-core/lib/coreBundle.js').write_text('const last = !shared || (!clientCount && !config.extension);')
        with self.assertRaisesRegex(RuntimeError, 'Unreviewed'):
            module.sync_seed(self.source, self.seed)


if __name__ == '__main__':
    unittest.main()
