// Offline work-order handoff: everything renders from the merged view, so it works with no backend.
import * as React from 'react';
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react';
import { Animated, Linking, ScrollView, StyleSheet, View } from 'react-native';
import {
  Avatar,
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  Divider,
  Portal,
  Text,
  TextInput,
  useTheme
} from 'react-native-paper';
import { SheetManager } from 'react-native-actions-sheet';
import { useFocusEffect } from '@react-navigation/native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useTranslation } from 'react-i18next';
import { OfflineProtocol } from '@offline-protocol/mesh-sdk';
import { RootStackScreenProps } from '../../types';
import { useDispatch, useSelector } from '../../store';
import { useMesh } from '../../contexts/MeshContext';
import { CustomSnackBarContext } from '../../contexts/CustomSnackBarContext';
import Tag from '../../components/Tag';
import { getStatusColor } from '../../utils/overall';
import {
  createOp,
  effectiveResult,
  OfflinePack,
  Outbound,
  resendOp,
  selectMergedView,
  StoredOp
} from '../../slices/offline';
import {
  isNearby,
  MergedView,
  OpArgs,
  OpBody,
  OpType,
  StatusPayload,
  TaskUpdatePayload,
  HandoffRequestPayload,
  NotePayload,
  WOStatus
} from '../../utils/offlineOps';

const STATUSES: WOStatus[] = ['OPEN', 'ON_HOLD', 'IN_PROGRESS', 'COMPLETE'];
const KEEP_AWAKE_TAG = 'offline-handoff';
const time = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const fullName = (pack: OfflinePack, userId: number | null) => {
  const m = pack.crew.find((c) => c.userId === userId);
  if (m) return `${m.firstName} ${m.lastName}`;
  const p = pack.workOrder.primaryUser;
  return p?.id === userId ? `${p.firstName} ${p.lastName}` : '—';
};

// One delivery row per recipient: delivered wins, otherwise the latest attempt.
const latestPerRecipient = (entries: Outbound[]): Outbound[] =>
  Object.values(
    entries.reduce<Record<string, Outbound>>((acc, o) => {
      const prev = acc[o.recipient];
      if (
        !prev ||
        (prev.state !== 'delivered' &&
          (o.state === 'delivered' || o.updatedAt > prev.updatedAt))
      )
        acc[o.recipient] = o;
      return acc;
    }, {})
  );

