#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, symbol_short, token, Address, Env, String
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    DeadlinePassed = 3,
    DeadlineNotPassed = 4,
    GoalNotMet = 5,
    GoalMet = 6,
    InvalidAmount = 7,
    AlreadyClaimed = 8,
}

#[contracttype]
pub enum DataKey {
    Campaign,        // CampaignInfo
    Pledge(Address), // i128
    Initialized,     // bool
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CampaignInfo {
    pub creator: Address,
    pub target: i128,
    pub deadline: u64,
    pub token: Address,
    pub title: String,
    pub description: String,
    pub raised: i128,
    pub claimed: bool,
}

#[contract]
pub struct CrowdfundingContract;

#[contractimpl]
impl CrowdfundingContract {
    pub fn initialize(
        env: Env,
        creator: Address,
        target_amount: i128,
        deadline: u64,
        token: Address,
        title: String,
        description: String,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::AlreadyInitialized);
        }

        if target_amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let campaign = CampaignInfo {
            creator,
            target: target_amount,
            deadline,
            token,
            title,
            description,
            raised: 0,
            claimed: false,
        };

        env.storage().instance().set(&DataKey::Campaign, &campaign);
        env.storage().instance().set(&DataKey::Initialized, &true);

        // Bump the instance storage TTL to avoid expiration
        env.storage().instance().extend_ttl(10000, 10000);

        Ok(())
    }

    pub fn pledge(env: Env, donor: Address, amount: i128) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let mut campaign: CampaignInfo = env.storage().instance().get(&DataKey::Campaign).unwrap();

        if env.ledger().timestamp() >= campaign.deadline {
            return Err(Error::DeadlinePassed);
        }

        donor.require_auth();

        // Transfer tokens from donor to contract
        let token_client = token::Client::new(&env, &campaign.token);
        token_client.transfer(&donor, &env.current_contract_address(), &amount);

        // Update pledge amount
        let key = DataKey::Pledge(donor.clone());
        let current_pledge: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let new_pledge = current_pledge + amount;
        env.storage().persistent().set(&key, &new_pledge);
        // Extend persistent storage TTL
        env.storage().persistent().extend_ttl(&key, 10000, 10000);

        // Update campaign raised amount
        campaign.raised += amount;
        env.storage().instance().set(&DataKey::Campaign, &campaign);

        // Emit event
        env.events().publish(
            (symbol_short!("pledge"), donor),
            amount,
        );

        Ok(())
    }

    pub fn withdraw(env: Env) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }

        let mut campaign: CampaignInfo = env.storage().instance().get(&DataKey::Campaign).unwrap();

        if campaign.claimed {
            return Err(Error::AlreadyClaimed);
        }

        if campaign.raised < campaign.target {
            return Err(Error::GoalNotMet);
        }

        campaign.creator.require_auth();

        // Transfer all raised tokens to creator
        let token_client = token::Client::new(&env, &campaign.token);
        token_client.transfer(
            &env.current_contract_address(),
            &campaign.creator,
            &campaign.raised,
        );

        campaign.claimed = true;
        env.storage().instance().set(&DataKey::Campaign, &campaign);

        // Emit event
        env.events().publish(
            (symbol_short!("withdraw"), campaign.creator.clone()),
            campaign.raised,
        );

        Ok(())
    }

    pub fn refund(env: Env, donor: Address) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }

        let mut campaign: CampaignInfo = env.storage().instance().get(&DataKey::Campaign).unwrap();

        if env.ledger().timestamp() < campaign.deadline {
            return Err(Error::DeadlineNotPassed);
        }

        if campaign.raised >= campaign.target {
            return Err(Error::GoalMet);
        }

        donor.require_auth();

        let key = DataKey::Pledge(donor.clone());
        let pledge_amount: i128 = env.storage().persistent().get(&key).unwrap_or(0);

        if pledge_amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // Transfer pledge back to donor
        let token_client = token::Client::new(&env, &campaign.token);
        token_client.transfer(
            &env.current_contract_address(),
            &donor,
            &pledge_amount,
        );

        // Reset pledge
        env.storage().persistent().set(&key, &0i128);

        // Update campaign raised amount
        campaign.raised -= pledge_amount;
        env.storage().instance().set(&DataKey::Campaign, &campaign);

        // Emit event
        env.events().publish(
            (symbol_short!("refund"), donor),
            pledge_amount,
        );

        Ok(())
    }

    pub fn get_campaign(env: Env) -> Result<CampaignInfo, Error> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(Error::NotInitialized);
        }

        let campaign: CampaignInfo = env.storage().instance().get(&DataKey::Campaign).unwrap();
        Ok(campaign)
    }

    pub fn get_pledge(env: Env, donor: Address) -> i128 {
        let key = DataKey::Pledge(donor);
        env.storage().persistent().get(&key).unwrap_or(0)
    }
}

mod test;
