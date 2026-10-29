use anchor_lang::prelude::*;

declare_id!("BWVM3J3QfWoco8b1GUFCzX1T7vDhuKHQbN5FDShUXhbC");

/// T07 spike program: the Solana mirror of the EVM spike vault.
/// A 0-lamport AGENT key co-signs spends paid by any SUBMITTER (the fee
/// payer). The policy account itself holds the funds; spends move lamports
/// directly from the policy PDA, because the System Program refuses a
/// transfer whose source carries data. Checks run in D6 precedence order.
/// SPIKE scope, landing in T12a: no withdraw, no deadline/session, caps and
/// agent immutable after initialize (only allowlist and freeze are admin
/// settable). The devnet program id is generated fresh on the deploy
/// machine; this id is for local testing only.

#[program]
pub mod spendfloor {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        agent: Pubkey,
        allowlist: Vec<Pubkey>,
        daily_cap: u64,
        per_tx_cap: u64,
    ) -> Result<()> {
        require!(agent != Pubkey::default(), SpendError::InvalidAgent);
        require!(
            !allowlist.is_empty() && allowlist.len() <= 8,
            SpendError::InvalidAllowlist
        );
        let policy = &mut ctx.accounts.policy;
        policy.owner = ctx.accounts.owner.key();
        policy.agent = agent;
        policy.allowlist = allowlist;
        policy.daily_cap = daily_cap;
        policy.per_tx_cap = per_tx_cap;
        policy.frozen = false;
        policy.current_day = 0;
        policy.spent_today = 0;
        policy.bump = ctx.bumps.policy;
        Ok(())
    }

    pub fn set_allowed(ctx: Context<Admin>, account: Pubkey, ok: bool) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        require!(policy.owner == ctx.accounts.owner.key(), SpendError::NotOwner);
        if ok {
            if !policy.allowlist.contains(&account) {
                require!(policy.allowlist.len() < 8, SpendError::InvalidAllowlist);
                policy.allowlist.push(account);
            }
        } else {
            policy.allowlist.retain(|a| *a != account);
        }
        Ok(())
    }

    pub fn set_frozen(ctx: Context<Admin>, frozen: bool) -> Result<()> {
        let policy = &mut ctx.accounts.policy;
        require!(policy.owner == ctx.accounts.owner.key(), SpendError::NotOwner);
        policy.frozen = frozen;
        Ok(())
    }

    pub fn spend(ctx: Context<Spend>, amount: u64) -> Result<()> {
        // Balance read first: it is a copied u64, so no borrow persists.
        let balance = ctx.accounts.policy.to_account_info().lamports();
        {
            let policy = &mut ctx.accounts.policy;
            let agent_matches = ctx.accounts.agent.key() == policy.agent;
            let allowed = policy.allowlist.contains(&ctx.accounts.recipient.key());
            let day = Clock::get()?.unix_timestamp / 86_400;
            let next_spent = decide(
                policy.frozen,
                agent_matches,
                amount,
                allowed,
                day,
                policy.current_day,
                policy.spent_today,
                policy.daily_cap,
                policy.per_tx_cap,
            )?;
            require!(balance >= amount, SpendError::InsufficientFunds);
            policy.current_day = day;
            policy.spent_today = next_spent;
        }
        // Direct lamport move, not a system transfer CPI: the System Program
        // refuses a transfer whose source carries data ("from must not carry
        // data"), and the policy PDA carries the policy struct. The program
        // owns the policy account, so the runtime permits the debit;
        // crediting any account is always permitted. Rent-exempt guard lands
        // in T12a; spike spends sit far above rent-exempt.
        **ctx
            .accounts
            .policy
            .to_account_info()
            .try_borrow_mut_lamports()? -= amount;
        **ctx
            .accounts
            .recipient
            .to_account_info()
            .try_borrow_mut_lamports()? += amount;
        Ok(())
    }
}