export default function OfflineHandoffScreen({
  route
}: RootStackScreenProps<'OfflineHandoff'>) {
  const { workOrderId } = route.params;
  const { t } = useTranslation();
  const theme = useTheme();
  const dispatch = useDispatch();
  const { showSnackBar } = useContext(CustomSnackBarContext);
  const {
    ready,
    protocol,
    startNearbyScan,
    stopNearbyScan,
    sync,
    syncing,
    bluetooth
  } = useMesh();
  const pack = useSelector((state) => state.offline.packs[workOrderId]);
  const nearby = useSelector((state) => state.offline.nearby);
  const outbound = useSelector((state) => state.offline.outbound);
  const ops = useSelector((state) => state.offline.ops);
  const myAddress = useSelector((state) => state.offline.myAddress);
  const backendReachable = useSelector(
    (state) => state.offline.backendReachable
  );
  const lastSyncAt = useSelector((state) => state.offline.lastSyncAt);
  const view = useSelector(selectMergedView(workOrderId));
  const [now, setNow] = useState(Date.now());
  const [note, setNote] = useState('');
  const [handoffNote, setHandoffNote] = useState('');
  const [numbers, setNumbers] = useState<Record<number, string>>({});
  const [modalRequest, setModalRequest] = useState<OpBody | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!ready) return;
      startNearbyScan();
      return stopNearbyScan;
    }, [ready, startNearbyScan, stopNearbyScan])
  );

  // iOS only runs BLE in the foreground, so the screen must not lock mid-handoff
  useFocusEffect(
    useCallback(() => {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
      return () => {
        deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
      };
    }, [])
  );

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  // In-app prompt when someone else's handoff request arrives while the screen is open
  const openRequest = view?.handoff.openRequest;
  const seenRequest = useRef(openRequest?.opId);
  useEffect(() => {
    if (!openRequest || openRequest.opId === seenRequest.current) return;
    seenRequest.current = openRequest.opId;
    const crewHere = pack?.crew.some((m) => m.address === myAddress);
    if (crewHere && openRequest.authorAddress !== myAddress)
      setModalRequest(openRequest);
  }, [openRequest?.opId]);

  if (!pack || !view) return null;

  const crew = pack.crew;
  const isCrew = crew.some((m) => m.address === myAddress);
  const canAct = isCrew && ready;
  const others = crew.filter((m) => m.address !== myAddress);
  const nameOf = (userId: number | null) => fullName(pack, userId);

  const run = <T extends OpType>(type: T, args: OpArgs[T]) =>
    dispatch(createOp(protocol, workOrderId, type, args)).catch(() =>
      showSnackBar(t('offline_action_failed'), 'error')
    );

  return (
    <ScrollView
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
    >
      {/* Header */}
      <Text variant="headlineSmall">{pack.workOrder.title}</Text>
      <View style={styles.row}>
        <Text style={{ color: 'grey' }}>#{pack.workOrder.customId}</Text>
        <StatusTag status={view.status} />
        <Tag
          text={
            backendReachable
              ? `${t('offline_online')} · ${
                  lastSyncAt
                    ? t('offline_last_synced', { time: time(lastSyncAt) })
                    : t('offline_not_synced')
                }`
              : t('offline_offline')
          }
          color={theme.colors.onSurface}
          backgroundColor={theme.colors.surfaceVariant}
        />
      </View>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text>
          {t('offline_primary', { name: nameOf(view.primaryUserId) })}
        </Text>
        <Button
          compact
          mode="outlined"
          icon="cloud-sync"
          loading={syncing}
          disabled={!backendReachable || syncing}
          onPress={sync}
        >
          {t('offline_sync_now')}
        </Button>
      </View>

      {/* Bluetooth off or not permitted: nothing reaches the crew until it's fixed */}
      {bluetooth !== 'on' && (
        <Card
          style={[
            styles.section,
            { backgroundColor: theme.colors.errorContainer }
          ]}
          mode="contained"
        >
          <Card.Title
            title={t(
              bluetooth === 'denied'
                ? 'offline_bluetooth_denied'
                : 'offline_bluetooth_off'
            )}
            titleNumberOfLines={3}
            left={(props) => <Avatar.Icon {...props} icon="bluetooth-off" />}
          />
          <Card.Actions>
            <Button mode="contained" onPress={() => Linking.openSettings()}>
              {t('open_settings')}
            </Button>
          </Card.Actions>
        </Card>
      )}

      {/* Nearby crew */}
      <Text variant="titleMedium" style={styles.section}>
        {t('offline_nearby_crew')}
      </Text>
      {others.length === 0 && <Text>{t('offline_no_other_crew')}</Text>}
      <View style={styles.row}>
        {others.map((m) => {
          const peer = nearby[m.address];
          const inRange = bluetooth === 'on' && isNearby(peer, now);
          return (
            <Chip
              key={m.address}
              icon={inRange ? 'bluetooth' : 'bluetooth-off'}
              disabled={!inRange}
            >
              {`${m.firstName} ${m.lastName}`}
              {inRange
                ? peer.rssi !== undefined
                  ? ` · ${peer.rssi} dBm`
                  : ''
                : ` · ${t('offline_out_of_range')}`}
            </Chip>
          );
        })}
      </View>
      {!ready && bluetooth === 'on' && (
        <Text style={{ color: 'grey' }}>{t('offline_starting')}</Text>
      )}

      {!isCrew ? (
        <Card style={styles.section} mode="outlined">
          <Card.Content>
            <Text>{t('offline_not_crew')}</Text>
          </Card.Content>
        </Card>
      ) : (
        <>
          {/* Handoff */}
          <Card style={styles.section} mode="outlined">
            <Card.Title title={t('offline_handoff_title')} />
            <Card.Content style={{ gap: 8 }}>
              {view.handoff.acceptedBy !== undefined && (
                <Text
                  variant="titleSmall"
                  style={{ color: theme.colors.primary }}
                >
                  {t('offline_handoff_accepted', {
                    name: nameOf(view.handoff.acceptedBy),
                    time: time(view.handoff.acceptedAt)
                  })}
                </Text>
              )}
              {openRequest ? (
                <>
                  <Text>
                    {t('offline_handoff_requested_by', {
                      name: nameOf(openRequest.authorUserId)
                    })}
                    {(openRequest.payload as HandoffRequestPayload).note
                      ? `: “${
                          (openRequest.payload as HandoffRequestPayload).note
                        }”`
                      : ''}
                  </Text>
                  {openRequest.authorAddress === myAddress ? (
                    <Text style={{ color: 'grey' }}>
                      {t('offline_waiting_accept')}
                    </Text>
                  ) : (
                    <Button
                      mode="contained"
                      icon="account-check"
                      disabled={!canAct}
                      onPress={() =>
                        run('HANDOFF_ACCEPT', { requestOpId: openRequest.opId })
                      }
                    >
                      {t('offline_accept_responsibility')}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <TextInput
                    mode="outlined"
                    dense
                    placeholder={t('offline_handoff_note')}
                    value={handoffNote}
                    onChangeText={setHandoffNote}
                  />
                  <Button
                    mode="contained"
                    icon="account-arrow-right"
                    disabled={!canAct}
                    onPress={() => {
                      run(
                        'HANDOFF_REQUEST',
                        handoffNote.trim() ? { note: handoffNote.trim() } : {}
                      );
                      setHandoffNote('');
                    }}
                  >
                    {t('offline_request_handoff')}
                  </Button>
                </>
              )}
            </Card.Content>
          </Card>

          {/* Actions */}
          <Text variant="titleMedium" style={styles.section}>
            {t('offline_add_update')}
          </Text>
          <TextInput
            mode="outlined"
            multiline
            placeholder={t('offline_update_placeholder')}
            value={note}
            onChangeText={setNote}
            maxLength={2000}
          />
          <View style={[styles.row, { justifyContent: 'space-between' }]}>
            <Button
              mode="outlined"
              icon="menu-down"
              disabled={!canAct}
              onPress={() =>
                SheetManager.show('dropdown-sheet', {
                  payload: {
                    items: STATUSES.map((s) => ({ value: s, label: t(s) })),
                    value: view.status,
                    setValue: (to: WOStatus) => {
                      if (to !== view.status) run('STATUS', { to });
                    }
                  }
                })
              }
            >
              {t('offline_change_status')}
            </Button>
            <Button
              mode="contained"
              disabled={!canAct || !note.trim()}
              onPress={() => {
                run('NOTE', { text: note.trim() });
                setNote('');
              }}
            >
              {t('send')}
            </Button>
          </View>

          {/* Checklist: SUBTASK toggles OPEN ↔ COMPLETE, NUMBER/METER commit on blur; other types are shown read-only */}
          <Text variant="titleMedium" style={styles.section}>
            {t('checklist')}
          </Text>
          {pack.tasks.map((task) => {
            const merged = view.tasks[task.id];
            const type = task.taskBase.taskType;
            if (type === 'SUBTASK')
              return (
                <Checkbox.Item
                  key={task.id}
                  label={task.taskBase.label}
                  status={
                    merged?.value === 'COMPLETE' ? 'checked' : 'unchecked'
                  }
                  disabled={!canAct}
                  onPress={() =>
                    run('TASK_UPDATE', {
                      taskId: task.id,
                      field: 'value',
                      to: merged?.value === 'COMPLETE' ? 'OPEN' : 'COMPLETE'
                    })
                  }
                />
              );
            if (type === 'NUMBER' || type === 'METER') {
              const draft = numbers[task.id] ?? merged?.value ?? '';
              return (
                <TextInput
                  key={task.id}
                  mode="outlined"
                  label={task.taskBase.label}
                  keyboardType="decimal-pad"
                  disabled={!canAct}
                  value={draft}
                  onChangeText={(v) =>
                    setNumbers((n) => ({
                      ...n,
                      [task.id]: v
                        .replace(/[^0-9.]/g, '')
                        .replace(/(\..*)\./g, '$1')
                    }))
                  }
                  onEndEditing={() => {
                    const to = numbers[task.id];
                    setNumbers(({ [task.id]: _, ...rest }) => rest);
                    if (to !== undefined && to !== '' && to !== merged?.value)
                      run('TASK_UPDATE', {
                        taskId: task.id,
                        field: 'value',
                        to
                      });
                  }}
                  style={{ marginVertical: 4 }}
                />
              );
            }
            return (
              <Text key={task.id} style={{ marginVertical: 8 }}>
                {task.taskBase.label}: {merged?.value ?? '—'}
              </Text>
            );
          })}
        </>
      )}

      <Timeline
        pack={pack}
        timeline={view.timeline}
        conflictsWith={view.conflictsWith}
        outbound={outbound}
        ops={ops}
        myAddress={myAddress}
        protocol={protocol}
      />

      <Portal>
        <Dialog
          visible={!!modalRequest}
          onDismiss={() => setModalRequest(null)}
        >
          <Dialog.Title>
            {modalRequest &&
              t('offline_handoff_requested_by', {
                name: nameOf(modalRequest.authorUserId)
              })}
          </Dialog.Title>
          {(modalRequest?.payload as HandoffRequestPayload)?.note && (
            <Dialog.Content>
              <Text>
                “{(modalRequest.payload as HandoffRequestPayload).note}”
              </Text>
            </Dialog.Content>
          )}
          <Dialog.Actions>
            <Button onPress={() => setModalRequest(null)}>
              {t('offline_later')}
            </Button>
            <Button
              mode="contained"
              disabled={!canAct}
              onPress={() => {
                run('HANDOFF_ACCEPT', { requestOpId: modalRequest.opId });
                setModalRequest(null);
              }}
            >
              {t('offline_accept_responsibility')}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </ScrollView>
  );
}

// Pulses when the merged status changes, so a conflict resolving on screen is easy to spot.
function StatusTag({ status }: { status: WOStatus }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    Animated.sequence([
      Animated.timing(scale, {
        toValue: 1.3,
        duration: 180,
        useNativeDriver: true
      }),
      Animated.spring(scale, { toValue: 1, friction: 3, useNativeDriver: true })
    ]).start();
  }, [status]);
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Tag
        text={t(status)}
        color="white"
        backgroundColor={getStatusColor(status, theme)}
      />
    </Animated.View>
  );
}

