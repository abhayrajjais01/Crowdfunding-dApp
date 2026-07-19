import { useEffect, useState } from 'react';
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit';
import { defaultModules } from '@creit.tech/stellar-wallets-kit/modules/utils';
import { 
  getCampaignInfo, 
  getPledge, 
  getCampaignEvents, 
  getLatestLedgerSequence, 
  preparePledgeTx, 
  prepareWithdrawTx, 
  prepareRefundTx,
  prepareInitializeTx,
  submitSignedXdr, 
  CONTRACT_ID,
  TOKEN_ID,
  NETWORK_PASSPHRASE
} from './stellar';
import type { CampaignInfo, CampaignEvent } from './stellar';

// Initialize StellarWalletsKit statically
StellarWalletsKit.init({
  modules: defaultModules(),
});

export default function App() {
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<CampaignInfo | null>(null);
  const [userPledge, setUserPledge] = useState<bigint>(0n);
  const [events, setEvents] = useState<CampaignEvent[]>([]);
  
  // Copy state
  const [copiedContract, setCopiedContract] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);

  // Form inputs
  const [pledgeAmount, setPledgeAmount] = useState<string>('10');
  const [initTarget, setInitTarget] = useState<string>('100');
  const [initDuration, setInitDuration] = useState<string>('10'); // in minutes
  const [initTitle, setInitTitle] = useState<string>('Clean the Oceans');
  const [initDesc, setInitDesc] = useState<string>('Fund a mission to remove plastic waste from the Pacific Ocean.');

  // UI state
  const [loading, setLoading] = useState<boolean>(true);
  const [txStatus, setTxStatus] = useState<{
    state: 'idle' | 'preparing' | 'signing' | 'submitting' | 'success' | 'error';
    message: string;
    hash?: string;
  }>({ state: 'idle', message: '' });

  // Load and refresh campaign status
  const refreshCampaignData = async () => {
    try {
      const info = await getCampaignInfo();
      setCampaign(info);
      
      if (connectedAddress) {
        const pledge = await getPledge(connectedAddress);
        setUserPledge(pledge);
      }
    } catch (err: any) {
      console.log("Campaign not initialized yet or query failed:", err.message);
      setCampaign(null);
    }
  };

  // Check connection on load
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const session = await StellarWalletsKit.getAddress();
        if (session && session.address) {
          setConnectedAddress(session.address);
        }
      } catch (err) {
        console.log("No active wallet session found on load");
      } finally {
        setLoading(false);
      }
    };
    checkConnection();
  }, []);

  // Fetch campaign data when address or mounting changes
  useEffect(() => {
    setLoading(true);
    refreshCampaignData().finally(() => setLoading(false));
  }, [connectedAddress]);

  // Real-time Event Polling Loop
  useEffect(() => {
    let isMounted = true;
    let pollInterval: any;

    const startEventPolling = async () => {
      try {
        let currentLedger = await getLatestLedgerSequence();
        // Fetch events from 200 ledgers ago for initial log
        const initialEvents = await getCampaignEvents(Math.max(1, currentLedger - 200));
        if (isMounted) {
          setEvents(initialEvents.reverse());
        }

        pollInterval = setInterval(async () => {
          try {
            const nextLedger = await getLatestLedgerSequence();
            if (nextLedger > currentLedger) {
              const newEvents = await getCampaignEvents(currentLedger);
              if (newEvents.length > 0 && isMounted) {
                setEvents(prev => {
                  const existingIds = new Set(prev.map(e => e.id));
                  const filteredNew = newEvents.filter(e => !existingIds.has(e.id));
                  return [...filteredNew.reverse(), ...prev];
                });
                // Refresh data to update progress in real-time
                refreshCampaignData();
              }
              currentLedger = nextLedger;
            }
          } catch (err) {
            console.error("Error polling events", err);
          }
        }, 5000);
      } catch (err) {
        console.error("Failed to start event polling", err);
      }
    };

    startEventPolling();

    return () => {
      isMounted = false;
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [connectedAddress]);

  // Copy helper
  const handleCopy = (text: string, type: 'contract' | 'token') => {
    navigator.clipboard.writeText(text);
    if (type === 'contract') {
      setCopiedContract(true);
      setTimeout(() => setCopiedContract(false), 1500);
    } else {
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 1500);
    }
  };

  // Helper to map contract errors to user-friendly messages
  const getFriendlyError = (err: any): string => {
    const msg = err.message || String(err);
    if (msg.includes("rejected") || msg.includes("User denied") || msg.includes("cancel")) {
      return "Transaction rejected. Please approve the transaction in your wallet extension.";
    }
    if (msg.includes("not funded") || msg.includes("active")) {
      return "Your connected account is not active or funded on Testnet yet. Please fund it via Friendbot.";
    }
    if (msg.includes("Contract") || msg.includes("HostError")) {
      if (msg.includes("Contract, 1") || msg.includes("Error(Contract, 1)")) return "Campaign is already initialized.";
      if (msg.includes("Contract, 2") || msg.includes("Error(Contract, 2)")) return "Campaign has not been initialized yet.";
      if (msg.includes("Contract, 3") || msg.includes("Error(Contract, 3)")) return "Pledge failed: The campaign deadline has passed.";
      if (msg.includes("Contract, 4") || msg.includes("Error(Contract, 4)")) return "Action failed: The campaign deadline has not passed yet.";
      if (msg.includes("Contract, 5") || msg.includes("Error(Contract, 5)")) return "Withdrawal failed: The funding target has not been met.";
      if (msg.includes("Contract, 6") || msg.includes("Error(Contract, 6)")) return "Refund failed: The funding target was met successfully.";
      if (msg.includes("Contract, 7") || msg.includes("Error(Contract, 7)")) return "Invalid pledge or refund amount.";
      if (msg.includes("Contract, 8") || msg.includes("Error(Contract, 8)")) return "Withdrawal failed: Funds have already been claimed.";
    }
    return msg;
  };

  // Wallet Connection Actions
  const handleConnect = async () => {
    try {
      setTxStatus({ state: 'idle', message: '' });
      await StellarWalletsKit.authModal();
      const session = await StellarWalletsKit.getAddress();
      if (session && session.address) {
        setConnectedAddress(session.address);
      }
    } catch (err: any) {
      setTxStatus({
        state: 'error',
        message: getFriendlyError(err)
      });
    }
  };

  const handleDisconnect = async () => {
    try {
      await StellarWalletsKit.disconnect();
      setConnectedAddress(null);
      setUserPledge(0n);
      setTxStatus({ state: 'idle', message: '' });
    } catch (err: any) {
      console.error("Disconnect failed", err);
    }
  };

  // Submit flow helper
  const executeTransaction = async (buildTxFn: () => Promise<any>) => {
    if (!connectedAddress) {
      setTxStatus({ state: 'error', message: 'Please connect your wallet first.' });
      return;
    }

    try {
      setTxStatus({ state: 'preparing', message: 'Simulating transaction & setting footprint...' });
      const preparedTx = await buildTxFn();

      setTxStatus({ state: 'signing', message: 'Awaiting wallet signature...' });
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(preparedTx.toXDR(), {
        networkPassphrase: NETWORK_PASSPHRASE,
        address: connectedAddress,
      });

      setTxStatus({ state: 'submitting', message: 'Submitting transaction to Testnet...' });
      const result = await submitSignedXdr(signedTxXdr);

      if (result.success) {
        setTxStatus({
          state: 'success',
          message: 'Transaction successfully executed on-chain!',
          hash: result.hash
        });
        refreshCampaignData();
      } else {
        setTxStatus({
          state: 'error',
          message: getFriendlyError(new Error(result.error)),
          hash: result.hash
        });
      }
    } catch (err: any) {
      setTxStatus({
        state: 'error',
        message: getFriendlyError(err)
      });
    }
  };

  // Transaction triggers
  const handlePledge = () => {
    executeTransaction(() => preparePledgeTx(connectedAddress!, pledgeAmount));
  };

  const handleWithdraw = () => {
    executeTransaction(() => prepareWithdrawTx(connectedAddress!));
  };

  const handleRefund = () => {
    executeTransaction(() => prepareRefundTx(connectedAddress!));
  };

  const handleInitialize = () => {
    const deadlineTimestamp = Math.floor(Date.now() / 1000) + parseInt(initDuration) * 60;
    executeTransaction(() => prepareInitializeTx(
      connectedAddress!,
      initTarget,
      deadlineTimestamp,
      initTitle,
      initDesc
    ));
  };

  // Time remaining calculator
  const formatTimeLeft = (deadlineSec: bigint): string => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const diff = deadlineSec - nowSec;
    if (diff <= 0n) return "Campaign Ended";
    
    const days = diff / 86400n;
    const hours = (diff % 86400n) / 3600n;
    const minutes = (diff % 3600n) / 60n;
    
    if (days > 0n) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0n) return `${hours}h ${minutes}m`;
    return `${minutes}m remaining`;
  };

  // Formatting large integers to XLM (divide stroops by 10^7)
  const formatStroopsToXlm = (stroops: bigint): string => {
    return (Number(stroops) / 10000000).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });
  };

  // Calculating progress
  const progressPercent = campaign && campaign.target > 0n 
    ? Math.min(100, Math.floor(Number(campaign.raised * 100n / campaign.target))) 
    : 0;

  const isExpired = campaign ? BigInt(Math.floor(Date.now() / 1000)) >= campaign.deadline : false;
  const isGoalMet = campaign ? campaign.raised >= campaign.target : false;

  return (
    <div className="app-container">
      {/* Header */}
      <header>
        <div className="logo-section">
          <h1>Stellar Raise</h1>
          <p>Level 2 - Yellow Belt Submission</p>
        </div>
        <div>
          {connectedAddress ? (
            <button className="wallet-btn connected font-mono" onClick={handleDisconnect}>
              <span className="wallet-indicator"></span>
              {connectedAddress.slice(0, 5)}...{connectedAddress.slice(-5)}
            </button>
          ) : (
            <button className="wallet-btn" onClick={handleConnect}>
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '0.2rem' }}><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 10h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8z"/><path d="M16 14h.01"/></svg>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {loading ? (
        <div className="panel" style={{ textAlign: 'center', padding: '5rem 2rem' }}>
          <div className="spinner" style={{ width: '45px', height: '45px', borderWidth: '4px', marginBottom: '1.5rem', color: '#10b981' }}></div>
          <p style={{ color: 'var(--text-secondary)', fontFamily: 'Fira Code', fontSize: '0.9rem' }}>Synchronizing testnet ledger sequence...</p>
        </div>
      ) : (
        <div className="dashboard-grid">
          {/* Main Campaign Status Card */}
          <div className="panel">
            {!campaign ? (
              // Uninitialized Campaign State
              <div className="action-box">
                <h2 style={{ fontSize: '1.45rem', borderBottom: '1px solid var(--panel-border)', paddingBottom: '0.85rem' }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                  Setup Crowdfunding Campaign
                </h2>
                <p className="description" style={{ marginBottom: '1.5rem' }}>
                  The crowdfunding smart contract has been deployed but not initialized yet. Configure campaign parameters below.
                </p>
                
                <div className="input-group">
                  <label>Campaign Title</label>
                  <input value={initTitle} onChange={(e) => setInitTitle(e.target.value)} placeholder="Campaign Title" />
                </div>
                
                <div className="input-group">
                  <label>Description</label>
                  <input value={initDesc} onChange={(e) => setInitDesc(e.target.value)} placeholder="Describe your funding goal..." />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
                  <div className="input-group">
                    <label>Funding Target</label>
                    <div className="input-wrapper">
                      <input type="number" value={initTarget} onChange={(e) => setInitTarget(e.target.value)} />
                      <span className="input-suffix">XLM</span>
                    </div>
                  </div>

                  <div className="input-group">
                    <label>Duration (Minutes)</label>
                    <div className="input-wrapper">
                      <input type="number" value={initDuration} onChange={(e) => setInitDuration(e.target.value)} />
                      <span className="input-suffix">MIN</span>
                    </div>
                  </div>
                </div>

                <button 
                  className="btn btn-admin" 
                  onClick={handleInitialize} 
                  disabled={!connectedAddress || txStatus.state !== 'idle'}
                  style={{ marginTop: '1rem' }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                  Initialize Campaign Contract
                </button>
                {!connectedAddress && (
                  <p style={{ color: 'var(--accent-rose)', fontSize: '0.825rem', textAlign: 'center', fontWeight: 600 }}>
                    * You must connect your Stellar wallet to execute the initialize transaction.
                  </p>
                )}
              </div>
            ) : (
              // Active Campaign State
              <div>
                <h2 style={{ fontSize: '1.8rem', background: 'linear-gradient(135deg, #f8fafc 0%, #cbd5e1 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  {campaign.title}
                </h2>
                <p className="description" style={{ fontSize: '0.98rem', marginTop: '0.5rem', marginBottom: '2rem' }}>
                  {campaign.description}
                </p>

                <div className="stats-container">
                  <div className="stat-card">
                    <div className="stat-value font-mono">
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(-45deg)' }}><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg>
                      {formatStroopsToXlm(campaign.raised)}
                    </div>
                    <div className="stat-label">Raised XLM</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value font-mono">
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>
                      {formatStroopsToXlm(campaign.target)}
                    </div>
                    <div className="stat-label">Target Goal</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value font-mono" style={{ color: isExpired ? 'var(--accent-rose)' : 'var(--accent-cyan)', fontSize: '1.45rem' }}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                      {formatTimeLeft(campaign.deadline)}
                    </div>
                    <div className="stat-label">Time Status</div>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="progress-section">
                  <div className="progress-header">
                    <span>Progress Indicator</span>
                    <span className="font-mono">{progressPercent}% ({formatStroopsToXlm(campaign.raised)} / {formatStroopsToXlm(campaign.target)} XLM)</span>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${progressPercent}%` }}></div>
                  </div>
                </div>

                {/* Main Action Forms */}
                {!isExpired ? (
                  // Active Pledging State
                  <div className="action-box">
                    <div className="input-group">
                      <label>
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                        Pledge Amount
                      </label>
                      <div className="input-wrapper">
                        <input 
                          type="number" 
                          value={pledgeAmount} 
                          onChange={(e) => setPledgeAmount(e.target.value)} 
                          disabled={txStatus.state !== 'idle'} 
                        />
                        <span className="input-suffix">XLM</span>
                      </div>
                    </div>
                    <button 
                      className="btn btn-primary" 
                      onClick={handlePledge}
                      disabled={!connectedAddress || txStatus.state !== 'idle' || parseFloat(pledgeAmount) <= 0}
                    >
                      Pledge Funds to Campaign
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                    </button>
                    {!connectedAddress && (
                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.825rem', textAlign: 'center', fontWeight: 600 }}>
                        * Connect your wallet to back this campaign.
                      </p>
                    )}
                  </div>
                ) : (
                  // Expired Campaign Admin/Pledgee Actions
                  <div className="action-box">
                    <h3>Campaign Expired</h3>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: '1.5', marginBottom: '0.5rem' }}>
                      {isGoalMet 
                        ? "Success! The funding target has been reached. The campaign creator can now withdraw the raised funds."
                        : "Expired. The campaign failed to reach its target. Backers can claim refunds for their pledged amounts."}
                    </p>

                    <div className="admin-actions">
                      {isGoalMet ? (
                        <button 
                          className="btn btn-primary" 
                          onClick={handleWithdraw}
                          disabled={!connectedAddress || campaign.claimed || txStatus.state !== 'idle'}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1v22"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                          {campaign.claimed ? "Funds Already Claimed" : "Withdraw Campaign Funds"}
                        </button>
                      ) : (
                        <button 
                          className="btn btn-danger" 
                          onClick={handleRefund}
                          disabled={!connectedAddress || userPledge === 0n || txStatus.state !== 'idle'}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                          Claim Refund ({formatStroopsToXlm(userPledge)} XLM)
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Transaction status card */}
            {txStatus.state !== 'idle' && (
              <div className="tx-status-card">
                <div className="tx-header">
                  <span className="tx-status-text font-mono">
                    {txStatus.state === 'preparing' && <><span className="spinner" style={{ color: 'var(--accent-cyan)' }}></span>Simulation Active</>}
                    {txStatus.state === 'signing' && <><span className="spinner" style={{ color: 'var(--accent-purple)' }}></span>Waiting for Signature</>}
                    {txStatus.state === 'submitting' && <><span className="spinner" style={{ color: '#f59e0b' }}></span>Broadcasting Transaction</>}
                    {txStatus.state === 'success' && <><span className="tx-success" style={{ marginRight: '0.2rem' }}>●</span>Success</>}
                    {txStatus.state === 'error' && <><span className="tx-error" style={{ marginRight: '0.2rem' }}>●</span>Transaction Error</>}
                  </span>
                </div>
                <div className="tx-body font-mono">{txStatus.message}</div>
                {txStatus.hash && (
                  <a 
                    className="tx-link font-mono" 
                    href={`https://stellar.expert/explorer/testnet/tx/${txStatus.hash}`} 
                    target="_blank" 
                    rel="noreferrer"
                  >
                    View on Explorer
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Right column: Contract Details and Real-time Activity Feed */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2.25rem' }}>
            {/* Contract Info Panel */}
            <div className="panel" style={{ padding: '2rem' }}>
              <h2 style={{ fontSize: '1.2rem', marginBottom: '1.25rem', borderBottom: '1px solid var(--panel-border)', paddingBottom: '0.6rem' }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22d3ee" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                Contract Details
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <div style={{ color: 'var(--text-secondary)', fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>CROWDFUND CONTRACT ID</div>
                  <div className="address-row">
                    <span className="address-text">{CONTRACT_ID.slice(0, 10)}...{CONTRACT_ID.slice(-10)}</span>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      {copiedContract && <span className="copy-success-tooltip">Copied!</span>}
                      <button className="btn-copy" onClick={() => handleCopy(CONTRACT_ID, 'contract')}>
                        {copiedContract ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-secondary)', fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>NATIVE XLM TOKEN ID</div>
                  <div className="address-row">
                    <span className="address-text">{TOKEN_ID.slice(0, 10)}...{TOKEN_ID.slice(-10)}</span>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      {copiedToken && <span className="copy-success-tooltip">Copied!</span>}
                      <button className="btn-copy" onClick={() => handleCopy(TOKEN_ID, 'token')}>
                        {copiedToken ? (
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                        ) : (
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
                {connectedAddress && (
                  <div>
                    <div style={{ color: 'var(--text-secondary)', fontWeight: 700, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>YOUR PLEDGED BALANCE</div>
                    <div className="font-mono" style={{ fontWeight: 700, fontSize: '1.2rem', marginTop: '0.35rem', color: 'var(--accent-green)' }}>
                      {formatStroopsToXlm(userPledge)} XLM
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Real-time Activity Log Panel */}
            <div className="panel events-panel" style={{ flexGrow: 1 }}>
              <h2 style={{ fontSize: '1.25rem', borderBottom: '1px solid var(--panel-border)', paddingBottom: '0.6rem', marginBottom: '0.25rem' }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
                Live Activity Feed
              </h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>
                Real-time Soroban RPC events emitted by the smart contract.
              </p>
              
              <div className="events-list">
                {events.length === 0 ? (
                  <div className="empty-log">No contract events recorded yet.</div>
                ) : (
                  events.map((ev) => (
                    <div className="event-row" key={ev.id}>
                      <div>
                        <div className="event-actor font-mono">
                          {ev.actor.slice(0, 6)}...{ev.actor.slice(-6)}
                        </div>
                        <div className="font-mono" style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: '0.15rem' }}>
                          Ledger {ev.ledger}
                        </div>
                      </div>
                      <div className="event-details">
                        <span className="event-amount font-mono">{ev.amount} XLM</span>
                        <div className="event-badge-container">
                          {ev.type === 'pledge' && (
                            <span className="event-badge badge-pledge">Pledge</span>
                          )}
                          {ev.type === 'withdraw' && (
                            <span className="event-badge badge-withdraw">Withdraw</span>
                          )}
                          {ev.type === 'refund' && (
                            <span className="event-badge badge-refund">Refund</span>
                          )}
                          {ev.type === 'unknown' && (
                            <span className="event-badge" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>Event</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
