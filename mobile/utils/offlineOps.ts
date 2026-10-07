// Pure offline logic shared by the slice and screens. No SDK, Redux or React imports.
import randomId from './randomId';

// One registered device of a user who may edit the work order.
export interface CrewMember {
  userId: number;
  firstName: string;
  lastName: string;
  address: string;
  publicKey: string;
}

export interface NearbyPeer {
  lastSeen: number;
  transport?: string;
  rssi?: number;
}

export const NEARBY_WINDOW_MS = 30_000;

export const isNearby = (peer: NearbyPeer | undefined, now: number): boolean =>
  !!peer && now - peer.lastSeen <= NEARBY_WINDOW_MS;

// Crew members other than this device that were seen within the window.
export const nearbyCrew = (
  crew: CrewMember[],
  nearby: { [address: string]: NearbyPeer },
  myAddress: string | null,
  now: number
): CrewMember[] =>
  crew.filter(
    (m) => m.address !== myAddress && isNearby(nearby[m.address], now)
  );

// ─── Ops ───────────────────────────────────

export type WOStatus = 'OPEN' | 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETE';
export type OpType =
  | 'NOTE'
  | 'STATUS'
  | 'TASK_UPDATE'
  | 'HANDOFF_REQUEST'
  | 'HANDOFF_ACCEPT';
const OP_TYPES: OpType[] = [
  'NOTE',
  'STATUS',
  'TASK_UPDATE',
  'HANDOFF_REQUEST',
  'HANDOFF_ACCEPT'
];

export type NotePayload = { text: string };
export type StatusPayload = { base: WOStatus; to: WOStatus };
export type TaskUpdatePayload = {
  taskId: number;
  field: 'value' | 'notes';
  base: string | null;
  to: string | null;
};
export type HandoffRequestPayload = { note?: string };
export type HandoffAcceptPayload = {
  requestOpId: string;
  basePrimaryUserId: number | null;
};

interface Payloads {
  NOTE: NotePayload;
  STATUS: StatusPayload;
  TASK_UPDATE: TaskUpdatePayload;
  HANDOFF_REQUEST: HandoffRequestPayload;
  HANDOFF_ACCEPT: HandoffAcceptPayload;
}

export interface OpBody<T extends OpType = OpType> {
  v: 1;
  opId: string;
  companyId: number;
  workOrderId: number;
  type: T;
  authorUserId: number;
  authorAddress: string;
  lamport: number;
  occurredAt: number;
  payload: Payloads[T];
}

export interface Envelope {
  body: string; // JSON.stringify(OpBody), signed exactly as transmitted
  sig: string; // base64 Ed25519 signature
}

export const MESH_TYPE = 'atlas.ops.v1';
export interface MeshMessage {
  t: typeof MESH_TYPE;
  ops: Envelope[];
}

export type SyncResult = 'APPLIED' | 'DUPLICATE' | 'CONFLICT' | 'REJECTED';

// The outcome that counts: a DUPLICATE carries the first upload's result in its detail, e.g. "CONFLICT: COMPLETE".
export const effectiveResult = (sync: {
  result: SyncResult;
  detail?: string | null;
}): SyncResult =>
  sync.result === 'DUPLICATE'
    ? (sync.detail?.split(':')[0] as SyncResult) || 'APPLIED'
    : sync.result;

// ─── Merged view ──────────────────────────

// The parts of an offline pack the merge reads.
export interface PackSnapshot {
  workOrder: { status: string; primaryUser?: { id: number } | null };
  tasks: {
    id: number;
    value?: string | number | null;
    notes?: string | null;
  }[];
}

export interface TaskState {
  value: string | null;
  notes: string | null;
}

export interface MergeOp {
  body: OpBody;
  sync?: { result: SyncResult; detail?: string | null };
}

export interface TimelineEntry {
  body: OpBody;
  result: SyncResult | 'APPLIED' | 'CONFLICT';
  synced: boolean;
}

