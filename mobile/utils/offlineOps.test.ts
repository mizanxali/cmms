import { generateKeyPairSync, sign, verify, createPublicKey } from 'crypto';
import {
  buildOp,
  checkInbound,
  effectiveResult,
  MergeOp,
  mergedView,
  NEARBY_WINDOW_MS,
  nearbyCrew,
  OpArgs,
  OpType,
  PackSnapshot,
  parseMeshMessage
} from './offlineOps';
import { signEnvelope, verifyEnvelope } from './offlineCrypto';

const member = (address: string, userId = 1) => ({
  userId,
  firstName: address,
  lastName: '',
  address,
  publicKey: ''
});

const ALICE = { userId: 1, address: 'off1alice' };
const BOB = { userId: 2, address: 'off1bob' };
const CAROL = { userId: 3, address: 'off1carol' };

const pack: PackSnapshot = {
  workOrder: { status: 'OPEN', primaryUser: { id: ALICE.userId } },
  tasks: [{ id: 10, value: 'OPEN', notes: null }]
};

// Builds an op the way the device does: base from the merged view of the ops the author has seen.
const op = <T extends OpType>(
  author: { userId: number; address: string },
  lamport: number,
  type: T,
  args: OpArgs[T],
  seen: MergeOp[] = []
): MergeOp => ({
  body: buildOp(type, args, {
    companyId: 1,
    workOrderId: 7,
    userId: author.userId,
    address: author.address,
    lamport,
    view: mergedView(pack, seen),
    opId: `${author.address}-${lamport}`,
    now: lamport * 1000
  })
});

test('nearbyCrew: crew seen within the window, excluding me and non-crew', () => {
  const now = 1_000_000;
  const crew = [
    member('off1me'),
    member('off1bob'),
    member('off1stale'),
    member('off1away')
  ];
  const nearby = {
    off1me: { lastSeen: now },
    off1bob: { lastSeen: now - NEARBY_WINDOW_MS },
    off1stale: { lastSeen: now - NEARBY_WINDOW_MS - 1 },
    off1carol: { lastSeen: now }
  };
  expect(nearbyCrew(crew, nearby, 'off1me', now).map((m) => m.address)).toEqual(
    ['off1bob']
  );
});

test('concurrent STATUS: the earlier op wins on every device (example A)', () => {
  const a = op(ALICE, 5, 'STATUS', { to: 'ON_HOLD' });
  const b = op(BOB, 6, 'STATUS', { to: 'IN_PROGRESS' });
  for (const ops of [
    [a, b],
    [b, a]
  ]) {
    const view = mergedView(pack, ops);
    expect(view.status).toBe('ON_HOLD');
    expect(view.results).toEqual({
      [a.body.opId]: 'APPLIED',
      [b.body.opId]: 'CONFLICT'
    });
    expect(view.conflictsWith).toEqual({ [b.body.opId]: a.body }); // "Alice's On Hold came first"
  }
});

test('an edit based on a received op does not conflict with it', () => {
  const a = op(ALICE, 5, 'STATUS', { to: 'ON_HOLD' });
  const b = op(BOB, 6, 'STATUS', { to: 'IN_PROGRESS' }, [a]);
  const view = mergedView(pack, [a, b]);
  expect(view.status).toBe('IN_PROGRESS');
  expect(Object.values(view.results)).toEqual(['APPLIED', 'APPLIED']);
});

test('TASK_UPDATE is compare-and-set per field', () => {
  const a = op(ALICE, 1, 'TASK_UPDATE', {
    taskId: 10,
    field: 'value',
    to: 'COMPLETE'
  });
  const b = op(BOB, 2, 'TASK_UPDATE', {
    taskId: 10,
    field: 'value',
    to: 'ON_HOLD'
  });
  const notes = op(BOB, 3, 'TASK_UPDATE', {
    taskId: 10,
    field: 'notes',
    to: 'loose bolt'
  });
  const view = mergedView(pack, [a, b, notes]);
  expect(view.tasks[10]).toEqual({ value: 'COMPLETE', notes: 'loose bolt' });
  expect(view.results[b.body.opId]).toBe('CONFLICT');
  expect(view.results[notes.body.opId]).toBe('APPLIED');
});

test('double HANDOFF_ACCEPT: first accept wins (example C)', () => {
  const req = op(ALICE, 8, 'HANDOFF_REQUEST', { note: 'bearing noise' });
  const bob = op(BOB, 9, 'HANDOFF_ACCEPT', { requestOpId: req.body.opId }, [
    req
  ]);
  const carol = op(
    CAROL,
    10,
    'HANDOFF_ACCEPT',
    { requestOpId: req.body.opId },
    [req]
  );
  const view = mergedView(pack, [carol, bob, req]);
  expect(view.primaryUserId).toBe(BOB.userId);
  expect(view.handoff).toEqual({
    openRequest: undefined,
    acceptedBy: BOB.userId,
    acceptedAt: 9000
  });
  expect(view.results[carol.body.opId]).toBe('CONFLICT');
});

