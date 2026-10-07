import type { PayloadAction } from '@reduxjs/toolkit';
import { createSelector, createSlice } from '@reduxjs/toolkit';
import { MessagePriority, OfflineProtocol } from '@offline-protocol/mesh-sdk';
import WorkOrder from '../models/workOrder';
import { Task } from '../models/tasks';
import { revertAll } from '../utils/redux';
import type { AppThunk, RootState } from '../store';
import {
  buildOp,
  CrewMember,
  DropReason,
  Envelope,
  MergedView,
  mergedView,
  MESH_TYPE,
  NearbyPeer,
  nearbyCrew as nearbyCrewOf,
  OpArgs,
  OpBody,
  OpType,
  SyncResult,
  effectiveResult
} from '../utils/offlineOps';
import { signEnvelope } from '../utils/offlineCrypto';
import api from '../utils/api';
import { getWorkOrderDetails } from './workOrder';
import { getTasks } from './task';
import { getCommentsByWorkOrder } from './comment';

export type { CrewMember };
export { effectiveResult };

// Work-order snapshot captured while online; offline ops apply on top of it.
export interface OfflinePack {
  workOrder: WorkOrder;
  tasks: Task[];
  crew: CrewMember[];
  fetchedAt: number;
}

export interface StoredOp {
  envelope: Envelope;
  body: OpBody;
  origin: 'local' | 'peer';
  receivedFrom?: string;
  sync?: { result: SyncResult; detail: string | null };
}

export type DeliveryState = 'sent' | 'retrying' | 'delivered' | 'failed';

// One SDK message carrying ops to one crew member
export interface Outbound {
  opIds: string[];
  recipient: string;
  state: DeliveryState;
  retryCount: number;
  updatedAt: number;
}

interface OfflineState {
  backendReachable: boolean;
  lastSyncAt: number | null;
  packs: { [workOrderId: number]: OfflinePack };
  myAddress: string | null;
  myPublicKey: string | null; // base64 of the 32-byte Ed25519 identity key
  registeredAddress: string | null;
  nearby: { [address: string]: NearbyPeer };
  myUserId: number | null;
  myCompanyId: number | null;
  lamport: number;
  ops: { [opId: string]: StoredOp };
  outbound: { [messageId: string]: Outbound };
  drops: { [reason in DropReason]?: number };
}

const initialState: OfflineState = {
  backendReachable: true,
  lastSyncAt: null,
  packs: {},
  myAddress: null,
  myPublicKey: null,
  registeredAddress: null,
  nearby: {},
  myUserId: null,
  myCompanyId: null,
  lamport: 0,
  ops: {},
  outbound: {},
  drops: {}
};

const slice = createSlice({
  name: 'offline',
  initialState,
  extraReducers: (builder) => builder.addCase(revertAll, () => initialState),
  reducers: {
    setBackendReachable(state: OfflineState, action: PayloadAction<boolean>) {
      state.backendReachable = action.payload;
    },
    savePack: {
      reducer(state: OfflineState, action: PayloadAction<OfflinePack>) {
        state.packs[action.payload.workOrder.id] = action.payload;
      },
      prepare(workOrder: WorkOrder, tasks: Task[], crew: CrewMember[]) {
        return {
          payload: { workOrder, tasks, crew, fetchedAt: Date.now() }
        };
      }
    },
    setIdentity(
      state: OfflineState,
      action: PayloadAction<{
        address: string;
        publicKey: string;
        userId: number;
        companyId: number;
      }>
    ) {
      state.myAddress = action.payload.address;
      state.myPublicKey = action.payload.publicKey;
      state.myUserId = action.payload.userId;
      state.myCompanyId = action.payload.companyId;
    },
    setRegisteredAddress(state: OfflineState, action: PayloadAction<string>) {
      state.registeredAddress = action.payload;
    },
    peerSeen(
      state: OfflineState,
      action: PayloadAction<{
        address: string;
        transport?: string;
        rssi?: number;
      }>
    ) {
      const { address, transport, rssi } = action.payload;
      const prev = state.nearby[address];
      state.nearby[address] = {
        lastSeen: Date.now(),
        transport: transport ?? prev?.transport,
        rssi: rssi ?? prev?.rssi
      };
    },
    peerLost(state: OfflineState, action: PayloadAction<string>) {
      delete state.nearby[action.payload];
    },
    addLocalOp(
      state: OfflineState,
      action: PayloadAction<{ envelope: Envelope; body: OpBody }>
    ) {
      const { envelope, body } = action.payload;
      state.ops[body.opId] = { envelope, body, origin: 'local' };
      state.lamport = body.lamport;
    },
    // Verified ops from a crew member; the same opId twice is kept once.
    receiveOps(
      state: OfflineState,
      action: PayloadAction<{
        from: string;
        ops: { envelope: Envelope; body: OpBody }[];
      }>
    ) {
      for (const { envelope, body } of action.payload.ops) {
        if (!state.ops[body.opId])
          state.ops[body.opId] = {
            envelope,
            body,
            origin: 'peer',
            receivedFrom: action.payload.from
          };
        state.lamport = Math.max(state.lamport, body.lamport);
      }
    },
    setOutbound(
      state: OfflineState,
      action: PayloadAction<{
        messageId: string;
        opIds: string[];
        recipient: string;
        state?: DeliveryState;
      }>
    ) {
      const { messageId, opIds, recipient } = action.payload;
      state.outbound[messageId] = {
        opIds,
        recipient,
        state: action.payload.state ?? 'sent',
        retryCount: 0,
        updatedAt: Date.now()
      };
    },
    // Driven by SDK delivery events. Ids we never sent (SDK-internal traffic) are ignored; delivered is final.
    markDelivery(
      state: OfflineState,
      action: PayloadAction<{
        messageId: string;
        state: DeliveryState;
        retryCount?: number;
      }>
    ) {
      const entry = state.outbound[action.payload.messageId];
      if (!entry || entry.state === 'delivered') return;
      entry.state = action.payload.state;
      if (action.payload.retryCount !== undefined)
        entry.retryCount = action.payload.retryCount;
      entry.updatedAt = Date.now();
    },
    markSynced(
      state: OfflineState,
      action: PayloadAction<{
        opId: string;
        result: SyncResult;
        detail: string | null;
      }>
    ) {
      const op = state.ops[action.payload.opId];
      if (op)
        op.sync = {
          result: action.payload.result,
          detail: action.payload.detail
        };
    },
    setLastSyncAt(state: OfflineState, action: PayloadAction<number>) {
      state.lastSyncAt = action.payload;
    },
    // Demo pre-flight: forget the op log; identity, registration and packs stay.
    resetOps(state: OfflineState) {
      state.lamport = 0;
      state.ops = {};
      state.outbound = {};
      state.drops = {};
    },
    countDrop(state: OfflineState, action: PayloadAction<DropReason>) {
      state.drops[action.payload] = (state.drops[action.payload] ?? 0) + 1;
    }
  }
});