export interface MergedView {
  status: WOStatus;
  primaryUserId: number | null;
  tasks: Record<number, TaskState>;
  timeline: TimelineEntry[];
  handoff: { openRequest?: OpBody; acceptedBy?: number; acceptedAt?: number };
  results: Record<string, 'APPLIED' | 'CONFLICT'>;
  // For each losing op, the op that set the field first (null when the value came from the pack)
  conflictsWith: Record<string, OpBody | null>;
}

// The field a compare-and-set op writes, or null for ops that never conflict.
const fieldOf = (body: OpBody): string | null => {
  if (body.type === 'STATUS') return 'status';
  if (body.type === 'HANDOFF_ACCEPT') return 'primary';
  if (body.type === 'TASK_UPDATE') {
    const p = body.payload as TaskUpdatePayload;
    return `task:${p.taskId}:${p.field}`;
  }
  return null;
};

export const opOrder = (a: OpBody, b: OpBody): number =>
  a.lamport - b.lamport ||
  (a.authorAddress < b.authorAddress
    ? -1
    : a.authorAddress > b.authorAddress
    ? 1
    : 0);

const str = (v: string | number | null | undefined): string | null =>
  v === null || v === undefined ? null : String(v);

export function mergedView(pack: PackSnapshot, ops: MergeOp[]): MergedView {
  const unique = new Map<string, MergeOp>();
  ops.forEach((op) => unique.set(op.body.opId, op));
  const sorted = [...unique.values()].sort((a, b) => opOrder(a.body, b.body));

  const view: MergedView = {
    status: pack.workOrder.status as WOStatus,
    primaryUserId: pack.workOrder.primaryUser?.id ?? null,
    tasks: Object.fromEntries(
      pack.tasks.map((t) => [
        t.id,
        { value: str(t.value), notes: str(t.notes) }
      ])
    ),
    timeline: [],
    handoff: {},
    results: {},
    conflictsWith: {}
  };
  const setBy: Record<string, OpBody> = {};

  for (const op of sorted) {
    const body = op.body;
    // Synced ops are already part of the refreshed pack: timeline only. The handoff card has no server
    // counterpart, so applied handoff ops keep driving it.
    if (op.sync) {
      view.timeline.push({ body, result: op.sync.result, synced: true });
      if (effectiveResult(op.sync) === 'APPLIED') showHandoff(view, body);
      continue;
    }
    const applied = apply(view, body);
    view.results[body.opId] = applied ? 'APPLIED' : 'CONFLICT';
    const field = fieldOf(body);
    if (field && applied) setBy[field] = body;
    if (field && !applied) view.conflictsWith[body.opId] = setBy[field] ?? null;
    view.timeline.push({
      body,
      result: view.results[body.opId],
      synced: false
    });
  }
  return view;
}

// Applies one op in place, compare-and-set for field ops. Returns false on conflict.
function apply(view: MergedView, body: OpBody): boolean {
  switch (body.type) {
    case 'NOTE':
      return true;
    case 'HANDOFF_REQUEST':
      showHandoff(view, body);
      return true;
    case 'STATUS': {
      const p = body.payload as StatusPayload;
      if (view.status !== p.base) return false;
      view.status = p.to;
      return true;
    }
    case 'TASK_UPDATE': {
      const p = body.payload as TaskUpdatePayload;
      const task = view.tasks[p.taskId];
      if (!task || task[p.field] !== p.base) return false;
      task[p.field] = p.to;
      return true;
    }
    case 'HANDOFF_ACCEPT': {
      const p = body.payload as HandoffAcceptPayload;
      if (view.primaryUserId !== p.basePrimaryUserId) return false;
      view.primaryUserId = body.authorUserId;
      showHandoff(view, body);
      return true;
    }
  }
  return false;
}

function showHandoff(view: MergedView, body: OpBody) {
  if (body.type === 'HANDOFF_REQUEST') view.handoff = { openRequest: body };
  if (body.type === 'HANDOFF_ACCEPT') {
    const { requestOpId } = body.payload as HandoffAcceptPayload;
    view.handoff = {
      openRequest:
        view.handoff.openRequest?.opId === requestOpId
          ? undefined
          : view.handoff.openRequest,
      acceptedBy: body.authorUserId,
      acceptedAt: body.occurredAt
    };
  }
}

