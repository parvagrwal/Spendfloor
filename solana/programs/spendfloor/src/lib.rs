use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount};
use sha2::{Digest, Sha256};

declare_id!("CQfuniyvMY9sPDAFMPRZzbpHEwRiyy3Y4BsfuQd3iAbE");

/// T12a (reworked to plan D4) + T12b complete Solana program: the mirror
/// of the T10 EVM vault, holding SPL SFUSD, not native SOL.
/// A 0-lamport AGENT key co-signs spends paid by any SUBMITTER (the fee
/// payer). The policy account holds only state; the spendable funds live
/// in a vault token account whose owner (authority) is the policy PDA.
/// Spends and withdraws move tokens via a Token-program CPI signed by the
/// PDA. The mint is pinned in the policy at init and never changes, so a
/// wrong mint (S6) or a Token-2022 account fails, and the token program
/// must be the classic Token program (S7, enforced by Anchor's
/// Program<Token> type). Checks run in D6 precedence order, with the
/// account checks (mint, duplicate, vault authority) after Unauthorized
/// and before Frozen. The policy hash is the T05 canonical hash,
/// computed on-chain, so T14 can prove both chains enforce the same
/// policy. Amounts are u64 micro-units (6 decimals); cap math is u128
/// so a 2^64-1 amount cannot overflow (V8).