/// Pure spend decision, mirroring the on-chain checks. The unit tests below
/// exercise this function attack-first; the on-chain wrapper adds account
/// validation, the clock, and the direct lamport move.
/// D6 order: Unauthorized -> Frozen -> ZeroAmount -> RecipientNotAllowed
/// -> DailyCapExceeded -> PerTxCapExceeded.
pub fn decide(
    frozen: bool,
    agent_matches: bool,
    amount: u64,
    allowed: bool,
    current_day: i64,
    stored_day: i64,
    stored_spent: u64,
    daily_cap: u64,
    per_tx_cap: u64,
) -> Result<u64> {
    require!(agent_matches, SpendError::Unauthorized);
    require!(!frozen, SpendError::Frozen);
    require!(amount > 0, SpendError::ZeroAmount);
    require!(allowed, SpendError::RecipientNotAllowed);
    let spent = if stored_day != current_day { 0 } else { stored_spent };
    let next = spent
        .checked_add(amount)
        .ok_or(SpendError::DailyCapExceeded)?;
    require!(next <= daily_cap, SpendError::DailyCapExceeded);
    require!(amount <= per_tx_cap, SpendError::PerTxCapExceeded);
    Ok(next)
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
    #[account(mut)]
    pub policy: Account<'info, Policy>,
}

#[derive(Accounts)]
pub struct Spend<'info> {
    #[account(mut, seeds = [b"policy"], bump = policy.bump)]
    pub policy: Account<'info, Policy>,
    /// CHECK: recipient is any account in the allowlist. The program only
    /// transfers lamports to it and never reads its data.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
    pub agent: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub owner: Pubkey,
    pub agent: Pubkey,
    #[max_len(8)]
    pub allowlist: Vec<Pubkey>,
    pub daily_cap: u64,
    pub per_tx_cap: u64,
    pub frozen: bool,
    pub current_day: i64,
    pub spent_today: u64,
    pub bump: u8,
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
    #[msg("Allowlist must contain 1 to 8 recipients")]
    InvalidAllowlist,
    #[msg("Caller is not the policy owner")]
    NotOwner,
    #[msg("Policy account does not hold enough lamports for the spend")]
    InsufficientFunds,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err_name<T: std::fmt::Debug>(r: Result<T>) -> String {
        format!("{}", r.unwrap_err())
    }

    #[test]
    fn valid_spend() {
        let next = decide(false, true, 100, true, 10, 10, 0, 1000, 400).unwrap();
        assert_eq!(next, 100);
    }

    #[test]
    fn over_daily_cap() {
        let e = err_name(decide(false, true, 200, true, 10, 10, 900, 1000, 400));
        assert!(e.contains("DailyCapExceeded"), "got: {e}");
    }

    #[test]
    fn over_per_tx_cap() {
        let e = err_name(decide(false, true, 500, true, 10, 10, 0, 1000, 400));
        assert!(e.contains("PerTxCapExceeded"), "got: {e}");
    }

    #[test]
    fn non_allowlisted() {
        let e = err_name(decide(false, true, 100, false, 10, 10, 0, 1000, 400));
        assert!(e.contains("RecipientNotAllowed"), "got: {e}");
    }

    #[test]
    fn frozen() {
        let e = err_name(decide(true, true, 100, true, 10, 10, 0, 1000, 400));
        assert!(e.contains("Frozen"), "got: {e}");
    }

    #[test]
    fn wrong_agent() {
        let e = err_name(decide(false, false, 100, true, 10, 10, 0, 1000, 400));
        assert!(e.contains("Unauthorized"), "got: {e}");
    }

    #[test]
    fn zero_amount() {
        let e = err_name(decide(false, true, 0, true, 10, 10, 0, 1000, 400));
        assert!(e.contains("ZeroAmount"), "got: {e}");
    }

    #[test]
    fn precedence() {
        // Frozen beats ZeroAmount.
        let e = err_name(decide(true, true, 0, true, 10, 10, 0, 1000, 400));
        assert!(e.contains("Frozen"), "got: {e}");
        // ZeroAmount beats RecipientNotAllowed.
        let e = err_name(decide(false, true, 0, false, 10, 10, 0, 1000, 400));
        assert!(e.contains("ZeroAmount"), "got: {e}");
        // RecipientNotAllowed beats both caps.
        let e = err_name(decide(false, true, 2000, false, 10, 10, 0, 1000, 400));
        assert!(e.contains("RecipientNotAllowed"), "got: {e}");
        // DailyCapExceeded beats PerTxCapExceeded.
        let e = err_name(decide(false, true, 500, true, 10, 10, 900, 1000, 400));
        assert!(e.contains("DailyCapExceeded"), "got: {e}");
    }

    #[test]
    fn day_rollover_resets_spent() {
        let next = decide(false, true, 100, true, 11, 10, 1000, 1000, 400).unwrap();
        assert_eq!(next, 100);
    }

    #[test]
    fn spent_overflow_is_daily_cap() {
        let e = err_name(decide(false, true, 1, true, 10, 10, u64::MAX, 1000, 400));
        assert!(e.contains("DailyCapExceeded"), "got: {e}");
    }
}