export const reducer = slice.reducer;

export const {
  setBackendReachable,
  savePack,
  setIdentity,
  setRegisteredAddress,
  peerSeen,
  peerLost,
  addLocalOp,
  receiveOps,
  setOutbound,
  markDelivery,
  markSynced,
  setLastSyncAt,
  resetOps,
  countDrop
} = slice.actions;

// Crew members (excluding this device) seen within the last 30 s. Pass `now` from a timer to re-render.
export const nearbyCrew = (
  state: RootState,
  workOrderId: number,
  now: number = Date.now()
): CrewMember[] =>
  nearbyCrewOf(
    state.offline.packs[workOrderId]?.crew ?? [],
    state.offline.nearby,
    state.offline.myAddress,
    now
  );

// Allowlist for the inbound pipeline: only crew addresses of this work order may send it ops.
export const isCrewAddress = (
  state: RootState,
  workOrderId: number,
  address: string
): boolean =>
  !!state.offline.packs[workOrderId]?.crew.some((m) => m.address === address);

const opsForWorkOrder = (
  ops: { [opId: string]: StoredOp },
  workOrderId: number
): StoredOp[] =>
  Object.values(ops).filter((op) => op.body.workOrderId === workOrderId);

// Memoized per work order: the pack with this device's ops applied.
const mergedViewSelectors = new Map<
  number,
  (state: RootState) => MergedView | null
>();
export const selectMergedView = (workOrderId: number) => {
  let selector = mergedViewSelectors.get(workOrderId);
  if (!selector) {
    selector = createSelector(
      [
        (state: RootState) => state.offline.packs[workOrderId],
        (state: RootState) => state.offline.ops
      ],
      (pack, ops) =>
        pack ? mergedView(pack, opsForWorkOrder(ops, workOrderId)) : null
    );
    mergedViewSelectors.set(workOrderId, selector);
  }
  return selector;
};

const meshMessage = (envelopes: Envelope[]) =>
  JSON.stringify({ t: MESH_TYPE, ops: envelopes });

// Sends envelopes to one crew member and records the outbound entry. A send that throws is recorded as failed
// under a local id, so the UI can offer Resend.
const sendTo =
  (
    protocol: OfflineProtocol,
    recipient: string,
    envelopes: Envelope[]
  ): AppThunk =>
  async (dispatch) => {
    const opIds = envelopes.map((e) => JSON.parse(e.body).opId);
    try {
      const messageId = await protocol.sendMessage({
        recipient,
        content: meshMessage(envelopes),
        priority: MessagePriority.High
      });
      dispatch(setOutbound({ messageId, opIds, recipient }));
    } catch {
      dispatch(
        setOutbound({
          messageId: `unsent:${opIds.join(',')}:${recipient}`,
          opIds,
          recipient,
          state: 'failed'
        })
      );
    }
  };

