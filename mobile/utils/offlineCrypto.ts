// Envelope signing and verification with the SDK identity key.
import type { OfflineProtocol } from '@offline-protocol/mesh-sdk';
import { Envelope, OpBody, parseOpBody } from './offlineOps';

type Signer = Pick<OfflineProtocol, 'signData' | 'verifySignature'>;

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));
export const toBase64 = (bytes: number[]): string =>
  btoa(String.fromCharCode(...bytes));
const fromBase64 = (b64: string): number[] =>
  Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function signEnvelope(
  protocol: Signer,
  body: OpBody
): Promise<Envelope> {
  const json = JSON.stringify(body);
  return { body: json, sig: toBase64(await protocol.signData(utf8(json))) };
}

// The signature covers the body string exactly as received; never re-serialize before verifying.
export async function verifyEnvelope(
  protocol: Signer,
  envelope: Envelope,
  publicKeyB64: string
): Promise<OpBody | null> {
  const body = parseOpBody(envelope.body);
  if (!body) return null;
  const ok = await protocol
    .verifySignature(
      fromBase64(publicKeyB64),
      utf8(envelope.body),
      fromBase64(envelope.sig)
    )
    .catch(() => false);
  return ok ? body : null;
}
