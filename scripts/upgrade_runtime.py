#!/usr/bin/env python3
"""Non-destructive, crash-recoverable runtime upgrade for the signed macOS app.

The installed runtime is intentionally writable (legacy versions mixed code and
runtime caches). Clone it with hardlinks, overlay only release-owned files using
new inodes, then switch directories. Never delete credentials, user state, or the
previous runtime. Fail closed on unsafe paths or version downgrades.
"""
from __future__ import annotations

import fcntl
import json
import os
import plistlib
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

VERSION = re.compile(r"^[0-9]+(?:\.[0-9]+){1,3}$")
REQUIRED = (
    "onboarding/cli.py", "scripts/setup_macos.py",
    "terminal/stateless_server.js", "vendor/python/bin/python3",
)
JOURNAL = ".runtime-upgrade-journal.json"
LOCK = ".runtime-upgrade.lock"


def check_dir(path: Path) -> None:
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError("Unsafe runtime directory: " + str(path))


def manifest(path: Path) -> tuple[int, ...]:
    file = path / "release-manifest.json"
    if file.is_symlink() or not file.is_file():
        raise RuntimeError("Missing or unsafe release manifest")
    value = json.loads(file.read_text(encoding="utf-8"))
    version = value.get("version")
    if value.get("platform") != "macos-arm64" or not isinstance(version, str) or not VERSION.fullmatch(version):
        raise RuntimeError("Invalid macOS runtime manifest")
    return tuple(int(n) for n in version.split("."))


def verify_seed(seed: Path) -> tuple[int, ...]:
    check_dir(seed)
    version = manifest(seed)
    for relative in REQUIRED:
        target = seed / relative
        if not target.is_file() or not target.resolve().is_relative_to(seed.resolve()):
            raise RuntimeError("Missing or unsafe release runtime file: " + relative)
    return version


