import test from 'node:test';
import assert from 'node:assert/strict';
import {filterTools,visibleTool,validateToolProfile} from '../tool-profiles.mjs';
test('catalog profiles keep workspace, ownership and core semantics',()=>{
 const tools=['browser_tabs','browser_find','mcpgo_inspect_page','mcpgo_workspace',
  'mcpgo_tab_action','mcpgo_browser_status','browser_take_screenshot',
  'browser_network_requests','browser_evaluate','browser_drag'].map(name=>({name}));
 assert.equal(filterTools(tools,'core').length,6);
 assert.equal(filterTools(tools,'vision').length,8);
 assert.equal(filterTools(tools,'diagnostics').length,10);
 assert.deepEqual(filterTools(tools,'full'),tools);
});
test('invalid profiles fail closed and do not expose unknown tools',()=>{
 assert.throws(()=>validateToolProfile(''),/Invalid/);
 assert.throws(()=>filterTools([], 'all'),/Invalid/);
 assert.equal(visibleTool('browser_nonexistent','core'),false);
 assert.equal(visibleTool('browser_take_screenshot','core'),false);
 assert.equal(visibleTool('browser_evaluate','vision'),false);
});
