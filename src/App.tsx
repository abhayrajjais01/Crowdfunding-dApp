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
    if (diff <= 0n) return "Campaign Closed";
    
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
            <button className="wallet-btn connected" onClick={handleDisconnect}>
              <span className="wallet-indicator"></span>
              {connectedAddress.slice(0, 4)}...{connectedAddress.slice(-4)}
            </button>
          ) : (
            <button className="wallet-btn" onClick={handleConnect}>
              <span className="wallet-indicator"></span>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {loading ? (
        <div className="panel" style={{ textAlign: 'center', padding: '4rem' }}>
          <div className="spinner" style={{ width: '40px', height: '40px', borderWidth: '4px', marginBottom: '1.5rem', color: 'var(--accent-purple)' }}></div>
          <p style={{ color: 'var(--text-secondary)' }}>Synchronizing ledger state...</p>
        </div>
      ) : (
        <div className="dashboard-grid">
          {/* Main Campaign Status Card */}
          <div className="panel">
            {!campaign ? (
              // Uninitialized Campaign State
              <div className="action-box">
                <h2>Initialize Campaign</h2>
                <p className="description" style={{ marginBottom: '1rem' }}>
                  No active crowdfunding campaign is initialized on this contract yet. If you are the contract creator, you can initialize one below.
                </p>
                
                <div className="input-group">
                  <label>Campaign Title</label>
                  <input value={initTitle} onChange={(e) => setInitTitle(e.target.value)} />
                </div>
                
                <div className="input-group">
                  <label>Description</label>
                  <input value={initDesc} onChange={(e) => setInitDesc(e.target.value)} />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
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
                  className="btn btn-primary" 
                  onClick={handleInitialize} 
                  disabled={!connectedAddress || txStatus.state !== 'idle'}
                  style={{ marginTop: '1rem' }}
                >
                  Initialize Smart Contract Campaign
                </button>
                {!connectedAddress && (
                  <p style={{ color: 'var(--accent-rose)', fontSize: '0.85rem', textAlign: 'center' }}>
                    * Connect your wallet to initialize this campaign.
                  </p>
                )}
              </div>
            ) : (
              // Active Campaign State
              <div>
                <h2>{campaign.title}</h2>
                <p className="description">{campaign.description}</p>

                <div className="stats-container">
                  <div className="stat-card">
                    <div className="stat-value">{formatStroopsToXlm(campaign.raised)}</div>
                    <div className="stat-label">Raised XLM</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{formatStroopsToXlm(campaign.target)}</div>
                    <div className="stat-label">Goal XLM</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value" style={{ color: isExpired ? 'var(--accent-rose)' : 'var(--accent-cyan)' }}>
                      {formatTimeLeft(campaign.deadline)}
                    </div>
                    <div className="stat-label">Status</div>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="progress-section">
                  <div className="progress-header">
                    <span>Progress ({progressPercent}%)</span>
                    <span>{formatStroopsToXlm(campaign.raised)} / {formatStroopsToXlm(campaign.target)} XLM</span>
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
                      <label>Pledge Amount</label>
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
                      Pledge to Campaign
                    </button>
                    {!connectedAddress && (
                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', textAlign: 'center' }}>
                        * Connect your wallet to back this campaign.
                      </p>
                    )}
                  </div>
                ) : (
                  // Expired Campaign Admin/Pledgee Actions
                  <div className="action-box">
                    <h3>Campaign Ended</h3>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', lineHeight: '1.5' }}>
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
                          {campaign.claimed ? "Funds Claimed" : "Withdraw Pledged Funds"}
                        </button>
                      ) : (
                        <button 
                          className="btn btn-danger" 
                          onClick={handleRefund}
                          disabled={!connectedAddress || userPledge === 0n || txStatus.state !== 'idle'}
                        >
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
                  <span className="tx-status-text">
                    {txStatus.state === 'preparing' && <><span className="spinner"></span>Preparing simulation</>}
                    {txStatus.state === 'signing' && <><span className="spinner"></span>Waiting for wallet signature</>}
                    {txStatus.state === 'submitting' && <><span className="spinner"></span>Submitting transaction</>}
                    {txStatus.state === 'success' && <><span className="tx-success">●</span>Success</>}
                    {txStatus.state === 'error' && <><span className="tx-error">●</span>Transaction Error</>}
                  </span>
                </div>
                <div className="tx-body">{txStatus.message}</div>
                {txStatus.hash && (
                  <a 
                    className="tx-link" 
                    href={`https://stellar.expert/explorer/testnet/tx/${txStatus.hash}`} 
                    target="_blank" 
                    rel="noreferrer"
                  >
                    View on Stellar Explorer ↗
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Right column: Contract Details and Real-time Activity Feed */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            {/* Contract Info Panel */}
            <div className="panel" style={{ padding: '1.75rem' }}>
              <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Contract Details</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.85rem' }}>
                <div>
                  <div style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>CROWDFUND CONTRACT ID</div>
                  <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', marginTop: '0.15rem', color: 'var(--accent-purple)' }}>{CONTRACT_ID}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>NATIVE XLM TOKEN ID</div>
                  <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', marginTop: '0.15rem', color: 'var(--accent-cyan)' }}>{TOKEN_ID}</div>
                </div>
                {connectedAddress && (
                  <div>
                    <div style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>YOUR PLEDGED BALANCE</div>
                    <div style={{ fontWeight: 700, marginTop: '0.15rem' }}>{formatStroopsToXlm(userPledge)} XLM</div>
                  </div>
                )}
              </div>
            </div>

            {/* Real-time Activity Log Panel */}
            <div className="panel events-panel" style={{ flexGrow: 1 }}>
              <h2 style={{ fontSize: '1.35rem', marginBottom: '0.5rem' }}>Live Activity Feed</h2>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                Real-time Soroban RPC events emitted by the smart contract.
              </p>
              
              <div className="events-list">
                {events.length === 0 ? (
                  <div className="empty-log">No contract events recorded yet.</div>
                ) : (
                  events.map((ev) => (
                    <div className="event-row" key={ev.id}>
                      <div>
                        <div className="event-actor">
                          {ev.actor.slice(0, 6)}...{ev.actor.slice(-6)}
                        </div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: '0.15rem' }}>
                          Ledger {ev.ledger}
                        </div>
                      </div>
                      <div className="event-details">
                        <span className="event-amount">{ev.amount} XLM</span>
                        <span className={`event-badge badge-${ev.type}`}>{ev.type}</span>
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
