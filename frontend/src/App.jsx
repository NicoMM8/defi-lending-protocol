import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import addresses from './contracts/addresses.json';
import LendingPoolABI from './contracts/LendingPool.json';
import ERC20ABI from './contracts/MockERC20.json';
import ActionModal from './components/ActionModal';
import './index.css';

function App() {
  const [account, setAccount] = useState(null);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [pool, setPool] = useState(null);
  
  // FIXME: Need to figure out a better way to handle these stats on mobile
  const [stats, setStats] = useState({ tvl: '...', totalBorrows: '...', healthFactor: '...' });
  const [markets, setMarkets] = useState([
    { name: 'USDC', address: addresses.USDC, ltv: '80%', apr: '4.2%', balance: '0' },
    { name: 'WETH', address: addresses.WETH, ltv: '70%', apr: '2.8%', balance: '0' }
  ]);
  const [loading, setLoading] = useState(false);
  const [currentView, setCurrentView] = useState('dashboard');
  
  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [activeMarket, setActiveMarket] = useState(null);
  const [activeAction, setActiveAction] = useState('Supply');

  const governanceProposals = [
    { id: 1, title: 'Add WBTC Market', status: 'Active', votesFor: '1.2M', votesAgainst: '40K' },
    { id: 2, title: 'Increase USDC LTV to 85%', status: 'Executed', votesFor: '2.5M', votesAgainst: '100K' }
  ];

  useEffect(() => {
    let p, lp;
    if (window.ethereum) {
      p = new ethers.BrowserProvider(window.ethereum);
      setProvider(p);
      lp = new ethers.Contract(addresses.LendingPool, LendingPoolABI, p);
      setPool(lp);
    } else {
      // Fallback for viewing stats without a wallet
      p = new ethers.JsonRpcProvider("http://localhost:8545");
      setProvider(p);
      lp = new ethers.Contract(addresses.LendingPool, LendingPoolABI, p);
      setPool(lp);
    }
  }, []);

  useEffect(() => {
    if (provider && pool) {
      loadData();
      
      const interval = setInterval(loadData, 30000);
      return () => clearInterval(interval);
    }
  }, [provider, pool, account]);

  const connectWallet = async () => {
    if (!provider) return;
    const s = await provider.getSigner();
    setSigner(s);
    setAccount(await s.getAddress());
    loadData();
  };

  const loadData = async () => {
    if (!provider || !pool) return;
    
    setLoading(true);
    try {
      // 1. Fetch market data and prices
      const oracleAddr = await pool.oracle();
      const oracle = new ethers.Contract(oracleAddr, ["function getTokenPrice(address) view returns (uint256)"], provider);
      
      const updatedMarkets = await Promise.all(
        markets.map(async (m) => {
          const marketData = await pool.markets(m.address);
          const price = await oracle.getTokenPrice(m.address);
          const supplyRate = await pool.getSupplyRate(m.address);
          
          // Convert rates to percentages (WAD math)
          const apr = (Number(supplyRate) / 1e16).toFixed(2) + '%';
          const ltv = (Number(marketData.ltv) / 1e16).toFixed(0) + '%';
          
          return { 
            ...m, 
            ltv, 
            apr, 
            price: Number(price) / 1e18,
            liquidity: Number(marketData.totalLiquidity) / 1e18,
            borrows: Number(marketData.totalBorrows) / 1e18
          };
        })
      );
      setMarkets(updatedMarkets);

      // 2. Calculate Dashboard Stats (TVL, Borrows)
      let totalTVL = 0;
      let totalBorrowsValue = 0;
      
      updatedMarkets.forEach(m => {
        totalTVL += (m.liquidity + m.borrows) * m.price;
        totalBorrowsValue += m.borrows * m.price;
      });

      // 3. Health Factor for connected user
      let hf = 'Safe';
      if (account) {
        const hfValue = await pool.getHealthFactor(account);
        if (hfValue > 1e20) {
          hf = 'Safe';
        } else {
          hf = (Number(hfValue) / 1e18).toFixed(2);
        }
      }

      setStats({
        tvl: '$' + (totalTVL / 1e6).toFixed(1) + 'M', // Assuming USDC is 6 decimals in price or normalized
        totalBorrows: '$' + (totalBorrowsValue / 1e3).toFixed(0) + 'K',
        healthFactor: hf
      });

    } catch (err) {
      console.error("Error fetching data:", err);
    }
    setLoading(false);
  };

  const openAction = (market, action) => {
    setActiveMarket(market);
    setActiveAction(action);
    setModalOpen(true);
  };

  const executeAction = async (amount) => {
    if (!signer || !pool) {
      alert("Please connect your wallet first!");
      return;
    }
    setLoading(true);
    try {
      const amt = ethers.parseUnits(amount, 18);
      const token = new ethers.Contract(activeMarket.address, ERC20ABI, signer);
      
      if (activeAction === 'Supply') {
        const txApp = await token.approve(addresses.LendingPool, amt);
        await txApp.wait();
        const tx = await pool.connect(signer).deposit(activeMarket.address, amt);
        await tx.wait();
      } else if (activeAction === 'Borrow') {
        const tx = await pool.connect(signer).borrow(activeMarket.address, amt);
        await tx.wait();
      }
      
      setModalOpen(false);
      loadData();
    } catch (err) {
      console.error(err);
      alert("Transaction failed! Check console for details.");
    }
    setLoading(false);
  };

  return (
    <div className="App">
      <nav className="sidebar glass">
        <div className="logo-container">
          <img src="./logo.png" className="logo-img" alt="logo" />
          <span className="brand-name">Zenith</span>
        </div>
        <ul className="nav-links">
          <li className={`nav-item ${currentView === 'dashboard' ? 'active' : ''}`} onClick={() => setCurrentView('dashboard')}>
            <span>Dashboard</span>
          </li>
          <li className={`nav-item ${currentView === 'governance' ? 'active' : ''}`} onClick={() => setCurrentView('governance')}>
            <span>Governance</span>
          </li>
        </ul>
      </nav>

      <main className="main-content">
        <header className="fade-in">
          <h2>{currentView === 'dashboard' ? 'Protocol Dashboard' : 'Governance Portal'}</h2>
          <button className="wallet-btn shimmer" onClick={connectWallet}>
            {account ? `${account.substring(0,6)}...${account.substring(38)}` : 'Connect Wallet'}
          </button>
        </header>

        {currentView === 'dashboard' ? (
          <>
            <section className="stats-grid fade-in">
              <div className="stat-card glass glow-on-hover">
                <div className="stat-label">Total Value Locked</div>
                <div className="stat-value">{stats.tvl}</div>
              </div>
              <div className="stat-card glass glow-on-hover">
                <div className="stat-label">Total Borrows</div>
                <div className="stat-value">{stats.totalBorrows}</div>
              </div>
              <div className="stat-card glass glow-on-hover">
                <div className="stat-label">Health Factor</div>
                <div className="stat-value" style={{ color: stats.healthFactor === 'Safe' ? '#00ff88' : '#ff4444' }}>
                  {stats.healthFactor}
                </div>
              </div>
            </section>

            <section className="market-section glass fade-in">
              <h3 className="section-title">Verified Markets</h3>
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>LTV</th>
                    <th>Supply APY</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.map((m, i) => (
                    <tr key={i} className="shimmer-hover">
                      <td><strong>{m.name}</strong></td>
                      <td>{m.ltv}</td>
                      <td style={{ color: '#00ff88' }}>{m.apr}</td>
                      <td style={{ display: 'flex', gap: '8px' }}>
                        <button className="action-btn" onClick={() => openAction(m, 'Supply')}>Supply</button>
                        <button className="action-btn" onClick={() => openAction(m, 'Borrow')}>Borrow</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        ) : (
          <section className="market-section glass fade-in">
            <h3 className="section-title">Active Proposals</h3>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Proposal</th>
                  <th>Status</th>
                  <th>Votes For</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {governanceProposals.map((p) => (
                  <tr key={p.id}>
                    <td>#{p.id}</td>
                    <td>{p.title}</td>
                    <td><span className={`status-badge ${p.status.toLowerCase()}`}>{p.status}</span></td>
                    <td>{p.votesFor}</td>
                    <td><button className="action-btn">Vote</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </main>

      <ActionModal 
        isOpen={modalOpen} 
        onClose={() => setModalOpen(false)}
        action={activeAction}
        tokenName={activeMarket?.name}
        loading={loading}
        onExecute={executeAction}
      />
    </div>
  );
}

export default App;
