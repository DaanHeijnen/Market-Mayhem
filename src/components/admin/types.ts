export type RunMutation=(path:string,body:Record<string,unknown>,idempotent?:boolean,idempotencyKey?:string)=>Promise<boolean>;
export type AdminState=any;
