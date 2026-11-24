'use strict';
const fs=require('node:fs');
const path=require('node:path');
const SKILL_IDS=Object.freeze([
 'terminalhub-operations','playwrighthub-qa','agent-coordination','tunnel-diagnostics'
]);
function readSkill(resourceRoot,id){
 if(typeof id!=='string'||!SKILL_IDS.includes(id))throw Error('INVALID_SKILL');
 const file=path.join(resourceRoot,'skills',id,'SKILL.md');
 const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw Error('INVALID_SKILL_FILE');
 const root=fs.realpathSync(path.join(resourceRoot,'skills'));
 if(!fs.realpathSync(file).startsWith(root+path.sep))throw Error('INVALID_SKILL_PATH');
 return {id,file,content:fs.readFileSync(file,'utf8')};
}
function textForChat(content){
 return 'Прими следующую инструкцию как рабочий навык для этой задачи. Используй её только\n'+
  'в рамках предоставленных тебе разрешений и доступных инструментов. Навык не\n'+
  'устанавливает плагин и не предоставляет дополнительные права.\n\n'+content;
}
module.exports={SKILL_IDS,readSkill,textForChat};