#[program]
pub mod spendfloor {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        ctx: Context<Initialize>,
        version: u32,
        decimals: u8,
        agent: Pubkey,
        per_tx_cap: u64,
        window_max: u64,
        window_seconds: u64,
        window_anchor: i64,
        expires_at: i64,
        recipients: Vec<Pubkey>,
        evm_set_hash: [u8; 32],
        mint: Pubkey,
    ) -> Result<()> {
        require!(agent != Pubkey::default(), SpendError::InvalidAgent);
        // D4: the mint is pinned at init and immutable afterwards. A
        // zero mint would make every later mint check vacuous.
        require!(mint != Pubkey::default(), SpendError::InvalidPolicy);
        let policy_key = ctx.accounts.policy.key();
        validate_policy(
            version,
            decimals,
            window_seconds,
            window_anchor,
            expires_at,
            &recipients,
            &agent,
            &policy_key,
        )?;
        let sol_set_hash = set_hash(&recipients);
        let policy_hash = compute_policy_hash(
            version,
            decimals,
            per_tx_cap,
            window_max,
            window_seconds,
            window_anchor,
            expires_at,
            &evm_set_hash,
            &sol_set_hash,
        );
        let policy = &mut ctx.accounts.policy;
        policy.owner = ctx.accounts.owner.key();
        policy.agent = agent;
        policy.version = version;
        policy.decimals = decimals;
        policy.per_tx_cap = per_tx_cap;
        policy.window_max = window_max;
        policy.window_seconds = window_seconds;
        policy.window_anchor = window_anchor;
        policy.expires_at = expires_at;
        policy.recipients = recipients;
        policy.evm_set_hash = evm_set_hash;
        policy.policy_hash = policy_hash;
        policy.frozen = false;
        policy.current_window = 0;
        policy.spent_in_window = 0;
        policy.bump = ctx.bumps.policy;
        policy.mint = mint;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_policy(
        ctx: Context<Admin>,
        version: u32,
        decimals: u8,
        per_tx_cap: u64,
        window_max: u64,
        window_seconds: u64,
        window_anchor: i64,
        expires_at: i64,
        recipients: Vec<Pubkey>,
        evm_set_hash: [u8; 32],
    ) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        require!(policy.owner == ctx.accounts.owner.key(), SpendError::NotOwner);
        let policy_key = policy.key();
        let agent = policy.agent;
        validate_policy(
            version,
            decimals,
            window_seconds,
            window_anchor,
            expires_at,
            &recipients,
            &agent,
            &policy_key,
        )?;
        let sol_set_hash = set_hash(&recipients);
        policy.policy_hash = compute_policy_hash(
            version,
            decimals,
            per_tx_cap,
            window_max,
            window_seconds,
            window_anchor,
            expires_at,
            &evm_set_hash,
            &sol_set_hash,
        );
        policy.version = version;
        policy.decimals = decimals;
        policy.per_tx_cap = per_tx_cap;
        policy.window_max = window_max;
        policy.window_seconds = window_seconds;
        policy.window_anchor = window_anchor;
        policy.expires_at = expires_at;
        policy.recipients = recipients;
        policy.evm_set_hash = evm_set_hash;
        // Spent and current window are NOT reset (T10 parity): the spend
        // lazily resets when the window index changes under the new
        // window parameters. The mint is NOT updated here: it is pinned
        // at init, so a policy update can never redirect funds to a
        // different mint.
        Ok(())
    }

    pub fn set_agent(ctx: Context<Admin>, new_agent: Pubkey) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        require!(policy.owner == ctx.accounts.owner.key(), SpendError::NotOwner);
        require!(new_agent != Pubkey::default(), SpendError::InvalidAgent);
        policy.agent = new_agent;
        Ok(())
    }

    pub fn set_frozen(ctx: Context<Admin>, frozen: bool) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        require!(policy.owner == ctx.accounts.owner.key(), SpendError::NotOwner);
        policy.frozen = frozen;
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let policy = &ctx.accounts.policy;
        require!(policy.owner == ctx.accounts.owner.key(), SpendError::NotOwner);
        // S6: both token accounts must hold the policy's pinned mint.
        require!(
            ctx.accounts.vault_token.mint == policy.mint
                && ctx.accounts.dest_token.mint == policy.mint,
            SpendError::InvalidPolicy
        );
        // The vault token account must be PDA-owned: otherwise the PDA
        // signer could not authorize the transfer, and the account is
        // not the vault.
        require!(
            ctx.accounts.vault_token.owner == ctx.accounts.policy.key(),
            SpendError::InvalidPolicy
        );
        // Withdraw lands with the owner (T10 parity: EVM withdraw pays
        // the owner).
        require!(
            ctx.accounts.dest_token.owner == ctx.accounts.owner.key(),
            SpendError::InvalidPolicy
        );
        // S13: source and destination must differ.
        require!(
            ctx.accounts.vault_token.key() != ctx.accounts.dest_token.key(),
            SpendError::InvalidAccounts
        );
        require!(
            ctx.accounts.vault_token.amount >= amount,
            SpendError::InsufficientFunds
        );
        let bump = policy.bump;
        let seeds: &[&[u8]] = &[b"policy", &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                token::ID,
                token::Transfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.dest_token.to_account_info(),
                    authority: ctx.accounts.policy.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    pub fn spend(ctx: Context<Spend>, amount: u64) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        // D6 first: Unauthorized.
        require!(
            ctx.accounts.agent.key() == policy.agent,
            SpendError::Unauthorized
        );
        // Account checks (S6, S13, vault authority) before the policy
        // decision: a malformed request cannot be evaluated against the
        // policy.
        require!(
            ctx.accounts.vault_token.mint == policy.mint
                && ctx.accounts.dest_token.mint == policy.mint,
            SpendError::InvalidPolicy
        );
        require!(
            ctx.accounts.vault_token.owner == policy.key(),
            SpendError::InvalidPolicy
        );
        require!(
            ctx.accounts.vault_token.key() != ctx.accounts.dest_token.key(),
            SpendError::InvalidAccounts
        );
        // D6 policy decision, in order.
        let now = Clock::get()?.unix_timestamp;
        let window_index = window_index_at(now, policy.window_anchor, policy.window_seconds);
        // T11 mirror: the agent is never a recipient, even if a rotation
        // made it one (set_policy rejects the agent at set time, but
        // set_agent can rotate onto a listed address).
        let allowed = policy
            .recipients
            .contains(&ctx.accounts.dest_token.owner)
            && ctx.accounts.dest_token.owner != policy.agent;
        let next_spent = decide(
            policy.frozen,
            true, // agent already checked above
            amount,
            allowed,
            now,
            policy.expires_at,
            window_index,
            policy.current_window,
            policy.spent_in_window,
            policy.window_max,
            policy.per_tx_cap,
        )?;
        require!(
            ctx.accounts.vault_token.amount >= amount,
            SpendError::InsufficientFunds
        );
        // Effects before the CPI (T10 parity). A failed CPI rolls the
        // whole transaction back, so the state update cannot strand.
        let policy = &mut ctx.accounts.policy;
        policy.current_window = window_index;
        policy.spent_in_window = next_spent;
        let bump = policy.bump;
        let seeds: &[&[u8]] = &[b"policy", &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                token::ID,
                token::Transfer {
                    from: ctx.accounts.vault_token.to_account_info(),
                    to: ctx.accounts.dest_token.to_account_info(),
                    authority: ctx.accounts.policy.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }
}

/// Shared policy validation for initialize and set_policy, mirroring the
/// T10 EVM vault's setPolicy rules. The agent and the policy account
/// itself are never valid recipients.
fn validate_policy(
    version: u32,
    decimals: u8,
    window_seconds: u64,
    window_anchor: i64,
    expires_at: i64,
    recipients: &[Pubkey],
    agent: &Pubkey,
    policy_account: &Pubkey,
) -> Result<()> {
    require!(version == 1, SpendError::InvalidPolicy);
    require!(decimals == 6, SpendError::InvalidPolicy);
    require!(
        window_seconds >= 60 && window_seconds <= 31_536_000,
        SpendError::InvalidPolicy
    );
    require!(window_anchor >= 0, SpendError::InvalidPolicy);
    require!(expires_at >= 0, SpendError::InvalidPolicy);
    require!(
        !recipients.is_empty() && recipients.len() <= 8,
        SpendError::InvalidPolicy
    );
    for (i, r) in recipients.iter().enumerate() {
        require!(*r != Pubkey::default(), SpendError::InvalidPolicy);
        require!(*r != *policy_account, SpendError::InvalidPolicy);
        require!(*r != *agent, SpendError::InvalidPolicy);
        for j in 0..i {
            require!(recipients[j] != *r, SpendError::InvalidPolicy);
        }
    }
    Ok(())
}

/// Window index for a timestamp under the policy window: 0 before the
/// anchor, floor((now - anchor) / window_seconds) after it. Mirrors the
/// T10 EVM vault's windowIndexAt.
fn window_index_at(now: i64, anchor: i64, window_seconds: u64) -> u64 {
    if now < anchor {
        0
    } else {
        ((now - anchor) as u64) / window_seconds
    }
}

/// Set hash: SHA-256 over the recipient pubkeys sorted ascending by bytes.
/// Matches the T05 canonical set hash.
fn set_hash(recipients: &[Pubkey]) -> [u8; 32] {
    let mut sorted: Vec<Pubkey> = recipients.to_vec();
    sorted.sort_by(|a, b| a.as_ref().cmp(b.as_ref()));
    let mut bytes = Vec::with_capacity(sorted.len() * 32);
    for r in &sorted {
        bytes.extend_from_slice(r.as_ref());
    }
    Sha256::digest(&bytes).into()
}

/// Policy hash: SHA-256 over the T05 canonical 122-byte preimage.
/// Tag "SPENDFLOOR/v1" (13) + version u32 BE + decimals u8 +
/// perTxMax u64 BE + windowMax u64 BE + windowSeconds u64 BE +
/// windowAnchor i64 BE + expiresAt i64 BE + evmSetHash (32) +
/// solSetHash (32).
#[allow(clippy::too_many_arguments)]
fn compute_policy_hash(
    version: u32,
    decimals: u8,
    per_tx_cap: u64,
    window_max: u64,
    window_seconds: u64,
    window_anchor: i64,
    expires_at: i64,
    evm_set_hash: &[u8; 32],
    sol_set_hash: &[u8; 32],
) -> [u8; 32] {
    let mut pre = Vec::with_capacity(122);
    pre.extend_from_slice(b"SPENDFLOOR/v1");
    pre.extend_from_slice(&version.to_be_bytes());
    pre.push(decimals);
    pre.extend_from_slice(&per_tx_cap.to_be_bytes());
    pre.extend_from_slice(&window_max.to_be_bytes());
    pre.extend_from_slice(&window_seconds.to_be_bytes());
    pre.extend_from_slice(&window_anchor.to_be_bytes());
    pre.extend_from_slice(&expires_at.to_be_bytes());
    pre.extend_from_slice(evm_set_hash);
    pre.extend_from_slice(sol_set_hash);
    Sha256::digest(&pre).into()
}

/// Pure spend decision, mirroring the on-chain checks. The unit tests
/// below exercise this function attack-first; the on-chain wrapper adds
/// account validation, the clock, and the token CPI.
/// D6 order: Unauthorized -> Frozen -> SessionExpired -> ZeroAmount ->
/// RecipientNotAllowed -> DailyCapExceeded -> PerTxCapExceeded.
/// Cap math is u128 (T12b): spent + amount cannot overflow, so V8's
/// 2^64-1 amount lands as DailyCapExceeded, never a panic.
#[allow(clippy::too_many_arguments)]
pub fn decide(
    frozen: bool,
    agent_matches: bool,
    amount: u64,
    allowed: bool,
    now: i64,
    expires_at: i64,
    window_index: u64,
    stored_window: u64,
    stored_spent: u64,
    window_max: u64,
    per_tx_cap: u64,
) -> Result<u64> {
    require!(agent_matches, SpendError::Unauthorized);
    require!(!frozen, SpendError::Frozen);
    require!(
        expires_at == 0 || now < expires_at,
        SpendError::SessionExpired
    );
    require!(amount > 0, SpendError::ZeroAmount);
    require!(allowed, SpendError::RecipientNotAllowed);
    let spent = if stored_window != window_index {
        0u128
    } else {
        stored_spent as u128
    };
    let next = spent + amount as u128;
    require!(next <= window_max as u128, SpendError::DailyCapExceeded);
    require!(amount <= per_tx_cap, SpendError::PerTxCapExceeded);
    Ok(next as u64)
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Policy::INIT_SPACE,
        seeds = [b"policy"],
        bump
    )]
    pub policy: Account<'info, Policy>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Admin<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"policy"], bump = policy.bump)]
    pub policy: Account<'info, Policy>,
}

