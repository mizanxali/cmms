// Runs the Offline Protocol SDK for the logged-in user: lifecycle, BLE permissions, device registration,
// the atlas.handoff presence service, and SDK events into the offline slice.
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react';
import { Alert, Linking, PermissionsAndroid, Platform } from 'react-native';
import { MeshServices, OfflineProtocol } from '@offline-protocol/mesh-sdk';
import { useTranslation } from 'react-i18next';
import useAuth from '../hooks/useAuth';
import store, { useDispatch, useSelector } from '../store';
import api from '../utils/api';
import { CustomSnackBarContext } from './CustomSnackBarContext';
import {
  countDrop,
  markDelivery,
  peerLost,
  peerSeen,
  receiveOps,
  resendUntracked,
  syncOffline,
  setIdentity,
  setRegisteredAddress
} from '../slices/offline';
import {
  checkInbound,
  Envelope,
  OpBody,
  parseMeshMessage,
  parseOpBody
} from '../utils/offlineOps';
import { toBase64, verifyEnvelope } from '../utils/offlineCrypto';
import { serializePermissionRequest } from '../utils/permissionQueue';

const APP_ID = 'atlas-cmms';
const SERVICE_ID = 'atlas.handoff';
const SCAN_INTERVAL_MS = 5000;
const LOG_SIZE = 200;

// One SDK profile per Atlas user, BLE only
const configFor = (companyId: number, userId: number) => ({
  appId: APP_ID,
  profile: `atlas-${companyId}-${userId}`,
  transports: { ble: { enabled: true } },
  encryption: {
    enabled: true,
    requireEncryption: true,
    autoKeyExchange: true,
    storePending: true
  }
});

const short = (id?: string) =>
  id ? `${id.slice(0, 10)}…${id.slice(-4)}` : '-';

// iOS prompts for Bluetooth on start().
async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const p = PermissionsAndroid.PERMISSIONS;
  const wanted =
    (Platform.Version as number) >= 31
      ? [p.BLUETOOTH_SCAN, p.BLUETOOTH_CONNECT, p.BLUETOOTH_ADVERTISE]
      : [p.ACCESS_FINE_LOCATION];
  const res = await serializePermissionRequest(() =>
    PermissionsAndroid.requestMultiple(wanted)
  );
  return wanted.every(
    (perm) => res[perm] === PermissionsAndroid.RESULTS.GRANTED
  );
}

interface MeshContextValue {
  ready: boolean;
  myAddress: string | null;
  protocol: OfflineProtocol | null;
  error: string | null;
  log: string[];
  startNearbyScan: () => void;
  stopNearbyScan: () => void;
  syncing: boolean;
  sync: () => void;
  bluetooth: 'on' | 'off' | 'denied';
}

const MeshContext = createContext<MeshContextValue | null>(null);

export function useMesh(): MeshContextValue {
  const ctx = useContext(MeshContext);
  if (!ctx) throw new Error('useMesh must be used within MeshProvider');
  return ctx;
}

