"""MCP-12 owner-local read-only usage summary, policy and fixture CLI.

This CLI performs no model calls, no retries, no Git writes, no external calls.
Usage totals are claims, not provider-confirmed calls or token charges.
"""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from execution.usage_ledger import UsageLedger,UsageDenied,choose_route,compare_fixture


def main():
    parser=argparse.ArgumentParser(description='McpGo local usage evidence inspector (no Send)')
    sub=parser.add_subparsers(dest='command',required=True)
    summary=sub.add_parser('summary',help='Show durable project/agent claims and verified local results')
    summary.add_argument('--db',type=Path,required=True)
    summary.add_argument('--project',required=True,help='TD, Museum or exact task:UUID read-only scope')
    summary.add_argument('--agent',required=True)
    route=sub.add_parser('route',help='Advisory: no model is dispatched')
    route.add_argument('--local',choices=['VERIFIED','PENDING','EXHAUSTED','BLOCKED'],required=True)
    route.add_argument('--ordinary',choices=['AVAILABLE','UNAVAILABLE','UNKNOWN'],required=True)
    route.add_argument('--limited',choices=['AVAILABLE','UNAVAILABLE','UNKNOWN'],required=True)
    route.add_argument('--owner-paid',action='store_true',default=False)
    compare=sub.add_parser('compare',help='Hypothetical same-fixture claims, never actual token savings')
    compare.add_argument('--fixtures',type=Path,required=True)
    capture=sub.add_parser('capture-codex',help='Import scoped local Codex telemetry, NOT billed usage')
    capture.add_argument('--db',type=Path,required=True)
    capture.add_argument('--session',type=Path,required=True)
    capture.add_argument('--codex-root',type=Path,required=True)
    capture.add_argument('--engine-state',type=Path,required=True)
    capture.add_argument('--engine-worktrees',type=Path,required=True)
    capture.add_argument('--project',choices=['TD','Museum'],required=True)
    capture.add_argument('--agent',required=True)
    capture.add_argument('--run-id',required=True)
    args=parser.parse_args()
    try:
        if args.command=='summary':
            result=UsageLedger(args.db,readonly=True).summary(args.project,args.agent)
        elif args.command=='route':
            result=choose_route(args.local,args.ordinary,args.limited,args.owner_paid)
        elif args.command=='capture-codex':
            from execution.role_engine import RoleEngine
            from execution.codex_usage import capture_codex_usage
            if (not args.engine_state.is_dir() or
                not (args.engine_state/'roles.sqlite3').is_file()):
                raise UsageDenied('Missing existing owner-registered RoleEngine state')
            engine=RoleEngine(args.engine_state,args.engine_worktrees)
            repo=engine._repo(args.project)
            ledger=UsageLedger(args.db)
            event=capture_codex_usage(ledger,args.session,args.codex_root,repo,
                         args.project,args.agent,args.run_id,owner_engine=engine)
            result={'event':event,'summary':ledger.summary(args.project,args.agent)}
        else:
            if args.fixtures.is_symlink() or not args.fixtures.is_file() or args.fixtures.stat().st_size>100_000:
                raise UsageDenied('Unsafe or too large fixture')
            fixture=json.loads(args.fixtures.read_text(encoding='utf-8'))
            result=compare_fixture(fixture)
        print(json.dumps(result,ensure_ascii=False,indent=2))
    except (UsageDenied,ValueError,OSError) as exc:
        print(json.dumps({'error':str(exc)},ensure_ascii=False),file=sys.stderr)
        return 2
    return 0


if __name__=='__main__':
    sys.exit(main())
