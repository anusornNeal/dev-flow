import crypto from 'node:crypto';
import { isIP } from 'node:net';
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

export interface StrictLoopbackAccessInput {
  remoteAddress?: string | null;
  forwardedFor?: string | null;
  forwarded?: string | null;
}

export interface StrictLoopbackAccessDecision {
  allowed: boolean;
  code?: 'UI_PREVIEW_LOCAL_ONLY';
  message?: string;
}

function normalizeForwardedAddress(value: string) {
  let candidate = value.trim();
  if (!candidate || /^unknown$/i.test(candidate) || candidate.startsWith('_')) return null;
  if (candidate.startsWith('"') && candidate.endsWith('"')) candidate = candidate.slice(1, -1).trim();
  const bracketed = candidate.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) {
    const normalized = normalizeIp(bracketed[1]);
    return isIP(normalized) ? normalized : null;
  }
  const ipv4WithPort = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4WithPort) {
    const normalized = normalizeIp(ipv4WithPort[1]);
    return isIP(normalized) ? normalized : null;
  }
  if (!/^[0-9a-f:.]+$/i.test(candidate)) return null;
  const normalized = normalizeIp(candidate);
  return isIP(normalized) ? normalized : null;
}

function parseForwardedForChain(value?: string | null) {
  if (value == null) return [] as string[];
  const raw = String(value).trim();
  if (!raw) return null;
  const chain = raw.split(',').map((entry) => normalizeForwardedAddress(entry));
  return chain.every((entry): entry is string => Boolean(entry)) ? chain : null;
}

function parseForwardedHeaderChain(value?: string | null) {
  if (value == null) return [] as string[];
  const raw = String(value).trim();
  if (!raw) return null;
  const chain: string[] = [];
  for (const element of raw.split(',')) {
    const forParams = element.split(';')
      .map((part) => part.trim())
      .filter((part) => /^for=/i.test(part));
    if (forParams.length !== 1) return null;
    const address = normalizeForwardedAddress(forParams[0].slice(forParams[0].indexOf('=') + 1));
    if (!address) return null;
    chain.push(address);
  }
  return chain;
}

export function evaluateStrictLoopbackAccess(input: StrictLoopbackAccessInput): StrictLoopbackAccessDecision {
  if (!isLoopback(input.remoteAddress)) {
    return { allowed: false, code: 'UI_PREVIEW_LOCAL_ONLY', message: 'UI preview documents and artifacts are available only from the local loopback interface.' };
  }
  const forwardedFor = parseForwardedForChain(input.forwardedFor);
  const forwarded = parseForwardedHeaderChain(input.forwarded);
  if (forwardedFor === null || forwarded === null) {
    return { allowed: false, code: 'UI_PREVIEW_LOCAL_ONLY', message: 'Malformed or unknown forwarding information is not trusted for UI preview access.' };
  }
  if (![...forwardedFor, ...forwarded].every((address) => isLoopback(address))) {
    return { allowed: false, code: 'UI_PREVIEW_LOCAL_ONLY', message: 'Forwarded UI preview access must remain entirely on loopback.' };
  }
  return { allowed: true };
}

export function createStrictLoopbackAccessMiddleware() {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const forwarded = req.headers.forwarded;
    const forwardedFor = req.headers['x-forwarded-for'];
    const decision = evaluateStrictLoopbackAccess({
      remoteAddress: req.socket?.remoteAddress,
      forwarded: Array.isArray(forwarded) ? forwarded.join(',') : forwarded,
      forwardedFor: Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor,
    });
    if (decision.allowed) return next();
    return res.status(403).json({ error: decision.message, code: decision.code });
  };
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