test('NOTEs are ordered by (lamport, authorAddress), not arrival', () => {
  const n1 = op(BOB, 3, 'NOTE', { text: 'b3' });
  const n2 = op(ALICE, 3, 'NOTE', { text: 'a3' });
  const n3 = op(ALICE, 1, 'NOTE', { text: 'a1' });
  const texts = mergedView(pack, [n1, n2, n3]).timeline.map(
    (e) => (e.body.payload as any).text
  );
  expect(texts).toEqual(['a1', 'a3', 'b3']);
});

test('synced ops stay in the timeline but are not applied', () => {
  const a = {
    ...op(ALICE, 5, 'STATUS', { to: 'ON_HOLD' }),
    sync: { result: 'APPLIED' as const }
  };
  const view = mergedView(pack, [a]);
  expect(view.status).toBe('OPEN'); // the refreshed pack carries the synced value
  expect(view.results).toEqual({});
  expect(view.timeline).toEqual([
    { body: a.body, result: 'APPLIED', synced: true }
  ]);
});

test('a synced handoff still shows on the card, without re-applying it', () => {
  const req = op(ALICE, 8, 'HANDOFF_REQUEST', {});
  const accept = op(BOB, 9, 'HANDOFF_ACCEPT', { requestOpId: req.body.opId }, [
    req
  ]);
  const synced = (
    o: MergeOp,
    result: 'APPLIED' | 'DUPLICATE',
    detail = null
  ) => ({
    ...o,
    sync: { result, detail }
  });
  const view = mergedView(pack, [
    synced(req, 'APPLIED'),
    synced(accept, 'DUPLICATE', 'APPLIED')
  ]);
  expect(view.handoff).toEqual({
    openRequest: undefined,
    acceptedBy: BOB.userId,
    acceptedAt: 9000
  });
  expect(view.primaryUserId).toBe(ALICE.userId); // the refreshed pack carries the server's primary
});

test('the same opId twice is counted once', () => {
  const n = op(ALICE, 1, 'NOTE', { text: 'once' });
  expect(mergedView(pack, [n, { body: { ...n.body } }]).timeline).toHaveLength(
    1
  );
});

test('effectiveResult reads the stored outcome of a DUPLICATE', () => {
  expect(effectiveResult({ result: 'APPLIED', detail: null })).toBe('APPLIED');
  expect(effectiveResult({ result: 'CONFLICT', detail: 'COMPLETE' })).toBe(
    'CONFLICT'
  );
  expect(effectiveResult({ result: 'DUPLICATE', detail: 'APPLIED' })).toBe(
    'APPLIED'
  );
  expect(
    effectiveResult({ result: 'DUPLICATE', detail: 'CONFLICT: COMPLETE' })
  ).toBe('CONFLICT');
  expect(
    effectiveResult({ result: 'DUPLICATE', detail: 'REJECTED: bad_signature' })
  ).toBe('REJECTED');
});

test('parseMeshMessage tolerates unknown messages', () => {
  const env = { body: '{}', sig: 'x' };
  expect(
    parseMeshMessage(
      JSON.stringify({ t: 'atlas.ops.v1', ops: [env, { body: 1 }] })
    )
  ).toEqual([env]);
  expect(
    parseMeshMessage(JSON.stringify({ t: 'atlas.chat.v9', ops: [env] }))
  ).toBeNull();
  expect(parseMeshMessage('test android 2026-10-02')).toBeNull();
});

test('checkInbound: sender and author must be crew, and the author address must match the user', () => {
  const crew = [member('off1alice', 1), member('off1bob', 2)];
  const body = op(ALICE, 1, 'NOTE', { text: 'x' }).body;
  expect(checkInbound(body, 'off1alice', crew)).toEqual({ publicKey: '' });
  expect(checkInbound(body, 'off1bob', crew)).toEqual({ publicKey: '' }); // relayed by another crew member
  expect(checkInbound(body, 'off1carol', crew)).toEqual({
    drop: 'sender_not_crew'
  });
  expect(checkInbound({ ...body, authorUserId: 2 }, 'off1alice', crew)).toEqual(
    { drop: 'author_not_crew' }
  );
  expect(checkInbound(body, 'off1alice', undefined)).toEqual({
    drop: 'no_pack'
  });
});

test('signed envelopes verify, and a tampered body is rejected', async () => {
  // Node's Ed25519 stands in for the SDK's signData / verifySignature.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12); // 32 raw key bytes
  const protocol: any = {
    signData: async (data: number[]) => [
      ...sign(null, Buffer.from(data), privateKey)
    ],
    verifySignature: async (pk: number[], data: number[], sig: number[]) =>
      verify(
        null,
        Buffer.from(data),
        createPublicKey({
          key: Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'),
            Buffer.from(pk)
          ]),
          format: 'der',
          type: 'spki'
        }),
        Buffer.from(sig)
      )
  };
  const body = op(ALICE, 1, 'NOTE', { text: 'Compressor bearing noise' }).body;
  const env = await signEnvelope(protocol, body);
  const key = raw.toString('base64');

  expect(await verifyEnvelope(protocol, env, key)).toEqual(body);
  const tampered = { ...env, body: env.body.replace('bearing', 'bEaring') };
  expect(await verifyEnvelope(protocol, tampered, key)).toBeNull();
});