// Memoized: nearby and clock ticks re-render the screen every few seconds, but the timeline only changes with ops,
// delivery state or the pack.
const Timeline = memo(function Timeline({
  pack,
  timeline,
  conflictsWith,
  outbound,
  ops,
  myAddress,
  protocol
}: {
  pack: OfflinePack;
  timeline: MergedView['timeline'];
  conflictsWith: MergedView['conflictsWith'];
  outbound: Record<string, Outbound>;
  ops: Record<string, StoredOp>;
  myAddress: string | null;
  protocol: OfflineProtocol | null;
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const dispatch = useDispatch();
  const firstNameOf = (address: string) =>
    pack.crew.find((c) => c.address === address)?.firstName ??
    address.slice(0, 10);
  const taskLabel = (taskId: number) =>
    pack.tasks.find((task) => task.id === taskId)?.taskBase.label ??
    `#${taskId}`;
  const valueLabel = (v: string | null) =>
    v === null ? '—' : t(v, { defaultValue: v });

  const describe = (body: OpBody): string => {
    switch (body.type) {
      case 'NOTE':
        return (body.payload as NotePayload).text;
      case 'STATUS':
        return t('offline_op_status', {
          status: t((body.payload as StatusPayload).to)
        });
      case 'TASK_UPDATE': {
        const p = body.payload as TaskUpdatePayload;
        return t(
          p.field === 'notes' ? 'offline_op_task_notes' : 'offline_op_task',
          { task: taskLabel(p.taskId), value: valueLabel(p.to) }
        );
      }
      case 'HANDOFF_REQUEST': {
        const n = (body.payload as HandoffRequestPayload).note;
        return n
          ? `${t('offline_op_request')}: “${n}”`
          : t('offline_op_request');
      }
      case 'HANDOFF_ACCEPT':
        return t('offline_op_accept');
    }
  };

  // "Conflict: Alice's On Hold came first" while offline; the server's verdict after sync
  const conflictText = (opId: string) => {
    const winner = conflictsWith[opId];
    if (!winner) return t('offline_conflict');
    const name = pack.crew.find(
      (c) => c.userId === winner.authorUserId
    )?.firstName;
    if (winner.type === 'HANDOFF_ACCEPT')
      return t('offline_conflict_accepted_first', { name });
    const to = (winner.payload as StatusPayload | TaskUpdatePayload).to;
    return t('offline_conflict_came_first', { name, value: valueLabel(to) });
  };

  // Synced / Already synced / Conflict: server kept X / Rejected (reason)
  const syncBadge = (s: StoredOp['sync']) => {
    const outcome = effectiveResult(s);
    if (outcome === 'CONFLICT') {
      const value =
        (s.result === 'DUPLICATE'
          ? s.detail?.split(': ').slice(1).join(': ')
          : s.detail) ?? '';
      return {
        text: t('offline_conflict_server_kept', { value: valueLabel(value) }),
        color: theme.colors.error
      };
    }
    if (outcome === 'REJECTED')
      return {
        text: t('offline_rejected', {
          reason: s.detail?.replace(/^REJECTED: /, '')
        }),
        color: theme.colors.error
      };
    return {
      text: t(
        s.result === 'DUPLICATE' ? 'offline_already_synced' : 'offline_synced'
      ),
      // @ts-ignore success is a custom theme colour
      color: theme.colors.success
    };
  };

  const deliveryLabel = (o: Outbound) =>
    o.state === 'retrying'
      ? t('offline_retrying', { count: o.retryCount })
      : t(`offline_${o.state}`);

  return (
    <>
      <Text variant="titleMedium" style={styles.section}>
        {t('offline_timeline')}
      </Text>
      {timeline.length === 0 && (
        <Text style={{ color: 'grey' }}>{t('offline_timeline_empty')}</Text>
      )}
      {[...timeline].reverse().map(({ body, result }) => {
        const sync = ops[body.opId]?.sync;
        const badge = sync
          ? syncBadge(sync)
          : result === 'CONFLICT'
          ? { text: conflictText(body.opId), color: theme.colors.error }
          : null;
        const deliveries =
          body.authorAddress === myAddress
            ? latestPerRecipient(
                Object.values(outbound).filter((o) =>
                  o.opIds.includes(body.opId)
                )
              )
            : [];
        return (
          <View key={body.opId} style={styles.entry}>
            <View style={[styles.row, { justifyContent: 'space-between' }]}>
              <Text variant="labelLarge">
                {fullName(pack, body.authorUserId)} · {time(body.occurredAt)}
              </Text>
              <View style={styles.row}>
                {badge && (
                  <Tag
                    text={badge.text}
                    color="white"
                    backgroundColor={badge.color}
                  />
                )}
                <Text variant="labelSmall" style={{ color: 'grey' }}>
                  {t('offline_signed')}
                </Text>
              </View>
            </View>
            <Text>{describe(body)}</Text>
            {deliveries.map((o) => (
              <View key={o.recipient} style={styles.row}>
                <Text
                  variant="labelSmall"
                  style={{
                    color:
                      o.state === 'delivered'
                        ? theme.colors.primary
                        : o.state === 'failed'
                        ? theme.colors.error
                        : 'grey'
                  }}
                >
                  {t('offline_to', { name: firstNameOf(o.recipient) })}:{' '}
                  {deliveryLabel(o)}
                </Text>
                {o.state === 'failed' && (
                  <Button
                    compact
                    onPress={() =>
                      dispatch(resendOp(protocol, body.opId, o.recipient))
                    }
                  >
                    {t('offline_resend')}
                  </Button>
                )}
              </View>
            ))}
            <Divider style={{ marginTop: 8 }} />
          </View>
        );
      })}
    </>
  );
});

const styles = StyleSheet.create({
  container: { padding: 16, gap: 8, paddingBottom: 48 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  section: { marginTop: 16 },
  entry: { gap: 2, paddingVertical: 6 }
});
