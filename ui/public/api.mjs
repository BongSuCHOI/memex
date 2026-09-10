import {t} from './i18n/index.mjs';
let csrf='';
export const setToken=token=>{csrf=token;};
/**
 * 서버 오류 봉투 `{code,key,params,message,details?}`를 전부 보존한다 (#109 · 설계 §5.2 C2.3).
 * `details.issues`는 ui.mjs의 renderIssues()가 행별로 그린다.
 */
export class ApiError extends Error{
  constructor(message,status,code,details=null,key=null,params=null){
    super(message);this.status=status;this.code=code;this.details=details;this.key=key;this.params=params;
  }
  get issues(){return Array.isArray(this.details?.issues)?this.details.issues:[];}
}
/** key가 있으면 번역하고, 없으면(코어 원문 패스스루) message를 그대로 보여준다. */
export function errorText(e){
  if(!e)return '';
  if(typeof e==='string')return e;                    // 0.6.x 봉투(문자열 error) 호환
  return e.key?t(e.key,e.params||undefined):(e.message||t('error.client.unknown'));
}
/** key===null이 코어 원문의 유일한 신호다 — 번역 누락이 아니라는 것을 화면이 알릴 수 있다. */
export function errorFromCore(e){return !!e&&(e.key??null)===null&&!!e.message;}
/**
 * HTTP 200 본문에 실려 오는 프로즈 (#109 · 설계 §5.3 분류 c · §5.4).
 *
 * 서버는 문장을 만들지 않고 `<field>Key`(+`<field>Params`)만 싣는다. 사용자·코어가 만든 실제
 * 값이 있으면 **그 값이 이긴다** — 세션 제목처럼 "있으면 원문, 없으면 대체 문구"인 필드가 있고,
 * 0.6.x가 저장해 둔 프로즈(`~/.memex/ui/operations.json`)도 그대로 읽혀야 한다.
 *
 *   payloadText(session,'title')   → 제목, 없으면 t('label.session.untitled')
 *   payloadText(page,'reason')     → t('state.schema.tableAbsent',{table})
 */
export function payloadText(record,field){
  if(!record)return '';
  const raw=record[field];
  if(typeof raw==='string'&&raw)return raw;
  const key=record[`${field}Key`];
  return typeof key==='string'&&key?t(key,record[`${field}Params`]||undefined):'';
}
export async function request(path,query={},options={}){
  const url=new URL('/api/v2/'+path,location.origin);
  for(const[k,v]of Object.entries(query))if(v!==undefined&&v!==null&&v!=='')url.searchParams.set(k,String(v));
  const controller=new AbortController();const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)controller.abort();
  const timer=setTimeout(()=>controller.abort('timeout'),options.timeout||30000);
  try{
    const response=await fetch(url,{method:options.method||(options.body?'POST':'GET'),signal:controller.signal,credentials:'same-origin',headers:{Accept:'application/json',...(options.body?{'Content-Type':'application/json','X-Memex-CSRF':csrf}:{})},body:options.body?JSON.stringify(options.body):undefined,cache:'no-store'});
    let result;try{result=await response.json();}catch{throw new ApiError(t('error.client.invalidResponse'),response.status,'INVALID_RESPONSE',null,'error.client.invalidResponse');}
    if(!response.ok){
      const e=(result&&result.error)||{};
      throw new ApiError(errorText(e)||`HTTP ${response.status}`,response.status,e.code,e.details??null,e.key??null,e.params??null);
    }
    return result;
  }catch(error){if(controller.signal.reason==='timeout')throw new ApiError(t('error.client.timeout'),408,'REQUEST_TIMEOUT',null,'error.client.timeout');throw error;}finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}
