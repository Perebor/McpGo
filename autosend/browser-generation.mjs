import fs from 'node:fs';
import path from 'node:path';

// A passive, locally written backend identity. Reading this file never
// attaches Chrome, creates a tab or touches a ChatGPT conversation.
export const DEFAULT_GENERATION_FILE=process.env.MCPHUB_AUTOSEND_BROWSER_GENERATION_FILE||
 path.join(process.env.APPDATA||'', 'mcpgo-windows','AutoSend','browser-generation.json');

export function readBrowserGeneration(file=DEFAULT_GENERATION_FILE){
 try{
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  return data?.version===1&&typeof data.generation==='string'&&
   /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(data.generation)
   ?data.generation:null;
 }catch{return null}
}

export class BrowserGenerationGuard{
 constructor(read=readBrowserGeneration){this.read=read;this.seen=read()}
 sync(approval){
  const current=this.read();
  if(current===this.seen)return false;
  this.seen=current;
  approval.reset();return true;
 }
}