import { createHash } from 'node:crypto';

/** Supported Git object types. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
/** A hexadecimal SHA-1 object identifier. */
export type ObjectId = string;
/** The all-zero object identifier used for missing objects. */
export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The Git object id of an empty tree. */
export const EMPTY_TREE_ID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Hashes a Git object header and raw content without storing it. */
export function hashObject(type: GitObjectType, content: Uint8Array | string): ObjectId {
  const body = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
  return createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
}
/** A parsed tree entry. */
export type TreeEntry = { mode: string; name: string; oid: ObjectId };
/** Parses the binary content of a tree object. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const b = Buffer.from(data), out: TreeEntry[] = [];
  let p = 0;
  while (p < b.length) {
    const space = b.indexOf(0x20, p), nul = b.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > b.length) throw new Error('Malformed tree object');
    const mode = b.toString('ascii', p, space), name = b.toString('utf8', space + 1, nul);
    if (!/^\d+$/.test(mode) || !name) throw new Error('Malformed tree entry');
    out.push({ mode, name, oid: b.subarray(nul + 1, nul + 21).toString('hex') }); p = nul + 21;
  }
  return out;
}
function treeSortName(entry: TreeEntry): Buffer { return Buffer.from(entry.name + (entry.mode === '40000' || entry.mode === '040000' ? '/' : ''), 'utf8'); }
/** Builds canonical tree content, sorting entries using Git's directory comparison rule. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortName(a), treeSortName(b)));
  const chunks: Buffer[] = [];
  for (const e of sorted) {
    if (!/^[0-9a-f]{40}$/i.test(e.oid)) throw new Error(`Invalid object id: ${e.oid}`);
    chunks.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}
/** Parsed Git identity and timestamp. */
export type GitIdentity = { name: string; email: string; timestamp: number; timezone: '+0000' };
/** Parsed commit fields. */
export type CommitData = { tree: ObjectId; parents: ObjectId[]; author: GitIdentity; committer: GitIdentity; message: string };
function identityLine(i: GitIdentity): string { return `${i.name} <${i.email}> ${i.timestamp} +0000`; }
function parseIdentity(s: string): GitIdentity {
  const m = /^(.*) <([^<>]*)> (-?\d+) (\+0000)$/.exec(s);
  if (!m) throw new Error('Malformed commit identity');
  return { name: m[1], email: m[2], timestamp: Number(m[3]), timezone: '+0000' };
}
/** Builds commit object content. */
export function buildCommit(c: CommitData): Buffer {
  if (!/^[0-9a-f]{40}$/i.test(c.tree) || c.parents.some(x => !/^[0-9a-f]{40}$/i.test(x))) throw new Error('Invalid commit object id');
  return Buffer.from(`tree ${c.tree}\n${c.parents.map(x => `parent ${x}\n`).join('')}author ${identityLine(c.author)}\ncommitter ${identityLine(c.committer)}\n\n${c.message}`, 'utf8');
}
/** Parses commit object content. */
export function parseCommit(data: Uint8Array): CommitData {
  const s = Buffer.from(data).toString('utf8'), cut = s.indexOf('\n\n');
  if (cut < 0) throw new Error('Malformed commit object');
  let tree = '', author: GitIdentity | undefined, committer: GitIdentity | undefined; const parents: string[] = [];
  for (const line of s.slice(0, cut).split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseIdentity(line.slice(10));
  }
  if (!/^[0-9a-f]{40}$/i.test(tree) || !author || !committer || parents.some(x => !/^[0-9a-f]{40}$/i.test(x))) throw new Error('Malformed commit headers');
  return { tree, parents, author, committer, message: s.slice(cut + 2) };
}
/** Parsed annotated tag fields. */
export type TagData = { object: ObjectId; type: GitObjectType; tag: string; tagger: string; message: string };
/** Parses annotated tag object content. */
export function parseTag(data: Uint8Array): TagData {
  const s = Buffer.from(data).toString('utf8'), cut = s.indexOf('\n\n'); if (cut < 0) throw new Error('Malformed tag object');
  const h = new Map(s.slice(0, cut).split('\n').map(x => { const i = x.indexOf(' '); return [x.slice(0, i), x.slice(i + 1)]; }));
  const object = h.get('object'), type = h.get('type'), tag = h.get('tag'), tagger = h.get('tagger');
  if (!object || !/^[0-9a-f]{40}$/i.test(object) || !['commit','tree','blob','tag'].includes(type ?? '') || tag === undefined || tagger === undefined) throw new Error('Malformed tag headers');
  return { object, type: type as GitObjectType, tag, tagger, message: s.slice(cut + 2) };
}
/** Stored Git object. */
export type GitObject = { type: GitObjectType; data: Buffer };
/** Issue comment. */
export type Comment = { id: number; body: string };
/** Repository issue. */
export type Issue = { number: number; id: number; title: string; body: string; state: 'open'|'closed'; labels: string[]; comments: Comment[] };
/** Repository pull request. */
export type PullRequest = { number: number; id: number; title: string; body: string; head: string; base: string; state: 'open'|'closed'; merged: boolean; mergedAt: string|null; mergeCommitId: string|null; comments: Comment[] };
/** In-memory repository state. */
export class Repository {
  readonly objects = new Map<ObjectId, GitObject>(); readonly refs = new Map<string, ObjectId>(); readonly labels = new Map<string, string>();
  readonly issues = new Map<number, Issue>(); readonly pulls = new Map<number, PullRequest>();
  private sequence = 1;
  name: string; privateRepo: boolean; description: string; readonly id: number;
  constructor(name: string, privateRepo: boolean, description: string, id: number) { this.name = name; this.privateRepo = privateRepo; this.description = description; this.id = id; }
  /** Stores an object and returns its id. */
  putObject(type: GitObjectType, data: Uint8Array | string): ObjectId { const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data); const oid = hashObject(type, bytes); this.objects.set(oid, { type, data: bytes }); return oid; }
  /** Retrieves an object by id. */
  getObject(oid: ObjectId): GitObject | undefined { return this.objects.get(oid); }
  /** Returns the object id at a full ref name. */
  refTip(ref: string): ObjectId | undefined { return this.refs.get(ref); }
  /** Returns a branch tip. */
  branchTip(branch: string): ObjectId | undefined { return this.refTip(branch.startsWith('refs/') ? branch : `refs/heads/${branch}`); }
  /** Returns the default HEAD target. */
  headTarget(): string { return 'refs/heads/main'; }
  /** Allocates the next shared issue/pull number. */
  nextNumber(): number { return this.sequence++; }
}
/** In-memory forge state and deterministic id/time sources. */
export class Forge {
  readonly repositories = new Map<string, Repository>(); viewerLogin: string | undefined; private requestSequence = 1; private globalSequence = 1; private repositorySequence = 1; private commentSequence = 1;
  readonly accessToken: string; readonly now: Date;
  constructor(options: { accessToken?: string; now?: string|Date } = {}) { this.accessToken = options.accessToken ?? ''; this.now = options.now instanceof Date ? new Date(options.now) : new Date(options.now ?? '2026-01-01T00:00:00.000Z'); if (!Number.isFinite(this.now.getTime())) throw new Error('Invalid forge timestamp'); }
  /** Returns a stable ISO timestamp. */
  timestamp(): string { return this.now.toISOString(); }
  /** Allocates a request id. */
  nextRequestId(): string { return `req-${this.requestSequence++}`; }
  /** Allocates a global issue or pull id. */
  nextGlobalId(): number { return this.globalSequence++; }
  /** Allocates a global comment id. */
  nextCommentId(): number { return this.commentSequence++; }
  /** Learns the first non-empty owner login and returns it. */
  learnLogin(owner: string): string { if (!this.viewerLogin && owner.trim()) this.viewerLogin = owner; return this.viewerLogin ?? 'viewer'; }
  /** Login used in rendered responses. */
  login(): string { return this.viewerLogin ?? 'viewer'; }
  /** Creates and registers a repository with a sequential database id. */
  createRepository(name: string, privateRepo = false, description = ''): Repository { const r = new Repository(name, privateRepo, description, this.repositorySequence++); this.repositories.set(name, r); return r; }
  /** Looks up a repository and applies the forge's single-viewer owner rule. */
  getRepository(owner: string, name: string): Repository | undefined { this.learnLogin(owner); if (this.viewerLogin !== owner) return undefined; return this.repositories.get(name); }
}
/** Builds a forge from the supported environment variables. */
export function createForgeFromEnv(env: Record<string, string | undefined> = process.env): Forge { return new Forge({ accessToken: env.MAKEFUN_SHOP_TOKEN ?? '', now: env.MAKEFUN_TRIAL_NOW ?? '2026-01-01T00:00:00.000Z' }); }