#[derive(Accounts)]
pub struct Spend<'info> {
    #[account(mut, seeds = [b"policy"], bump = policy.bump)]
    pub policy: Account<'info, Policy>,
    /// The vault's token account: owned by the policy PDA, holding the
    /// policy's pinned mint. The program never reads its data beyond
    /// the TokenAccount fields Anchor deserializes.
    #[account(mut)]
    pub vault_token: Account<'info, TokenAccount>,
    /// The recipient's token account: its owner must be allowlisted.
    #[account(mut)]
    pub dest_token: Account<'info, TokenAccount>,
    pub agent: Signer<'info>,
    /// Classic Token program only (S7): Anchor verifies this account is
    /// the Token program id, so a fake token program fails here.
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"policy"], bump = policy.bump)]
    pub policy: Account<'info, Policy>,
    #[account(mut)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub dest_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub version: u32,
    pub decimals: u8,
    pub per_tx_cap: u64,
    pub window_max: u64,
    pub window_seconds: u64,
    pub window_anchor: i64,
    pub expires_at: i64,
    #[max_len(8)]
    pub recipients: Vec<Pubkey>,
    pub evm_set_hash: [u8; 32],
    pub policy_hash: [u8; 32],
    pub frozen: bool,
    pub current_window: u64,
    pub spent_in_window: u64,
    pub bump: u8,
    /// Pinned at init, immutable afterwards (D4). Appended last so all
    /// earlier field offsets are unchanged from T12a.
    pub mint: Pubkey,
}

