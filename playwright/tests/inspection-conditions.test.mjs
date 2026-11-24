import test from 'node:test';
import assert from 'node:assert/strict';
import {conditionPlan} from '../inspection-conditions.mjs';
import {planPageInspection,PAGE_INSPECT_TOOL} from '../page-inspection.mjs';
test('predefined state checks URLs and same-origin iframe selectors, not arbitrary code',()=>{
 const p=planPageInspection({strategy:'state',selector:'#publish',includeFrames:true,expectedText:'Saved',timeoutSeconds:3});
 assert.equal(p.tool,'browser_evaluate');assert.ok(p.args.function.startsWith('async () =>'));
 assert.ok(p.args.function.includes('contentDocument'));
 assert.ok(p.args.function.includes('MCPGO_PAGE_CONDITION_NOT_MET'));
 const malicious="');document.cookie='stolen";
 const escaped=conditionPlan({strategy:'state',selector:malicious}).args.function;
 assert.ok(escaped.includes(JSON.stringify(malicious)));
 assert.ok(!escaped.includes("const options={selector:');"));
});
test('bounded scroll cannot exceed max steps or run arbitrary scripts',()=>{
 const p=planPageInspection({strategy:'scroll',selector:'#row900',containerSelector:'#rows',maxSteps:4,stepPixels:450});
 assert.equal(p.kind,'scroll');assert.ok(p.args.function.includes('scrollTop+=options.stepPixels'));
 assert.throws(()=>conditionPlan({strategy:'scroll',selector:'#row',maxSteps:1000}),/LIMIT/);
 assert.throws(()=>conditionPlan({strategy:'scroll',selector:'#row',stepPixels:10000}),/STEP/);
 assert.throws(()=>conditionPlan({strategy:'scroll',selector:'#row',timeoutSeconds:20}),/TIMEOUT/);
});
test('read-only stale ref recovery returns a fresh find, never a replayed click',()=>{
 const plan=planPageInspection({strategy:'recover',query:'Publish',maxResults:2});
 assert.deepEqual(plan,{kind:'recover',tool:'browser_find',args:{text:'Publish',maxResults:2},visualFallback:false});
 assert.ok(PAGE_INSPECT_TOOL.inputSchema.properties.includeFrames);
});
test('invalid URL, resource path and unsupported state fail before execution',()=>{
 for(const v of [{strategy:'state',expectedUrl:'file:///etc/passwd'},
  {strategy:'state',expectedRequestPath:'https://example.com/secret'},
  {strategy:'state',elementState:'unchecked',selector:'#foo'},
  {strategy:'state'}, {strategy:'scroll',expectedText:'x',includeFrames:'1'},
  {strategy:'state',selector:'a'.repeat(350)}])assert.throws(()=>conditionPlan(v),/INSPECTION/);
});
test('SVG image-only fallback bypasses accessibility snapshot safely',()=>{
 const p=planPageInspection({strategy:'visual',screenshotOnly:true});
 assert.equal(p.kind,'image-only');assert.equal(p.tool,'browser_take_screenshot');
 assert.deepEqual(p.args,{type:'webp',scale:'css',fullPage:false});
 assert.equal(p.visualFallback,false);
 assert.throws(()=>planPageInspection({strategy:'auto',screenshotOnly:true}),/INSPECTION_IMAGE/);
});