/** Returns all existing objects reachable through commit, tree, and tag links. */
export function reachableObjects(repo: Repository, roots: Iterable<ObjectId>): Set<ObjectId> {
  const seen = new Set<ObjectId>(), pending = [...roots];
  while (pending.length) { const oid = pending.pop()!; if (seen.has(oid)) continue; seen.add(oid); const o = repo.getObject(oid); if (!o) continue;
    if (o.type === 'tree') for (const e of parseTree(o.data)) pending.push(e.oid);
    else if (o.type === 'commit') { const c = parseCommit(o.data); pending.push(c.tree, ...c.parents); }
    else if (o.type === 'tag') pending.push(parseTag(o.data).object);
  }
  return new Set([...seen].filter(x => repo.getObject(x)));
}
/** Tests whether ancestor is equal to or an ancestor of descendant. */
export function isAncestor(repo: Repository, ancestor: ObjectId, descendant: ObjectId): boolean {
  const todo = [descendant], seen = new Set<string>(); while (todo.length) { const x = todo.pop()!; if (x === ancestor) return true; if (seen.has(x)) continue; seen.add(x); const o = repo.getObject(x); if (o?.type === 'commit') todo.push(...parseCommit(o.data).parents); } return false;
}
/** Finds the best common ancestor of two commits, or null. */
export function mergeBase(repo: Repository, a: ObjectId, b: ObjectId): ObjectId | null {
  const depths = (start: string) => { const d = new Map<string, number>(), q: [string,number][] = [[start,0]]; while(q.length){const [x,n]=q.shift()!; if((d.get(x)??Infinity)<=n)continue; d.set(x,n); const o=repo.getObject(x); if(o?.type==='commit') for(const p of parseCommit(o.data).parents) q.push([p,n+1]);} return d; };
  const da=depths(a), db=depths(b); let best: string|null=null, score=Infinity; for(const [x,n] of da){const m=db.get(x); if(m!==undefined && Math.max(n,m)<score){best=x;score=Math.max(n,m);}} return best;
}
/** Flatten a tree into file paths, omitting subtrees. */
export function flattenTree(repo: Repository, tree: ObjectId): Map<string,{mode:string; oid:ObjectId}> {
  const out = new Map<string,{mode:string;oid:string}>(); const walk=(id:string,prefix:string)=>{const o=repo.getObject(id);if(!o||o.type!=='tree')return;for(const e of parseTree(o.data)){const p=prefix?`${prefix}/${e.name}`:e.name;if(e.mode==='40000'||e.mode==='040000')walk(e.oid,p);else out.set(p,{mode:e.mode,oid:e.oid});}}; walk(tree,''); return out;
}
/** Looks up a path in a tree and returns its entry type and id. */
export function lookupTreePath(repo: Repository, tree: ObjectId, path: string): {mode:string;oid:ObjectId;type:'tree'|'blob'}|undefined {
  const parts=path.split('/').filter(Boolean); let current=tree, entry:TreeEntry|undefined;
  for(let i=0;i<parts.length;i++){const o=repo.getObject(current);if(!o||o.type!=='tree')return;entry=parseTree(o.data).find(e=>e.name===parts[i]);if(!entry)return;if(i<parts.length-1){if(entry.mode!=='40000'&&entry.mode!=='040000')return;current=entry.oid;}}
  return entry?{...entry,type:entry.mode==='40000'||entry.mode==='040000'?'tree':'blob'}:undefined;
}
/** Writes a blob at a path, creating intermediate trees. */
export function writeFile(repo:Repository, root:ObjectId|null, blob:ObjectId, path:string, mode='100644'):ObjectId {
  const parts=path.split('/').filter(Boolean);if(!parts.length)throw new Error('Path must not be empty');
  const rec=(tree:ObjectId|null,depth:number):ObjectId=>{const entries=tree&&repo.getObject(tree)?.type==='tree'?parseTree(repo.getObject(tree)!.data):[];const name=parts[depth];const idx=entries.findIndex(e=>e.name===name);
    if(depth===parts.length-1){const e={mode,name,oid:blob};if(idx>=0)entries[idx]=e;else entries.push(e);}else{const sub=idx>=0?entries[idx].oid:null;const oid=rec(sub,depth+1);const e={mode:'40000',name,oid};if(idx>=0)entries[idx]=e;else entries.push(e);}return repo.putObject('tree',buildTree(entries));};return rec(root,0);
}
/** Removes a file path, returning null when the root becomes empty. */
export function removeFile(repo:Repository,root:ObjectId,path:string):ObjectId|null {
  const parts=path.split('/').filter(Boolean);if(!parts.length)return root;
  const rec=(tree:ObjectId,depth:number):ObjectId|null=>{const o=repo.getObject(tree);if(!o||o.type!=='tree')return tree;const entries=parseTree(o.data),idx=entries.findIndex(e=>e.name===parts[depth]);if(idx<0)return tree;
    if(depth===parts.length-1)entries.splice(idx,1);else{const child=rec(entries[idx].oid,depth+1);if(child===null)entries.splice(idx,1);else entries[idx]={...entries[idx],oid:child};}return entries.length?repo.putObject('tree',buildTree(entries)):null;};return rec(root,0);
}
/** Returns a commit's tree id. */
export function commitTree(repo:Repository,commit:ObjectId):ObjectId { const o=repo.getObject(commit);if(!o||o.type!=='commit')throw new Error('Not a commit');return parseCommit(o.data).tree; }
/** Creates and stores a commit using the forge's deterministic identity and timestamp. */
export function createCommit(repo:Repository,forge:Forge,tree:ObjectId,parents:ObjectId[],message:string):ObjectId {
  const identity={name:forge.login(),email:`${forge.login()}@forge.local`,timestamp:Math.floor(forge.now.getTime()/1000),timezone:'+0000' as const};return repo.putObject('commit',buildCommit({tree,parents,author:identity,committer:identity,message}));
}
/** Rebuilds a tree from a flat path-to-blob map. */
export function treeFromFlat(repo:Repository,files:Map<string,string>|Record<string,string>):ObjectId {
  let root:ObjectId|null=null;const entries=files instanceof Map?[...files]:Object.entries(files);for(const [path,oid] of entries)root=writeFile(repo,root,oid,path);if(root)return root;const empty=repo.putObject('tree',Buffer.alloc(0));return empty;
}
/** Three-way merges flattened tree files and reports conflicting paths. */
export function mergeTrees(repo:Repository,base:ObjectId|null,ours:ObjectId|null,theirs:ObjectId|null):{tree:ObjectId|null;conflicts:string[]} {
  const flatten=(id:string|null)=>id?flattenTree(repo,id):new Map<string,{mode:string;oid:string}>(), b=flatten(base),o=flatten(ours),t=flatten(theirs);const paths=new Set([...b.keys(),...o.keys(),...t.keys()]), merged=new Map<string,string>(), conflicts:string[]=[];
  const eq=(x:unknown,y:unknown)=>JSON.stringify(x??null)===JSON.stringify(y??null);
  for(const p of paths){const bv=b.get(p),ov=o.get(p),tv=t.get(p);let v;if(eq(ov,tv))v=ov;else if(eq(bv,ov))v=tv;else if(eq(bv,tv))v=ov;else{conflicts.push(p);continue;}if(v)merged.set(p,v.oid);}
  if(conflicts.length)return{tree:null,conflicts};return{tree:merged.size?treeFromFlat(repo,merged):null,conflicts};
}
/** Per-file line change summary. */
export type FileDiff = { filename:string; status:'added'|'modified'|'removed'; additions:number; deletions:number };
function linesOf(data:Buffer):string[]{const s=data.toString('utf8');return s.length?s.split('\n').filter((x,i,a)=>!(i===a.length-1&&x==='')):[];}
function lineCounts(a:string[],b:string[]):[number,number]{const dp=Array.from({length:a.length+1},()=>new Uint32Array(b.length+1));for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);return[b.length-dp[0][0],a.length-dp[0][0]];}
/** Computes added, modified, and removed files with LCS line counts. */
export function diffTrees(repo:Repository,oldTree:ObjectId|null,newTree:ObjectId|null):FileDiff[]{const a=oldTree?flattenTree(repo,oldTree):new Map(),b=newTree?flattenTree(repo,newTree):new Map(),out:FileDiff[]=[];for(const p of new Set([...a.keys(),...b.keys()])){const x=a.get(p),y=b.get(p);if(x&&y&&x.oid===y.oid&&x.mode===y.mode)continue;const xo=x?repo.getObject(x.oid):undefined,yo=y?repo.getObject(y.oid):undefined;const al=xo?.type==='blob'?linesOf(xo.data):[],bl=yo?.type==='blob'?linesOf(yo.data):[];let [add,del]=lineCounts(al,bl);const status=!x?'added':!y?'removed':'modified';if(status==='added'&&add===0)add=1;out.push({filename:p,status,additions:add,deletions:del});}return out;}
