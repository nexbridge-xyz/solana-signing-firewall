# Shots

Every shot comes from the devnet run of 2026-11-20. The terminal output is in
`docs/devnet-run/terminal.txt`; show it as it is, or replay it at reading speed. Do not run the
demo again for the video: a new run makes new transactions that would not match the record.

| Time      | Shot                                                                                                                                                                                                 | Source                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 0:00–0:12 | Title card. Text only: "Signing Firewall for Solana" and "A devnet proof of concept". No logos.                                                                                                      | —                                                 |
| 0:12–0:25 | The first diagram of `README.md` ("How it works"), rendered.                                                                                                                                         | README.md                                         |
| 0:25–0:35 | Terminal: the header (signer, commit) and scenes 1 to 4.                                                                                                                                             | terminal.txt, from the top to the end of scene 4  |
| 0:35–0:45 | Explorer pages of scenes 1 to 4, a few seconds each. Show the status and the token balance changes.                                                                                                  | Links in `docs/devnet-run/scenes.md`, rows 1 to 4 |
| 0:45–1:00 | Terminal: scene 5, both steps. Hold on "approved by" and "signer calls 1". On-screen note: "In this demo one person plays both roles; in real use the approver is another person on another device." | terminal.txt, scene 5                             |
| 1:00–1:35 | Terminal: scenes 6 to 11, one cut each, highlighting the reason code and "signer calls 0".                                                                                                           | terminal.txt, scenes 6 to 11                      |
| 1:35–1:45 | Terminal: scene 12 (quote digest, settlement link, the report text).                                                                                                                                 | terminal.txt, scene 12                            |
| 1:45–1:53 | Terminal: scene 13, the four options with their outcomes.                                                                                                                                            | terminal.txt, scene 13                            |
| 1:53–1:59 | Terminal: scene 14, "second report" paid, "third report" `X402_BUDGET_EXCEEDED`.                                                                                                                     | terminal.txt, scene 14                            |
| 1:59–2:05 | Terminal: scene 15, `X402_NOT_TRANSFER_CHECKED`, "/settle was never called".                                                                                                                         | terminal.txt, scene 15                            |
| 2:05–2:13 | Terminal: `pnpm fixtures` ending with "69 core and 45 x402 vectors: 114 pass, 0 fail."                                                                                                               | Run it locally; it is offline                     |
| 2:13–2:20 | Terminal: the `pnpm verify-run` output ending with "7 of 7 on-chain messages match the reviewed bytes".                                                                                              | terminal.txt, the end                             |
| 2:20–2:30 | End card. Text only: the repository address and nexbridge.xyz.                                                                                                                                       | —                                                 |

Before the upload: the repository address on the end card must be public, or left off.
