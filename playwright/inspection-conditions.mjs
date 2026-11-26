/** Predefined browser-side checks. No caller-authored JavaScript is executed.
 * Intended only for the current OWNED tab, via the serialized proxy queue.
 */
const short=(v,max=240)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
export function conditionPlan(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('INVALID_INSPECTION_ARGUMENTS');
 const strategy=input.strategy;
 if(!['state','scroll'].includes(strategy))throw Error('INVALID_INSPECTION_STRATEGY');
 const selector=input.selector;
 const expectedUrl=input.expectedUrl;
 const expectedRequestPath=input.expectedRequestPath;
 if(selector!==undefined&&!short(selector))throw Error('INVALID_INSPECTION_SELECTOR');
 if(expectedUrl!==undefined){
  if(!short(expectedUrl,2048))throw Error('INVALID_INSPECTION_URL');
  try{const u=new URL(expectedUrl);if(!['http:','https:'].includes(u.protocol)||u.href!==expectedUrl)throw Error();}
  catch{throw Error('INVALID_INSPECTION_URL');}
 }
 if(expectedRequestPath!==undefined&&(!short(expectedRequestPath)||
   !expectedRequestPath.startsWith('/')||expectedRequestPath.startsWith('//')))
  throw Error('INVALID_INSPECTION_RESOURCE');
 if(strategy==='state'&&!selector&&!expectedUrl&&!expectedRequestPath)
  throw Error('INSPECTION_CONDITION_REQUIRED');
 if(strategy==='scroll'&&!selector&&!short(input.expectedText))
  throw Error('INSPECTION_CONDITION_REQUIRED');
 if(input.includeFrames!==undefined&&typeof input.includeFrames!=='boolean')
  throw Error('INVALID_INSPECTION_FRAMES');
 if(input.expectedText!==undefined&&!short(input.expectedText))
  throw Error('INVALID_INSPECTION_TEXT');
 if(input.containerSelector!==undefined&&!short(input.containerSelector))
  throw Error('INVALID_INSPECTION_SELECTOR');
 if(input.elementState!==undefined&&!['visible','hidden','attached','detached'].includes(input.elementState))
  throw Error('INVALID_INSPECTION_STATE');
 const timeoutSeconds=input.timeoutSeconds??3;
 if(!Number.isFinite(timeoutSeconds)||timeoutSeconds<1||timeoutSeconds>4)
  throw Error('INVALID_INSPECTION_TIMEOUT');
 const maxSteps=input.maxSteps??6;
 if(!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>12)
  throw Error('INVALID_INSPECTION_SCROLL_LIMIT');
 const stepPixels=input.stepPixels??550;
 if(!Number.isInteger(stepPixels)||stepPixels<80||stepPixels>1000)
  throw Error('INVALID_INSPECTION_SCROLL_STEP');
 const opts={selector:selector||null,expectedText:input.expectedText||null,
  expectedUrl:expectedUrl||null,expectedRequestPath:expectedRequestPath||null,
  includeFrames:input.includeFrames===true,elementState:input.elementState||'visible',
  containerSelector:input.containerSelector||null,maxSteps,stepPixels,
  timeoutMs:Math.round(timeoutSeconds*1000),strategy};
 return {kind:strategy,tool:'browser_evaluate',args:{function:inspectionFunction(opts)},visualFallback:false};
}
function inspectionFunction(opts){
 // JSON encoding, NOT interpolation as JavaScript source. The page cannot
 // select an expression, pass a function, navigate, click or submit forms.
 return `async () => {
  const options=${JSON.stringify(opts)};
  const visible=el=>{if(!el)return false;const box=el.getBoundingClientRect();
   const css=el.ownerDocument.defaultView?.getComputedStyle(el);
   return box.width>0&&box.height>0&&css?.display!=='none'&&css?.visibility!=='hidden';};
  const documents=()=>{const docs=[document];let inaccessibleFrames=0;
   if(options.includeFrames){for(const frame of [...document.querySelectorAll('iframe')].slice(0,20)){
     try{if(frame.contentDocument)docs.push(frame.contentDocument);else inaccessibleFrames++;}
     catch{inaccessibleFrames++;}
   }}return {docs,inaccessibleFrames};};
  const check=()=>{
   if(options.expectedUrl&&location.href!==options.expectedUrl)return false;
   if(options.expectedRequestPath){
    const observed=performance.getEntriesByType('resource').some(entry=>{
     try{return new URL(entry.name,location.href).pathname===options.expectedRequestPath&&entry.responseEnd>0;}
     catch{return false;}
    });
    if(!observed)return false;
   }
   if(options.selector||options.expectedText){
    const {docs}=documents();const elements=[];
    for(const doc of docs){
      if(options.selector)elements.push(...[...doc.querySelectorAll(options.selector)].slice(0,40));
      else if(doc.body)elements.push(doc.body);
    }
    const state=options.elementState;
    if(state==='detached'){if(elements.length)return false;}
    else if(state==='hidden'){
      if(elements.some(el=>visible(el)))return false;
    }else{
      if(!elements.some(el=>(state==='attached'||visible(el))&&
        (!options.expectedText||String(el.textContent||'').includes(options.expectedText))))return false;
    }
   }
   return true;
  };
  const started=Date.now();let steps=0;
  while(Date.now()-started<=options.timeoutMs){
    let matched=false;
    try{matched=check();}
    catch{throw Error('MCPGO_PAGE_CONDITION_INVALID_SELECTOR');}
    if(matched){const frameInfo=documents();return {matched:true,steps,checkedFrames:frameInfo.docs.length,
      inaccessibleFrames:frameInfo.inaccessibleFrames,networkStatusVerified:false};}
    if(options.strategy==='scroll'&&steps<options.maxSteps){
      const container=options.containerSelector?document.querySelector(options.containerSelector):null;
      const target=container||document.scrollingElement||document.documentElement;
      target.scrollTop+=options.stepPixels;steps++;
    }else if(options.strategy==='scroll'&&steps>=options.maxSteps){
      throw Error('MCPGO_SCROLL_LIMIT_REACHED');
    }
    await new Promise(resolve=>setTimeout(resolve,180));
  }
  throw Error('MCPGO_PAGE_CONDITION_NOT_MET');
 }`;
}
