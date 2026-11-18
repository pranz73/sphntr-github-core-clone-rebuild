import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { hashObject, type GitObjectType, type ObjectId } from './store.ts';

/** Maximum pkt-line payload size after the four-byte prefix. */
export const MAX_PKT_PAYLOAD = 65516;
/** Parsed pkt-line packet. */
export type Packet = { type:'data'; data:Buffer } | { type:'flush'|'delim'|'response-end' };
/** Frames a payload as a pkt-line. */
export function framePacket(payload:Uint8Array|string):Buffer { const b=typeof payload==='string'?Buffer.from(payload):Buffer.from(payload);if(b.length>MAX_PKT_PAYLOAD)throw new Error('pkt-line payload too large');const n=b.length+4;return Buffer.concat([Buffer.from(n.toString(16).padStart(4,'0'),'ascii'),b]); }
/** Emits a pkt-line flush marker. */
export function flushPacket():Buffer{return Buffer.from('0000','ascii');}
/** Emits a pkt-line delimiter marker. */
export function delimPacket():Buffer{return Buffer.from('0001','ascii');}
/** Emits a pkt-line response-end marker. */
export function responseEndPacket():Buffer{return Buffer.from('0002','ascii');}
/** Incrementally decodes pkt-line packets. */
export class PacketDecoder {
  private pending=Buffer.alloc(0); private ended=false;
  /** Adds a chunk and returns all complete packets. */
  push(chunk:Uint8Array):Packet[]{if(this.ended)throw new Error('Decoder is finished');this.pending=Buffer.concat([this.pending,Buffer.from(chunk)]);const out:Packet[]=[];while(this.pending.length>=4){const h=this.pending.toString('ascii',0,4);if(!/^[0-9a-fA-F]{4}$/.test(h))throw new Error('Malformed pkt-line length');const n=parseInt(h,16);if(n<4){this.pending=this.pending.subarray(4);out.push({type:n===0?'flush':n===1?'delim':'response-end'});continue;}if(n>65520)throw new Error('pkt-line too large');if(this.pending.length<n)break;out.push({type:'data',data:Buffer.from(this.pending.subarray(4,n))});this.pending=this.pending.subarray(n);}return out;}
  /** Marks end of stream and rejects an incomplete trailing packet. */
  finish():void{this.ended=true;if(this.pending.length)throw new Error('Trailing incomplete pkt-line');}
}
/** Decodes a complete pkt-line buffer and rejects trailing partial input. */
export function decodePackets(data:Uint8Array):Packet[]{const d=new PacketDecoder(),out=d.push(data);d.finish();return out;}
/** Inflates a zlib stream beginning at offset and reports consumed bytes. */
export function inflateAt(data:Uint8Array,offset=0):{data:Buffer;consumed:number}{const b=Buffer.from(data).subarray(offset);const r=inflateSync(b,{info:true});return{data:r.buffer,consumed:r.engine.bytesWritten};}
function readVar(buf:Buffer,state:{p:number}):number{let n=0,shift=0;while(true){if(state.p>=buf.length)throw new Error('Truncated delta varint');const c=buf[state.p++];n|=(c&0x7f)<<shift;if(!(c&0x80))return n;shift+=7;if(shift>49)throw new Error('Oversized delta varint');}}
/** Applies a Git delta instruction stream to its base. */
export function applyDelta(baseData:Uint8Array,deltaData:Uint8Array):Buffer{const base=Buffer.from(baseData),d=Buffer.from(deltaData),s={p:0};const source=readVar(d,s),target=readVar(d,s);if(source!==base.length)throw new Error('Delta source size mismatch');const chunks:Buffer[]=[];let total=0;while(s.p<d.length){const op=d[s.p++];if(op===0)throw new Error('Invalid delta opcode');if(op&0x80){let off=0,size=0;for(let i=0;i<4;i++)if(op&(1<<i)){if(s.p>=d.length)throw new Error('Truncated delta copy');off|=d[s.p++]<<(i*8);}for(let i=0;i<3;i++)if(op&(1<<(i+4))){if(s.p>=d.length)throw new Error('Truncated delta copy');size|=d[s.p++]<<(i*8);}if(size===0)size=0x10000;if(off+size>base.length)throw new Error('Delta copy outside base');chunks.push(base.subarray(off,off+size));total+=size;}else{if(s.p+op>d.length)throw new Error('Truncated delta insert');chunks.push(d.subarray(s.p,s.p+op));s.p+=op;total+=op;}}if(total!==target)throw new Error('Delta target size mismatch');return Buffer.concat(chunks,total);}
/** External object resolver used for thin ref-deltas. */
export type ObjectResolver=(oid:ObjectId)=>{type:GitObjectType;data:Uint8Array}|undefined;
type Packed={type:GitObjectType;data:Buffer;oid:string};
function typeName(t:number):GitObjectType{if(t===1)return'commit';if(t===2)return'tree';if(t===3)return'blob';if(t===4)return'tag';throw new Error('Invalid pack object type');}
/** Reads and validates a Git pack, resolving deltas and verifying its checksum. */
export function readPack(input:Uint8Array,resolver?:ObjectResolver):{objects:Map<ObjectId,{type:GitObjectType;data:Buffer}>;objectCount:number;deltaCount:number}{const b=Buffer.from(input);if(b.length<32||b.toString('ascii',0,4)!=='PACK')throw new Error('Invalid pack header');const version=b.readUInt32BE(4);if(version!==2&&version!==3)throw new Error('Unsupported pack version');const count=b.readUInt32BE(8), checksum=b.subarray(b.length-20);if(createHash('sha1').update(b.subarray(0,b.length-20)).digest().compare(checksum)!==0)throw new Error('Pack checksum mismatch');let p=12;const entries:{type:number;size:number;offset:number;data:Buffer;baseOffset?:number;baseId?:string}[]=[];
  for(let i=0;i<count;i++){const offset=p;let c=b[p++];if(c===undefined)throw new Error('Truncated pack');const type=(c>>4)&7;let size=c&15,shift=4;while(c&0x80){if(p>=b.length-20)throw new Error('Truncated pack header');c=b[p++];size+=(c&0x7f)*2**shift;shift+=7;}let baseOffset:number|undefined,baseId:string|undefined;if(type===6){let x=b[p++],dist=x&0x7f;while(x&0x80){x=b[p++];dist=((dist+1)<<7)|(x&0x7f);}baseOffset=offset-dist;}else if(type===7){if(p+20>b.length-20)throw new Error('Truncated ref-delta');baseId=b.subarray(p,p+20).toString('hex');p+=20;}else if(type<1||type>4)throw new Error('Invalid pack type');const inf=inflateAt(b,p);p+=inf.consumed;if(inf.data.length!==size)throw new Error('Packed object size mismatch');entries.push({type,size,offset,data:inf.data,baseOffset,baseId});}
  if(p!==b.length-20)throw new Error('Unexpected bytes before pack checksum');const byOffset=new Map(entries.map(e=>[e.offset,e]));const resolved=new Map<object,Packed>();let deltaCount=0;const resolve=(e:typeof entries[number],stack=new Set<object>()):Packed=>{if(resolved.has(e))return resolved.get(e)!;if(stack.has(e))throw new Error('Delta cycle');stack.add(e);let v:Packed;if(e.type>=1&&e.type<=4){const type=typeName(e.type);v={type,data:e.data,oid:hashObject(type,e.data)};}else{deltaCount++;let base:Packed|undefined;if(e.type===6){const be=byOffset.get(e.baseOffset!);if(be)base=resolve(be,stack);}else{base=[...resolved.values()].find(x=>x.oid===e.baseId);if(!base){const external=resolver?.(e.baseId!);if(external)base={type:external.type,data:Buffer.from(external.data),oid:e.baseId!};}}if(!base)throw new Error(`Unresolved delta base ${e.baseId??e.baseOffset}`);const data=applyDelta(base.data,e.data);v={type:base.type,data,oid:hashObject(base.type,data)};}stack.delete(e);resolved.set(e,v);return v;};const objects=new Map<string,{type:GitObjectType;data:Buffer}>();for(const e of entries){const r=resolve(e);objects.set(r.oid,{type:r.type,data:r.data});}return{objects,objectCount:count,deltaCount};}
