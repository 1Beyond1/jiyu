import {request} from 'node:https'
import {HttpError} from './security.ts'
export function publicGatewayDnsEnabled(hostname: string) {
  const gateway = process.env.JIYU_AI_PUBLIC_DNS_GATEWAY
  return !!gateway && hostname === gateway
}
export function publicDnsAnswers(value:unknown,isPublic:(ip:string)=>boolean){
 const body=value as {Status?:unknown;Answer?:{type:number;data:string}[]}
 if(body?.Status!==0||!Array.isArray(body.Answer))throw new HttpError(502,'可信公网DNS没有返回有效地址')
 const ips=body.Answer.filter(a=>a.type===1||a.type===28)
 if(!ips.length||ips.some(a=>typeof a.data!=='string'||!isPublic(a.data)))throw new HttpError(400,'可信DNS仍返回内网或保留地址，已拒绝连接')
 return ips.map(a=>({address:a.data,family:a.type===1?4:6}))
}
export async function resolvePublicGateway(hostname:string,isPublic:(ip:string)=>boolean,signal?:AbortSignal){
 if(!publicGatewayDnsEnabled(hostname))throw new HttpError(400,'未启用此网关的可信公网DNS')
 // Fixed Cloudflare HTTPS resolver, pinned to its public bootstrap IP. No key,
 // caller URL, system DNS change, proxy override, redirect, or insecure TLS.
 const url=new URL('https://cloudflare-dns.com/dns-query');url.searchParams.set('name',hostname);url.searchParams.set('type','A')
 const value=await new Promise<unknown>((resolve,reject)=>{
  const req=request(url,{method:'GET',family:4,agent:false,servername:'cloudflare-dns.com',lookup:(_h,_o,cb)=>cb(null,'1.1.1.1',4),headers:{Accept:'application/dns-json'},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)},res=>{
   if(res.statusCode!==200){res.destroy();reject(new HttpError(502,'可信公网DNS请求失败或返回重定向'));return}
   let size=0;const parts:Buffer[]=[]
   res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>16384)res.destroy(new Error('DNS response too large'));else parts.push(chunk)})
   res.on('error',()=>reject(new HttpError(502,'可信公网DNS响应中断或超限')))
   res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')))}catch{reject(new HttpError(502,'可信公网DNS响应无效'))}})
  });req.on('error',()=>reject(new HttpError(502,'无法连接可信公网DNS或请求超时')));req.end()
 })
 return publicDnsAnswers(value,isPublic)
}
