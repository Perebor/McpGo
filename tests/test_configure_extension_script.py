"""Exercise the manual Playwright token helper using an interactive pseudo-terminal."""
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "playwright/configure-extension.sh"
SECRET = "MyPlaywrightExtensionToken_1234567"


class ConfigureExtensionScriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "Home With Spaces"
        self.home.mkdir()
        self.settings = self.home / "Library/Application Support/McpGo/playwright"
        self.env = {**os.environ, "HOME": str(self.home)}

    def run_interactive(self, token=SECRET, arguments=()):
        reader, writer = pty.openpty()
        process = subprocess.Popen(["/bin/bash", str(SCRIPT), *arguments],
                                   stdin=writer, stdout=writer, stderr=writer,
                                   env=self.env, close_fds=True)
        os.close(writer)
        result = bytearray()
        delivered = False
        try:
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                ready, _, _ = select.select([reader], [], [], 0.1)
                if ready:
                    try:
                        chunk = os.read(reader, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    result.extend(chunk)
                    if b"(hidden): " in result and not delivered:
                        os.write(reader, (token + "\n").encode())
                        delivered = True
                if process.poll() is not None:
                    while select.select([reader], [], [], 0)[0]:
                        try:
                            drained = os.read(reader, 4096)
                            if not drained:
                                break
                            result.extend(drained)
                        except OSError:
                            break
                    break
            else:
                process.kill()
                self.fail("configure-extension.sh timed out")
            return process.wait(timeout=2), result.decode("utf-8", "replace")
        finally:
            os.close(reader)
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)

    def test_valid_token_saves_both_files_without_echoing_secret(self):
        code, output = self.run_interactive()
        self.assertEqual(code, 0, output)
        self.assertNotIn(SECRET, output)
        self.assertEqual((self.settings / "extension-token").read_text(), SECRET + "\n")
        self.assertEqual((self.settings / "browser-mode").read_text(), "extension\n")
        self.assertEqual(self.settings.stat().st_mode & 0o077, 0)
        for name in ("extension-token", "browser-mode"):
            self.assertEqual((self.settings / name).stat().st_mode & 0o077, 0)
        self.assertEqual(list(self.settings.glob(".*")), [])

    def test_accepts_optional_assignment_prefix_and_extension_flag(self):
        code, output = self.run_interactive("PLAYWRIGHT_MCP_EXTENSION_TOKEN=" + SECRET, ("--extension",))
        self.assertEqual(code, 0, output)
        self.assertEqual((self.settings / "extension-token").read_text().strip(), SECRET)

    def test_rejected_token_preserves_previous_settings(self):
        self.settings.mkdir(parents=True)
        (self.settings / "extension-token").write_text("previous-token\n")
        (self.settings / "browser-mode").write_text("extension\n")
        for invalid in ("bad", "includes space 123456789", "wrong/characters/123456"):
            code, output = self.run_interactive(invalid)
            self.assertNotEqual(code, 0, output)
            self.assertIn("Invalid extension token", output)
            self.assertEqual((self.settings / "extension-token").read_text(), "previous-token\n")
            self.assertEqual((self.settings / "browser-mode").read_text(), "extension\n")

    def test_symlinked_mode_file_is_rejected_before_secret_write(self):
        self.settings.mkdir(parents=True)
        outside = Path(self.tmp.name) / "outside-file"
        outside.write_text("keep\n")
        (self.settings / "browser-mode").symlink_to(outside)
        code, output = self.run_interactive()
        self.assertNotEqual(code, 0, output)
        self.assertIn("Unsafe", output)
        self.assertEqual(outside.read_text(), "keep\n")
        self.assertFalse((self.settings / "extension-token").exists())
        self.assertNotIn(SECRET, output)

    def test_rejects_symlinked_settings_directory(self):
        external = Path(self.tmp.name) / "outside-settings"
        external.mkdir()
        self.settings.parent.mkdir(parents=True)
        self.settings.symlink_to(external)
        code, output = self.run_interactive()
        self.assertNotEqual(code, 0, output)
        self.assertIn("Unsafe", output)
        self.assertEqual(list(external.iterdir()), [])

    def test_noninteractive_input_is_rejected_before_creating_settings(self):
        result = subprocess.run(["/bin/bash", str(SCRIPT)], input=SECRET + "\n",
                                capture_output=True, text=True, env=self.env, timeout=6)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("interactive terminal", result.stderr)
        self.assertFalse(self.settings.exists())
        self.assertNotIn(SECRET, result.stderr + result.stdout)


if __name__ == "__main__":
    unittest.main()
