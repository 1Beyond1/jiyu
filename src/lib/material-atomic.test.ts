import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { MaterialAtomicSession, canonicalMaterialSources } from './material-atomic.ts'
const file = (id:string,name:string,text:string,version='1') => ({id,name,text,version,sha256:createHash('sha256').update(text).digest('hex')})

test('同原件输入顺序不同仍得到相同别名，摘要与版本严查', async () => {
  const a=file('a','乙.txt','唯一段落'),b=file('b','甲.txt','重复重复')
  const x=await MaterialAtomicSession.create([a,b],{required:['说明']},{q:'事实'}),y=await MaterialAtomicSession.create([b,a],{required:['说明']},{q:'事实'})
  assert.deepEqual(x.invoke({type:'version'}),y.invoke({type:'version'}))
  assert.deepEqual(x.invoke({type:'read',ids:['a','b']}),y.invoke({type:'read',ids:['a','b']}))
  assert.equal(x.tools,3); assert.equal(y.tools,3)
  assert.equal((x.invoke({type:'locate',id:'a',quote:'唯一'}) as {exact:boolean}).exact,true)
  assert.equal((x.invoke({type:'locate',id:'b',quote:'重复'}) as {ambiguous:boolean}).ambiguous,true)
  assert.deepEqual(x.invoke({type:'parse',id:'a'}),{alias:'F1',lines:[{start:0,end:4,text:'唯一段落'}]})
  assert.deepEqual(x.invoke({type:'calc',operation:'multiply',left:3,right:4}),{value:12})
  assert.throws(()=>x.invoke({type:'calc',operation:'divide',left:1,right:0}))
  assert.throws(()=>x.invoke({type:'read',ids:['other']}))
  const key=x.snapshotKey(); await x.replace([b,file('a','乙.txt','替换正文','2')]);assert.throws(()=>x.assertSnapshot(key))
  await assert.rejects(()=>MaterialAtomicSession.create([{...a,text:'篡改'}],{}))
  assert.deepEqual(canonicalMaterialSources([file('z','同.txt','同'),file('c','同.txt','同')]).map(f=>f.id),['c','z'])
})

test('原子数量、调用次数、未知用量和时限保守停止',async()=>{
  const a=file('a','a.txt','abc'), now=Date.now()
  const x=await MaterialAtomicSession.create([a],{}, {q:'事实'},now)
  assert.equal(x.invoke({type:'clarify',questionId:'q'}),'事实'); assert.equal(x.invoke({type:'clarify',questionId:'q'}),'事实');assert.throws(()=>x.invoke({type:'clarify',questionId:'q'}))
  while(x.tools<20)x.invoke({type:'rules'});assert.throws(()=>x.invoke({type:'rules'}))
  const y=await MaterialAtomicSession.create([a],{}, {},now);for(let i=0;i<4;i++){y.beginModelCall();y.finishModelCall(1)}assert.throws(()=>y.beginModelCall())
  const z=await MaterialAtomicSession.create([a],{}, {},now);z.beginModelCall();assert.throws(()=>z.finishModelCall(null));assert.throws(()=>z.finishModelCall(0));assert.throws(()=>z.invoke({type:'rules'}));await assert.rejects(()=>z.replace([a]))
  const t=await MaterialAtomicSession.create([a],{}, {},now);assert.throws(()=>t.invoke({type:'rules'},now+180001))
  const late=await MaterialAtomicSession.create([a],{}, {},now);late.beginModelCall(now);assert.throws(()=>late.finishModelCall(1,now+180001));assert.throws(()=>late.finishModelCall(0,now+180002));assert.throws(()=>late.invoke({type:'rules'},now+180002))
  const over=await MaterialAtomicSession.create([a],{}, {},now);over.beginModelCall();assert.throws(()=>over.finishModelCall(24001));assert.throws(()=>over.finishModelCall(0));assert.throws(()=>over.invoke({type:'rules'}))
})