// ─── Building ops ───────────────────────────────────────────

// What the user chose; `base` comes from the merged view at the moment they act.
export interface OpArgs {
  NOTE: { text: string };
  STATUS: { to: WOStatus };
  TASK_UPDATE: { taskId: number; field: 'value' | 'notes'; to: string | null };
  HANDOFF_REQUEST: { note?: string };
  HANDOFF_ACCEPT: { requestOpId: string };
}

export interface OpContext {
  companyId: number;
  workOrderId: number;
  userId: number;
  address: string;
  lamport: number;
  view: MergedView;
  opId?: string; // tests
  now?: number; // tests
}

export function buildOp<T extends OpType>(
  type: T,
  args: OpArgs[T],
  ctx: OpContext
): OpBody<T> {
  const payload = withBase(type, args, ctx.view) as Payloads[T];
  return {
    v: 1,
    opId: ctx.opId ?? randomId(),
    companyId: ctx.companyId,
    workOrderId: ctx.workOrderId,
    type,
    authorUserId: ctx.userId,
    authorAddress: ctx.address,
    lamport: ctx.lamport,
    occurredAt: ctx.now ?? Date.now(),
    payload
  };
}

function withBase(type: OpType, args: any, view: MergedView): object {
  switch (type) {
    case 'STATUS':
      return { base: view.status, to: args.to };
    case 'TASK_UPDATE':
      return {
        taskId: args.taskId,
        field: args.field,
        base:
          view.tasks[args.taskId]?.[args.field as 'value' | 'notes'] ?? null,
        to: args.to
      };
    case 'HANDOFF_ACCEPT':
      return {
        requestOpId: args.requestOpId,
        basePrimaryUserId: view.primaryUserId
      };
    default:
      return { ...args };
  }
}

// ─── Parsing and inbound checks ─────────────────────────────

// Envelopes of an atlas.ops.v1 message, or null for anything else (unknown `t`, bad JSON).
export function parseMeshMessage(content: string): Envelope[] | null {
  let msg: any;
  try {
    msg = JSON.parse(content);
  } catch {
    return null;
  }
  if (msg?.t !== MESH_TYPE || !Array.isArray(msg.ops)) return null;
  return msg.ops.filter(
    (e: any) => typeof e?.body === 'string' && typeof e?.sig === 'string'
  );
}

export function parseOpBody(body: string): OpBody | null {
  let b: any;
  try {
    b = JSON.parse(body);
  } catch {
    return null;
  }
  const ok =
    b?.v === 1 &&
    typeof b.opId === 'string' &&
    Number.isInteger(b.companyId) &&
    Number.isInteger(b.workOrderId) &&
    OP_TYPES.includes(b.type) &&
    Number.isInteger(b.authorUserId) &&
    typeof b.authorAddress === 'string' &&
    Number.isInteger(b.lamport) &&
    typeof b.occurredAt === 'number' &&
    typeof b.payload === 'object' &&
    b.payload !== null;
  return ok ? b : null;
}

export type DropReason =
  | 'bad_envelope'
  | 'no_pack'
  | 'sender_not_crew'
  | 'author_not_crew'
  | 'bad_signature';

// Steps 2-3 of the inbound pipeline: sender and author must both be crew of the op's
// work order, and the author's address must belong to the claimed user. Returns the key to verify with.
export function checkInbound(
  body: OpBody,
  sender: string,
  crew: CrewMember[] | undefined
): { publicKey: string } | { drop: DropReason } {
  if (!crew) return { drop: 'no_pack' };
  if (!crew.some((m) => m.address === sender))
    return { drop: 'sender_not_crew' };
  const author = crew.find((m) => m.address === body.authorAddress);
  if (!author || author.userId !== body.authorUserId)
    return { drop: 'author_not_crew' };
  return { publicKey: author.publicKey };
}
