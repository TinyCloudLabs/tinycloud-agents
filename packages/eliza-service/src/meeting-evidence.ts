import { createHash } from "node:crypto";
import { MEETING_ENVELOPE_BYTE_LIMIT, MEETING_ORIGINAL_BODY_BYTE_LIMIT } from "./meeting-contract.js";
import type { EvidenceBasis, EvidenceEnvelope, PublishedMeetingSnapshot, SourceReference } from "./meeting-contract.js";
export interface RetrievalContext { deadlineAt?: number; signal?: AbortSignal }
export interface BodyResult { state: "missing" | "access_denied" | "timeout" | "cancelled" | "size_limit" | "unavailable"; reasonCode?: string }
export class MeetingRetrievalError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); this.name = "MeetingRetrievalError"; }
}
export function checkContext(context: RetrievalContext = {}): void {
  if (context.signal?.aborted) throw new MeetingRetrievalError("retrieval_cancelled", 499);
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) throw new MeetingRetrievalError("retrieval_timeout", 504);
}
/** Supplement SDK signals with deadline checks, late-reply discard, and listener cleanup. */
export async function withinContext<T>(operation: (signal?: AbortSignal) => Promise<T>, context: RetrievalContext = {}): Promise<T> {
  checkContext(context);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(new MeetingRetrievalError("retrieval_cancelled", 499)); };
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.deadlineAt !== undefined) timer = setTimeout(() => { controller.abort(); reject(new MeetingRetrievalError("retrieval_timeout", 504)); }, Math.max(0, context.deadlineAt - Date.now()));
  });
  try { const result = await Promise.race([operation(controller.signal), stop]); checkContext(context); return result; }
  finally { if (timer) clearTimeout(timer); if (onAbort) context.signal?.removeEventListener("abort", onAbort); }
}
export function isAccessError(error: unknown): boolean {
  const e = error as { name?: string; code?: string } | null;
  return e?.name === "NoDelegationError" || e?.name === "DelegationExpiredError" || ["delegation_required", "delegation_expired", "delegation_revoked", "access_denied"].includes(e?.code ?? "");
}

