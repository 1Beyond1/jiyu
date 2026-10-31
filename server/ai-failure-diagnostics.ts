import {mkdir,readdir,writeFile} from 'node:fs/promises'
import {resolve,sep} from 'node:path'
import {createHash} from 'node:crypto'
export interface AIFailureDiagnostics { directory:string; syntheticInputHash:string }
export function failureDiagnostics(options:AIFailureDiagnostics|undefined,dataDir:string){
 if(!options)return async()=>{}
 const directory=resolve(options.directory),privateRoot=resolve(dataDir,'..','private')+sep
 if(!directory.startsWith(privateRoot)||!/^[a-f0-9]{64}$/.test(options.syntheticInputHash))throw Error('AI诊断须明确限定private目录和已审合成输入hash')
 let queue=Promise.resolve()
 return async(inputHash:string,runId:string,response:unknown,secret:string,error:unknown)=>{
  if(inputHash!==options.syntheticInputHash||response===undefined||!/^[-a-f0-9]{36}$/.test(runId))return
  const save=async()=>{
  try{
   await mkdir(directory,{recursive:true,mode:0o700})
   if((await readdir(directory)).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).length>=2)return
   const raw=JSON.stringify(response).replaceAll(secret,'[已隐藏]'),data=response as any,choice=data?.choices?.[0],content=choice?.message?.content
   const redacted=typeof content==='string'?content.replaceAll(secret,'[已隐藏]'):null
   const digest=(s:string)=>createHash('sha256').update(s).digest('hex')
   await writeFile(resolve(directory,runId+'.json'),JSON.stringify({runId,inputHash,reason:error instanceof Error?error.message.replaceAll(secret,'[已隐藏]'):'Rejected',responseKeys:data&&typeof data==='object'?Object.keys(data):[],finishReason:choice?.finish_reason??null,contentType:typeof content,contentChars:redacted?.length??null,contentSHA256:redacted===null?null:digest(redacted),responseSHA256:digest(raw),originalTruncated:Buffer.byteLength(raw)>65536,redactedOriginal:Buffer.byteLength(raw)<=65536?raw:raw.slice(0,16000),privateSyntheticDiagnostic:true},null,2),{flag:'wx',mode:0o600})
  }catch{/* Optional private diagnostics cannot change product outcomes or leak errors. */}
  }
  queue=queue.then(save,save);await queue
 }
}
