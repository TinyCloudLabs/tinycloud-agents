import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as evidence from './meeting-evidence.js';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const reference = { source: 'fireflies', sourceId: 'fixture', meetingRef: 'fixture-id', revision: 'a'.repeat(64) } as const;
const snapshot = (raw: string, schema = 'json-records', basis = 'transcript') => ({
  contractVersion: 3, source: reference.source, sourceId: reference.sourceId, meetingRef: reference.meetingRef,
  operationId: 'fixture-operation', createdAt: '2026-09-14T00:00:00Z',
  metadata: { title: 'Fixture', startedAt: null, organizerEmail: null, participants: [], metadata: {} },
  body: { basis, encoding: 'utf-8', schema, raw, original: { digest: sha(raw), byteLength: Buffer.byteLength(raw), recordCount: null, extent: 'unknown', captureComplete: null }, omissions: [] },
  overview: { text: 'Stored overview', provenance: { provider: null, generatedAt: null, sourceDigest: null, freshness: 'unknown' } }, aliases: [],
});
const decode = (input: unknown, basis = 'transcript') => {
  expect(typeof (evidence as any).decodeSnapshotEvidence).toBe('function');
  return (evidence as any).decodeSnapshotEvidence(input, reference, basis);
};
describe('version 3 exact evidence', () => {
  test('preserves every original record and offset beyond old sampling limits', () => {
    const raw = JSON.stringify(Array.from({length: 20_001}, (_, i) => ({text: `x${i}`})));
    const result = decode(snapshot(raw));
    expect(result.state).toBe('complete');
    expect(result.spans).toHaveLength(20_001);
    expect(result.spans.at(-1)).toEqual({text:'x20000', recordIndex:20_000, start:0, end:6});
    expect(result.coverage).toMatchObject({fetched:true,totalRecords:20_001,decodedRecords:20_001,suppliedRecords:20_001,processedRecords:null});
    expect(result.original.extent).toBe('unknown');
  });
  test('records unsupported original records without replacing their positions', () => {
    const result = decode(snapshot(JSON.stringify([{text:'first'}, {unrecognized:'lost'}, {text:'last',speaker_name:'A',start_time:42}])));
    expect(result.state).toBe('partial');
    expect(result.spans.map((span:any) => span.recordIndex)).toEqual([0,2]);
    expect(result.omissions).toContainEqual({code:'unsupported_record',recordIndex:1});
    expect(result.coverage).toMatchObject({totalRecords:3,decodedRecords:2,suppliedRecords:2});
  });
  test('never treats notes or an overview as transcript evidence', () => {
    expect(decode(snapshot('Notes only','text','notes')).state).toBe('unavailable');
    const result = decode(snapshot('Notes only','text','notes'),'notes');
    expect(result.basis).toBe('notes'); expect(result.state).toBe('complete');
    const overview = decode(snapshot('Transcript','text'),'overview');
    expect(overview.basis).toBe('overview'); expect(overview.overviewProvenance.freshness).toBe('unknown');
  });
  test('verifies raw digest and raw byte extent before decoding', () => {
    const changed = snapshot('Original','text'); changed.body.raw = 'Changed';
    expect(decode(changed).omissions).toContainEqual({code:'original_digest_mismatch'});
    const extent = snapshot('Original','text'); extent.body.original.byteLength = 1;
    expect(decode(extent).omissions).toContainEqual({code:'original_extent_mismatch'});
  });
  test('retains prior capture omissions even after complete artifact decoding', () => {
    const input = snapshot('Retained','text'); (input.body.omissions as any[]).push({code:'upstream_capture_gap'});
    const result = decode(input); expect(result.state).toBe('partial');
    expect(result.omissions).toContainEqual({code:'upstream_capture_gap'});
  });
  test('admits 1 MiB raw UTF8 and refuses 1 byte over without sampling', () => {
    const raw = '🙂'.repeat(1_048_576 / 4);
    const result = decode(snapshot(raw,'text')); expect(result.state).toBe('complete'); expect(result.spans[0].text).toBe(raw);
    const over = decode(snapshot(raw+'x','text')); expect(over.state).toBe('capacity'); expect(over.spans).toEqual([]);
  });
  test('rejects malformed JSON and complete framing capacity overflow explicitly', () => {
    expect(decode(snapshot('[{')).omissions).toContainEqual({code:'invalid_json'});
    const result = decode(snapshot('\u0000'.repeat(1_048_576),'text'));
    expect(result.state).toBe('capacity'); expect(result.spans).toEqual([]);
  });
  test('rejects invalid typed snapshot fields before claiming complete evidence', () => {
    const metadata = snapshot('Retained','text'); (metadata.metadata as any).participants = 'invalid';
    expect(decode(metadata).state).toBe('unavailable');
    const accounting = snapshot('Retained','text'); (accounting.body.original as any).extent = 'invented';
    expect(decode(accounting).state).toBe('unavailable');
    const utf8 = snapshot('\ud800','text'); expect(decode(utf8).state).toBe('unavailable');
  });
  test('preserves transcriber timing and verified Google participant attribution', () => {
    const transcriber = decode(snapshot(JSON.stringify([{text:'Decision',speaker_name:'Avery',start:42}])));
    expect(transcriber.spans[0]).toMatchObject({speaker:'Avery',startSecs:42});
    const google = snapshot(JSON.stringify([{text:'Decision',participant:'conference/participants/1',startTime:'2026-09-14T12:00:42Z'}]));
    (google.metadata as any).startedAt='2026-09-14T12:00:00Z';
    (google.metadata.metadata as any).participantNamesByResource={'conference/participants/1':'Robin'};
    expect(decode(google).spans[0]).toMatchObject({speaker:'Robin',startSecs:42});
  });
  test('enumerates Google Docs paragraphs, tables, tabs and footnotes with original paths', () => {
    const paragraph=(content:string)=>({paragraph:{elements:[{textRun:{content}}]}});
    const raw=JSON.stringify({body:{content:[paragraph('Body'),{table:{tableRows:[{tableCells:[{content:[paragraph('Cell')]}]}]}}]},tabs:[{documentTab:{body:{content:[paragraph('Tab')]}}}],footnotes:{f1:{content:[paragraph('Footnote')]}}});
    const input=snapshot(raw,'google-docs','notes');
    const result=decode(input,'notes');expect(result.state).toBe('complete');
    expect(result.spans.map((s:any)=>s.text)).toEqual(['Body','Cell','Tab','Footnote']);
    expect(result.spans[1].path).toBe('$.body.content[1].table.tableRows[0].tableCells[0].content[0].paragraph.elements[0].textRun.content');
    expect(result.coverage).toMatchObject({decodedRecords:4,totalRecords:4,suppliedRecords:4});
    const unsupported=decode(snapshot(JSON.stringify({body:{content:[paragraph('Retained'),{unknownRichObject:{}}]}}),'google-docs','notes'),'notes');
    expect(unsupported.state).toBe('partial');expect(unsupported.omissions.some((o:any)=>o.code==='unsupported_docs_structure')).toBe(true);
  });
  test('shared publication/evidence types match byte for byte', () => {
    const local = readFileSync(new URL('./meeting-contract.ts', import.meta.url),'utf8');
    const corePath = new URL('../../../../tinychat/packages/core/src/meeting-contract.ts', import.meta.url);
    // Standalone companion CI pins the shared contract; paired workspaces also compare sources.
    expect(sha(local)).toBe('288a193d93e42667949c4024affdef826e659297c4cf610e666f8fba862653ad');
    if (existsSync(corePath)) expect(local).toBe(readFileSync(corePath,'utf8'));
  });
});
