import {readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,platform} from 'node:os';

export const PLAYWRIGHT_EXTENSION_ID='mmlmfjhmonkocbjadbfplnigmagldckm';

/** Find exactly one Chrome profile with the official extension installed.
 * Never read browsing history, cookies, saved accounts, or profile contents.
 * Ambiguity is deliberately left to the user's explicit chrome-profile setting.
 */
export function detectUniqueExtensionProfile({
  chromeRoot=join(homedir(),'Library','Application Support','Google','Chrome'),
  extensionId=PLAYWRIGHT_EXTENSION_ID,
}={}){
  if(platform()!=='darwin')return null;
  let entries;
  try{entries=readdirSync(chromeRoot,{withFileTypes:true});}catch{return null;}
  const matches=[];
  for(const ent of entries){
    if(!ent.isDirectory() || !/^(Default|Profile \d+)$/.test(ent.name))continue;
    const ext=join(chromeRoot,ent.name,'Extensions',extensionId);
    try{
      if(!lstatSync(ext).isDirectory())continue;
      if(readdirSync(ext,{withFileTypes:true}).some(x=>x.isDirectory() && /^\d+\.\d+/.test(x.name)))
        matches.push(ent.name);
    }catch{}
  }
  return matches.length===1?matches[0]:null;
}
