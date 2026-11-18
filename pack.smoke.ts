import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Forge, buildTree, createCommit, hashObject } from './store.ts';
import { readPack, writePack } from './pack.ts';

const forge=new Forge(),repo=forge.createRepository('smoke');
const blobData=Buffer.from('round-trip blob payload that crosses the four-bit size boundary');
const blob=repo.putObject('blob',blobData);
const tree=repo.putObject('tree',buildTree([{mode:'100644',name:'file.txt',oid:blob}]));
const commit=createCommit(repo,forge,tree,[],'pack smoke');
const input=[blob,tree,commit].map(id=>repo.getObject(id)!);
const roundTrip=readPack(writePack(input));
assert.equal(roundTrip.objects.size,3);
for(const id of [blob,tree,commit])assert.deepEqual(roundTrip.objects.get(id),repo.getObject(id));

function encVar(value:number):Buffer{const out:number[]=[];do{let b=value&127;value=Math.floor(value/128);if(value)b|=128;out.push(b);}while(value);return Buffer.from(out);}
function packHeader(type:number,size:number):Buffer{let first=(type<<4)|(size&15);size=Math.floor(size/16);if(size)first|=128;const out=[first];while(size){let b=size&127;size=Math.floor(size/128);if(size)b|=128;out.push(b);}return Buffer.from(out);}
const base=Buffer.from('a reusable base object for delta resolution');
const target=Buffer.from('a reusable improved base object for delta resolution');
let common=0;while(common<base.length&&common<target.length&&base[common]===target[common])common++;
const suffix=target.subarray(common);
// Copy the common prefix, then insert the changed suffix.
const delta=Buffer.concat([encVar(base.length),encVar(target.length),Buffer.from([0x91,0,common]),Buffer.from([suffix.length]),suffix]);
const deltaData=Buffer.concat([packHeader(3,base.length),deflateSync(base),packHeader(7,delta.length),Buffer.from(hashObject('blob',base),'hex'),deflateSync(delta)]);
const header=Buffer.concat([Buffer.from('PACK'),Buffer.from([0,0,0,2,0,0,0,2]),deltaData]);
const deltaPack=Buffer.concat([header,createHash('sha1').update(header).digest()]);
const resolved=readPack(deltaPack);
assert.equal(resolved.deltaCount,1);
assert.deepEqual(resolved.objects.get(hashObject('blob',target))?.data,target);
console.log('pack smoke passed');
