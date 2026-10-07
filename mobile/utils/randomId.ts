// 12 random bytes as hex. Used for op ids, which are dedup keys, not secrets.
const randomId = (): string => {
  const arr = new Uint8Array(12);
  // ponytail: Hermes has no crypto.getRandomValues; Math.random gives 96 unique-enough bits. Use expo-crypto if
  // ids ever need to be unpredictable.
  if (globalThis.crypto?.getRandomValues)
    globalThis.crypto.getRandomValues(arr);
  else arr.forEach((_, i) => (arr[i] = Math.floor(Math.random() * 256)));
  return Array.from(arr, (v) => v.toString(16).padStart(2, '0')).join('');
};

export default randomId;
