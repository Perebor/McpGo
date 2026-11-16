"""Installer browser check is read-only, precise, and never blocks McpGo."""
import pathlib
import plistlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "onboarding"))
from browser_compat import (BACKGROUND_MINIMUM_TEXT, browser_check, compatible_version,
                            mac_chrome_version, version_tuple)


class BrowserCompatibilityTests(unittest.TestCase):
    def test_exact_background_threshold(self):
        self.assertEqual(BACKGROUND_MINIMUM_TEXT, "158.0.8127.2")
        self.assertFalse(compatible_version("157.0.8103.52"))
        self.assertFalse(compatible_version("158.0.8127.1"))
        self.assertTrue(compatible_version("158.0.8127.2"))
        self.assertTrue(compatible_version("159.0.0.0"))
        self.assertFalse(compatible_version("158.0.8127.beta"))
        self.assertIsNone(version_tuple("157; rm -rf /"))

    def test_outdated_is_a_warning_not_installer_failure(self):
        result = browser_check("chrome", version="157.0.8103.52")
        self.assertEqual(result["status"], "outdated")
        self.assertFalse(result["backgroundReady"])
        self.assertFalse(result["blocking"])
        self.assertEqual(result["updateUrl"], "https://www.google.com/chrome/")
        self.assertEqual(browser_check("chrome", version="158.0.8127.2")["status"], "ready")
        self.assertEqual(browser_check("chrome", version="invalid")["status"], "not-found")
        self.assertEqual(browser_check("msedge", version="157.0.0.0")["updateUrl"],
                         "https://www.microsoft.com/edge")
        edge = browser_check("msedge", version="158.0.1200.10")
        self.assertTrue(edge["backgroundReady"])
        self.assertTrue(edge["requiresRealBrowserVerification"])
        self.assertEqual(edge["minimumVersion"], "158")
        with self.assertRaises(ValueError):
            browser_check("bad-browser", version="159.0.0.0")

    def test_macos_checks_genuine_google_chrome_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            app = pathlib.Path(temp) / "Google Chrome.app"
            info = app / "Contents/Info.plist"
            info.parent.mkdir(parents=True)
            info.write_bytes(plistlib.dumps({
                "CFBundleIdentifier": "com.google.Chrome",
                "CFBundleShortVersionString": "158.0.8127.2",
            }))
            self.assertEqual(mac_chrome_version(paths=[app]), "158.0.8127.2")
            info.write_bytes(plistlib.dumps({
                "CFBundleIdentifier": "org.chromium.Chromium",
                "CFBundleShortVersionString": "159.0.0.0",
            }))
            self.assertIsNone(mac_chrome_version(paths=[app]))
            info.write_bytes(b"broken plist")
            self.assertIsNone(mac_chrome_version(paths=[app]))


if __name__ == "__main__":
    unittest.main()