def atomic_json(path: Path, data: dict) -> None:
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    with temporary.open("x", encoding="utf-8") as handle:
        os.chmod(temporary, 0o600)
        json.dump(data, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def safe_child(support: Path, name: str, prefix: str) -> Path:
    if not isinstance(name, str) or not name.startswith(prefix) or "/" in name or "\\" in name or ".." in name:
        raise RuntimeError("Invalid recovery path")
    target = support / name
    if target.is_symlink():
        raise RuntimeError("Unsafe recovery symlink")
    return target


def recover(support: Path, installed: Path) -> None:
    journal = support / JOURNAL
    if not journal.exists():
        return
    if journal.is_symlink() or not journal.is_file():
        raise RuntimeError("Unsafe upgrade journal")
    record = json.loads(journal.read_text(encoding="utf-8"))
    backup = safe_child(support, record.get("backup"), ".runtime-rollback-")
    safe_child(support, record.get("stage"), ".runtime-stage-")
    if not installed.exists():
        check_dir(backup)
        os.rename(backup, installed)
    else:
        check_dir(installed)
    journal.unlink()


def overlay(seed: Path, stage: Path) -> None:
    # Preserve existing, untracked user files; replace only bundled code.
    for folder, dirs, files in os.walk(seed, followlinks=False):
        source_dir = Path(folder)
        relative_dir = source_dir.relative_to(seed)
        destination_dir = stage / relative_dir
        if destination_dir.exists() or destination_dir.is_symlink():
            check_dir(destination_dir)
        else:
            destination_dir.mkdir(mode=0o700)
        for name in list(dirs):
            source = source_dir / name
            if source.is_symlink():
                dirs.remove(name)
                files.append(name)
        for name in files:
            src = source_dir / name
            dest = destination_dir / name
            if dest.is_dir() and not dest.is_symlink():
                raise RuntimeError("Release file conflicts with existing directory: " + str(dest))
            temp = destination_dir / (".upgrade-" + uuid.uuid4().hex)
            try:
                if src.is_symlink():
                    link = os.readlink(src)
                    if os.path.isabs(link) or not (src.parent / link).resolve().is_relative_to(seed.resolve()):
                        raise RuntimeError("Unsafe release symlink: " + str(src))
                    os.symlink(link, temp)
                elif src.is_file():
                    if not stat.S_ISREG(src.stat().st_mode):
                        raise RuntimeError("Unsafe release file: " + str(src))
                    shutil.copy2(src, temp)
                else:
                    raise RuntimeError("Unexpected release entry: " + str(src))
                os.replace(temp, dest)
            finally:
                if temp.is_symlink() or temp.exists():
                    temp.unlink()


def upgrade(seed: Path, support: Path) -> str:
    check_dir(support)
    seed_version = verify_seed(seed)
    installed = support / "Runtime"
    lock = support / LOCK
    if lock.is_symlink():
        raise RuntimeError("Unsafe runtime upgrade lock")
    with lock.open("a+b") as lock_file:
        os.chmod(lock, 0o600)
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        recover(support, installed)
        if installed.exists() or installed.is_symlink():
            check_dir(installed)
            try:
                old_version = manifest(installed)
            except (OSError, ValueError, RuntimeError):
                # Earlier release versions may have no manifest; upgrade only
                # if the installed runtime has the expected McpGo entrypoint.
                if not (installed / "onboarding/cli.py").is_file():
                    raise
                old_version = (0, 0)
            if old_version >= seed_version:
                return "current" if old_version == seed_version else "newer-installed"
        stage = support / (".runtime-stage-" + uuid.uuid4().hex)
        backup = support / (".runtime-rollback-" + uuid.uuid4().hex)
        try:
            if installed.exists():
                # Hardlinks avoid copying hundreds of MB; the overlay always
                # creates new inodes, so the rollback copy remains immutable.
                shutil.copytree(installed, stage, symlinks=True, copy_function=os.link)
            else:
                stage.mkdir(mode=0o700)
            overlay(seed, stage)
            if manifest(stage) != seed_version:
                raise RuntimeError("Staged release version mismatch")
            for relative in REQUIRED:
                if not (stage / relative).is_file():
                    raise RuntimeError("Staged runtime incomplete: " + relative)
            if installed.exists():
                atomic_json(support / JOURNAL, {"stage": stage.name, "backup": backup.name})
                os.rename(installed, backup)
                try:
                    os.rename(stage, installed)
                except BaseException:
                    os.rename(backup, installed)
                    raise
                (support / JOURNAL).unlink()
            else:
                os.rename(stage, installed)
            return "upgraded"
        finally:
            if stage.exists() and not stage.is_symlink():
                shutil.rmtree(stage)



def migrate_onboarding_state(support: Path, installed: Path, home: Path) -> bool:
    """Adopt a relocated, completed wizard only when no older agent owns it.

    Never silently import credentials from a second active McpGo installation.
    A mismatched installation with active LaunchAgents requires a controlled
    migration, not new OpenAI tunnels or new API keys.
    """
    state_path = support / "Onboarding" / "state.json"
    if not state_path.exists():
        return False
    if state_path.is_symlink() or not state_path.is_file() or state_path.stat().st_mode & 0o077:
        raise RuntimeError("Unsafe onboarding state; not migrating")
    state = json.loads(state_path.read_text(encoding="utf-8"))
    previous_name = state.get("installationRoot")
    if previous_name == str(installed):
        return False
    if not isinstance(previous_name, str) or not previous_name.startswith("/") or state.get("version") != 1:
        return False
    previous = Path(previous_name)
    if (previous.name not in ("McpGo", "Runtime") or previous.is_symlink() or
            not previous.is_dir() or not previous.resolve().is_relative_to(home.resolve()) or
            not (previous / "onboarding/cli.py").is_file()):
        return False
    if state.get("wizardDismissed") is not True:
        return False
    tunnels = state.get("tunnels", {})
    if not isinstance(tunnels, dict) or not all(
            isinstance(tunnels.get(k), dict) and
            re.fullmatch(r"tunnel_[A-Za-z0-9_-]{3,180}", tunnels[k].get("id", ""))
            for k in ("terminal", "browser")):
        return False
    agents = home / "Library" / "LaunchAgents"
    for pattern in ("com.mcphub*.plist", "com.chatterminalhub*.plist"):
        for plist in agents.glob(pattern):
            if plist.is_symlink():
                return False
            try:
                data = plistlib.loads(plist.read_bytes())
                current = data.get("EnvironmentVariables", {}).get("MCPGO_INSTALL_ROOT")
                if current != str(installed):
                    return False
            except (ValueError, OSError, TypeError):
                return False
    state["installationRoot"] = str(installed)
    atomic_json(state_path, state)
    return True


SERVICE_LABELS = (
    "com.chatterminalhub.oneshot",
    "com.mcphub.playwright.browser",
    "com.mcphub.playwright.proxy",
    "com.mcphub.autosend.browser",
    "com.mcphub.autosend",
    "com.mcphub.messaging",
    "com.mcphub.dashboard",
    "com.chatterminalhub.tunnel",
    "com.mcphub.playwright.tunnel",
)


def restart_owned_services(installed: Path, home: Path) -> int:
    """Restart *only* running LaunchAgents belonging to this runtime."""
    if sys.platform != "darwin":
        return 0
    restarted = 0
    domain = "gui/" + str(os.getuid()) + "/"
    agents = home / "Library" / "LaunchAgents"
    for label in SERVICE_LABELS:
        path = agents / (label + ".plist")
        if not path.is_file() or path.is_symlink():
            continue
        try:
            data = plistlib.loads(path.read_bytes())
            if data.get("EnvironmentVariables", {}).get("MCPGO_INSTALL_ROOT") != str(installed):
                continue
            result = subprocess.run(["/bin/launchctl", "print", domain + label],
                                    timeout=4, capture_output=True)
            if result.returncode != 0:
                continue
            # A loaded job can be stopped or waiting; preserve that state.
            output = result.stdout.decode("utf-8", "replace") if isinstance(result.stdout, bytes) else result.stdout
            if not re.search(r"(?m)^\s*state = running\s*$", output or "") or not re.search(r"(?m)^\s*pid = [1-9][0-9]*\s*$", output or ""):
                continue
            result = subprocess.run(["/bin/launchctl", "kickstart", "-k", domain + label],
                                    timeout=15, capture_output=True)
            if result.returncode == 0:
                restarted += 1
            else:
                print("Warning: could not restart " + label, file=sys.stderr)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            print("Warning: could not restart " + label, file=sys.stderr)
    return restarted

def main() -> int:
    if len(sys.argv) != 3:
        print("usage: upgrade_runtime.py <signed RuntimeSeed> <Application Support/McpGo>", file=sys.stderr)
        return 2
    seed, support = (Path(p).absolute() for p in sys.argv[1:])
    if seed.name != "RuntimeSeed" or support.name != "McpGo":
        print("Unexpected runtime upgrade locations", file=sys.stderr)
        return 2
    try:
        status = upgrade(seed, support)
        migrated = migrate_onboarding_state(support, support / "Runtime", Path.home())
        restarted = restart_owned_services(support / "Runtime", Path.home()) if status == "upgraded" else 0
        print(status + ("; wizard migrated" if migrated else "") + f"; services restarted: {restarted}")
        return 0
    except Exception as exc:
        print("Runtime upgrade refused: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
