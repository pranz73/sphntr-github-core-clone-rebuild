import type { Forge } from './store.ts';
import { routeRest, repositoryShape, issueShape, pullShape } from './rest.ts';

const capabilities={tools:{}};
const serverInfo={name:'makefun-forge',version:'1.0.0'};
const supportedVersions=['2026-07-28','2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
const schema=(properties:Record<string,unknown>,required:string[])=>({type:'object',properties,required});
export const MCP_TOOLS=[
 {name:'create_repo',description:'Create a repository under the viewer.',inputSchema:schema({name:{type:'string'},description:{type:'string'},private:{type:'boolean'},owner:{type:'string'}},['name'])},
 {name:'get_repo',description:'Get a repository owned by the viewer.',inputSchema:schema({owner:{type:'string'},repo:{type:'string'}},['owner','repo'])},
 {name:'create_issue',description:'Create an issue in a repository.',inputSchema:schema({owner:{type:'string'},repo:{type:'string'},title:{type:'string'},body:{type:'string'}},['owner','repo','title'])},
 {name:'list_issues',description:'List issues in a repository.',inputSchema:schema({owner:{type:'string'},repo:{type:'string'},state:{type:'string',enum:['open','closed','all'],default:'open'}},['owner','repo'])},
 {name:'create_pull_request',description:'Open a pull request between repository branches.',inputSchema:schema({owner:{type:'string'},repo:{type:'string'},title:{type:'string'},head:{type:'string'},base:{type:'string'},body:{type:'string'}},['owner','repo','title','head','base'])},
 {name:'merge_pull_request',description:'Merge an open pull request.',inputSchema:schema({owner:{type:'string'},repo:{type:'string'},pull_number:{type:'integer'}},['owner','repo','pull_number'])},
];
type Reply={status:number;payload:unknown|null};
const rpcError=(id:unknown,code:number,message:string):Reply=>({status:200,payload:{jsonrpc:'2.0',id,error:{code,message}}});
function rpcResult(id:unknown,result:unknown):Reply{return{status:200,payload:{jsonrpc:'2.0',id,result}};}
function callTool(f:Forge,name:unknown,args:unknown):unknown {
 if(typeof name!=='string'||!MCP_TOOLS.some(t=>t.name===name))throw Object.assign(new Error('Unknown tool'),{rpc:true});
 if(!args||typeof args!=='object'||Array.isArray(args))args={};const a=args as Record<string,any>;
 const required:Record<string,string[]>={create_repo:['name'],get_repo:['owner','repo'],create_issue:['owner','repo','title'],list_issues:['owner','repo'],create_pull_request:['owner','repo','title','head','base'],merge_pull_request:['owner','repo','pull_number']};
 if(required[name].some(k=>a[k]===undefined||a[k]===null))throw Object.assign(new Error('Missing required argument'),{rpc:true});
 const owner=String(a.owner??f.login()),repo=String(a.repo??'');
 const run=(method:string,segments:string[],body?:unknown,query=new URLSearchParams())=>routeRest(f,{method,segments,query,body,authenticated:true,baseUrl:'http://localhost'});
 let reply;
 if(name==='create_repo')reply=run('POST',['user','repos'],{name:a.name,description:a.description,private:a.private});
 else if(name==='get_repo')reply=run('GET',['repos',owner,repo]);
 else if(name==='create_issue')reply=run('POST',['repos',owner,repo,'issues'],{title:a.title,body:a.body});
 else if(name==='list_issues')reply=run('GET',['repos',owner,repo,'issues'],undefined,new URLSearchParams({state:a.state??'open'}));
 else if(name==='create_pull_request')reply=run('POST',['repos',owner,repo,'pulls'],{title:a.title,head:a.head,base:a.base,body:a.body});
 else {const n=Number(a.pull_number);const merged=run('PUT',['repos',owner,repo,'pulls',String(n),'merge'],{merge_method:'merge'});if(merged.status>=400)return {content:[{type:'text',text:typeof (merged.body as any)?.message==='string'?(merged.body as any).message:'Pull request merge failed'}],isError:true};reply=run('GET',['repos',owner,repo,'pulls',String(n)]);}
 if(reply.status>=400)return {content:[{type:'text',text:typeof (reply.body as any)?.message==='string'?(reply.body as any).message:'Tool request failed'}],isError:true};
 let shaped=reply.body;
 if(name==='create_repo'||name==='get_repo'){const r=f.getRepository(owner,name==='create_repo'?String(a.name):repo);if(r)shaped=repositoryShape(f,r);}
 if(name==='create_issue'&&shaped&&typeof shaped==='object'){const r=f.getRepository(owner,repo)!;const i=r.issues.get((shaped as any).number);if(i)shaped=issueShape(f,r,i);}
 if(name==='create_pull_request'||name==='merge_pull_request'){const r=f.getRepository(owner,repo)!;const p=r.pulls.get(Number(a.pull_number??(shaped as any)?.number));if(p)shaped=pullShape(f,r,p);}
 return {content:[{type:'text',text:JSON.stringify(shaped)}],structuredContent:shaped,isError:false};
}
function one(f:Forge,value:any):Reply {
 const id=value&&Object.hasOwn(value,'id')?value.id:null;
 if(!value||typeof value!=='object'||Array.isArray(value)||value.jsonrpc!=='2.0'||typeof value.method!=='string')return rpcError(id,-32600,'Invalid Request');
 if(!Object.hasOwn(value,'id'))return{status:202,payload:null};
 const p=value.params&&typeof value.params==='object'?value.params:{};
 switch(value.method){case'server/discover':return rpcResult(id,{supportedVersions,capabilities,serverInfo,_meta:{'io.modelcontextprotocol/serverInfo':serverInfo}});case'initialize':return rpcResult(id,{protocolVersion:typeof p.protocolVersion==='string'?p.protocolVersion:'2025-11-25',capabilities,serverInfo});case'ping':return rpcResult(id,{});case'tools/list':return rpcResult(id,{tools:MCP_TOOLS});case'tools/call':try{return rpcResult(id,callTool(f,p.name,p.arguments));}catch(e){if((e as any)?.rpc)return rpcError(id,-32602,(e as Error).message);return rpcResult(id,{content:[{type:'text',text:e instanceof Error?e.message:'Tool failed'}],isError:true});}default:return rpcError(id,-32601,'Method not found');}
}
export function handleMcp(forge:Forge,raw:string):Reply {let body:any;try{body=JSON.parse(raw);}catch{return{status:400,payload:{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}};}if(Array.isArray(body)){const results=body.map(x=>one(forge,x)).filter(x=>x.payload!==null);return results.length?{status:200,payload:results.map(x=>x.payload)}:{status:202,payload:null};}return one(forge,body);}
