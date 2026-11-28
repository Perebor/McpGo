"""Owner-invoked MCP-10 bridge: HMAC Hub lease -> local Git roles -> ACK only.

No AutoSend, ChatGPT, browser or model calls. Untrusted Hub payloads cannot
supply source edits; the pinned plan comes from the owner's local workflow.
"""
import hashlib
import json
from pathlib import Path
import secrets
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'messaging'))
import delegated_auth
from execution.role_engine import PROJECT_ROLES,ScopeError,_digest,_validate

MAX_RESPONSE=32768


class DelegatedQueueClient:
    def __init__(self,actor,project,secret,*,port=8971):
        if project not in PROJECT_ROLES or actor!=PROJECT_ROLES[project]['coder']:
            raise ValueError('Only exact project-scoped coder lease identity permitted')
        if not isinstance(secret,bytes) or len(secret)!=32:
            raise ValueError('Invalid delegated key')
        if type(port) is not int or not 1<=port<=65535:
            raise ValueError('Invalid local API port')
        self.actor=actor
        self.project=project
        self.secret=secret
        self.port=port

    def _post(self,route,body):
        if route not in ('/api/work/claim','/api/work/ack'):
            raise ValueError('Delegated route forbidden')
        raw=json.dumps(body,sort_keys=True,separators=(',',':')).encode('utf-8')
        now=int(time.time())
        nonce=secrets.token_urlsafe(18)
        signature=delegated_auth.sign(self.secret,self.actor,self.project,
             'POST',route,now,nonce,body=raw)
        request=urllib.request.Request(
             f'http://127.0.0.1:{self.port}'+route,data=raw,
             headers={'Host':'127.0.0.1:8971',
                      'X-MCPHub-Client':'delegate',
                      'X-MCPHub-Actor':self.actor,
                      'X-MCPHub-Project':self.project,
                      'X-MCPHub-Time':str(now),
                      'X-MCPHub-Nonce':nonce,
                      'X-MCPHub-Signature':signature,
                      'Content-Type':'application/json'})
        # The caller MUST NOT retry after a transport error. The operation may
        # have committed before the response disappeared.
        with urllib.request.urlopen(request,timeout=4) as response:
            data=response.read(MAX_RESPONSE+1)
            if len(data)>MAX_RESPONSE:
                raise ValueError('Oversize Hub response')
            payload=json.loads(data)
            if response.status!=200 or not isinstance(payload,dict):
                raise ValueError('Unverified Hub response')
            return payload

    def claim(self):
        value=self._post('/api/work/claim',{'agent':self.actor,'project':self.project})
        if set(value)!={'task'}:
            raise ValueError('Unexpected claim response')
        return value['task']

    def ack(self,item_id,lease,result_fingerprint):
        value=self._post('/api/work/ack',{'agent':self.actor,'project':self.project,
                     'id':item_id,'lease_token':lease,
                     'result_fingerprint':result_fingerprint})
        if value.get('state')!='ACKED':
            raise ValueError('Hub did not accept ACK')
        return value


def execute_once(engine,plan,client):
    """No automatic retries, no model work, no unbounded Hub instructions."""
    plan=_validate(plan)
    if plan['project']!=client.project:
        return {'status':'NEED_OWNER','stage':'PROJECT_SCOPE_REQUIRES_APPROVAL'}
    try:
        engine.check_scope(client.actor,client.project,'coder')
    except ScopeError:
        return {'status':'NEED_OWNER','stage':'PROJECT_REPOSITORY_NOT_AUTHORIZED'}
    try:
        lease=client.claim()
    except urllib.error.HTTPError as error:
        # HTTP 403 is an explicit, pre-mutation refusal by Hub authorization.
        if error.code==403:
            return {'status':'NEED_OWNER','stage':'DELEGATION_REVOKED_OR_FORBIDDEN'}
        return {'status':'UNKNOWN','stage':'CLAIM_UNCONFIRMED'}
    except (ValueError,TypeError,urllib.error.URLError,OSError):
        # Transport outcome may be ambiguous: never retry a claim automatically.
        return {'status':'UNKNOWN','stage':'CLAIM_UNCONFIRMED'}
    if lease is None:
        return {'status':'NO_TASK'}
    if (not isinstance(lease,dict) or
        lease.get('project')!=plan['project'] or
        lease.get('agent')!=client.actor or
        lease.get('fingerprint')!=_digest(plan) or
        lease.get('payload')!={'intent':'build','context':'McpGo'} or
        not isinstance(lease.get('id'),str) or
        not isinstance(lease.get('lease_token'),str)):
        return {'status':'UNKNOWN','stage':'UNMATCHED_PINNED_PLAN'}
    receipt=engine.run(plan)
    if receipt['status']!='VERIFIED':
        return {'status':receipt['status'],'stage':'LOCAL_EXECUTION_NOT_VERIFIED',
                'execution':receipt}
    proof=hashlib.sha256(json.dumps(receipt,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    try:
        client.ack(lease['id'],lease['lease_token'],proof)
    except (ValueError,TypeError,urllib.error.URLError,OSError):
        return {'status':'UNKNOWN','stage':'ACK_UNCONFIRMED',
                'execution':receipt}
    return {'status':'ACKED','queue_id':lease['id'],'result_fingerprint':proof,
            'execution':receipt}
