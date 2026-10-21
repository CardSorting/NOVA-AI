/** Allowlisted wire DTOs. Never copy nested engine objects into a response. */
export function publicUsage(value: any) {
  const keys=['prompt_tokens','completion_tokens','total_tokens'];
  if(!value||!keys.every(k=>Number.isSafeInteger(value[k])&&value[k]>=0&&value[k]<=1_000_000_000))return null;
  return {prompt_tokens:value.prompt_tokens,completion_tokens:value.completion_tokens,total_tokens:value.total_tokens};
}
export function publicJob(value:any) {
  const safe:Record<string,unknown>={};
  if(typeof value?.id!=='string'||!/^[-\w.:]{1,128}$/.test(value.id))throw Error('Invalid response.');
  safe.id=value.id;
  if(['queued','pending','running','completed','failed','cancelled','unknown','not_started'].includes(value.status))safe.status=value.status;
  if(value.object==='chat.completion')safe.object=value.object;
  for(const k of ['model'])if(typeof value[k]==='string'&&/^[\w.:-]{1,120}$/.test(value[k]))safe[k]=value[k];
  for(const k of ['createdAt','pollAfterMs','retainedUntil'])if(value[k]===null||Number.isSafeInteger(value[k])&&value[k]>=0)safe[k]=value[k];
  for(const k of ['isAttachedDuplicate','committed'])if(typeof value[k]==='boolean')safe[k]=value[k];
  for(const k of ['content','output','text'])if(value[k]===null||typeof value[k]==='string'&&Buffer.byteLength(value[k])<=16*1024*1024)safe[k]=value[k];
  if(value.usage!==undefined)safe.usage=publicUsage(value.usage);
  if(typeof value.outputSha256==='string'&&/^[a-f0-9]{64}$/.test(value.outputSha256))safe.outputSha256=value.outputSha256;
  for(const k of ['streamUrl','statusUrl'])if(value[k]===`/v1/jobs/${value.id}${k==='streamUrl'?'/stream':''}`)safe[k]=value[k];
  return safe;
}
export async function boundedJson(response:Response,limit:number) {
  const reader=response.body?.getReader();if(!reader)throw Error('Missing response.');
  const chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>limit)throw Error('Response too large.');chunks.push(part.value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  finally{await reader.cancel().catch(()=>{});}
}
