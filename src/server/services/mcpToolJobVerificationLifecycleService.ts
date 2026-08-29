import {
  releaseReusableVerificationCandidateLeaseAsync,
  releaseVerificationCandidateAsync,
} from './verificationCandidateService';
import type { McpToolJob } from '../repositories/mcpToolJobRepository';

export function verificationCandidateIdForArgs(args: any) {
  const candidateId = args?.__verificationCandidate?.candidateId;
  return typeof candidateId === 'string' && candidateId.trim() ? candidateId.trim() : '';
}

export async function releaseVerificationCandidateForArgsAsync(args: any) {
  const candidateId = verificationCandidateIdForArgs(args);
  if (!candidateId) return false;
  const leaseId = typeof args?.__verificationCandidate?.reuseLease?.leaseId === 'string'
    ? args.__verificationCandidate.reuseLease.leaseId.trim()
    : '';
  if (!leaseId) return await releaseVerificationCandidateAsync(candidateId);
  const releasedLease = await releaseReusableVerificationCandidateLeaseAsync(leaseId);
  return releasedLease || await releaseVerificationCandidateAsync(candidateId);
}

export function releaseTerminalVerificationCandidate(job: Pick<McpToolJob, 'args'> | null | undefined) {
  if (!verificationCandidateIdForArgs(job?.args)) return false;
  void releaseVerificationCandidateForArgsAsync(job?.args).catch(() => {});
  return true;
}
