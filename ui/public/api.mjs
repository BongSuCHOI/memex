let csrf='';
export const setToken=token=>{csrf=token;};
export class ApiError extends Error{constructor(message,status,code){super(message);this.status=status;this.code=code;}}
export async function request(path,query={},options={}){
  const url=new URL('/api/v2/'+path,location.origin);
  for(const[k,v]of Object.entries(query))if(v!==undefined&&v!==null&&v!=='')url.searchParams.set(k,String(v));
  const controller=new AbortController();const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)controller.abort();
  const timer=setTimeout(()=>controller.abort('timeout'),options.timeout||30000);
  try{
    const response=await fetch(url,{method:options.method||(options.body?'POST':'GET'),signal:controller.signal,credentials:'same-origin',headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json','X-Memex-CSRF':csrf}:{})},body:options.body?JSON.stringify(options.body):undefined,cache:'no-store'});
    let result;try{result=await response.json();}catch{throw new ApiError('서버 응답 형식을 확인할 수 없습니다.',response.status,'INVALID_RESPONSE');}
    if(!response.ok)throw new ApiError(result.error?.message||result.error||`HTTP ${response.status}`,response.status,result.error?.code);
    return result;
  }catch(error){if(controller.signal.reason==='timeout')throw new ApiError('응답 대기 시간이 초과됐습니다. 변경 작업은 서버에서 계속 실행될 수 있으므로 기록을 확인한 뒤 재시도하세요.',408,'REQUEST_TIMEOUT');throw error;}finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
