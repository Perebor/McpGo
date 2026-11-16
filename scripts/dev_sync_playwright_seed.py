#!/usr/bin/env python3
"""Copy only pinned public npm dependencies into the signed DEV RuntimeSeed.

Never touches the live writable runtime, user profiles, tokens, or LaunchAgents.
Requires the local checkout to contain a verified npm-ci installation.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def sync_seed(source: Path, seed: Path):
    from_pkg = source / 'package.json'
    from_modules = source / 'node_modules'
    target = seed / 'playwright'
    if any(p.is_symlink() for p in (source,seed,target,from_modules)):
        raise RuntimeError('Symlinked source or destination is not allowed')
    if not target.is_dir() or not from_modules.is_dir():
        raise RuntimeError('Missing Playwright dependencies or destination')
    intended = json.loads(from_pkg.read_text())['dependencies']['@playwright/mcp']
    installed = json.loads((from_modules/'@playwright/mcp/package.json').read_text())['version']
    if intended != installed:
        raise RuntimeError('Playwright version differs from pinned package')
    core = (from_modules/'playwright-core/lib/coreBundle.js').read_text()
    if 'const last = !shared || !clientCount;' not in core or \
       'PLAYWRIGHT_MCP_SESSION_NAME || clientInfo.clientName' in core:
        raise RuntimeError('Unreviewed Playwright group lifecycle patch in source modules')
    staged = Path(tempfile.mkdtemp(prefix='.mcpgo-playwright-seed-',dir=target))
    previous = target / '.mcpgo-playwright-previous'
    if previous.exists():
        staged.rmdir()
        raise RuntimeError('Incomplete previous seed sync; refusing to overwrite')
    swapped = False
    try:
        shutil.copytree(from_modules,staged/'node_modules',symlinks=False)
        if (target/'node_modules').exists():
            (target/'node_modules').rename(previous)
        (staged/'node_modules').rename(target/'node_modules')
        swapped = True
        for name in ('package.json','package-lock.json','patch-playwright.mjs'):
            src = source/name
            dest = target/name
            if not src.is_file() or src.is_symlink() or dest.is_symlink():
                raise RuntimeError('Unsafe Playwright seed metadata '+name)
            handle, temporary = tempfile.mkstemp(prefix='.mcpgo-pkg-',dir=target)
            try:
                with os.fdopen(handle,'wb') as stream:
                    stream.write(src.read_bytes())
                os.chmod(temporary,0o644)
                os.replace(temporary,dest)
            finally:
                if os.path.exists(temporary):os.unlink(temporary)
        if previous.exists():shutil.rmtree(previous)
        return installed
    except Exception:
        if swapped:
            shutil.rmtree(target/'node_modules')
        if previous.exists():previous.rename(target/'node_modules')
        raise
    finally:
        shutil.rmtree(staged,ignore_errors=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--bundle',required=True,type=Path)
    args=parser.parse_args()
    target=args.bundle.resolve()
    if 'McpGo Dev.app/Contents/Resources/RuntimeSeed' not in str(target):
        raise SystemExit('Only an isolated McpGo Dev RuntimeSeed is permitted')
    version=sync_seed(ROOT/'playwright',target)
    print('[dev] Embedded pinned Playwright MCP '+version+' in Dev RuntimeSeed; live runtime not modified')