#[error_code]
pub enum SpendError {
    #[msg("Agent signature does not match the policy agent")]
    Unauthorized,
    #[msg("Policy is frozen")]
    Frozen,
    #[msg("Amount is zero")]
    ZeroAmount,
    #[msg("Recipient is not allowlisted")]
    RecipientNotAllowed,
    #[msg("Daily cap exceeded")]
    DailyCapExceeded,
    #[msg("Per-transaction cap exceeded")]
    PerTxCapExceeded,
    #[msg("Agent address is invalid")]
    InvalidAgent,
    #[msg("Policy is invalid")]
    InvalidPolicy,
    #[msg("Caller is not the policy owner")]
    NotOwner,
    #[msg("Token account does not hold enough for the transfer")]
    InsufficientFunds,
    #[msg("Policy session has expired")]
    SessionExpired,
    #[msg("Source and destination token accounts must differ")]
    InvalidAccounts,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err_name<T: std::fmt::Debug>(r: Result<T>) -> String {
        format!("{}", r.unwrap_err())
    }

    #[test]
    fn valid_spend() {
        let next = decide(false, true, 100, true, 1000, 0, 5, 5, 0, 1000, 400).unwrap();
        assert_eq!(next, 100);
    }

    #[test]
    fn over_window_cap() {
        let e = err_name(decide(false, true, 200, true, 1000, 0, 5, 5, 900, 1000, 400));
        assert!(e.contains("DailyCapExceeded"), "got: {e}");
    }

