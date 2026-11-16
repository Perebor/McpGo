"""Release upgrades must never discard a configured McpGo installation."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("upgrade_runtime", ROOT / "scripts/upgrade_runtime.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def make_release(target: Path, version: str, source: str = "old"):
    target.mkdir(parents=True, exist_ok=True)
    (target / "release-manifest.json").write_text(
        json.dumps({"version": version, "platform": "macos-arm64"}))
    for name in module.REQUIRED:
        file = target / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text("code-" + source + "-" + name)


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mcpgo-upgrade-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.support = self.base / "McpGo"
        self.support.mkdir()
        self.seed = self.base / "bundle" / "RuntimeSeed"
        self.runtime = self.support / "Runtime"
        make_release(self.seed, "2.1.0", "new")

    def test_first_install_and_repeat_are_idempotent(self):
        self.assertEqual(module.upgrade(self.seed, self.support), "upgraded")
        self.assertEqual(module.upgrade(self.seed, self.support), "current")
        self.assertEqual((self.runtime / "onboarding/cli.py").read_text(), "code-new-onboarding/cli.py")

    def test_update_preserves_untracked_user_data_and_original_for_rollback(self):
        make_release(self.runtime, "2.0.0", "old")
        private = self.runtime / "playwright" / "user-profile" / "session.json"
        private.parent.mkdir(parents=True, exist_ok=True)
        private.write_text("PRIVATE USER SESSION")
        state = self.support / "Onboarding/state.json"
        state.parent.mkdir(parents=True)
        state.write_text('{"wizardDismissed":true,"tunnels":{"terminal":{"id":"saved"}}}')
        key = self.support / "playwright/tunnel.id"
        key.parent.mkdir()
        key.write_text("SAVED TUNNEL ID")
        self.assertEqual(module.upgrade(self.seed, self.support), "upgraded")
        self.assertEqual(private.read_text(), "PRIVATE USER SESSION")
        self.assertEqual(key.read_text(), "SAVED TUNNEL ID")
        self.assertIn('"wizardDismissed":true', state.read_text())
        self.assertEqual((self.runtime / "onboarding/cli.py").read_text(), "code-new-onboarding/cli.py")
        backups = list(self.support.glob(".runtime-rollback-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "onboarding/cli.py").read_text(), "code-old-onboarding/cli.py")

    def test_two_concurrent_updaters_never_create_two_installations(self):
        from concurrent.futures import ThreadPoolExecutor
        make_release(self.runtime, "2.0.0", "old")
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: module.upgrade(self.seed, self.support),
                                        range(2)))
        self.assertEqual(sorted(results), ["current", "upgraded"])
        self.assertEqual(len(list(self.support.glob(".runtime-rollback-*"))), 1)
        self.assertEqual((self.runtime / "onboarding/cli.py").read_text(),
                         "code-new-onboarding/cli.py")

    def test_no_downgrade_of_existing_runtime(self):
        make_release(self.runtime, "2.2.0")
        self.assertEqual(module.upgrade(self.seed, self.support), "newer-installed")
        self.assertFalse(list(self.support.glob(".runtime-rollback-*")))

    def test_corrupted_seed_never_touches_existing_runtime(self):
        make_release(self.runtime, "2.0.0")
        (self.seed / "onboarding/cli.py").unlink()
        with self.assertRaises(RuntimeError):
            module.upgrade(self.seed, self.support)
        self.assertEqual((self.runtime / "onboarding/cli.py").read_text(), "code-old-onboarding/cli.py")

    def test_recover_crash_between_directory_moves(self):
        backup = self.support / ".runtime-rollback-crash"
        make_release(backup, "2.0.0", "old")
        module.atomic_json(self.support / module.JOURNAL,
                           {"backup": backup.name, "stage": ".runtime-stage-crash"})
        module.recover(self.support, self.runtime)
        self.assertTrue(self.runtime.is_dir())
        self.assertFalse((self.support / module.JOURNAL).exists())
        self.assertEqual((self.runtime / "onboarding/cli.py").read_text(), "code-old-onboarding/cli.py")

    def test_relocated_completed_wizard_is_adopted_without_reprovision(self):
        home = self.base / "person"
        agents = home / "Library" / "LaunchAgents"
        agents.mkdir(parents=True)
        source = home / "Desktop" / "McpGo"
        (source / "onboarding").mkdir(parents=True)
        (source / "onboarding/cli.py").write_text("old")
        state = self.support / "Onboarding/state.json"
        state.parent.mkdir()
        module.atomic_json(state, {
            "installationRoot": str(source), "version": 1, "phase": "verification",
            "wizardDismissed": True,
            "tunnels": {"terminal": {"id": "tunnel_old123"}, "browser": {"id": "tunnel_old234"}},
        })
        self.assertTrue(module.migrate_onboarding_state(self.support, self.runtime, home))
        self.assertEqual(json.loads(state.read_text())["installationRoot"], str(self.runtime))
        self.assertFalse(module.migrate_onboarding_state(self.support, self.runtime, home))

    def test_active_other_installation_prevents_wizard_migration(self):
        import plistlib
        home = self.base / "person"
        agents = home / "Library" / "LaunchAgents"
        agents.mkdir(parents=True)
        source = home / "Desktop" / "McpGo"
        (source / "onboarding").mkdir(parents=True)
        (source / "onboarding/cli.py").write_text("old")
        (agents / "com.mcphub.dashboard.plist").write_bytes(plistlib.dumps({
            "EnvironmentVariables": {"MCPGO_INSTALL_ROOT": str(source)},
        }))
        state = self.support / "Onboarding/state.json"
        state.parent.mkdir()
        module.atomic_json(state, {
            "installationRoot": str(source), "version": 1,
            "wizardDismissed": True,
            "tunnels": {"terminal": {"id": "tunnel_old123"}, "browser": {"id": "tunnel_old234"}},
        })
        self.assertFalse(module.migrate_onboarding_state(self.support, self.runtime, home))
        self.assertEqual(json.loads(state.read_text())["installationRoot"], str(source))

    def test_restart_touches_only_agents_owned_by_new_runtime(self):
        import plistlib
        home = self.base / "person"
        agents = home / "Library" / "LaunchAgents"
        agents.mkdir(parents=True)
        owned = agents / "com.mcphub.dashboard.plist"
        owned.write_bytes(plistlib.dumps({"EnvironmentVariables": {
            "MCPGO_INSTALL_ROOT": str(self.runtime)}}))
        foreign = agents / "com.mcphub.messaging.plist"
        foreign.write_bytes(plistlib.dumps({"EnvironmentVariables": {
            "MCPGO_INSTALL_ROOT": "/some/other/installation"}}))
        response = type("Result", (), {"returncode": 0})()
        with patch.object(module.sys, "platform", "darwin"), patch.object(
                module.subprocess, "run", return_value=response) as run:
            self.assertEqual(module.restart_owned_services(self.runtime, home), 1)
        self.assertEqual(run.call_count, 2)
        self.assertIn("com.mcphub.dashboard", run.call_args.args[0][-1])
        self.assertNotIn("com.mcphub.messaging", str(run.call_args_list))

    def test_bad_installation_symlink_is_rejected(self):
        other = self.base / "other"
        other.mkdir()
        self.runtime.symlink_to(other, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            module.upgrade(self.seed, self.support)

    def test_failed_switch_restores_old_runtime(self):
        make_release(self.runtime, "2.0.0", "old")
        original_rename = module.os.rename
        def flaky(src, dest):
            if Path(src).name.startswith(".runtime-stage-") and Path(dest) == self.runtime:
                raise OSError("simulated switch failure")
            return original_rename(src, dest)
        with patch.object(module.os, "rename", side_effect=flaky):
            with self.assertRaises(OSError):
                module.upgrade(self.seed, self.support)
        self.assertEqual((self.runtime / "onboarding/cli.py").read_text(), "code-old-onboarding/cli.py")


if __name__ == "__main__":
    unittest.main()
