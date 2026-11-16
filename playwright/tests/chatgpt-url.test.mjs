import test from 'node:test';
import assert from 'node:assert/strict';
import {chatGPTConversationKey,sameChatGPTConversation} from '../chatgpt-url.mjs';
const project='a'.repeat(32),other='b'.repeat(32);
const chat='00000000-0000-4000-8000-000000000001';
const different='00000000-0000-4000-8000-000000000002';
const bare=`https://chatgpt.com/g/g-p-${project}/c/${chat}`;
const canonical=`https://chatgpt.com/g/g-p-${project}-gafus-refactor/c/${chat}`;

test('project slug is cosmetic: matching project key + conversation UUID is sufficient',()=>{
 assert.equal(chatGPTConversationKey(bare),chatGPTConversationKey(canonical));
 assert.equal(sameChatGPTConversation(bare,canonical),true);
 assert.equal(sameChatGPTConversation(canonical,bare),true);
 assert.equal(sameChatGPTConversation(canonical,`https://chatgpt.com/g/g-p-${project}-renamed/c/${chat}`),true);
});
test('project ID, conversation ID and scope remain strict',()=>{
 assert.equal(sameChatGPTConversation(bare,`https://chatgpt.com/g/g-p-${other}-gafus-refactor/c/${chat}`),false);
 assert.equal(sameChatGPTConversation(bare,`https://chatgpt.com/g/g-p-${project}-gafus-refactor/c/${different}`),false);
 assert.equal(sameChatGPTConversation(bare,`https://chatgpt.com/c/${chat}`),false);
 assert.equal(sameChatGPTConversation(`https://chatgpt.com/c/${chat}`,`https://chatgpt.com/c/${chat}`),true);
});
test('invalid, hostile or decorated URLs are rejected',()=>{
 for(const value of ['',null,'https://example.com'+new URL(canonical).pathname,
  canonical+'?share=1',canonical+'#anchor','http://chatgpt.com'+new URL(canonical).pathname,
  'https://chatgpt.com.evil.test'+new URL(canonical).pathname,
  'https://chatgpt.com/g/g-p-bad/c/'+chat])
  assert.equal(chatGPTConversationKey(value),null,String(value));
});