    #[test]
    fn over_per_tx_cap() {
        let e = err_name(decide(false, true, 500, true, 1000, 0, 5, 5, 0, 1000, 400));
        assert!(e.contains("PerTxCapExceeded"), "got: {e}");
    }

    #[test]
    fn non_recipient() {
        let e = err_name(decide(false, true, 100, false, 1000, 0, 5, 5, 0, 1000, 400));
        assert!(e.contains("RecipientNotAllowed"), "got: {e}");
    }

    #[test]
    fn frozen() {
        let e = err_name(decide(true, true, 100, true, 1000, 0, 5, 5, 0, 1000, 400));
        assert!(e.contains("Frozen"), "got: {e}");
    }

    #[test]
    fn wrong_agent() {
        let e = err_name(decide(false, false, 100, true, 1000, 0, 5, 5, 0, 1000, 400));
        assert!(e.contains("Unauthorized"), "got: {e}");
    }

    #[test]
    fn zero_amount() {
        let e = err_name(decide(false, true, 0, true, 1000, 0, 5, 5, 0, 1000, 400));
        assert!(e.contains("ZeroAmount"), "got: {e}");
    }

    #[test]
    fn session_expired() {
        let e = err_name(decide(false, true, 100, true, 2000, 1500, 5, 5, 0, 1000, 400));
        assert!(e.contains("SessionExpired"), "got: {e}");
    }

    #[test]
    fn session_expired_at_boundary() {
        // now == expires_at is expired (V19 parity with the EVM vault).
        let e = err_name(decide(false, true, 100, true, 1500, 1500, 5, 5, 0, 1000, 400));
        assert!(e.contains("SessionExpired"), "got: {e}");
    }