export function safeMeetingRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value) && !value.includes("..");
}
export function validRevision(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
export function emptyEvidence(reference: SourceReference, basis: EvidenceBasis, state: EvidenceEnvelope["state"], code: string): EvidenceEnvelope {
  return { contractVersion: 3, kind: "evidence", reference, basis, metadata: null, state, original: null,
    coverage: { fetched: false, decodedRecords: 0, totalRecords: null, suppliedRecords: 0, processedRecords: null },
    spans: [], omissions: [{ code }], overviewProvenance: null };
}
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
function validSnapshot(snapshot: PublishedMeetingSnapshot): boolean {
  const metadata = snapshot.metadata;
  if (!isRecord(metadata) || !nullableString(metadata.title) || !nullableString(metadata.startedAt) || !nullableString(metadata.organizerEmail)
    || !isRecord(metadata.metadata) || !Array.isArray(metadata.participants) || metadata.participants.some(item => !isRecord(item)
      || (item.name !== undefined && typeof item.name !== "string") || (item.email !== undefined && typeof item.email !== "string"))) return false;
  if (snapshot.overview !== null) {
    const overview = snapshot.overview;
    if (!isRecord(overview) || typeof overview.text !== "string" || !isRecord(overview.provenance)) return false;
    const p = overview.provenance;
    if (!nullableString(p.provider) || !nullableString(p.generatedAt) || !nullableString(p.sourceDigest) || !["known", "unknown"].includes(p.freshness as string)) return false;
  }
  if (snapshot.body !== null) {
    const body = snapshot.body;
    if (!isRecord(body) || !isRecord(body.original) || !Array.isArray(body.omissions)) return false;
    const o = body.original;
    if (!validRevision(o.digest) || !Number.isSafeInteger(o.byteLength) || Number(o.byteLength) < 0
      || (o.recordCount !== null && (!Number.isSafeInteger(o.recordCount) || Number(o.recordCount) < 0))
      || !["known", "unknown"].includes(o.extent as string) || ![null, true, false].includes(o.captureComplete as null | boolean)
      || body.omissions.some(item => !isRecord(item) || typeof item.code !== "string")) return false;
  }
  return true;
}
/** Enumerate every supported Google Docs text run; original JSON paths survive normalization. */
function docsRecords(document: unknown, omissions: EvidenceEnvelope["omissions"]): unknown[] {
  const records: unknown[]=[];
  const unsupported=(path:string)=>{omissions.push({code:"unsupported_docs_structure",recordIndex:records.length,detail:path});records.push(null);};
  const content=(items:unknown,path:string,depth=0)=>{
    if(!Array.isArray(items)||depth>64){unsupported(path);return;}
    items.forEach((item,index)=>{
      const at=`${path}[${index}]`;if(!isRecord(item)){unsupported(at);return;}
      if(isRecord(item.paragraph)&&Array.isArray(item.paragraph.elements)){
        item.paragraph.elements.forEach((element:unknown,i:number)=>{
          const runPath=`${at}.paragraph.elements[${i}]`;
          if(isRecord(element)&&isRecord(element.textRun)&&typeof element.textRun.content==="string")records.push({text:element.textRun.content,path:`${runPath}.textRun.content`});
          else if(!isRecord(element)||!['pageBreak','columnBreak','horizontalRule','footnoteReference'].some(key=>key in element))unsupported(runPath);
        });
      } else if(isRecord(item.table)&&Array.isArray(item.table.tableRows)){
        item.table.tableRows.forEach((row:unknown,r:number)=>{
          const rowPath=`${at}.table.tableRows[${r}]`;
          if(!isRecord(row)||!Array.isArray(row.tableCells)){unsupported(rowPath);return;}
          row.tableCells.forEach((cell:unknown,c:number)=>content(isRecord(cell)?cell.content:undefined,`${rowPath}.tableCells[${c}].content`,depth+1));
        });
      } else if(isRecord(item.tableOfContents))content(item.tableOfContents.content,`${at}.tableOfContents.content`,depth+1);
      else if(!('sectionBreak' in item))unsupported(at);
    });
  };
  const visit=(value:unknown,path:string,depth=0)=>{
    if(!isRecord(value)||depth>64){unsupported(path);return;}
    let recognized=false;
    if(isRecord(value.body)){recognized=true;content(value.body.content,`${path}.body.content`,depth+1);}
    if(Array.isArray(value.tabs)){recognized=true;value.tabs.forEach((tab:unknown,i:number)=>visit(tab,`${path}.tabs[${i}]`,depth+1));}
    if(isRecord(value.documentTab)){recognized=true;visit(value.documentTab,`${path}.documentTab`,depth+1);}
    if(Array.isArray(value.childTabs)){recognized=true;value.childTabs.forEach((tab:unknown,i:number)=>visit(tab,`${path}.childTabs[${i}]`,depth+1));}
    for(const field of ['headers','footers','footnotes'])if(isRecord(value[field])){
      recognized=true;for(const [key,section]of Object.entries(value[field] as Record<string,unknown>))content(isRecord(section)?section.content:undefined,`${path}.${field}[${JSON.stringify(key)}].content`,depth+1);
    }
    if(!recognized)unsupported(path);
  };
  visit(document,'$');return records;
}
/** Decode all admitted artifact records. No text sampling or evidence fitting. */
export function decodeSnapshotEvidence(snapshot: PublishedMeetingSnapshot, reference: SourceReference, basis: EvidenceBasis): EvidenceEnvelope {
  const result = emptyEvidence(reference, basis, "unavailable", "unsupported_snapshot");
  const fail = (state: EvidenceEnvelope["state"], code: string) => {
    result.state = state; result.spans = []; result.coverage.suppliedRecords = 0;
    result.omissions.push({ code }); return result;
  };
  if (!snapshot || snapshot.contractVersion !== 3 || snapshot.source !== reference.source || snapshot.sourceId !== reference.sourceId || snapshot.meetingRef !== reference.meetingRef) return result;
  if (!validSnapshot(snapshot)) return result;
  result.omissions = []; result.coverage.fetched = true; result.metadata = snapshot.metadata ?? null;
  if (basis === "overview") {
    if (!snapshot.overview || typeof snapshot.overview.text !== "string" || !snapshot.overview.text.trim()) return fail("missing", "overview_missing");
    result.overviewProvenance = snapshot.overview.provenance;
    result.spans = [{ text: snapshot.overview.text, recordIndex: 0, start: 0, end: snapshot.overview.text.length }];
    result.coverage.totalRecords = result.coverage.decodedRecords = result.coverage.suppliedRecords = 1;
  } else {
    const body = snapshot.body;
    if (!body) return fail("missing", "body_missing");
    if (body.basis !== basis) return fail("unavailable", "basis_mismatch");
    if (typeof body.raw !== "string" || body.encoding !== "utf-8" || !body.original || !Array.isArray(body.omissions)) return fail("unavailable", "unsupported_body");
    result.original = body.original; result.omissions = [...body.omissions];
    if (Buffer.from(body.raw, "utf8").toString("utf8") !== body.raw) return fail("unavailable", "invalid_utf8");
    const bytes = Buffer.byteLength(body.raw, "utf8");
    if (sha256(body.raw) !== body.original.digest) return fail("unavailable", "original_digest_mismatch");
    if (bytes !== body.original.byteLength) return fail("unavailable", "original_extent_mismatch");
    if (bytes > MEETING_ORIGINAL_BODY_BYTE_LIMIT) return fail("capacity", "original_body_byte_limit");
    let records: unknown[];
    if (body.schema === "text") records = [{ text: body.raw }];
    else if (body.schema === "json-records" || body.schema === "google-docs") {
      let decoded: unknown;
      try { decoded = JSON.parse(body.raw); } catch { return fail("unavailable", "invalid_json"); }
      if(body.schema === "google-docs")records=docsRecords(decoded,result.omissions);
      else { if (!Array.isArray(decoded)) return fail("unavailable", "unsupported_body"); records = decoded; }
    } else return fail("unavailable", "unsupported_body_schema");
    result.coverage.totalRecords = records.length;
    if (body.original.recordCount !== null && body.original.recordCount !== records.length) result.omissions.push({ code: "original_record_count_mismatch" });
    for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
      const record = records[recordIndex];
      if (!record || typeof record !== "object" || typeof (record as {text?:unknown}).text !== "string") {
        result.omissions.push({ code: "unsupported_record", recordIndex }); continue;
      }
      const item = record as Record<string, unknown>; const text = item.text as string;
      const names=snapshot.metadata.metadata.participantNamesByResource;
      const joinedSpeaker=typeof item.participant === "string" && isRecord(names) ? names[item.participant] : undefined;
      const speaker = [item.speaker_name, item.speaker, item.speakerName, joinedSpeaker].find(value => typeof value === "string" && value.trim());
      const elapsed=typeof item.startTime === "string" && snapshot.metadata.startedAt ? (Date.parse(item.startTime)-Date.parse(snapshot.metadata.startedAt))/1000 : undefined;
      const startSecs = [item.start_time, item.startTime, item.start, elapsed].find(value => typeof value === "number" && Number.isFinite(value) && value >= 0);
      result.spans.push({ text, recordIndex, start: 0, end: text.length,
        ...(body.schema === "google-docs" && typeof item.path === "string" ? {path:item.path} : {}),
        ...(typeof speaker === "string" ? { speaker } : {}), ...(typeof startSecs === "number" ? { startSecs } : {}) });
      result.coverage.decodedRecords++;
    }
    result.coverage.suppliedRecords = result.spans.length;
    if (!result.spans.some(span => span.text.trim())) return fail("missing", "empty_body");
  }
  result.state = result.omissions.length ? "partial" : "complete";
  // Include the actual tool response wrapper in admission. JSON escaping counts.
  const framed = { ok: true, tool: "TINYCLOUD_READ_MEETING", result: { text: "", data: result, frames: [] } };
  if (Buffer.byteLength(JSON.stringify(framed), "utf8") > MEETING_ENVELOPE_BYTE_LIMIT) {
    result.metadata = null; return fail("capacity", "evidence_envelope_byte_limit");
  }
  return result;
}
