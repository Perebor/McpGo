"""Read-only installed-browser compatibility check for background Playwright Extension.

Chrome 158.0.8127.2+ is needed for *background connect-page creation* with
the authentication token. Older versions may still run Playwright Extension.
Never modify, download, or launch a browser from the installer.
"""
from __future__ import annotations

import os
from pathlib import Path
import plistlib
import re
import sys

BACKGROUND_MINIMUM = (158, 0, 8127, 2)
BACKGROUND_MINIMUM_TEXT = ".".join(map(str, BACKGROUND_MINIMUM))
UPDATE_URLS = {
    "chrome": "https://www.google.com/chrome/",
    "msedge": "https://www.microsoft.com/edge",
}


def version_tuple(raw: str | None) -> tuple[int, ...] | None:
    if not isinstance(raw, str) or not re.fullmatch(r"\d+(?:\.\d+){0,3}", raw.strip()):
        return None
    return tuple(int(component) for component in raw.strip().split("."))


def compatible_version(raw: str | None) -> bool:
    parsed = version_tuple(raw)
    return parsed is not None and (*parsed, *(0 for _ in range(4 - len(parsed)))) >= BACKGROUND_MINIMUM


def mac_chrome_version(home: Path | None = None, paths: list[Path] | None = None) -> str | None:
    """Read the installed *Google Chrome* app bundle, not Chromium or the system browser."""
    home = home or Path.home()
    candidates = paths if paths is not None else [
        Path("/Applications/Google Chrome.app"),
        home / "Applications/Google Chrome.app",
    ]
    for app in candidates:
        info = app / "Contents/Info.plist"
        try:
            with info.open("rb") as stream:
                metadata = plistlib.load(stream)
            if metadata.get("CFBundleIdentifier") != "com.google.Chrome":
                continue
            version = metadata.get("CFBundleShortVersionString")
            if version_tuple(version) is not None:
                return version
        except (OSError, ValueError, TypeError, plistlib.InvalidFileException):
            continue
    return None


def windows_browser_version(browser: str) -> str | None:
    """Query per-user and machine-wide installed-browser registry metadata."""
    if sys.platform != "win32":
        return None
    import winreg
    key = "SOFTWARE\\Google\\Chrome\\BLBeacon" if browser == "chrome" else "SOFTWARE\\Microsoft\\Edge\\BLBeacon"
    for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (0, winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(root, key, 0, winreg.KEY_READ | view) as opened:
                    value, _ = winreg.QueryValueEx(opened, "version")
                    if version_tuple(value) is not None:
                        return value
            except OSError:
                continue
    return None


def browser_check(browser: str = "chrome", *, version: str | None = None) -> dict:
    if browser not in UPDATE_URLS:
        raise ValueError("Unsupported browser")
    if version is None:
        version = windows_browser_version(browser) if sys.platform == "win32" else mac_chrome_version()
    detected = version if version_tuple(version) is not None else None
    # Chrome's precise background-connect milestone is documented upstream.
    # Edge uses Chromium but not Chrome's build number; a matching major
    # version is only an approximate compatibility recommendation for Edge.
    ready = (compatible_version(detected) if browser == "chrome"
             else bool(version_tuple(detected) and version_tuple(detected)[0] >= 158))
    return {
        "browser": browser,
        "version": detected,
        "minimumVersion": BACKGROUND_MINIMUM_TEXT if browser == "chrome" else "158",
        "backgroundReady": ready,
        "requiresRealBrowserVerification": browser == "msedge",
        "status": "ready" if ready else ("outdated" if detected else "not-found"),
        "updateUrl": UPDATE_URLS[browser],
        "blocking": False,
    }
