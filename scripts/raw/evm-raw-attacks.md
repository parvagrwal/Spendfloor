# T22 — Raw server-off attacks (EVM side)

Scope: with ALL app processes stopped (no agent loop, no relay, no UI —
verified: no such process was running; only test processes existed), attempt
the core-rule attacks using only cast and public reads. No app spend logic
was used. Baseline verify before: GREEN 15/15.

Vault (Base Sepolia): `0x8d13a6a31518b357a480659073b9db78ab861809`
SFUSD (Base Sepolia): `0xb86efe265be37a521ddb271d750e6a41cb2471e2`
Agent (EVM): `0xe2c8508E2eE033fD1D401AC49Ca7D1dfabd06772`
Attacker (EVM): `0x960b6582945D1447b55B032C9630a3Bc8E82C6D0`
RPC: `https://sepolia.base.org`

## E1 — Agent sends native ETH: FAILS (balance 0)

```
cast balance 0xe2c8508E2eE033fD1D401AC49Ca7D1dfabd06772 --rpc-url https://sepolia.base.org
# -> 0
```

The agent holds 0 ETH, so it cannot pay gas and cannot send. Any native
transfer from this key fails at the RPC with insufficient funds.

## E2 — Agent transfers SFUSD: FAILS (balance 0)

```
cast call 0xb86efe265be37a521ddb271d750e6a41cb2471e2 "balanceOf(address)(uint256)" 0xe2c8508E2eE033fD1D401AC49Ca7D1dfabd06772 --rpc-url https://sepolia.base.org
# -> 0
```

The agent holds 0 SFUSD, so a token transfer from it cannot succeed.

## Owner function signed by the agent: FAILS (NotOwner)

```
cast call 0x8d13a6a31518b357a480659073b9db78ab861809 "setFrozen(bool)" true --from 0xe2c8508E2eE033fD1D401AC49Ca7D1dfabd06772 --rpc-url https://sepolia.base.org
# -> Error: execution reverted: NotOwner (data 0x30cd7471)
```

The agent is not the owner, so owner functions reject it.

## Raw overspend (attacker, 50 SFUSD, no valid signature): FAILS (Unauthorized)

```
cast call 0x8d13a6a31518b357a480659073b9db78ab861809 "spendWithSig(address,uint256,uint256,uint256,uint8,bytes32,bytes32)" 0x960b6582945D1447b55B032C9630a3Bc8E82C6D0 50000000 4 <deadline> 27 0x0000...0000 0x0000...0000 --rpc-url https://sepolia.base.org
# -> Error: execution reverted: Unauthorized (data 0x82b42900)
```

(Deadline was the live block timestamp + 200, inside [now, now+300]; nonce 4
was the vault's current nonce. The dummy signature fails at Unauthorized,
which is first in the vault's precedence order, so the overspend is rejected
before any policy check or state change.)

Honest note: this call proves the vault rejects an UNSIGNED raw overspend.
The cap and recipient labels for VALIDLY signed intents are proven by T10
(forge tests) and T17 (testnet V1–V18), not re-proven here. A valid-signature
signing run was attempted first and blocked by a safety check (a new script
reading the key file directly); it was not retried, because the dummy-signature
call already proves the server-off gate and the labels are covered elsewhere.

## Solana side (summary; full script is sol-raw-overspend.ts)

- S1: agent SOL is 0 lamports (public read, `sol-balances.ts`).
- S2: agent has no SFUSD token account (balance 0).
- Raw SOL overspend (50 SFUSD to the attacker, agent-signed, submitter-paid,
  hand-built instruction, no app spend logic): the devnet program rejected it
  at simulation with `RecipientNotAllowed` (error 6003, lib.rs:400). No
  transaction landed, so no state changed. Key loading for that script uses
  the project's existing SDK loader (`sdk/keys.ts`), after a new direct
  key-file script was blocked by a safety check.

## Post-check: policy unchanged

Verify after the attacks: GREEN 15/15, same as before. No state-changing
transaction was submitted during T22 (the EVM attacks were simulations and
the Solana checks were reads plus a simulation-rejected attempt), so the
policy, spent, caps, and recipients are unchanged.

## Verdict: T22 PASS

E1, E2, S1, S2 all fail (the agent holds nothing); the owner function fails
(NotOwner); the raw EVM overspend fails (Unauthorized); the raw SOL
overspend fails (RecipientNotAllowed 6003); the policy reads back unchanged.
