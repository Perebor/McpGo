import test from 'node:test';
import assert from 'node:assert/strict';
import {PortableTabIdentity,parseTabRows} from '../portable-tab-identity.mjs';
const list=(...rows)=>'### Result\n'+rows.join('\n');
const row=(index,url,current=false)=>`- ${index}: ${current?'(current) ':''}[Title](${url})`;

test('opaque tab id survives numeric index shift if page URL uniquely matches',()=>{
 const ids=new PortableTabIdentity();
 const first=ids.observe(list(row(0,'https://a.test',true),row(1,'https://b.test')));
 const b=first.tabs.find(x=>x.index===1).id;
 const second=ids.observe(list(row(0,'https://b.test',true)));
 assert.equal(second.tabs[0].id,b);
 assert.equal(ids.resolve(b).index,0);
 assert.equal(ids.byIndex(0),b);
 assert.doesNotMatch(JSON.stringify(second),/https?:\/\//);
});
test('same URL in several tabs invalidates ambiguous handles rather than choose wrong tab',()=>{
 const ids=new PortableTabIdentity();
 const first=ids.observe(list(row(0,'https://example.com'))).tabs[0].id;
 const dupe=ids.observe(list(row(0,'https://example.com'),row(1,'https://example.com')));
 assert.equal(dupe.ambiguous,2);
 assert.equal(ids.resolve(first),null);
 assert.equal(ids.byIndex(0),null);
 assert.equal(ids.byIndex(1),null);
 const after=ids.observe(list(row(1,'https://example.com')));
 assert.notEqual(after.tabs[0].id,first);
});
test('explicit navigation can rebind handle if active index still matches',()=>{
 const ids=new PortableTabIdentity();
 const first=ids.observe(list(row(0,'https://a.test',true),row(1,'https://b.test')));
 const old=first.tabs[0].id;
 assert.equal(ids.rebindAfterKnownNavigation(old,0,list(row(0,'https://c.test',true),row(1,'https://b.test'))),true);
 assert.equal(ids.resolve(old).index,0);
 assert.equal(ids.rebindAfterKnownNavigation(old,0,list(row(0,'https://c.test'),row(1,'https://d.test',true))),false);
});
test('parser ignores incomplete, untrusted or malformed lines and never reveals URLs',()=>{
 const rows=parseTabRows(list(row(0,'https://abc.test/secret?token=VALUE',true),'- 1: [Malformed](url','- 3: no_url'));
 assert.equal(rows.length,1);
 assert.equal(rows[0].index,0);
 assert.ok(rows[0].current);
 assert.doesNotMatch(JSON.stringify(rows),/VALUE|abc\.test/);
});