    #[test]
    fn precedence() {
        // Frozen beats SessionExpired.
        let e = err_name(decide(true, true, 100, true, 2000, 1500, 5, 5, 0, 1000, 400));
        assert!(e.contains("Frozen"), "got: {e}");
        // SessionExpired beats ZeroAmount.
        let e = err_name(decide(false, true, 0, true, 2000, 1500, 5, 5, 0, 1000, 400));
        assert!(e.contains("SessionExpired"), "got: {e}");
        // ZeroAmount beats RecipientNotAllowed.
        let e = err_name(decide(false, true, 0, false, 1000, 0, 5, 5, 0, 1000, 400));
        assert!(e.contains("ZeroAmount"), "got: {e}");
        // RecipientNotAllowed beats both caps.
        let e = err_name(decide(false, true, 2000, false, 1000, 0, 5, 5, 0, 1000, 400));
        assert!(e.contains("RecipientNotAllowed"), "got: {e}");
        // DailyCapExceeded beats PerTxCapExceeded.
        let e = err_name(decide(false, true, 500, true, 1000, 0, 5, 5, 900, 1000, 400));
        assert!(e.contains("DailyCapExceeded"), "got: {e}");
    }

    #[test]
    fn window_rollover_resets_spent() {
        let next = decide(false, true, 100, true, 1000, 0, 6, 5, 1000, 1000, 400).unwrap();
        assert_eq!(next, 100);
    }

    #[test]
    fn spent_overflow_is_daily_cap() {
        let e = err_name(decide(false, true, 1, true, 1000, 0, 5, 5, u64::MAX, 1000, 400));
        assert!(e.contains("DailyCapExceeded"), "got: {e}");
    }

    #[test]
    fn window_index_at_edges() {
        assert_eq!(window_index_at(999, 1000, 86400), 0);
        assert_eq!(window_index_at(1000, 1000, 86400), 0);
        assert_eq!(window_index_at(1000 + 86400, 1000, 86400), 1);
        assert_eq!(window_index_at(1000 + 86400 - 1, 1000, 86400), 0);
    }

    #[test]
    fn set_hash_is_order_independent() {
        let a = Pubkey::new_from_array([1u8; 32]);
        let b = Pubkey::new_from_array([2u8; 32]);
        let h1 = set_hash(&[a, b]);
        let h2 = set_hash(&[b, a]);
        assert_eq!(h1, h2);
    }

    #[test]
    fn policy_hash_changes_with_fields() {
        let evm = [0u8; 32];
        let sol = [1u8; 32];
        let base = compute_policy_hash(1, 6, 2000, 5000, 86400, 1000, 0, &evm, &sol);
        let other = compute_policy_hash(1, 6, 2001, 5000, 86400, 1000, 0, &evm, &sol);
        assert_ne!(base, other);
    }

    #[test]
    fn validate_policy_rejects_bad_inputs() {
        let agent = Pubkey::new_from_array([9u8; 32]);
        let vault = Pubkey::new_from_array([8u8; 32]);
        let good = vec![
            Pubkey::new_from_array([1u8; 32]),
            Pubkey::new_from_array([2u8; 32]),
        ];
        assert!(validate_policy(1, 6, 86400, 1000, 0, &good, &agent, &vault).is_ok());
        assert!(validate_policy(2, 6, 86400, 1000, 0, &good, &agent, &vault).is_err());
        assert!(validate_policy(1, 18, 86400, 1000, 0, &good, &agent, &vault).is_err());
        assert!(validate_policy(1, 6, 59, 1000, 0, &good, &agent, &vault).is_err());
        assert!(validate_policy(1, 6, 86400, -1, 0, &good, &agent, &vault).is_err());
        assert!(validate_policy(1, 6, 86400, 1000, -1, &good, &agent, &vault).is_err());
        assert!(validate_policy(1, 6, 86400, 1000, 0, &[], &agent, &vault).is_err());
        assert!(validate_policy(1, 6, 86400, 1000, 0, &vec![Pubkey::default()], &agent, &vault).is_err());
        assert!(validate_policy(1, 6, 86400, 1000, 0, &vec![vault], &agent, &vault).is_err());
        assert!(validate_policy(1, 6, 86400, 1000, 0, &vec![agent], &agent, &vault).is_err());
        let dup = vec![
            Pubkey::new_from_array([1u8; 32]),
            Pubkey::new_from_array([1u8; 32]),
        ];
        assert!(validate_policy(1, 6, 86400, 1000, 0, &dup, &agent, &vault).is_err());
    }
}
