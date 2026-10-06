import NetInfo from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';
import { useSelector } from '../store';
import { getUserInfos } from '../utils/userApi';

// utils/api.ts records the outcome of every request, so a probe is just a request.
const probe = () => getUserInfos().catch(() => {});

export default function useBackendReachability(): boolean {
  const reachable = useSelector((state) => state.offline.backendReachable);
  const [connected, setConnected] = useState<boolean>(true);

  useEffect(
    () =>
      NetInfo.addEventListener((state) => setConnected(!!state.isConnected)),
    []
  );

  // NetInfo can report connected before the LAN route works, so keep probing until the backend answers.
  useEffect(() => {
    probe();
    if (reachable || !connected) return;
    const id = setInterval(probe, 3000);
    return () => clearInterval(id);
  }, [connected, reachable]);

  return reachable;
}
