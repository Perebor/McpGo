import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {probeBrowserHealth} from '../browser-health.mjs';

test('passive TCP health never calls any Chrome browser tool',async()=>{
 const server=net.createServer(socket=>socket.end());
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const health=await probeBrowserHealth({port:server.address().port});
  assert.equal(health.connected,true);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('offline scheduler extension is unavailable without attaching a Chrome tab',async()=>{
 const health=await probeBrowserHealth({port:65412,timeoutMs:100});
 assert.equal(health.connected,false);
 assert.match(health.reason,/AutoSend/);
});
test('private backend port must be on loopback',async()=>{
 await assert.rejects(probeBrowserHealth({host:'example.com'}),/loopback/);
 await assert.rejects(probeBrowserHealth({port:1}),/loopback/);
});
