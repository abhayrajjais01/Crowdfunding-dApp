#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token, Address, Env, String
};

#[test]
fn test_crowdfunding_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    // 1. Setup accounts
    let creator = Address::generate(&env);
    let donor1 = Address::generate(&env);
    let donor2 = Address::generate(&env);

    // 2. Setup mock token contract (Stellar Asset Contract)
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = sac.address();
    let token_client = token::Client::new(&env, &token_address);
    let stellar_asset_client = token::StellarAssetClient::new(&env, &token_address);

    // Mint tokens to donors
    stellar_asset_client.mint(&donor1, &1000i128);
    stellar_asset_client.mint(&donor2, &500i128);

    // Verify initial donor balances
    assert_eq!(token_client.balance(&donor1), 1000i128);
    assert_eq!(token_client.balance(&donor2), 500i128);

    // 3. Register and initialize Crowdfunding Contract
    let contract_id = env.register(CrowdfundingContract, ());
    let crowdfund_client = CrowdfundingContractClient::new(&env, &contract_id);

    let target_amount = 1200i128;
    let deadline = 100u64; // ledger timestamp
    let title = String::from_str(&env, "Save the Forests");
    let description = String::from_str(&env, "Help us plant 1000 trees.");

    // Initialise
    crowdfund_client.initialize(
        &creator,
        &target_amount,
        &deadline,
        &token_address,
        &title,
        &description,
    );

    // Assert double-initialization fails
    let double_init_res = crowdfund_client.try_initialize(
        &creator,
        &target_amount,
        &deadline,
        &token_address,
        &title,
        &description,
    );
    assert!(double_init_res.is_err());

    // Verify campaign details
    let campaign = crowdfund_client.get_campaign();
    assert_eq!(campaign.creator, creator);
    assert_eq!(campaign.target, target_amount);
    assert_eq!(campaign.deadline, deadline);
    assert_eq!(campaign.token, token_address);
    assert_eq!(campaign.title, title);
    assert_eq!(campaign.description, description);
    assert_eq!(campaign.raised, 0i128);
    assert_eq!(campaign.claimed, false);

    // 4. Test Pledge Action
    // Donor 1 pledges 800
    crowdfund_client.pledge(&donor1, &800i128);
    assert_eq!(token_client.balance(&donor1), 200i128); // 1000 - 800
    assert_eq!(token_client.balance(&contract_id), 800i128);
    assert_eq!(crowdfund_client.get_pledge(&donor1), 800i128);
    assert_eq!(crowdfund_client.get_campaign().raised, 800i128);

    // Donor 2 pledges 500 (total = 1300, target met)
    crowdfund_client.pledge(&donor2, &500i128);
    assert_eq!(token_client.balance(&donor2), 0i128); // 500 - 500
    assert_eq!(token_client.balance(&contract_id), 1300i128);
    assert_eq!(crowdfund_client.get_pledge(&donor2), 500i128);
    assert_eq!(crowdfund_client.get_campaign().raised, 1300i128);

    // Assert pledging after deadline fails
    env.ledger().set_timestamp(deadline + 1);
    let donor1_late_pledge_res = crowdfund_client.try_pledge(&donor1, &100i128);
    assert!(donor1_late_pledge_res.is_err());

    // 5. Test Withdraw Action (Goal is met, deadline passed)
    // Creator withdraws
    crowdfund_client.withdraw();
    assert_eq!(token_client.balance(&creator), 1300i128);
    assert_eq!(token_client.balance(&contract_id), 0i128);
    assert_eq!(crowdfund_client.get_campaign().claimed, true);

    // Assert double withdraw fails
    let double_withdraw_res = crowdfund_client.try_withdraw();
    assert!(double_withdraw_res.is_err());
}

#[test]
fn test_crowdfunding_refund() {
    let env = Env::default();
    env.mock_all_auths();

    // Setup accounts
    let creator = Address::generate(&env);
    let donor1 = Address::generate(&env);

    // Setup mock token
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = sac.address();
    let token_client = token::Client::new(&env, &token_address);
    let stellar_asset_client = token::StellarAssetClient::new(&env, &token_address);

    stellar_asset_client.mint(&donor1, &1000i128);

    // Register and initialize contract
    let contract_id = env.register(CrowdfundingContract, ());
    let crowdfund_client = CrowdfundingContractClient::new(&env, &contract_id);

    let target_amount = 1200i128;
    let deadline = 100u64;
    let title = String::from_str(&env, "Save the Forests");
    let description = String::from_str(&env, "Help us plant 1000 trees.");

    crowdfund_client.initialize(
        &creator,
        &target_amount,
        &deadline,
        &token_address,
        &title,
        &description,
    );

    // Donor 1 pledges 800 (under target)
    crowdfund_client.pledge(&donor1, &800i128);
    assert_eq!(token_client.balance(&donor1), 200i128);
    assert_eq!(token_client.balance(&contract_id), 800i128);

    // Assert refund before deadline fails
    let refund_early_res = crowdfund_client.try_refund(&donor1);
    assert!(refund_early_res.is_err());

    // Advance time past deadline
    env.ledger().set_timestamp(deadline + 1);

    // Assert withdraw fails since goal not met
    let withdraw_fail_res = crowdfund_client.try_withdraw();
    assert!(withdraw_fail_res.is_err());

    // Refund donor 1
    crowdfund_client.refund(&donor1);
    assert_eq!(token_client.balance(&donor1), 1000i128); // gets all 800 back
    assert_eq!(token_client.balance(&contract_id), 0i128);
    assert_eq!(crowdfund_client.get_pledge(&donor1), 0i128);
    assert_eq!(crowdfund_client.get_campaign().raised, 0i128);
}