// Builds, signs and stores an op, then sends it to every other crew member.
export const createOp =
  <T extends OpType>(
    protocol: OfflineProtocol,
    workOrderId: number,
    type: T,
    args: OpArgs[T]
  ): AppThunk =>
  async (dispatch, getState) => {
    const state = getState().offline;
    const pack = state.packs[workOrderId];
    if (!pack || !state.myAddress || !state.myUserId || !state.myCompanyId)
      throw new Error('offline_not_ready');
    const body = buildOp(type, args, {
      companyId: state.myCompanyId,
      workOrderId,
      userId: state.myUserId,
      address: state.myAddress,
      lamport: state.lamport + 1,
      view: selectMergedView(workOrderId)(getState())
    });
    const envelope = await signEnvelope(protocol, body);
    dispatch(addLocalOp({ envelope, body }));
    const recipients = new Set(
      pack.crew.map((m) => m.address).filter((a) => a !== state.myAddress)
    );
    await Promise.all(
      [...recipients].map((r) => dispatch(sendTo(protocol, r, [envelope])))
    );
    return body;
  };

// Sends the same envelope again (same opId; the SDK assigns a new message id and the receiver dedups by opId).
export const resendOp =
  (protocol: OfflineProtocol, opId: string, recipient: string): AppThunk =>
  async (dispatch, getState) => {
    const op = getState().offline.ops[opId];
    if (op) await dispatch(sendTo(protocol, recipient, [op.envelope]));
  };

// After a restart: a local op whose send was never recorded (app killed between sendMessage and persisting
// the outbound entry) is sent again, so its delivery can be tracked. Receivers dedup by opId.
export const resendUntracked =
  (protocol: OfflineProtocol): AppThunk =>
  async (dispatch, getState) => {
    const { ops, outbound, packs, myAddress } = getState().offline;
    const tracked = new Set(
      Object.values(outbound).flatMap((o) =>
        o.opIds.map((id) => `${id}|${o.recipient}`)
      )
    );
    const sends = Object.values(ops)
      .filter((op) => op.origin === 'local' && !op.sync)
      .flatMap((op) =>
        (packs[op.body.workOrderId]?.crew ?? [])
          .filter(
            (m) =>
              m.address !== myAddress &&
              !tracked.has(`${op.body.opId}|${m.address}`)
          )
          .map((m) => dispatch(sendTo(protocol, m.address, [op.envelope])))
      );
    await Promise.all(sends);
    return sends.length;
  };

// ─── Sync ─────────────────────────────────────────────────

interface OpResult {
  opId: string | null;
  result: SyncResult;
  detail: string | null;
}

export interface SyncSummary {
  synced: number;
  already: number;
  conflicts: number;
  rejected: number;
}

// Refetches the work order, tasks, crew and comments, and replaces the pack: synced ops leave the overlay.
const refreshPack =
  (workOrderId: number): AppThunk =>
  async (dispatch) => {
    const [workOrder, tasks, crew] = await Promise.all([
      dispatch(getWorkOrderDetails(workOrderId)),
      dispatch(getTasks(workOrderId)),
      api.get<CrewMember[]>(`offline/work-orders/${workOrderId}/crew`)
    ]);
    if (workOrder && tasks) dispatch(savePack(workOrder, tasks, crew));
    dispatch(getCommentsByWorkOrder(workOrderId));
  };

let syncing: Promise<SyncSummary> | null = null;

// Uploads every op without a result (mine and peers'), records the results, then refreshes the touched packs.
// Single-flight: a second call while one runs gets the same promise.
export const syncOffline = (): AppThunk => (dispatch, getState) => {
  const run = async (): Promise<SyncSummary> => {
    const pending = Object.values(getState().offline.ops).filter(
      (op) => !op.sync
    );
    const summary: SyncSummary = {
      synced: 0,
      already: 0,
      conflicts: 0,
      rejected: 0
    };
    for (let i = 0; i < pending.length; i += 200) {
      const chunk = pending.slice(i, i + 200);
      const { results } = await api.post<{ results: OpResult[] }>(
        'offline/ops',
        { ops: chunk.map((op) => op.envelope) },
        {},
        true
      );
      results.forEach((r, k) => {
        dispatch(
          markSynced({
            opId: chunk[k].body.opId,
            result: r.result,
            detail: r.detail
          })
        );
        const outcome = effectiveResult(r);
        if (outcome === 'CONFLICT') summary.conflicts++;
        else if (outcome === 'REJECTED') summary.rejected++;
        else if (r.result === 'DUPLICATE') summary.already++;
        else summary.synced++;
      });
    }
    const touched = new Set(pending.map((op) => op.body.workOrderId));
    await Promise.all([...touched].map((id) => dispatch(refreshPack(id))));
    dispatch(setLastSyncAt(Date.now()));
    return summary;
  };
  if (!syncing) syncing = run().finally(() => (syncing = null));
  return syncing;
};

export default slice;
