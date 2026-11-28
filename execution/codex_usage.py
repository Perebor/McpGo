"""Read-only, bounded Codex client telemetry, NOT provider-signed billing receipts.

Only parses session_meta.cwd and event_msg/token_count.info.total_token_usage.
Never reads, stores, outputs or interprets prompts, tool calls or text replies.
Must be explicitly bound to a local project repository and actor by owner.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import uuid

from execution.usage_ledger import UsageDenied

FIELDS=('input_tokens','cached_input_tokens','cache_write_input_tokens',
        'output_tokens','reasoning_output_tokens','total_tokens')
SESSION_RE=re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z',re.I)
MAX_FILE_BYTES=64*1024*1024
MAX_LINE_BYTES=2*1024*1024


def _read_number_dict(raw):
    if not isinstance(raw,dict) or not all(k in raw for k in FIELDS):
        raise UsageDenied('Codex token usage incomplete; no import')
    if any(type(raw[k]) is not int or raw[k]<0 or raw[k]>10**13 for k in FIELDS):
        raise UsageDenied('Codex token usage must be nonnegative bounded integers')
    if (raw['cached_input_tokens']+raw['cache_write_input_tokens']>raw['input_tokens']
        or raw['reasoning_output_tokens']>raw['output_tokens']
        or raw['total_tokens']!=raw['input_tokens']+raw['output_tokens']):
        raise UsageDenied('Codex token arithmetic inconsistent')
    return {k:raw[k] for k in FIELDS}


def _source_path(session_file,codex_root):
    root=Path(codex_root).resolve(strict=True)
    file=Path(session_file)
    if file.is_symlink() or file.suffix.lower()!='.jsonl' or not file.is_file():
        raise UsageDenied('Invalid or symlinked Codex session file')
    canonical=file.resolve(strict=True)
    try: parts=canonical.relative_to(root).parts
    except ValueError as exc:
        raise UsageDenied('Codex session path is outside approved root') from exc
    if len(parts)<2 or parts[0] not in ('sessions','archived_sessions'):
        raise UsageDenied('Codex file is not in approved sessions tree')
    if canonical.stat().st_size>MAX_FILE_BYTES:
        raise UsageDenied('Codex session too large for bounded telemetry scan')
    return canonical


def read_codex_usage(session_file,codex_root,repo):
    """Return sanitized cumulative usage of ONE exact owner-scoped session."""
    canonical=_source_path(session_file,codex_root)
    trusted_repo=Path(repo).resolve(strict=True)
    if trusted_repo.is_symlink() or not trusted_repo.is_dir():
        raise UsageDenied('Unsafe owner repository scope')
    meta=None
    previous=None
    event_count=0
    increasing_count=0
    dig=hashlib.sha256()
    with canonical.open('rb') as stream:
        for line in stream:
            if len(line)>MAX_LINE_BYTES:
                raise UsageDenied('Oversized Codex JSONL line')
            if b'"session_meta"' not in line and b'"token_count"' not in line:
                continue
            try: obj=json.loads(line)
            except (UnicodeError,ValueError) as exc:
                raise UsageDenied('Malformed scoped Codex telemetry line') from exc
            if not isinstance(obj,dict):continue
            kind=obj.get('type')
            payload=obj.get('payload')
            if not isinstance(payload,dict):continue
            if kind=='session_meta':
                sid=payload.get('id')
                if meta is not None or not isinstance(sid,str) or not SESSION_RE.fullmatch(sid):
                    raise UsageDenied('Multiple or missing Codex session identities')
                if not canonical.name.endswith(sid+'.jsonl'):
                    raise UsageDenied('Codex filename/session identity mismatch')
                if payload.get('model_provider')!='openai':
                    raise UsageDenied('Untrusted or unsupported Codex model provider')
                cwd=payload.get('cwd')
                if not isinstance(cwd,str):
                    raise UsageDenied('Codex session has no owner project directory')
                try: folder=Path(cwd).resolve(strict=True)
                except OSError as exc:raise UsageDenied('Codex project directory missing') from exc
                if folder != trusted_repo:
                    raise UsageDenied('Codex session belongs to a different project checkout')
                meta=sid.lower()
            elif kind=='event_msg' and payload.get('type')=='token_count':
                if meta is None:
                    raise UsageDenied('Codex telemetry before scoped session identity')
                info=payload.get('info')
                if not isinstance(info,dict):
                    raise UsageDenied('Missing Codex usage info')
                usage=_read_number_dict(info.get('total_token_usage'))
                if previous is not None and any(usage[k]<previous[k] for k in FIELDS):
                    raise UsageDenied('Codex usage regressed; manual reconciliation required')
                if previous is None or usage['total_tokens']>previous['total_tokens']:
                    increasing_count+=1
                event_count+=1
                dig.update(json.dumps(usage,sort_keys=True,separators=(',',':')).encode('ascii')+b'\n')
                previous=usage
    if meta is None or previous is None or not event_count:
        raise UsageDenied('No project-bound Codex token_count evidence found')
    return {'session_id':meta,'input_tokens':previous['input_tokens'],
            'cached_input_tokens':previous['cached_input_tokens'],
            'cache_write_input_tokens':previous['cache_write_input_tokens'],
            'output_tokens':previous['output_tokens'],
            'reasoning_output_tokens':previous['reasoning_output_tokens'],
            'total_tokens':previous['total_tokens'],
            'token_update_events':event_count,
            'observed_increases':increasing_count,
            'source_digest':dig.hexdigest(),
            'source_kind':'LOCAL_CODEX_SESSION_NOT_PROVIDER_SIGNED'}


def capture_codex_usage(ledger,session_file,codex_root,repo,project,agent,run_id,*,owner_engine):
    """Store local Codex telemetry ONLY for an owner-registered project checkout.

    A caller cannot give a TD fixture/repo the 'Museum' label, or attribute a
    log to the coordinator. The registered RoleEngine mapping is authoritative.
    """
    from execution.usage_ledger import _identity
    from execution.role_engine import PROJECT_ROLES
    _identity(project,agent,run_id,'codex-scope')
    if agent != PROJECT_ROLES[project]['coder']:
        raise UsageDenied('Only registered owner coder may account this Codex session')
    try:
        owner_engine.check_scope(agent,project,'coder')
        approved_repo=owner_engine._repo(project)
        if approved_repo.resolve(strict=True)!=Path(repo).resolve(strict=True):
            raise UsageDenied('Codex source is not tied to registered owner project')
    except (ValueError,OSError) as exc:
        raise UsageDenied('Owner project/role registration unavailable') from exc
    snap=read_codex_usage(session_file,codex_root,approved_repo)
    return ledger.record_codex_observation(project,agent,run_id,snap)
