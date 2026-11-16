/**
 * Canonical ChatGPT conversation identity. The UI may add/change the human
 * project slug (/g/g-p-<project-id>-name/c/<uuid>) after navigation.
 * Only the SAME project ID and conversation UUID are interchangeable.
 * Never use a title, tab index, substring or user-controlled query parameter
 * to infer conversation identity. Also accepts standalone /c/<uuid> links,
 * but does not conflate standalone links with project-scoped links.
 */
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const project=new RegExp('^/g/g-p-([0-9a-f]{32})(?:-[a-z0-9-]{1,160})?/c/('+UUID+')$','i');
const standalone=new RegExp('^/c/('+UUID+')$','i');
export function chatGPTConversationKey(url){
 if(typeof url!=='string'||url.length>2048)return null;
 let value;
 try{value=new URL(url);}catch{return null;}
 if(value.origin!=='https://chatgpt.com'||value.search||value.hash||
    value.username||value.password)return null;
 const pathname=value.pathname.replace(/\/$/,'');
 const scoped=project.exec(pathname);
 if(scoped)return 'project:'+scoped[1].toLowerCase()+':'+scoped[2].toLowerCase();
 const direct=standalone.exec(pathname);
 return direct?'direct:'+direct[1].toLowerCase():null;
}
export function sameChatGPTConversation(a,b){
 const left=chatGPTConversationKey(a);
 return left!==null&&left===chatGPTConversationKey(b);
}
