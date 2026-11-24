import {conditionPlan} from './inspection-conditions.mjs';
/** Read-only, workspace-scoped high-signal browser inspection, one active tab.
 * This is a planner: it never owns Chrome, retries writes, or chooses tabs.
 * Every planned action is executed by the proxy's existing serialized guard.
 */
export const PAGE_INSPECT_TOOL={
 name:'mcpgo_inspect_page',
 description:'Inspect the CURRENT owned tab. auto/find and recover return concise node matches and fresh refs (never replay a stale click); snapshot scopes to target/depth; verify waits for visible text; state checks exact URL, selector state, same-origin iframes and observed resource path (not HTTP success); scroll searches with a bounded number of scroll steps. visual combines accessibility boxes with explicit image (screenshotOnly for SVG/no-body). Never clicks, submits, navigates, or automatically retries mutations.',
 inputSchema:{type:'object',properties:{
  strategy:{type:'string',enum:['auto','find','snapshot','verify','visual','state','scroll','recover'],description:'auto/find/snapshot/verify/visual, recover (refresh stale ref via search), state (URL/DOM/resource), or bounded scroll'},
  query:{type:'string',description:'Case-insensitive page text to find'},
  regex:{type:'string',description:'Regex for find (instead of query), e.g. /publish/i'},
  target:{type:'string',description:'Exact snapshot ref or unique selector to scope snapshot/visual'},
  depth:{type:'integer',minimum:1,maximum:12,description:'Maximum snapshot depth; defaults to 6'},
  maxResults:{type:'integer',minimum:1,maximum:15,description:'Maximum find matches; defaults to 5'},
  boxes:{type:'boolean',description:'Include bounding boxes in accessibility snapshot'},
  visualFallback:{type:'boolean',description:'Explicitly permit screenshot only when auto result has little accessibility signal'},
  screenshotOnly:{type:'boolean',description:'For an SVG or no-body page: get image directly, avoid a hanging accessibility snapshot'},
  expectedGone:{type:'string',description:'Verify this text disappears'},
  timeoutSeconds:{type:'number',minimum:1,maximum:15,description:'Bounded verify timeout in seconds, default 7; max 4 for state/scroll'},
  selector:{type:'string',description:'CSS selector for predefined state/scroll inspection'},
  expectedUrl:{type:'string',description:'Exact canonical HTTP(S) URL to wait for; response only returns matched boolean'},
  expectedRequestPath:{type:'string',description:'Path of a completed resource in Resource Timing, NOT proof of HTTP success'},
  expectedText:{type:'string',description:'For verify: visible text to await; for state/scroll: text inside selector'},
  elementState:{type:'string',enum:['visible','hidden','attached','detached']},
  includeFrames:{type:'boolean',description:'Inspect same-origin iframe documents only, never cross-origin'},
  containerSelector:{type:'string',description:'Optional scrollable container selector'},
  maxSteps:{type:'integer',minimum:1,maximum:12},
  stepPixels:{type:'integer',minimum:80,maximum:1000},
 },additionalProperties:false}
};
const hasText=v=>typeof v==='string'&&v.trim().length>0;
const isShortString=v=>typeof v==='string'&&v.length<=300;
export function planPageInspection(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('INVALID_INSPECTION_ARGUMENTS');
 const allow=new Set(Object.keys(PAGE_INSPECT_TOOL.inputSchema.properties).concat('workspace_id'));
 if(Object.keys(input).some(k=>!allow.has(k)))throw Error('INVALID_INSPECTION_ARGUMENTS');
 const strategy=input.strategy||'auto';
 if(!['auto','find','snapshot','verify','visual','state','scroll','recover'].includes(strategy))throw Error('INVALID_INSPECTION_STRATEGY');
 for(const name of ['query','regex','target','expectedText','expectedGone']){
  if(input[name]!==undefined&&(!isShortString(input[name])||!hasText(input[name])))
   throw Error('INVALID_INSPECTION_TEXT');
 }
 for(const [name,min,max] of [['depth',1,12],['maxResults',1,15]]){
  if(input[name]!==undefined&&(!Number.isInteger(input[name])||input[name]<min||input[name]>max))
   throw Error('INVALID_INSPECTION_LIMIT');
 }
 if(input.timeoutSeconds!==undefined&&(!Number.isFinite(input.timeoutSeconds)||input.timeoutSeconds<1||input.timeoutSeconds>15))
  throw Error('INVALID_INSPECTION_TIMEOUT');
 if(input.boxes!==undefined&&typeof input.boxes!=='boolean')throw Error('INVALID_INSPECTION_BOXES');
 if(input.visualFallback!==undefined&&typeof input.visualFallback!=='boolean')throw Error('INVALID_INSPECTION_FALLBACK');
 if(input.screenshotOnly!==undefined&&typeof input.screenshotOnly!=='boolean')throw Error('INVALID_INSPECTION_IMAGE_MODE');
 if(input.screenshotOnly&&strategy!=='visual')throw Error('INSPECTION_IMAGE_ONLY_REQUIRES_VISUAL');
 if(input.query&&input.regex)throw Error('INSPECTION_QUERY_OR_REGEX_REQUIRED');
 if(['state','scroll'].includes(strategy))return conditionPlan(input);
 if(strategy==='recover'){
  if(!input.query&&!input.regex)throw Error('INSPECTION_QUERY_REQUIRED');
  return {kind:'recover',tool:'browser_find',args:{
   ...(input.query?{text:input.query}:{regex:input.regex}),maxResults:input.maxResults??5},visualFallback:false};
 }
 let effective=strategy==='auto'?(input.query||input.regex?'find':'snapshot'):strategy;
 if(effective==='find'){
  if(!input.query&&!input.regex)throw Error('INSPECTION_QUERY_REQUIRED');
  return {kind:'find',tool:'browser_find',args:{
   ...(input.query?{text:input.query}:{regex:input.regex}),maxResults:input.maxResults??5},
   visualFallback:strategy==='auto'&&input.visualFallback===true};
 }
 if(effective==='verify'){
  if(!input.expectedText&&!input.expectedGone)throw Error('INSPECTION_EXPECTATION_REQUIRED');
  return {kind:'verify',tool:'browser_wait_for',args:{
   ...(input.expectedText?{text:input.expectedText}:{}),
   ...(input.expectedGone?{textGone:input.expectedGone}:{}),
   time:input.timeoutSeconds??7},visualFallback:false};
 }
 if(strategy==='visual'&&input.screenshotOnly)
  return {kind:'image-only',tool:'browser_take_screenshot',args:visualSnapshotArgs(),visualFallback:false};
 const snapArgs={depth:input.depth??6,...(input.target?{target:input.target}:{}),
  boxes:effective==='visual'||input.boxes===true};
 return {kind:effective,tool:'browser_snapshot',args:snapArgs,
  visualFallback:effective==='visual'||(strategy==='auto'&&input.visualFallback===true)};
}
export function lowAccessibilitySignal(message){
 if(message?.error||message?.result?.isError)return false;
 const pieces=(message?.result?.content||[]).filter(c=>c?.type==='text').map(c=>c.text||'');
 if(!pieces.length)return true;
 const txt=pieces.join('\n').replace(/^### (?:Result|Page Snapshot)[^\n]*\n?/gm,'').trim();
 if(/no matches|0 matches|no results found|no matching elements/i.test(txt))return true;
 // Avoid screenshots when a normal accessibility tree contains useful controls.
 if(/\b(?:button|link|textbox|checkbox|heading|option|menuitem)\b/i.test(txt))return false;
 return txt.length<90;
}
export const visualSnapshotArgs=()=>({type:'webp',scale:'css',fullPage:false});
