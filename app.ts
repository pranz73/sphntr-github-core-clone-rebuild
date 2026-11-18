import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createForgeFromEnv, type Forge } from './store.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';
import { routeRest as dispatchRest } from './rest.ts';

function sendJson(forge:Forge,res:ServerResponse,status:number,value:unknown,requestId=true):void {res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');if(requestId)res.setHeader('X-GitHub-Request-Id',forge.nextRequestId());res.end(JSON.stringify(value));}
async function readBody(req:IncomingMessage):Promise<Buffer>{const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>64*1024*1024)throw Object.assign(new Error('Request body too large'),{status:413});chunks.push(b);}return Buffer.concat(chunks,size);}
function decodeSegment(value:string):string|undefined{try{return decodeURIComponent(value);}catch{return;}}
export function createApp(env:Record<string,string|undefined>=process.env):Server{
 const forge=createForgeFromEnv(env);return createServer(async(req,res)=>{
  try{
   const url=new URL(req.url??'/',`http://${req.headers.host??'localhost'}`),path=url.pathname;
   if(req.method==='GET'&&path==='/healthz'){sendJson(forge,res,200,{ok:true});return;}
   if(path==='/api/v3'||path==='/api/v3/'){if(req.method==='GET'){res.setHeader('X-Oauth-Scopes','repo, read:org');sendJson(forge,res,200,{current_user_url:'/api/v3/user',meta:'/api/v3/meta',version:'1'});return;}}
   if(path==='/api/v3'||path.startsWith('/api/v3/')){if(req.headers.authorization!==`Bearer ${env.MAKEFUN_SHOP_TOKEN??''}`){sendJson(forge,res,401,{message:'Requires authentication'});return;}const rawPath=path.slice('/api/v3'.length).split('/').filter(Boolean),segments:string[]=[];for(const segment of rawPath){const decoded=decodeSegment(segment);if(decoded===undefined){sendJson(forge,res,404,{message:'Not Found'});return;}segments.push(decoded);}let body:any,malformedJson=false;if(['POST','PATCH','PUT','DELETE'].includes(req.method??'')){const raw=await readBody(req);if(raw.length){try{body=JSON.parse(raw.toString('utf8'));}catch{malformedJson=true;}}}const reply=dispatchRest(forge,{method:req.method??'GET',segments,query:url.searchParams,body,malformedJson,authenticated:true,baseUrl:`${req.socket.encrypted?'https':'http'}://${req.headers.host??'localhost'}`});res.statusCode=reply.status;res.setHeader('X-GitHub-Request-Id',forge.nextRequestId());if(reply.headers)for(const [k,v] of Object.entries(reply.headers))res.setHeader(k,v);if(reply.body===undefined){res.end();return;}res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(reply.body));return;}
   const match=/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
   if(match){const owner=decodeSegment(match[1]),repo=decodeSegment(match[2]);if(owner===undefined||repo===undefined){sendJson(forge,res,404,{message:'Not Found'},false);return;}
    if(match[3]==='info/refs'&&req.method==='GET'){const service=url.searchParams.get('service');if(service!=='git-upload-pack'&&service!=='git-receive-pack'){sendJson(forge,res,404,{message:'Not Found'},false);return;}await handleInfoRefs(forge,req,res,owner,repo,service);return;}
    if(match[3]==='git-upload-pack'&&req.method==='POST'){const b=await readBody(req);await handleUploadPack(forge,req,res,owner,repo,b);return;}
    if(match[3]==='git-receive-pack'&&req.method==='POST'){const b=await readBody(req);await handleReceivePack(forge,req,res,owner,repo,b);return;}
   }
   sendJson(forge,res,404,{message:'Not Found'});
  }catch(error){if(res.headersSent){res.destroy(error instanceof Error?error:undefined);return;}const status=(error as {status?:number})?.status??500;sendJson(forge,res,status,{message:status===413?'Request body too large':error instanceof Error?error.message:'Internal Server Error'});}
 });
}
