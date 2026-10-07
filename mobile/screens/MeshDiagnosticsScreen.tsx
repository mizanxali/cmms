// Dev tool: shows the shared mesh runtime (MeshContext) — identity, registration, crew of the last opened
// work order, nearby peers marked crew / not crew — and a harness that creates ops on that work order.
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Platform, ScrollView } from 'react-native';
import { Button, Divider, List, Text, useTheme } from 'react-native-paper';
import { MessagePriority } from '@offline-protocol/mesh-sdk';
import { View } from '../components/Themed';
import { RootStackScreenProps } from '../types';
import { useMesh } from '../contexts/MeshContext';
import { useDispatch, useSelector } from '../store';
import {
  isNearby,
  MESH_TYPE,
  NEARBY_WINDOW_MS,
  OpArgs,
  OpType
} from '../utils/offlineOps';
import {
  createOp,
  resendOp,
  resetOps,
  selectMergedView
} from '../slices/offline';

const short = (id?: string) =>
  id ? `${id.slice(0, 10)}…${id.slice(-4)}` : '-';

export default function MeshDiagnosticsScreen({}: RootStackScreenProps<'MeshDiagnostics'>) {
  const theme = useTheme();
  const {
    ready,
    myAddress,
    protocol,
    error,
    log,
    startNearbyScan,
    stopNearbyScan
  } = useMesh();
  const dispatch = useDispatch();
  const { registeredAddress, packs, nearby, ops, outbound, lamport, drops } =
    useSelector((state) => state.offline);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    startNearbyScan();
    return stopNearbyScan;
  }, [ready]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

  const lastPack = Object.values(packs).sort(
    (a, b) => b.fetchedAt - a.fetchedAt
  )[0];
  const crew = lastPack?.crew ?? [];
  const crewByAddress = new Map(crew.map((m) => [m.address, m]));
  const woId = lastPack?.workOrder.id;
  const view = useSelector((state) =>
    woId ? selectMergedView(woId)(state) : null
  );
  const nameOf = (userId: number) => {
    const m = crew.find((c) => c.userId === userId);
    return m ? m.firstName : `user ${userId}`;
  };
  const peers = Object.entries(nearby)
    .filter(([address, p]) => address !== myAddress && isNearby(p, now))
    .sort(([, a], [, b]) => b.lastSeen - a.lastSeen);

  const run = async <T extends OpType>(type: T, args: OpArgs[T]) => {
    try {
      await dispatch(createOp(protocol, woId, type, args));
      setSendResult(`created ${type}`);
    } catch (err) {
      setSendResult(`create failed: ${err}`);
    }
  };

  // Re-sends my latest op with one extra byte in the body, so receivers must drop it as bad_signature.
  const sendTampered = async () => {
    const last = Object.values(ops)
      .filter((o) => o.origin === 'local')
      .sort((a, b) => b.body.lamport - a.body.lamport)[0];
    if (!protocol || !last) return setSendResult('create an op first');
    const envelope = {
      ...last.envelope,
      body: last.envelope.body.replace('"v":1', '"v": 1')
    };
    for (const m of crew.filter((c) => c.address !== myAddress))
      await protocol.sendMessage({
        recipient: m.address,
        content: JSON.stringify({ t: MESH_TYPE, ops: [envelope] }),
        priority: MessagePriority.High
      });
    setSendResult('sent tampered copy');
  };

  const sendTest = async () => {
    if (!protocol || !selected) return;
    try {
      const id = await protocol.sendMessage({
        recipient: selected,
        content: `test ${Platform.OS} ${new Date().toISOString()}`,
        priority: MessagePriority.High
      });
      setSendResult(`sent ${short(id)} → ${short(selected)}`);
    } catch (err) {
      setSendResult(`send failed: ${err}`);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ padding: 16, gap: 8 }}>
        <Text selectable>Address: {myAddress ?? '-'}</Text>
        <Text>
          Running: {String(ready)} · Registered:{' '}
          {myAddress && registeredAddress === myAddress ? 'yes' : 'no'}
        </Text>
        {error && <Text style={{ color: theme.colors.error }}>{error}</Text>}
        <Divider />
        <Text variant="titleSmall">
          Crew ·{' '}
          {lastPack
            ? `#${lastPack.workOrder.id} ${lastPack.workOrder.title}`
            : 'open a work order online'}
        </Text>
        {crew.map((m) => (
          <List.Item
            key={m.address}
            title={`${m.firstName} ${m.lastName}${
              m.address === myAddress ? ' (me)' : ''
            }`}
            description={short(m.address)}
          />
        ))}
        <Divider />
        <Text variant="titleSmall">
          Nearby (last {NEARBY_WINDOW_MS / 1000} s)
        </Text>
        {peers.map(([address, p]) => {
          const member = crewByAddress.get(address);
          return (
            <List.Item
              key={address}
              title={
                member
                  ? `${member.firstName} ${member.lastName} · crew`
                  : `${short(address)} · not crew`
              }
              description={`${p.transport ?? '?'} · rssi ${
                p.rssi ?? '?'
              } · ${Math.round((now - p.lastSeen) / 1000)} s ago`}
              onPress={() => setSelected(address)}
              left={(props) => (
                <List.Icon
                  {...props}
                  icon={
                    selected === address ? 'radiobox-marked' : 'radiobox-blank'
                  }
                />
              )}
            />
          );
        })}
        {/* Test harness: dev builds only */}
        {__DEV__ && (
          <Button
            mode="contained"
            disabled={!ready || !selected}
            onPress={sendTest}
          >
            Send test
          </Button>
        )}
        {sendResult && <Text>{sendResult}</Text>}
        <Divider />
        <Text variant="titleSmall">
          Ops · lamport {lamport} · dropped {JSON.stringify(drops)}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {__DEV__ && (
            <>
              <Button
                mode="outlined"
                disabled={!ready || !woId}
                onPress={() =>
                  run('NOTE', {
                    text: `Test note ${
                      Platform.OS
                    } ${new Date().toLocaleTimeString()}`
                  })
                }
              >
                Add test note
              </Button>
              <Button
                mode="outlined"
                disabled={!ready || !woId}
                onPress={() => run('STATUS', { to: 'ON_HOLD' })}
              >
                Status ON_HOLD
              </Button>
              <Button
                mode="outlined"
                disabled={!ready || !woId}
                onPress={() => run('STATUS', { to: 'IN_PROGRESS' })}
              >
                Status IN_PROGRESS
              </Button>
              <Button mode="outlined" disabled={!ready} onPress={sendTampered}>
                Send tampered
              </Button>
            </>
          )}
          <Button mode="outlined" onPress={() => dispatch(resetOps())}>
            Reset offline data
          </Button>
        </View>
        {view?.timeline.map(({ body, result }) => {
          const deliveries = Object.values(outbound).filter((o) =>
            o.opIds.includes(body.opId)
          );
          return (
            <View key={body.opId} style={{ gap: 2 }}>
              <Text>
                L{body.lamport} {body.type} by {nameOf(body.authorUserId)} ·{' '}
                {result} · {JSON.stringify(body.payload)}
              </Text>
              {deliveries.map((d, i) => (
                <Text
                  key={i}
                  style={{ fontSize: 12 }}
                  onPress={
                    d.state === 'failed'
                      ? () =>
                          dispatch(resendOp(protocol, body.opId, d.recipient))
                      : undefined
                  }
                >
                  {'  '}→ {nameOf(crewByAddress.get(d.recipient)?.userId)}:{' '}
                  {d.state}
                  {d.state === 'retrying' ? ` (${d.retryCount})` : ''}
                  {d.state === 'failed' ? ' · tap to resend' : ''}
                </Text>
              ))}
            </View>
          );
        })}
        {view && (
          <Text selectable style={{ fontSize: 11 }}>
            {JSON.stringify(
              {
                status: view.status,
                primaryUserId: view.primaryUserId,
                tasks: view.tasks,
                handoff: view.handoff,
                results: view.results
              },
              null,
              1
            )}
          </Text>
        )}
        <Divider />
        <Text variant="titleSmall">Log</Text>
        {log.map((line, i) => (
          <Text
            key={i}
            selectable
            style={{
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
              fontSize: 11
            }}
          >
            {line}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}
