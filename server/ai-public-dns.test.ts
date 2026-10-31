import {test} from 'node:test'
import assert from 'node:assert/strict'
import {publicDnsAnswers,publicGatewayDnsEnabled} from './ai-public-dns.ts'
import {isPublicAddress} from './ai.ts'
test('显式单网关可信DNS：默认关闭、其他主机拒绝、混入保留地址整批拒绝',()=>{
 const old=process.env.JIYU_AI_PUBLIC_DNS_GATEWAY
 try{
  delete process.env.JIYU_AI_PUBLIC_DNS_GATEWAY
  assert.equal(publicGatewayDnsEnabled('gateway.example.com'),false)
  process.env.JIYU_AI_PUBLIC_DNS_GATEWAY='gateway.example.com'
  assert.equal(publicGatewayDnsEnabled('gateway.example.com'),true)
  assert.equal(publicGatewayDnsEnabled('other.example'),false)
  assert.equal(publicDnsAnswers({Status:0,Answer:[{type:1,data:'172.67.128.173'},{type:1,data:'104.21.2.37'}]},isPublicAddress).length,2)
  for(const data of ['198.18.1.14','127.0.0.1','10.0.0.1','::1'])assert.throws(()=>publicDnsAnswers({Status:0,Answer:[{type:1,data:'172.67.128.173'},{type:1,data}]},isPublicAddress))
  assert.throws(()=>publicDnsAnswers({Status:3,Answer:[]},isPublicAddress))
 }finally{if(old===undefined)delete process.env.JIYU_AI_PUBLIC_DNS_GATEWAY;else process.env.JIYU_AI_PUBLIC_DNS_GATEWAY=old}
})
