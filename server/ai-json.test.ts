import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseModelObject} from './ai.ts'
test('只兼容完整JSON代码块，拒绝夹带文字、损坏内容及非对象',()=>{
 assert.deepEqual(parseModelObject('{"ok":true}'),{ok:true})
 assert.deepEqual(parseModelObject('  ```json\n{"ok":true}\n```\n'),{ok:true})
 assert.deepEqual(parseModelObject('```\r\n{"ok":true}\r\n```'),{ok:true})
 for(const value of ['说明\n```json\n{"ok":true}\n```','```json\n{"ok":true}\n```\n额外文字','```js\n{"ok":true}\n```','```json\n{"ok":\n```','[1,2]','```json\n[1,2]\n```'])assert.throws(()=>parseModelObject(value))
})
