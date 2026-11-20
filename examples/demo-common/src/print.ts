// Terminal output for the scenes. English only; no keys, no RPC URLs.
import type { ReasonRecord, SceneRecord, StepRecord } from './record.js';

export type Log = (line: string) => void;

export const shortDigest = (hex: string | undefined) =>
  hex === undefined || hex === '' ? '-' : `${hex.slice(0, 12)}...`;

export const formatReason = (reason: ReasonRecord) =>
  reason.path === undefined ? reason.code : `${reason.code} at ${reason.path}`;

/** 1500000 base units with 6 decimals -> "1.50". */
export function usdc(baseUnits: bigint | string): string {
  const value = BigInt(baseUnits);
  const whole = value / 1_000_000n;
  const cents = (value % 1_000_000n) / 10_000n;
  return `${whole.toString()}.${cents.toString().padStart(2, '0')}`;
}

function printStep(log: Log, step: StepRecord, labelled: boolean): void {
  const indent = labelled ? '    ' : '  ';
  if (labelled) log(`  ${step.label}`);
  log(`${indent}outcome       ${step.outcome}`);
  log(
    `${indent}reasons       ${step.reasons.length === 0 ? 'none' : step.reasons.map(formatReason).join(', ')}`,
  );
  if (step.quotes !== undefined) {
    for (const quote of step.quotes) {
      log(
        `${indent}option ${String(quote.option + 1)}      ${usdc(quote.amount)} of ${quote.asset.slice(0, 8)}... to ${quote.payTo.slice(0, 8)}..., fee payer ${quote.feePayer?.slice(0, 8) ?? '-'}...`,
      );
      log(
        `${indent}              digest ${shortDigest(quote.requirementsDigest)}  ${quote.outcome}${quote.reasons.length === 0 ? '' : `: ${quote.reasons.join(', ')}`}`,
      );
    }
  }
  if (step.messageDigest !== undefined) {
    log(`${indent}message       sha256 ${shortDigest(step.messageDigest)}`);
  }
  log(`${indent}signer calls  ${String(step.signerCalls)}`);
  if (!step.sent) log(`${indent}sent          no`);
  else
    log(
      `${indent}sent          ${step.explorer ?? `${step.signature ?? '?'} (local, no explorer)`}`,
    );
  if (step.note !== undefined) log(`${indent}note          ${step.note}`);
}

export function printScene(log: Log, scene: SceneRecord): void {
  log('');
  log(`Scene ${String(scene.scene)}. ${scene.title}`);
  log(`  expected      ${scene.expected}`);
  const labelled = scene.steps.length > 1;
  for (const step of scene.steps) printStep(log, step, labelled);
}