export function MeshProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { isAuthenticated, user } = useAuth();
  const dispatch = useDispatch();
  const { myAddress, myPublicKey, registeredAddress, backendReachable } =
    useSelector((state) => state.offline);
  const [protocol, setProtocol] = useState<OfflineProtocol | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  // Serializes start/stop so a quick logout/login can't overlap two native instances.
  const lifecycle = useRef<Promise<void>>(Promise.resolve());
  const scanTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const registering = useRef(false);
  const { showSnackBar } = useContext(CustomSnackBarContext);
  const [syncing, setSyncing] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [bluetoothOn, setBluetoothOn] = useState(true);
  const protoRef = useRef<OfflineProtocol | null>(null);

  // The log is buffered and published once a second: retry and diagnostic storms (tens of events a second) would
  // otherwise re-render every useMesh() consumer per line.
  const pendingLog = useRef<string[]>([]);
  const append = useCallback((line: string) => {
    console.log(`[mesh ${Platform.OS}] ${line}`);
    pendingLog.current.unshift(
      `${new Date().toISOString().slice(11, 23)} ${line}`
    );
  }, []);
  useEffect(() => {
    const id = setInterval(() => {
      if (!pendingLog.current.length) return;
      const lines = pendingLog.current;
      pendingLog.current = [];
      setLog((prev) => [...lines, ...prev].slice(0, LOG_SIZE));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Inbound pipeline: parse → sender and author are crew → signature → store.
  const receive = useCallback(
    async (e: any) => {
      const envelopes = e.app_id === APP_ID && parseMeshMessage(e.content);
      if (!envelopes) {
        append(`ignored message from ${short(e.sender)} app_id=${e.app_id}`);
        return;
      }
      const accepted: { envelope: Envelope; body: OpBody }[] = [];
      for (const envelope of envelopes) {
        const body = parseOpBody(envelope.body);
        const check = body
          ? checkInbound(
              body,
              e.sender,
              store.getState().offline.packs[body.workOrderId]?.crew
            )
          : ({ drop: 'bad_envelope' } as const);
        const verified =
          'publicKey' in check &&
          (await verifyEnvelope(protoRef.current, envelope, check.publicKey));
        if (verified) {
          accepted.push({ envelope, body: verified });
          append(
            `${
              store.getState().offline.ops[verified.opId]
                ? 'duplicate'
                : 'accepted'
            } ${verified.type} L${verified.lamport} ${verified.opId}`
          );
        } else {
          const reason = 'drop' in check ? check.drop : 'bad_signature';
          dispatch(countDrop(reason));
          append(`dropped op from ${short(e.sender)}: ${reason}`);
        }
      }
      // Persist straight away: the SDK has already acknowledged delivery
      if (accepted.length)
        dispatch(receiveOps({ from: e.sender, ops: accepted }));
    },
    [append, dispatch]
  );

  const handleEvent = useCallback(
    (e: any) => {
      switch (e.type) {
        case 'identity_ready':
          append(`identity_ready ${short(e.address)}`);
          break;
        case 'neighbor_discovered':
          dispatch(
            peerSeen({
              address: e.peer_id,
              transport: e.transport,
              rssi: e.rssi
            })
          );
          append(
            `neighbor_discovered ${short(e.peer_id)} rssi=${e.rssi ?? '?'}`
          );
          break;
        case 'neighbor_lost':
          dispatch(peerLost(e.peer_id));
          append(`neighbor_lost ${short(e.peer_id)}`);
          break;
        case 'service_discovered':
          if (e.service_id === SERVICE_ID)
            dispatch(peerSeen({ address: e.provider_peer_id }));
          break;
        case 'message_received':
          append(
            `message_received from ${short(e.sender)} encrypted=${e.encrypted}`
          );
          receive(e).catch((err) => append(`receive failed: ${err}`));
          break;
        case 'message_delivered':
          dispatch(
            markDelivery({ messageId: e.message_id, state: 'delivered' })
          );
          append(`message_delivered ${short(e.message_id)}`);
          break;
        case 'message_retrying':
          dispatch(
            markDelivery({
              messageId: e.message_id,
              state: 'retrying',
              retryCount: e.retry_count
            })
          );
          append(
            `message_retrying ${short(e.message_id)} retry=${e.retry_count}`
          );
          break;
        case 'message_failed':
          dispatch(
            markDelivery({
              messageId: e.message_id,
              state: 'failed',
              retryCount: e.retry_count
            })
          );
          append(`message_failed ${short(e.message_id)} ${e.reason}`);
          break;
        // Parked for an unreachable peer; the SDK keeps probing, so it is not terminal
        case 'message_undeliverable':
          dispatch(
            markDelivery({ messageId: e.message_id, state: 'retrying' })
          );
          append(`message_undeliverable ${short(e.message_id)} ${e.reason}`);
          break;
        case 'diagnostic':
          if (e.level === 'warning' || e.level === 'error')
            append(
              `diag ${e.level}: ${e.message} ${JSON.stringify(e.context ?? {})}`
            );
          break;
      }
    },
    [append, dispatch, receive]
  );

  const stopNearbyScan = useCallback(() => {
    if (scanTimer.current) clearInterval(scanTimer.current);
    scanTimer.current = null;
  }, []);

  const startNearbyScan = useCallback(() => {
    stopNearbyScan();
    const scan = () =>
      new MeshServices()
        .discoverServices(SERVICE_ID)
        .catch((err) => append(`discoverServices failed: ${err}`));
    scan();
    scanTimer.current = setInterval(scan, SCAN_INTERVAL_MS);
  }, [append, stopNearbyScan]);

  // Lifecycle: one SDK identity per Atlas user on this device
  const userId = user?.id;
  const companyId = user?.companyId;
  useEffect(() => {
    if (!isAuthenticated || !userId || !companyId) return;
    const proto = new OfflineProtocol(configFor(companyId, userId));
    protoRef.current = proto; // the inbound pipeline verifies with it, possibly before start() resolves
    proto.on('all', handleEvent);
    let active = true;
    lifecycle.current = lifecycle.current.then(async () => {
      try {
        if (!active) return;
        if (!(await requestBlePermissions())) {
          setError('Bluetooth permission denied');
          setPermissionDenied(true);
          Alert.alert(
            t('bluetooth_needed'),
            t('bluetooth_needed_description'),
            [
              { text: t('cancel'), style: 'cancel' },
              {
                text: t('open_settings'),
                onPress: () => Linking.openSettings()
              }
            ]
          );
          return;
        }
        await proto.start();
        const address = await proto.localAddress();
        const publicKey = toBase64(await proto.getIdentityPublicKey());
        if (!active) return;
        dispatch(setIdentity({ address, publicKey, userId, companyId }));
        await new MeshServices().registerService(SERVICE_ID, '1', {});
        append(`started as ${short(address)}`);
        append(
          `env TextEncoder=${typeof TextEncoder} btoa=${typeof btoa} getRandomValues=${typeof globalThis
            .crypto?.getRandomValues}`
        );
        setError(null);
        setPermissionDenied(false);
        if (!active) return;
        setProtocol(proto);
        const resent = await dispatch(resendUntracked(proto));
        if (resent) append(`re-sent ${resent} untracked op message(s)`);
      } catch (err) {
        setError(String(err));
        append(`start failed: ${err}`);
      }
    });
    return () => {
      active = false;
      setProtocol(null);
      stopNearbyScan();
      lifecycle.current = lifecycle.current.then(async () => {
        // destroy() so the next login re-creates the native instance with its own profile
        await proto.stop().catch(() => {});
        await proto.destroy().catch(() => {});
        append('stopped');
      });
    };
  }, [
    isAuthenticated,
    userId,
    companyId,
    handleEvent,
    append,
    dispatch,
    stopNearbyScan
  ]);

  // Registration: retried whenever the backend becomes reachable
  useEffect(() => {
    if (
      !protocol ||
      !myAddress ||
      !myPublicKey ||
      !backendReachable ||
      registeredAddress === myAddress ||
      registering.current
    )
      return;
    registering.current = true;
    api
      .post(
        'offline/devices',
        { address: myAddress, publicKey: myPublicKey },
        {},
        true
      )
      .then(() => {
        dispatch(setRegisteredAddress(myAddress));
        append(`registered ${short(myAddress)}`);
      })
      .catch((err) => append(`register failed: ${err}`))
      .finally(() => {
        registering.current = false;
      });
  }, [
    protocol,
    myAddress,
    myPublicKey,
    backendReachable,
    registeredAddress,
    append,
    dispatch
  ]);

  // The radio can be switched off at any time; the SDK only exposes it as a query
  useEffect(() => {
    if (!protocol) return;
    const check = () =>
      protocol
        .isBluetoothEnabled()
        .then(setBluetoothOn)
        .catch(() => {});
    check();
    const id = setInterval(check, 3000);
    return () => clearInterval(id);
  }, [protocol]);

  // Sync: on the false→true reachability edge and on "Sync now"; toast a one-line summary
  const sync = useCallback(() => {
    setSyncing(true);
    dispatch(syncOffline())
      .then((s) => {
        const parts = [
          s.synced && t('offline_n_synced', { count: s.synced }),
          s.already && t('offline_n_already', { count: s.already }),
          s.conflicts && t('offline_n_conflicts', { count: s.conflicts }),
          s.rejected && t('offline_n_rejected', { count: s.rejected })
        ].filter(Boolean);
        if (parts.length)
          showSnackBar(
            parts.join(' · '),
            s.conflicts || s.rejected ? 'info' : 'success'
          );
        append(`synced ${JSON.stringify(s)}`);
      })
      .catch((err) => {
        showSnackBar(t('offline_sync_failed'), 'error');
        append(`sync failed: ${err}`);
      })
      .finally(() => setSyncing(false));
  }, [dispatch, showSnackBar, t, append]);

  const wasReachable = useRef(backendReachable);
  useEffect(() => {
    if (isAuthenticated && backendReachable && !wasReachable.current) sync();
    wasReachable.current = backendReachable;
  }, [backendReachable, isAuthenticated, sync]);

  return (
    <MeshContext.Provider
      value={{
        ready: !!protocol,
        myAddress,
        protocol,
        error,
        log,
        startNearbyScan,
        stopNearbyScan,
        syncing,
        sync,
        bluetooth: permissionDenied ? 'denied' : bluetoothOn ? 'on' : 'off'
      }}
    >
      {children}
    </MeshContext.Provider>
  );
}
