import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, Repository, ZERO_OID, parseCommit, parseTag, reachableObjects, isAncestor } from './store.ts';
import { decodePackets, framePacket, flushPacket, writePack, readPack, sideband } from './pack.ts';

const agent = 'agent=makefun-git/1.0';
const uploadCaps = ['multi_ack','thin-pack','side-band','side-band-64k','ofs-delta','shallow','deepen-since','deepen-not','no-progress','include-tag','multi_ack_detailed'];
const receiveCaps = ['report-status','delete-refs','side-band-64k','ofs-delta'];
function json(res:ServerResponse,status:number,value:unknown):void { res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value)); }
function repoOr404(forge:Forge,owner:string,name:string,res:ServerResponse):Repository|undefined { const repo=forge.getRepository(owner,name);if(!repo)json(res,404,{message:'Not Found'});return repo; }
function refs(repo:Repository):[string,string][] { return [...repo.refs].sort(([a],[b])=>a<b?-1:a>b?1:0); }
function advertisedHead(repo:Repository):string { return repo.refs.get(repo.headTarget())??ZERO_OID; }
export async function handleInfoRefs(forge:Forge,req:IncomingMessage,res:ServerResponse,owner:string,repoName:string,service:string):Promise<void>{
 const repo=repoOr404(forge,owner,repoName,res);if(!repo)return;
 const upload=service==='git-upload-pack';res.setHeader('Content-Type',`application/x-git-${upload?'upload':'receive'}-pack-advertisement`);
 const protocol=String(req.headers['git-protocol']??'');
 if(upload&&/version=2/.test(protocol)){res.end(Buffer.concat([framePacket('version 2\n'),framePacket(`${agent}\n`),framePacket('ls-refs=unborn\n'),framePacket('fetch=shallow wait-for-done\n'),framePacket('object-format=sha1\n'),flushPacket()]));return;}
 const parts:Buffer[]=[framePacket(`# service=${service}\n`),flushPacket()];const caps=upload?[...uploadCaps,`symref=HEAD:${repo.headTarget()}`,agent]:[...receiveCaps,agent];
 const head=advertisedHead(repo);if(head===ZERO_OID)parts.push(framePacket(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));else parts.push(framePacket(`${head} HEAD\0${caps.join(' ')}\n`));
 for(const [name,oid] of refs(repo)){parts.push(framePacket(`${oid} ${name}\n`));const obj=repo.getObject(oid);if(obj?.type==='tag'){try{parts.push(framePacket(`${parseTag(obj.data).object} ${name}^{}\n`));}catch{}}}
 parts.push(flushPacket());res.end(Buffer.concat(parts));
}
function bodyBytes(body:unknown):Buffer { if(Buffer.isBuffer(body))return body;if(body instanceof Uint8Array)return Buffer.from(body);return Buffer.alloc(0); }
function packetLines(body:Buffer){return decodePackets(body);}
function reachableCommits(repo:Repository,roots:string[]):Set<string>{const seen=new Set<string>(),todo=[...roots];while(todo.length){const id=todo.pop()!;if(seen.has(id))continue;const o=repo.getObject(id);if(!o||o.type!=='commit')continue;seen.add(id);todo.push(...parseCommit(o.data).parents);}return seen;}
function packObjects(repo:Repository,ids:Set<string>):Buffer{return writePack([...ids].map(id=>repo.getObject(id)).filter((x):x is NonNullable<typeof x>=>!!x));}
function appendPackSideband(out:Buffer[],pack:Buffer){out.push(sideband(pack,1));}
function fetchResult(repo:Repository,wants:string[],haves:string[],depth?:number,clientShallow:string[]=[]):{pack:Buffer;shallow:string[];unshallow:string[]}{
 const haveCommits=reachableCommits(repo,haves), haveObjects=reachableObjects(repo,haves), distances=new Map<string,number>(), queue=wants.map(id=>[id,0] as [string,number]), boundary=new Set<string>(), unshallow=new Set<string>(), shallowSet=new Set(clientShallow);
 while(queue.length){const [id,generation]=queue.shift()!;if(haveCommits.has(id)||(distances.get(id)??Infinity)<=generation)continue;const obj=repo.getObject(id);if(!obj||obj.type!=='commit')continue;distances.set(id,generation);const parents=parseCommit(obj.data).parents;
  if(depth!==undefined&&generation+1>=depth){if(parents.some(p=>repo.getObject(p)))boundary.add(id);continue;}
  if(shallowSet.has(id)){if(depth===undefined||parents.length===0){boundary.add(id);continue;}unshallow.add(id);}
  queue.push(...parents.map(parent=>[parent,generation+1] as [string,number]));
 }
 const commits=new Set(distances.keys()),include=new Set<string>();for(const id of commits){if(!haveObjects.has(id))include.add(id);const o=repo.getObject(id);if(o?.type==='commit')for(const x of reachableObjects(repo,[parseCommit(o.data).tree]))if(!haveObjects.has(x))include.add(x);}
 return{pack:packObjects(repo,include),shallow:[...boundary].filter(id=>!shallowSet.has(id)),unshallow:[...unshallow],};
}
export async function handleUploadPack(forge:Forge,req:IncomingMessage,res:ServerResponse,owner:string,repoName:string,body?:Uint8Array):Promise<void>{
 const repo=repoOr404(forge,owner,repoName,res);if(!repo)return;res.setHeader('Content-Type','application/x-git-upload-pack-result');
 try{const packets=packetLines(bodyBytes(body));const lines=packets.filter(p=>p.type==='data').map(p=>(p as {data:Buffer}).data.toString().replace(/\n$/,''));const v2=lines[0]?.startsWith('command=');
 if(v2){const command=lines[0].slice(8),dl=packets.findIndex(p=>p.type==='delim');if(dl<0)throw new Error('Missing delimiter');const args=packets.slice(dl+1).filter(p=>p.type==='data').map(p=>(p as {data:Buffer}).data.toString().trim());if(command==='ls-refs'){const peel=args.includes('peel'),sym=args.includes('symrefs'),unborn=args.includes('unborn'),prefixes:string[]=[];for(let i=0;i<args.length;i++)if(args[i]==='ref-prefix'&&args[i+1]!==undefined)prefixes.push(args[++i]);const all:[string,string][]=[['HEAD',advertisedHead(repo)],...refs(repo)];const out:Buffer[]=[];for(const [name,oid] of all){if(prefixes.length&&!prefixes.some(p=>name.startsWith(p)))continue;if(name==='HEAD'&&oid===ZERO_OID){if(unborn)out.push(framePacket(`unborn HEAD${sym?` symref-target:${repo.headTarget()}`:''}\n`));continue;}let suffix=name==='HEAD'&&sym?` symref-target:${repo.headTarget()}`:'';const obj=repo.getObject(oid);if(peel&&obj?.type==='tag'){try{suffix+=` peeled:${parseTag(obj.data).object}`;}catch{}}out.push(framePacket(`${oid} ${name}${suffix}\n`));}out.push(flushPacket());res.end(Buffer.concat(out));return;}
 if(command==='fetch'){const wants:string[]=[],haves:string[]=[],shallow:string[]=[];let depth:number|undefined;for(let i=0;i<args.length;i++){const [word,value]=args[i].split(' ',2);if(word==='want'&&value)wants.push(value);if(word==='have'&&value)haves.push(value);if(word==='shallow'&&value)shallow.push(value);if(word==='deepen'&&value)depth=Math.max(1,Number(value)||1);}
 const known=haves.filter(id=>repo.getObject(id)?.type==='commit');const result=fetchResult(repo,wants,haves,depth,shallow);const out:Buffer[]=[framePacket('acknowledgments\n'),...(known.length?known.map(id=>framePacket(`ACK ${id}\n`)):[framePacket('NAK\n')]),flushPacket()];if(depth!==undefined||shallow.length){out.push(framePacket('shallow-info\n'),...result.shallow.map(x=>framePacket(`shallow ${x}\n`)),...result.unshallow.map(x=>framePacket(`unshallow ${x}\n`)),flushPacket());}out.push(framePacket('packfile\n'));appendPackSideband(out,result.pack);out.push(flushPacket());res.end(Buffer.concat(out));return;}throw new Error('Unsupported upload-pack command');
 }
 const wants:string[]=[],haves:string[]=[],shallow:string[]=[];let depth:number|undefined;for(const line of lines){const plain=line.split('\0',1)[0].trim(),[word,id]=plain.split(/\s+/,2);if(word==='want'&&id)wants.push(id);else if(word==='have'&&id)haves.push(id);else if(word==='shallow'&&id)shallow.push(id);else if(word==='deepen'&&id)depth=Math.max(1,Number(id)||1);}
 const result=fetchResult(repo,wants,haves,depth,shallow);const out:Buffer[]=[...result.shallow.map(x=>framePacket(`shallow ${x}\n`)),framePacket('NAK\n')];appendPackSideband(out,result.pack);out.push(flushPacket());res.end(Buffer.concat(out));
 }catch{json(res,400,{message:'Malformed upload-pack request'});}
}
export async function handleReceivePack(forge:Forge,req:IncomingMessage,res:ServerResponse,owner:string,repoName:string,body?:Uint8Array):Promise<void>{
 const repo=repoOr404(forge,owner,repoName,res);if(!repo)return;res.setHeader('Content-Type','application/x-git-receive-pack-result');const raw=bodyBytes(body);let commands:{old:string;next:string;ref:string}[]=[],packStart=0,band=false,packError:string|undefined;
 try{let pos=0,done=false;while(pos+4<=raw.length){const h=raw.toString('ascii',pos,pos+4);if(!/^[0-9a-fA-F]{4}$/.test(h))throw new Error('Malformed packet length');const n=parseInt(h,16);pos+=4;if(n===0){packStart=pos;done=true;break;}if(n<4||pos+n-4>raw.length)throw new Error('Malformed packet');const text=raw.toString('utf8',pos,pos+n-4);pos+=n-4;const nul=text.indexOf('\0'),line=nul>=0?text.slice(0,nul):text;if(nul>=0)band=text.slice(nul+1).split(/\s+/).includes('side-band-64k');const m=/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line.trim());if(!m)throw new Error('Malformed ref command');commands.push({old:m[1],next:m[2],ref:m[3]});}if(!done)throw new Error('Missing command flush');
 }catch{json(res,400,{message:'Malformed receive-pack request'});return;}
 if(packStart<raw.length){try{const parsed=readPack(raw.subarray(packStart),id=>repo.getObject(id));for(const [id,obj] of parsed.objects)repo.objects.set(id,obj);}catch(e){packError=e instanceof Error?e.message:'invalid pack';}}
 const report:Buffer[]=[framePacket(packError?`unpack ${packError}\n`:'unpack ok\n')];for(const c of commands){let reason='';const current=repo.refs.get(c.ref);if(packError)reason='unpack error';else if((c.old===ZERO_OID&&current)||(c.old!==ZERO_OID&&current!==c.old))reason='stale';else if(c.next===ZERO_OID){repo.refs.delete(c.ref);}else if(!repo.getObject(c.next))reason='missing object';else if(c.ref.startsWith('refs/heads/')&&current&&!isAncestor(repo,current,c.next))reason='non-fast-forward';if(reason)report.push(framePacket(`ng ${c.ref} ${reason}\n`));else if(c.next!==ZERO_OID){repo.refs.set(c.ref,c.next);report.push(framePacket(`ok ${c.ref}\n`));}else report.push(framePacket(`ok ${c.ref}\n`));}report.push(flushPacket());const stream=Buffer.concat(report);res.end(band?Buffer.concat([sideband(stream,1),flushPacket()]):stream);
}
