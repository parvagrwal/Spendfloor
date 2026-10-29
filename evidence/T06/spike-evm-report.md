# T06 SPIKE-EVM report (CLOSED 2026-10-29)

Hypothesis: on Base Sepolia, an AGENT key with 0 wei can authorize a capped,
allowlisted transfer that a SUBMITTER pays for; an over-limit attempt is
recorded as a mined, decodable revert. Hypothesis HELD on all six criteria.

## Vault

- Address: 0x8d084a81fb4236b9dd20d8cf86875293ab68c092
- Deploy tx: 0x6d4945f334be27b03bbcb14efc43fc29216ca17760a8d068fc8748f01c4c7029, block 51721336, status success
- Fund tx: 0x700da21032a19e8e93ddee039a31007d2802fe741b1227a06588b981294d0de9, block 51721355, status success, vault funded 0.005 ETH
- Code: `evm/src/Vault.sol` (native-ETH vault, agent-signed intents, D6 precedence)
- Params: dailyCap 0.002 ETH, perTxCap 0.0005 ETH, allowlist [OWNER, SUBMITTER]
- Bytecode compiled with solc 0.8.37, evm_version=cancun (criterion 6)

## Criteria

1. Anvil: 14/14 tests green, fuzz 10,000 runs with 0 counterexamples (seed 42).
   Evidence: `evidence/T06/anvil-tests-2026-10-29.txt`. H8 gate: PASS, no kill.
2. Sepolia valid spends 3/3, status 1:
   - 0.0001 ETH to SUBMITTER, tx 0x006b38b461fe7df5f21bec2125e0ca1eabe69be28a2268eb371ae8c15172d8f6, block 51722542
   - 0.0001 ETH to OWNER, tx 0xd96788a138aa7ccbd7b4ad9966be33e21ec4c7677493b191fb2df6145fc897af, block 51722565
   - 0.0001 ETH to SUBMITTER, tx 0x1ec11bcf303b7bec97344f22665f527dffd80670467bf9819f3439fa117aa4cb, block 51722579
3. Sepolia over-cap attempts 3/3, status 0, decoded DailyCapExceeded, all within 30 s:
   - Attempt 1: tx 0x06dada79c08be8fe9608255791025f95bfd57a8d1dd70a1a3f458e7d2a5c0327, block 51722604, mined in 4.0 s (first run; decode fixed on replay)
   - Attempt 2: tx 0xf45bc6eb944e973df01fe34679cc61dcbfb2577462bc21e29d5339a1df46633b, block 51723370, mined in 1.2 s
   - Attempt 3: tx 0xe7f7c6bc55815460eaec427764b6c013979ec1c566638336b91b1cfc0ebcda6f, block 51723379, mined in 2.0 s
   - Explicit gas limit (200000) on all three, so the reverts mined instead of failing locally. This verifies the viem explicit-gas flag.
4. AGENT balance 0 wei throughout (checked before, after valid spends, after over-cap attempts, after tampered intent).
5. Tampered intent 1/1: signed for 0.0001 ETH, submitted as 0.0002 ETH, tx 0xb25b7df439583974823d44899537dc7d7a3c1ef75c67c39fea8b3f29a0aae68f, block 51723400, status 0, decoded Unauthorized.
6. evm_version=cancun bytecode deployed (see deploy tx above).

Vault spent total after all legs: 0.0003 ETH (exactly the 3 valid spends).
Evidence: `evidence/T06/spend-sepolia-2026-10-29.txt` (clean resumed run),
`evidence/T06/spend-sepolia-2026-10-29-attempt1.txt` (first run: valid spends
plus the over-cap attempt whose decode failed on the harness, not the chain).

## Harness failures during the run (no on-chain state affected)

- First run stopped at over-cap 1: this viem version's `account.sign` returns a
  65-byte hex string, not a Signature object, so the v field encoded as NaN
  and the first spend call threw before any transaction was sent. Fixed by
  parsing r/s/v from the hex string; raw signing verified by recoverAddress
  returning the agent address.
- Same run then stopped at over-cap 1's decode: the node returns the revert
  data (`0xcc70389d` = DailyCapExceeded) on the raw RPC error, several cause
  levels below viem's top error, where the decoder never looked. Fixed by
  walking the cause chain. The run was resumed with SPENDFLOOR_SPEND_RESUME=1
  (valid spends skipped after asserting the 0.0003 ETH spent total; over-cap 1
  decoded by replay, no new transaction).

## Spike limitations (T10 lands them)

No nonce (replay bounded by the daily cap only), no deadline/session, no
withdraw, caps and agent immutable after construction. Tests use no forge-std
by design, so `evm/` stays dependency-free and transfers without submodules.

## Files

- `evm/src/Vault.sol`, `evm/test/Vault.t.sol`
- `sdk/deploy-vault.ts` (owner machine), `sdk/spend-sepolia.ts` (agent machine)
- `evidence/T06/anvil-tests-2026-10-29.txt`, `evidence/T06/spend-sepolia-2026-10-29.txt`, `evidence/T06/spend-sepolia-2026-10-29-attempt1.txt`

## Next

T07 (SPIKE-SOL) is next in tracker order.
