import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { LoginConfig, SigningKeys } from '../src/mcp/login.js';

// A stand-in Keycloak realm: one RSA signing key (kid k1) and a token minter.
// The defaults are a valid access token for the agent-engine client.
export function fakeKeycloak(publicUrl = 'https://agent-engine.test') {
  const cfg: LoginConfig = { issuer: 'https://keycloak.test/auth/realms/stark', jwksUrl: 'https://keycloak.test/auth/realms/stark/protocol/openid-connect/certs', clientId: 'agent-engine', publicUrl, domain: 'starkfuture.com' };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keys: SigningKeys = { keyFor: async (kid) => (kid === 'k1' ? publicKey : undefined) };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = (over: Record<string, unknown> = {}) => ({
    iss: cfg.issuer,
    aud: 'agent-engine',
    azp: 'agent-engine',
    typ: 'Bearer',
    sub: 'f1d2c3b4',
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    email: 'ana@starkfuture.com',
    email_verified: true,
    ...over,
  });
  const token = (over: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1', typ: 'JWT' }, key: KeyObject = privateKey) => {
    const body = Object.fromEntries(Object.entries(claims(over)).filter(([, v]) => v !== undefined));
    const data = `${b64(header)}.${b64(body)}`;
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
  };
  return { cfg, keys, token, publicKey };
}
