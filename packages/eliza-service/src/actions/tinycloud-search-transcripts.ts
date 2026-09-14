import type { Action, IAgentRuntime, Memory, Plugin, ProviderDataRecord } from '@elizaos/core';
import { ToolError } from '../handlers/tools.js';
import { checkContext, safeMeetingRef, validRevision } from '../meeting-evidence.js';
import type { RetrievalContext } from '../meeting-evidence.js';
import type { CatalogMeeting, CatalogPageEnvelope, CatalogPageRequest, EvidenceEnvelope, ExactReadRequest, MeetingSource } from '../meeting-contract.js';
export const TINYCLOUD_FIND_MEETINGS = 'tinycloud_find_meetings';
export const TINYCLOUD_READ_MEETING = 'tinycloud_read_meeting';
export const TINYCLOUD_SEARCH_TRANSCRIPTS = 'tinycloud_search_transcripts';
export const TINYCLOUD_LIST_MEETING_ACTIONS = 'tinycloud_list_meeting_actions';
export const TINYCLOUD_CONNECTORS_SQL_PATH = 'xyz.tinycloud.tinychat/connectors';
export const TINYCLOUD_CONNECTORS_KV_PREFIX = `${TINYCLOUD_CONNECTORS_SQL_PATH}/`;
export type TranscriptSource = MeetingSource;
export interface TranscriptReader {
  pageMetadata(args: CatalogPageRequest, context?: RetrievalContext): Promise<CatalogPageEnvelope>;
  getMetadata(meetingRef: string, context?: RetrievalContext): Promise<CatalogMeeting | null>;
  readEvidence(args: ExactReadRequest, context?: RetrievalContext): Promise<EvidenceEnvelope>;
  assertAccess?(): void;
}
export interface TranscriptRegistry { readerFor(entityId: string, roomId?: string): TranscriptReader }
const registries = new WeakMap<object, TranscriptRegistry>();
export function setTranscriptRegistry(runtime: object, registry: TranscriptRegistry | null): void {
  if (registry) registries.set(runtime, registry); else registries.delete(runtime);
}
export function transcriptRegistryFor(runtime: object | null | undefined): TranscriptRegistry | null { return runtime ? registries.get(runtime) ?? null : null; }
export function isSource(value: unknown): value is MeetingSource { return value === 'fireflies' || value === 'google-meet' || value === 'tinycloud-transcriber'; }
export function safeSourceId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.includes('..') && !/[\\/]/.test(value); }
const record = (value: unknown): value is Record<string,unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function parseFindMeetingsArgs(args: Record<string,unknown>): CatalogPageRequest | null {
  if (args.contractVersion !== 3 || Object.keys(args).some(key => !['contractVersion','after','filters','limit'].includes(key))) return null;
  if (args.after !== undefined && !safeMeetingRef(args.after)) return null;
  if (args.limit !== undefined && args.limit !== 100) return null;
  if (args.filters !== undefined) {
    if (!record(args.filters) || Object.keys(args.filters).some(key => !['source'].includes(key))) return null;
    if (args.filters.source !== undefined && !isSource(args.filters.source)) return null;
  }
  return args as unknown as CatalogPageRequest;
}
export function parseReadMeetingArgs(args: Record<string,unknown>): ExactReadRequest | null {
  if (args.contractVersion !== 3 || Object.keys(args).some(key => !['contractVersion','reference','basis'].includes(key))) return null;
  if (!record(args.reference) || Object.keys(args.reference).some(key => !['meetingRef','source','sourceId','revision'].includes(key))) return null;
  const ref = args.reference;
  if (!safeMeetingRef(ref.meetingRef) || !isSource(ref.source) || !safeSourceId(ref.sourceId) || !validRevision(ref.revision)) return null;
  if (!['transcript','notes','overview'].includes(args.basis as string)) return null;
  return args as unknown as ExactReadRequest;
}
function toolReader(runtime: IAgentRuntime, message: Memory): TranscriptReader {
  const registry = transcriptRegistryFor(runtime);
  if (!registry) throw new ToolError('transcript delegation required',409,'delegation_required');
  try { return registry.readerFor(message.entityId,message.roomId); }
  catch(error) {
    const name=(error as {name?:string}).name;
    if(name==="DelegationExpiredError")throw new ToolError("transcript delegation expired",409,"delegation_expired");
    if(name==="NoDelegationError")throw new ToolError("transcript delegation required",409,"delegation_required");
    throw error;
  }
}
export async function findMeetings(reader: TranscriptReader, args: CatalogPageRequest, context: RetrievalContext = {}) { return {text:'',data:await reader.pageMetadata(args,context)}; }
export async function readMeeting(reader: TranscriptReader, args: ExactReadRequest, context: RetrievalContext = {}) { return {text:'',data:await reader.readEvidence(args,context)}; }
function action(operation: 'find'|'read', name: string): Action {
  return {name,description:'Authorized version 3 metadata pages or exact immutable evidence reads.',similes:[],examples:[],
    validate:async()=>true,
    handler:async(runtime,message,_state,options)=>{
      const input=options as {args?:Record<string,unknown>;context?:RetrievalContext}|undefined;
      if(input?.args?.contractVersion!==3)throw new ToolError('upgrade required',426,'upgrade_required');
      const args=operation==='find'?parseFindMeetingsArgs(input.args):parseReadMeetingArgs(input.args);
      if(!args)throw new ToolError('invalid meeting arguments',400,'invalid_args');
      const context=input?.context??{};checkContext(context);const reader=toolReader(runtime,message);
      const result=operation==='find'?await findMeetings(reader,args as CatalogPageRequest,context):await readMeeting(reader,args as ExactReadRequest,context);
      checkContext(context);reader.assertAccess?.();
      return {success:true,text:'',data:result.data as unknown as ProviderDataRecord};
    },
  };
}
const retired = (name:string):Action => ({name,description:'Retired aggregate tool; use version 3 metadata pages and exact reads.',similes:[],examples:[],validate:async()=>true,handler:async()=>{throw new ToolError('upgrade required',426,'upgrade_required');}});
export const tinycloudFindMeetingsAction=action('find','TINYCLOUD_FIND_MEETINGS');
export const tinycloudReadMeetingAction=action('read','TINYCLOUD_READ_MEETING');
export const tinycloudSearchTranscriptsAction=retired('TINYCLOUD_SEARCH_TRANSCRIPTS');
export const tinycloudListMeetingActionsAction=retired('TINYCLOUD_LIST_MEETING_ACTIONS');
export const tinycloudSearchTranscriptsPlugin:Plugin={name:'tinycloud-meeting-tools',description:'Delegated exact meeting evidence and metadata pages.',actions:[tinycloudFindMeetingsAction,tinycloudReadMeetingAction,tinycloudSearchTranscriptsAction,tinycloudListMeetingActionsAction]};
