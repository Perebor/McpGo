import test from 'node:test';
import assert from 'node:assert/strict';
import {planPageInspection,lowAccessibilitySignal,PAGE_INSPECT_TOOL} from '../page-inspection.mjs';
test('auto prefers bounded find over whole-page snapshots',()=>{
 const plan=planPageInspection({query:'Publish',maxResults:3,visualFallback:true});
 assert.deepEqual(plan,{kind:'find',tool:'browser_find',args:{text:'Publish',maxResults:3},visualFallback:true});
 assert.equal(PAGE_INSPECT_TOOL.name,'mcpgo_inspect_page');
});
test('targeted snapshot, visual and verification are different explicit operations',()=>{
 assert.deepEqual(planPageInspection({target:'#dialog',depth:3}),{kind:'snapshot',tool:'browser_snapshot',args:{depth:3,target:'#dialog',boxes:false},visualFallback:false});
 assert.equal(planPageInspection({strategy:'visual'}).visualFallback,true);
 assert.equal(planPageInspection({strategy:'visual'}).args.boxes,true);
 assert.deepEqual(planPageInspection({strategy:'verify',expectedText:'Saved',timeoutSeconds:5}),
  {kind:'verify',tool:'browser_wait_for',args:{text:'Saved',time:5},visualFallback:false});
});
test('invalid arguments, long search, large timeout and unknown keys fail closed',()=>{
 for(const input of [{query:'a',regex:'b'},{strategy:'verify'},{strategy:'find'},
  {depth:-1},{maxResults:200},{timeoutSeconds:300},{target:'a'.repeat(301)},
  {unrestrictedCode:'() => document.cookie'},{boxes:'yes'}]){
  assert.throws(()=>planPageInspection(input),/INSPECTION/);
 }
});
test('visual fallback is only considered on low-signal successful text',()=>{
 const msg=text=>({result:{content:[{type:'text',text}]}});
 assert.ok(lowAccessibilitySignal(msg('### Page Snapshot\n- canvas')));
 assert.ok(lowAccessibilitySignal(msg('No matches found')));
 assert.equal(lowAccessibilitySignal(msg('- button "Continue"\n- textbox "Search"')),false);
 assert.equal(lowAccessibilitySignal({result:{isError:true,content:[]}}),false);
});
