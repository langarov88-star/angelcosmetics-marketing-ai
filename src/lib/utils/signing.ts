// HMAC-SHA256 message signing for inter-worker authentication

export async function signMessage(
  payload: string,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(payload);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export async function verifySignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const expected = await signMessage(payload, secret);
  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

export function buildSignaturePayload(
  workflowId: string,
  correlationId: string,
  timestamp: number
): string {
  return `${workflowId}:${correlationId}:${timestamp}`;
}
