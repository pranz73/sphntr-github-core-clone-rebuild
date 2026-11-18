import { createApp } from './app.ts';
import type { Server } from 'node:http';

const envUrl=process.env.MAKEFUN_ENV_URL;
if(!envUrl){process.exitCode=1;}else{
 const server=createApp();
 const listen=()=>new Promise<number>((resolve,reject)=>{server.once('error',reject);server.listen(0,()=>{server.removeListener('error',reject);const a=server.address();if(!a||typeof a==='string')reject(new Error('Failed to bind port'));else resolve(a.port);});});
 const close=(s:Server)=>new Promise<void>((resolve,reject)=>s.close(e=>e?reject(e):resolve()));
 const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
 try{const port=await listen();const base=envUrl.replace(/\/$/,'');const registered=await fetch(`${base}/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({port})});if(!registered.ok)throw new Error(`Registration failed: ${registered.status}`);
  while(true){try{const response=await fetch(`${base}/done`);if(response.ok){const result=await response.json() as {done?:boolean};if(result.done===true)break;}}catch{}await wait(250);}await close(server);process.exitCode=0;
 }catch(error){console.error(error);try{await close(server);}catch{}process.exitCode=1;}
}
