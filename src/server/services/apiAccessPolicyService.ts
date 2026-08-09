import crypto from 'node:crypto';
import type express from 'express';

export interface ApiAccessPolicyInput {
  method: string;
  remoteAddress?: string | null;
  forwardedFor?: string | null;
  authorization?: string | null;
  remoteTokenHeader?: string | null;
  configuredRemoteToken?: string | null;
}

export type ApiTrustLevel = 'local' | 'trusted-remote' | 'remote-readonly';

export interface ApiAccessPolicyDecision {
  allowed: boolean;
  trust?: ApiTrustLevel;
  code?: 'REMOTE_API_AUTH_REQUIRED' | 'REMOTE_API_AUTH_INVALID';
  message?: string;
}

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeIp(value?: string | null) {
  const address = String(value || '').trim().replace(/^::ffff:/, '');
  if (address === '::1') return '127.0.0.1';
  return address;
}

function isLoopback(value?: string | null) {
  const address = normalizeIp(value);
  return address === '127.0.0.1' || address.startsWith('127.');
}

function forwardedClient(value?: string | null) {
  const first = String(value || '').split(',')[0]?.trim();
  return normalizeIp(first);
}

function bearerToken(value?: string | null) {
  const match = String(value || '').match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function timingSafeEqualText(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function evaluateApiAccessPolicy(input: ApiAccessPolicyInput): ApiAccessPolicyDecision {
  const method = String(input.method || 'GET').toUpperCase();
  const forwarded = forwardedClient(input.forwardedFor);
  const directLocal = isLoopback(input.remoteAddress);
  const forwardedLocal = !forwarded || isLoopback(forwarded);
  const trustedLocal = directLocal && forwardedLocal;

  if (trustedLocal) return { allowed: true, trust: 'local' };
  if (READ_ONLY_METHODS.has(method)) return { allowed: true, trust: 'remote-readonly' };

  const configuredToken = String(input.configuredRemoteToken || '').trim();
  if (!configuredToken) {
    return {
      allowed: false,
      code: 'REMOTE_API_AUTH_REQUIRED',
      message: 'Remote privileged API access is disabled until DEVFLOW_TRUSTED_REMOTE_TOKEN is configured.',
    };
  }

  const suppliedToken = bearerToken(input.authorization) || String(input.remoteTokenHeader || '').trim();
  if (!suppliedToken || !timingSafeEqualText(suppliedToken, configuredToken)) {
    return {
      allowed: false,
      code: 'REMOTE_API_AUTH_INVALID',
      message: 'Remote privileged API authorization is invalid.',
    };
  }

  return { allowed: true, trust: 'trusted-remote' };
}

export function createPrivilegedApiAccessMiddleware() {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const decision = evaluateApiAccessPolicy({
      method: req.method,
      remoteAddress: req.socket?.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for'] as string | undefined,
      authorization: req.headers.authorization,
      remoteTokenHeader: req.headers['x-devflow-remote-token'] as string | undefined,
      configuredRemoteToken: process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN,
    });

    if (decision.allowed) return next();
    return res.status(403).json({
      error: decision.message,
      code: decision.code,
    });
  };
}
