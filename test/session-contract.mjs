// Explicit integration entrypoint; uses the product's installed DSH runtime.
import {createRequire} from 'node:module'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {apply} from '../index.js'
const root=process.env.TOKENS_HARNESS_ROOT
if(!root)throw Error('Set TOKENS_HARNESS_ROOT to the product repository')
const req=createRequire(resolve(root,'.build/desktop/dsh-plugin-desktop/package.json'))
const {validateStoredEvents}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-persistence')).href)
// Session format v4 (DSH 0.2) admission: every appended row passes this before it is written.
// A row it refuses fails the whole append, and the agent turn with it.
const {assertV4RowAdmission}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href)
const {zipSync,unzipSync,strToU8,strFromU8}=req('fflate')
const hooks={}
apply({on:(event,fn)=>hooks[event]=fn},{remindThresholds:[3,5],blockThreshold:8,fuzzyRemindThresholds:[5,8],fuzzyBlockThreshold:12,fuzzyTools:['pwsh'],include:[],exclude:[],argumentsPreviewChars:500})
const agent={},pending=[],events=[]
for(let i=1;i<=10;i++){
 const d=await hooks['tools/post-execute']({agent,name:'pwsh',arguments:'{"command":"echo loop-guard-test"}'},{},async()=>({kind:'accept'}))
 for(const m of d.additionalContexts??[]){assert.ok(!pending.some(x=>x.id===m.id),'duplicate pending ID');pending.push(m)}
 if(i>=8)assert.equal(d.kind,'block')
}
assert.equal(pending.length,3)
for(const message of pending)events.push({type:'user/message',seq:events.length+1,time:Date.now(),data:message,surfaceOp:'append'})
// Every notice the guard emits must be admitted by the v4 writer (the 2026-11-04 wedge).
for(const event of events)assertV4RowAdmission(JSON.parse(JSON.stringify(event)))
// The retired wrapper is still refused, so this check can tell the two shapes apart.
const retired=JSON.parse(JSON.stringify(events[0]));retired.data.source={kind:'plugin',plugin:'tokens-loop-guard',form:'notice'}
assert.throws(()=>assertV4RowAdmission(retired),/producer-owned source kind/)
for(const header of [{id:'loop-guard-regression',version:3},{id:'loop-guard-regression-v4',version:4}])validateStoredEvents(header,JSON.parse(JSON.stringify(events)))
const header={id:'loop-guard-regression',version:3}
const zip=zipSync({'session.v3.jsonl':strToU8(events.map(x=>JSON.stringify(x)).join('\n'))})
const replay=strFromU8(unzipSync(zip)['session.v3.jsonl']).split('\n').map(JSON.parse)
validateStoredEvents(header,replay)
const broken=JSON.parse(JSON.stringify(events));delete broken[0].data.id
assert.throws(()=>validateStoredEvents(header,broken),/identified message/)
await hooks['agent/pre-step']({agent,messages:[{source:{kind:'user'}}]},async()=>{})
const resumed=await hooks['tools/post-execute']({agent,name:'pwsh',arguments:'{"command":"echo loop-guard-test"}'},{},async()=>({kind:'accept'}))
assert.equal(resumed.kind,'accept')
console.log('PASS: batch notices admitted by the v4 writer (retired plugin wrapper refused), continuation reset, real DSH stored-event validation and ZIP round-trip; missing-ID regression rejected')
