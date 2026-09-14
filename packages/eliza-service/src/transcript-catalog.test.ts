import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createReader } from './transcript-registry.js';
import { parseFindMeetingsArgs, parseReadMeetingArgs } from './actions/tinycloud-search-transcripts.js';
import { TRANSCRIPT_RESPONSE_BYTE_LIMIT, createTranscriptFetch } from './transcript-transport.js';
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const base = {source:'fireflies',sourceId:'source',meetingRef:'0000'} as const;
function fixture() {
 const db=new Database(':memory:');
 db.run(`CREATE TABLE connector_meeting(id TEXT PRIMARY KEY,source TEXT,source_id TEXT,title TEXT,started_at TEXT,organizer_email TEXT,participants TEXT,metadata TEXT,head_revision TEXT,head_snapshot_key TEXT,publication_state TEXT)`);
 const raw='Original transcript.';
 const snapshot={contractVersion:3,...base,operationId:'op',createdAt:'2026-09-14T00:00:00Z',metadata:{title:'Original title',startedAt:null,organizerEmail:null,participants:[],metadata:{}},body:{basis:'transcript',encoding:'utf-8',schema:'text',raw,original:{digest:hash(raw),byteLength:Buffer.byteLength(raw),recordCount:1,extent:'known',captureComplete:null},omissions:[]},overview:null,aliases:[]};
 const bytes=JSON.stringify(snapshot), revision=hash(bytes); const bodies=new Map([[revision,bytes]]);
 const insert=db.prepare(`INSERT INTO connector_meeting VALUES(?, 'fireflies', 'source', ?, NULL,NULL,'[]','{}', ?,NULL,'published')`);
 for(let i=0;i<601;i++)insert.run(String(i).padStart(4,'0'),i===500?'Sole target':'Other',revision);
 db.run("UPDATE connector_meeting SET source='tinycloud-transcriber' WHERE id='0500'");
 let reads=0;
 const reader=createReader({sql:{db:()=>({query:async(sql:string,params:any[]=[])=>({ok:true,data:{rows:db.query(sql).values(...params)}})})},kv:{get:async(key:string)=>{reads++;const body=bodies.get(key.split('/').at(-1)!);return body?{ok:true,data:{data:body}}:{ok:false,error:{code:'KV_NOT_FOUND',message:'Key not found'}}}}});
 const page=(args:any={})=>{expect(typeof (reader as any).pageMetadata).toBe('function');return(reader as any).pageMetadata({contractVersion:3,...args});};
 const read=(ref:any={...base,revision})=>{expect(typeof (reader as any).readEvidence).toBe('function');return(reader as any).readEvidence({contractVersion:3,reference:ref,basis:'transcript'});};
 return {db,page,read,bodies,revision,reads:()=>reads};
}
test('v3 tool parsers require explicit revision and reject legacy arguments',()=>{
 expect(parseFindMeetingsArgs({contractVersion:3,filters:{source:'tinycloud-transcriber'},limit:100})).not.toBeNull();
 expect(parseReadMeetingArgs({contractVersion:3,reference:{...base,revision:'a'.repeat(64)},basis:'transcript'})).not.toBeNull();
 expect(parseReadMeetingArgs({focus:'summary'})).toBeNull();
 expect(parseFindMeetingsArgs({contractVersion:3,filters:{title:'Ä'}})).toBeNull();
 expect(parseReadMeetingArgs({contractVersion:3,reference:{...base,revision:'A'.repeat(64)},basis:'transcript'})).toBeNull();
});
test('catalog predicates precede 100-row pages and find sole row 501',async()=>{
 const f=fixture();try{const page=await f.page({filters:{source:'tinycloud-transcriber'}});expect(page.rows.map((r:any)=>r.meetingRef)).toEqual(['0500']);expect(page.exhausted).toBe(true);expect(page.scope).toBe('observed');}finally{f.db.close();}
});
test('immutable-ID pagination scans beyond 500 and declares concurrent observed scope',async()=>{
 const f=fixture();try{const first=await f.page();expect(first.rows).toHaveLength(100);expect(first.nextCursor).toBe('0099');
 f.db.run("DELETE FROM connector_meeting WHERE id = '0100'");
 f.db.run("UPDATE connector_meeting SET title='Edited' WHERE id='0101'");
 f.db.run("INSERT INTO connector_meeting SELECT '0000a',source,source_id,title,started_at,organizer_email,participants,metadata,head_revision,head_snapshot_key,publication_state FROM connector_meeting WHERE id='0000'");
 const second=await f.page({after:first.nextCursor});expect(second.rows[0].meetingRef).toBe('0101');expect(second.rows[0].title).toBe('Edited');
 let all=[...first.rows,...second.rows],page=second;while(!page.exhausted){page=await f.page({after:page.nextCursor});all.push(...page.rows);}
 expect(all).toHaveLength(600);expect(all.at(-1).meetingRef).toBe('0600');expect(all.some((r:any)=>r.meetingRef==='0000a')).toBe(false);
 }finally{f.db.close();}
});
test('exact reads preserve frozen historical revisions and verify snapshot bytes',async()=>{
 const f=fixture();try{f.db.run("UPDATE connector_meeting SET head_revision=? WHERE id='0000'",['b'.repeat(64)]);
 expect((await f.read()).spans[0].text).toBe('Original transcript.');
 f.bodies.set(f.revision,f.bodies.get(f.revision)!+' ');expect((await f.read()).omissions).toContainEqual({code:'snapshot_digest_mismatch'});
 }finally{f.db.close();}
});
test('deleted identities and missing frozen revisions return unavailable',async()=>{
 const f=fixture();try{expect((await f.read({...base,revision:'c'.repeat(64)})).state).toBe('unavailable');
 const reads=f.reads();f.db.run("UPDATE connector_meeting SET publication_state='deleted' WHERE id='0000'");expect((await f.read()).state).toBe('unavailable');expect(f.reads()).toBe(reads);
 }finally{f.db.close();}
});
test('transport admits complete 2 MiB framing and refuses one byte over',async()=>{
 expect(TRANSCRIPT_RESPONSE_BYTE_LIMIT).toBe(2_097_152);
 const exact='x'.repeat(2_097_152);expect(await(await createTranscriptFetch(async()=>new Response(exact))('http://test.invalid')).text()).toBe(exact);
 await expect(createTranscriptFetch(async()=>new Response(exact+'x'))('http://test.invalid')).rejects.toMatchObject({code:'TRANSCRIPT_RESPONSE_SIZE_LIMIT'});
});
