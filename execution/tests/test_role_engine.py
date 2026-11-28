"""MCP-10 integration: only temporary Git fixtures, no ChatGPT/TD/Museum writes."""
import concurrent.futures,hashlib,pathlib,subprocess,sys,tempfile,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]))
try:
 from execution.role_engine import RoleEngine,ScopeError,UnsafePlan,LeaseConflict,ConflictError
except ImportError:
 RoleEngine=None
 ScopeError=UnsafePlan=LeaseConflict=ConflictError=ValueError
def git(repo,*args):
 return subprocess.check_output(['git','-C',str(repo),*args],text=True,encoding='utf-8').strip()
def sha(s): return hashlib.sha256(s.encode()).hexdigest()
class RoleE2E(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='mcpgo10-');self.addCleanup(self.tmp.cleanup)
  self.root=pathlib.Path(self.tmp.name);self.repo=self.root/'owner_td';self.repo.mkdir()
  git(self.repo,'init','-q');git(self.repo,'config','user.name','Fixture Owner')
  git(self.repo,'config','user.email','owner@example.invalid')
  (self.repo/'src').mkdir();(self.repo/'tests').mkdir()
  self.original='def scale(x):\n    return x\n'
  for m in ['alpha','beta']:(self.repo/'src'/f'{m}.py').write_text(self.original)
  (self.repo/'tests'/'__init__.py').write_text('')
  git(self.repo,'add','.');git(self.repo,'commit','-qm','owner baseline')
  self.base=git(self.repo,'rev-parse','HEAD')
 def engine(self):
  self.assertIsNotNone(RoleEngine,'executor source missing')
  e=RoleEngine(self.root/'state',self.root/'worktrees');e.register('TD',self.repo);return e
 def plan(self,m='alpha',task='task-a',fail=False):
  source=f'def scale(x):\n    return x * {3 if fail else 2}\n'
  test='import unittest\n'+f'from src.{m} import scale\n'+'class TestScale(unittest.TestCase):\n    def test_scale(self):\n        self.assertEqual(scale(7),14)\n'
  return dict(project='TD',task_id=task,base_commit=self.base,changes=[
   dict(path=f'src/{m}.py',expected_sha256=sha(self.original),content=source),
   dict(path=f'tests/test_{m}.py',expected_sha256=None,content=test)])
 def test_actual_roles_three_worktrees_and_git_proof(self):
  e=self.engine();r=e.run(self.plan())
  self.assertEqual(r['status'],'VERIFIED')
  self.assertEqual(set(r['roles']),{'coordinator','coder','tester','auditor'})
  self.assertEqual(r['coordinator_actor'],'mcpgo_lead')
  self.assertEqual(len(set(r['role_pids'].values())),4)
  self.assertEqual(len(set(r['worktrees'].values())),3)
  self.assertTrue(r['tester_pass'] and r['auditor_pass'])
  self.assertEqual(git(self.repo,'rev-parse','HEAD'),self.base)
  self.assertEqual((self.repo/'src'/'alpha.py').read_text(),self.original)
  self.assertEqual(git(self.repo,'rev-parse',r['branch']),r['commit'])
  self.assertEqual(git(self.repo,'rev-parse',r['commit']+'^'),self.base)
  self.assertEqual(set(git(self.repo,'diff','--name-only',self.base,r['commit']).splitlines()),{'src/alpha.py','tests/test_alpha.py'})
  self.assertEqual(e.run(self.plan())['commit'],r['commit'])
 def test_parallel_branches_independent_changes(self):
  e=self.engine();plans=[self.plan('alpha','first'),self.plan('beta','second')]
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
   rs=[f.result(timeout=45) for f in [pool.submit(e.run,p) for p in plans]]
  self.assertEqual([x['status'] for x in rs],['VERIFIED','VERIFIED'])
  self.assertEqual(len({x['branch'] for x in rs}),2)
  self.assertEqual(len({x['commit'] for x in rs}),2)
  for r,m in zip(rs,['alpha','beta']):
   self.assertEqual(set(git(self.repo,'diff','--name-only',self.base,r['commit']).splitlines()),{f'src/{m}.py',f'tests/test_{m}.py'})
  self.assertEqual(git(self.repo,'rev-parse','HEAD'),self.base)
 def test_actor_project_fence(self):
  e=self.engine();e.check_scope('td_coder','TD','coder')
  with self.assertRaises(ScopeError):e.check_scope('td_coder','Museum','coder')
  with self.assertRaises(ScopeError):e.check_scope('td_auditor','TD','coder')
  with self.assertRaises(ScopeError):e.register('Museum',self.repo)
  with self.assertRaises(ScopeError):e.run({**self.plan(),'project':'Museum'})
 def test_claim_durable_no_replay_with_new_payload(self):
  e=self.engine();self.assertEqual(e.run(self.plan())['status'],'VERIFIED')
  p=self.plan();p['changes'][0]['content']='def scale(x):\n    return 999\n'
  with self.assertRaises(ConflictError):e.run(p)
  self.assertEqual(e.summary('TD')['VERIFIED'],1)
 def test_untrusted_path_and_shell_fields_fail_closed(self):
  e=self.engine()
  for bad in ('../outside.py','/tmp/evil.py','.git/config','src/../other.py','README.md','src/a.exe'):
   p=self.plan();p['changes'][0]['path']=bad
   with self.subTest(path=bad),self.assertRaises(UnsafePlan):e.run(p)
  p=self.plan();p['test_command']='powershell -c something'
  with self.assertRaises(UnsafePlan):e.run(p)
  self.assertEqual(e.summary('TD')['VERIFIED'],0)
 def test_failing_test_has_no_verification_or_retry(self):
  e=self.engine();p=self.plan(task='fails',fail=True);r=e.run(p)
  self.assertEqual(r['status'],'FAILED');self.assertFalse(r['tester_pass'])
  with self.assertRaises(LeaseConflict):e.run(p)
 def test_branch_lock_denies_conflicting_work(self):
  e=self.engine();p=self.plan()
  with e.reserve_branch('TD',p['task_id']):
   with self.assertRaises(LeaseConflict):e.run(p)
  self.assertEqual(e.summary('TD')['VERIFIED'],0)
 def test_two_projects_parallel_have_separate_repositories_and_actors(self):
  museum=self.root/'owner_museum';museum.mkdir()
  git(museum,'init','-q')
  git(museum,'config','user.name','Fixture Owner')
  git(museum,'config','user.email','owner@example.invalid')
  (museum/'src').mkdir();(museum/'tests').mkdir()
  (museum/'src'/'exhibit.py').write_text(self.original)
  (museum/'tests'/'__init__.py').write_text('')
  git(museum,'add','.');git(museum,'commit','-qm','separate museum baseline')
  museum_base=git(museum,'rev-parse','HEAD')
  e=self.engine()
  e.register('Museum',museum)
  museum_plan={'project':'Museum','task_id':'museum-feature','base_commit':museum_base,'changes':[
   {'path':'src/exhibit.py','expected_sha256':sha(self.original),'content':'def scale(x):\n    return x * 2\n'},
   {'path':'tests/test_exhibit.py','expected_sha256':None,
    'content':'import unittest\nfrom src.exhibit import scale\nclass ExhibitTest(unittest.TestCase):\n    def test_scale(self):\n        self.assertEqual(scale(7),14)\n'}]}
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
   td_future=pool.submit(e.run,self.plan(task='td-feature'))
   museum_future=pool.submit(e.run,museum_plan)
   td=td_future.result(timeout=45);ms=museum_future.result(timeout=45)
  self.assertEqual((td['status'],ms['status']),('VERIFIED','VERIFIED'))
  self.assertIn('mcpgo/TD/',td['branch'])
  self.assertIn('mcpgo/Museum/',ms['branch'])
  self.assertEqual(git(self.repo,'rev-parse','HEAD'),self.base)
  self.assertEqual(git(museum,'rev-parse','HEAD'),museum_base)
  self.assertEqual(git(museum,'rev-parse',ms['branch']),ms['commit'])
  self.assertNotEqual(td['commit'],ms['commit'])
  self.assertNotIn(str(museum),str(td['worktrees']))
  with self.assertRaises(ScopeError):e.check_scope('td_coder','Museum','coder')

if __name__=='__main__':unittest.main()