function encodeVar(n:number):Buffer{const a:number[]=[];do{let c=n&0x7f;n=Math.floor(n/128);if(n)c|=0x80;a.push(c);}while(n);return Buffer.from(a);}
/** Writes a version 2 pack containing plain objects only. */
export function writePack(objects:Iterable<{type:GitObjectType;data:Uint8Array}>):Buffer{const all=[...objects],parts:Buffer[]=[Buffer.from('PACK'),Buffer.from([0,0,0,2]),Buffer.alloc(4)];parts[2].writeUInt32BE(all.length);for(const o of all){const data=Buffer.from(o.data);let n=data.length,first=((['commit','tree','blob','tag'].indexOf(o.type)+1)<<4)|(n&15);n=Math.floor(n/16);const h=[first];while(n){let c=n&0x7f;n=Math.floor(n/128);if(n)c|=0x80;h.push(c);}parts.push(Buffer.from(h),deflateSync(data));}const body=Buffer.concat(parts);return Buffer.concat([body,createHash('sha1').update(body).digest()]);}
/** Frames bytes over sideband pkt-lines using the selected band byte. */
export function sideband(data:Uint8Array,band=1):Buffer{if(band<1||band>3)throw new Error('Invalid sideband');const b=Buffer.from(data),size=MAX_PKT_PAYLOAD-1,chunks:Buffer[]=[];for(let p=0;p<b.length;p+=size)chunks.push(framePacket(Buffer.concat([Buffer.from([band]),b.subarray(p,p+size)])));return Buffer.concat(chunks);}
