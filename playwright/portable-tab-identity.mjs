/**
 * Index-independent opaque tab handles for Playwright MCP's public tabs list.
 * The official extension does not expose chrome.tabs.Tab.id to MCP tools. We
 * therefore only preserve identity when the URL fingerprint is UNIQUE across
 * the current list; duplicate or vanished tabs fail closed. Never persist or
 * report tab URLs, titles, cookies or page data in the registry.
 *
 * This deliberately cannot guarantee physical continuity when the user
 * replaces a tab with an identical-URL tab between two observations. For a
 * stronger guarantee, an official stable upstream targetId is required.
 * Portable on macOS/Windows, no Chrome/OS-specific APIs.
 */
import {createHash, randomUUID} from 'node:crypto';

const tabLine=/^\s*-\s*(\d+):\s*(.*)$/;
const safeIndex=i=>Number.isSafeInteger(i)&&i>=0&&i<100000;
const digest=url=>createHash('sha256').update(url).digest('hex');
export function parseTabRows(content){
  const rows=[];
  for(const line of String(content).split(/\r?\n/)){
    const match=tabLine.exec(line);
    if(!match)continue;
    const index=Number(match[1]);
    if(!safeIndex(index))continue;
    let part=match[2];
    const current=part.startsWith('(current) ');
    if(current)part=part.slice('(current) '.length);
    const begin=part.indexOf(']('),end=part.lastIndexOf(')');
    // Never claim an identity from incomplete text or non-URL labels.
    if(begin<0||end<=begin+2||end!==part.length-1||part[0]!=='[')continue;
    const url=part.slice(begin+2,end);
    if(!url || url.length>8192)continue;
    rows.push({index,current,fingerprint:digest(url)});
  }
  return rows;
}
export class PortableTabIdentity {
  constructor(){this.entries=new Map();this.generation=0;this.last=new Map();this.current=null;this.ambiguous=0;}
  clear(){this.entries.clear();this.last.clear();this.current=null;this.ambiguous=0;this.generation++;}
  observe(content){
    const rows=parseTabRows(content);
    const counts=new Map();for(const r of rows)counts.set(r.fingerprint,(counts.get(r.fingerprint)||0)+1);
    const known=new Map();for(const [id,entry] of this.entries)known.set(entry.fingerprint,id);
    const latest=new Map();let ambiguous=0;
    for(const r of rows){
      if(counts.get(r.fingerprint)!==1){ambiguous++;continue;}
      let id=known.get(r.fingerprint);
      if(!id)id='tab-'+randomUUID();
      latest.set(id,{fingerprint:r.fingerprint,index:r.index,current:r.current});
    }
    // No carry-over for unseen/ambiguous pages: do not attach ownership to a
    // different tab merely because its old temporary numeric index was reused.
    this.entries=latest;
    this.last=new Map([...latest].map(([id,e])=>[e.index,id]));
    this.current=[...latest].find(([,e])=>e.current)?.[0]||null;
    this.ambiguous=ambiguous;
    return this.snapshot();
  }
  snapshot(){return {
    generation:this.generation,
    current:this.current,
    ambiguous:this.ambiguous,
    tabs:[...this.entries].map(([id,e])=>({id,index:e.index,current:e.current}))
  };}
  resolve(id){
    if(typeof id!=='string'||!/^tab-[a-f0-9-]{36}$/.test(id))return null;
    const entry=this.entries.get(id);
    return entry?{id,index:entry.index,current:entry.current}:null;
  }
  byIndex(index){return safeIndex(index)?this.last.get(index)||null:null;}
  rebindAfterKnownNavigation(id, beforeIndex, content){
    const old=this.entries.get(id);
    if(!old||old.index!==beforeIndex||!old.current)return false;
    const rows=parseTabRows(content);
    const at=rows.find(r=>r.index===beforeIndex && r.current);
    if(!at)return false;
    if(rows.filter(r=>r.fingerprint===at.fingerprint).length!==1)return false;
    // The explicit navigation was serialized and targeted the currently
    // verified page. Re-key only after validating a unique destination URL;
    // in particular, never confuse a newly opened duplicate with this page.
    const existing=[...this.entries].some(([other,e])=>other!==id&&e.fingerprint===at.fingerprint);
    if(existing)return false;
    this.observe(content);
    const changed=[...this.entries].find(([,e])=>e.index===beforeIndex);
    if(!changed)return false;
    if(changed[0]!==id){this.entries.delete(changed[0]);this.entries.set(id,changed[1]);}
    this.last.set(beforeIndex,id);this.current=id;
    return true;
  }
}
