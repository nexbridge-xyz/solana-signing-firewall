// `pnpm demo:record`: the Markdown table of a recorded run, for the README.
import type { RunRecord } from '@nexbridge/example-demo-common';

const cell = (text: string) => text.replace(/\|/g, '\\|');

export function renderTable(run: RunRecord): string {
  const lines = [
    `Recorded on ${run.network}, ${run.startedAt}, from commit ${run.code.commit.slice(0, 12)}${run.code.dirty ? ' (with uncommitted changes)' : ''}. Signer: ${run.signer}.`,
    '',
    '| # | Scene | Result | Reasons | Inner signer calls | Vectors | Transaction |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const scene of run.scenes) {
    const results = scene.steps.map((s) => s.outcome).join(', then ');
    const reasons = [
      ...new Set(
        scene.steps.flatMap((s) =>
          s.reasons.map((r) =>
            r.path === undefined ? `\`${r.code}\`` : `\`${r.code}\` at \`${r.path}\``,
          ),
        ),
      ),
    ];
    const calls = scene.steps.map((s) => String(s.signerCalls)).join(', then ');
    const links = scene.steps
      .filter((s) => s.sent)
      .map((s) =>
        s.explorer === undefined
          ? `slot ${s.slot ?? '?'} (local)`
          : `[slot ${s.slot ?? '?'}](${s.explorer})`,
      );
    lines.push(
      `| ${String(scene.scene)} | ${cell(scene.title)} | ${cell(results)} | ${reasons.length === 0 ? '-' : reasons.join(', ')} | ${calls} | ${scene.vectors.join(', ')} | ${links.length === 0 ? 'not sent' : links.join(', ')} |`,
    );
  }
  if (!run.complete) {
    lines.push('', `The run stopped early: ${run.error ?? 'no reason recorded'}.`);
  }
  lines.push(
    '',
    "Scene 15 counts the calls of the facilitator's key; every other scene counts the calls of the wrapped Keychain signer.",
  );
  return `${lines.join('\n')}\n`;
}
