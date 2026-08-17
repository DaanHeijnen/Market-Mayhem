export async function api<T>(path:string, init:RequestInit={}){
  const res=await fetch(path,{credentials:'include',...init,headers:{'content-type':'application/json',...(init.headers||{})}});
  const data=await res.json().catch(()=>({})); if(!res.ok) throw new Error(data.error||`Request failed (${res.status})`); return data as T;
}
export function mutation<T>(path:string, data:unknown, idempotent=false){
  const headers:Record<string,string>={}; if(idempotent) headers['Idempotency-Key']=crypto.randomUUID();
  return api<T>(path,{method:'POST',body:JSON.stringify(data),headers});
}
