const fs = require('fs');
const path = require('path');

const base = 'frontend';
const src = path.join(base, 'src');
const components = path.join(src, 'components');
const contracts = path.join(src, 'contracts');
const publicDir = path.join(base, 'public');

[base, src, components, contracts, publicDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// 1. vite.config.js
fs.writeFileSync(path.join(base, 'vite.config.js'), `
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`);

// 2. main.jsx
fs.writeFileSync(path.join(src, 'main.jsx'), `
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
`);

// 3. index.css (The full premium CSS)
fs.writeFileSync(path.join(src, 'index.css'), `
:root {
  --bg-dark: #0a0b0d;
  --glass-bg: rgba(255, 255, 255, 0.03);
  --glass-border: rgba(255, 255, 255, 0.1);
  --primary-glow: #00f2ff;
  --accent-purple: #7000ff;
  --accent-gradient: linear-gradient(135deg, #00f2ff 0%, #7000ff 100%);
  --text-muted: #8a8f98;
  --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

body {
  margin: 0;
  background-color: var(--bg-dark);
  background-image: 
    radial-gradient(circle at 20% 20%, rgba(0, 242, 255, 0.05) 0%, transparent 40%),
    radial-gradient(circle at 80% 80%, rgba(112, 0, 255, 0.05) 0%, transparent 40%);
  color: #fff;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  min-height: 100vh;
  overflow-x: hidden;
}

.App { display: flex; min-height: 100vh; }
.glass { background: var(--glass-bg); backdrop-filter: blur(12px); border: 1px solid var(--glass-border); border-radius: 20px; }

.sidebar { width: 260px; padding: 2.5rem 1.5rem; border-right: 1px solid var(--glass-border); }
.logo-container { display: flex; align-items: center; gap: 12px; margin-bottom: 3.5rem; }
.logo-img { width: 35px; height: 35px; filter: drop-shadow(0 0 8px var(--primary-glow)); }
.brand-name { font-size: 1.5rem; font-weight: 700; background: var(--accent-gradient); background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent; }

.nav-links { list-style: none; padding: 0; }
.nav-item { padding: 1rem 1.2rem; margin-bottom: 0.8rem; border-radius: 12px; color: var(--text-muted); cursor: pointer; transition: var(--transition); display: flex; align-items: center; gap: 12px; }
.nav-item.active { background: rgba(0, 242, 255, 0.1); color: #fff; box-shadow: inset 0 0 15px rgba(0, 242, 255, 0.05); }
.nav-item:hover:not(.active) { background: rgba(255, 255, 255, 0.05); transform: translateX(5px); }

.main-content { flex: 1; padding: 3rem; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2.5rem; }
.wallet-btn { background: var(--accent-gradient); border: none; padding: 0.7rem 1.5rem; border-radius: 30px; color: white; font-weight: 600; cursor: pointer; transition: var(--transition); box-shadow: 0 4px 15px rgba(0, 242, 255, 0.3); }

/* Animations */
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
.shimmer { background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.05), transparent); background-size: 200% 100%; animation: shimmer 2s infinite; }
.glow-on-hover:hover { box-shadow: 0 0 20px rgba(0, 242, 255, 0.2); border-color: rgba(0, 242, 255, 0.4); }

.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
.stat-card { padding: 1.5rem; position: relative; overflow: hidden; }
.stat-label { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 0.5rem; }
.stat-value { font-size: 1.8rem; font-weight: 700; color: #fff; }

.market-section { padding: 2rem; }
.section-title { font-size: 1.4rem; margin-bottom: 1.5rem; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; padding: 1rem; color: var(--text-muted); font-weight: 500; border-bottom: 1px solid var(--glass-border); }
td { padding: 1.2rem 1rem; border-bottom: 1px solid rgba(255, 255, 255, 0.03); }
.action-btn { padding: 0.5rem 1rem; border-radius: 10px; border: 1px solid var(--glass-border); background: rgba(255, 255, 255, 0.05); color: #fff; cursor: pointer; transition: var(--transition); }
.action-btn:hover { background: var(--accent-gradient); border-color: transparent; }

/* Modal Overlay */
.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal-content { width: 100%; max-width: 450px; padding: 2.5rem; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.fade-in { animation: fadeIn 0.6s ease forwards; }
`);

// 4. ActionModal.jsx
fs.writeFileSync(path.join(components, 'ActionModal.jsx'), `
import React, { useState } from 'react';
const ActionModal = ({ isOpen, onClose, action, tokenName, onExecute, loading }) => {
  const [amount, setAmount] = useState('');
  if (!isOpen) return null;
  return (
    <div className="modal-overlay">
      <div className="modal-content glass fade-in">
        <header style={{display:'flex', justifyContent:'space-between', marginBottom:'2rem'}}>
          <h3 style={{background:'var(--accent-gradient)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent'}}>{action} {tokenName}</h3>
          <button onClick={onClose} style={{background:'none', border:'none', color:'#8a8f98', fontSize:'1.8rem', cursor:'pointer'}}>&times;</button>
        </header>
        <div className="modal-body">
          <div style={{marginBottom:'2rem'}}>
            <label style={{display:'block', marginBottom:'0.8rem', color:'#8a8f98'}}>Amount</label>
            <div style={{position:'relative', display:'flex', alignItems:'center'}}>
              <input type="number" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} 
                style={{width:'100%', background:'rgba(255,255,255,0.05)', border:'1px solid var(--glass-border)', borderRadius:'12px', padding:'1.2rem', color:'#fff', fontSize:'1.2rem', outline:'none'}} />
              <span style={{position:'absolute', right:'1.2rem', color:'#00f2ff', fontWeight:600}}>{tokenName}</span>
            </div>
          </div>
          <button className="execute-btn" disabled={loading || !amount} onClick={() => onExecute(amount)}
            style={{width:'100%', padding:'1.2rem', borderRadius:'15px', background:'var(--accent-gradient)', border:'none', color:'white', fontSize:'1.1rem', fontWeight:700, cursor:'pointer', opacity: (loading || !amount) ? 0.5 : 1}}>
            {loading ? 'Processing...' : \`Confirm \${action}\`}
          </button>
        </div>
      </div>
    </div>
  );
};
export default ActionModal;
`);

// 5. App.jsx
fs.writeFileSync(path.join(src, 'App.jsx'), `
import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import ActionModal from './components/ActionModal';
import './index.css';

// We recover these from the root if possible, or use the ones from the history
const addresses = ${fs.readFileSync('deployed-addresses.json', 'utf8')};

function App() {
  const [account, setAccount] = useState(null);
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [currentView, setCurrentView] = useState('dashboard');
  const [modalOpen, setModalOpen] = useState(false);
  const [activeMarket, setActiveMarket] = useState(null);
  const [activeAction, setActiveAction] = useState('Supply');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (window.ethereum) {
      setProvider(new ethers.BrowserProvider(window.ethereum));
    }
  }, []);

  const connectWallet = async () => {
    const s = await provider.getSigner();
    setSigner(s);
    setAccount(await s.getAddress());
  };

  const markets = [
    { name: 'USDC', address: addresses.USDC, ltv: '80%', apr: '4.2%' },
    { name: 'WETH', address: addresses.WETH, ltv: '70%', apr: '2.8%' }
  ];

  return (
    <div className="App">
      <nav className="sidebar glass">
        <div className="logo-container">
          <img src="/logo.png" className="logo-img" alt="logo" />
          <span className="brand-name">Zenith</span>
        </div>
        <ul className="nav-links">
          <li className={\`nav-item \${currentView === 'dashboard' ? 'active' : ''}\`} onClick={() => setCurrentView('dashboard')}>Dashboard</li>
          <li className={\`nav-item \${currentView === 'governance' ? 'active' : ''}\`} onClick={() => setCurrentView('governance')}>Governance</li>
        </ul>
      </nav>
      <main className="main-content">
        <header className="fade-in">
          <h2>{currentView === 'dashboard' ? 'Protocol Dashboard' : 'Governance Portal'}</h2>
          <button className="wallet-btn shimmer" onClick={connectWallet}>
            {account ? \`\${account.substring(0,6)}...\${account.substring(38)}\` : 'Connect Wallet'}
          </button>
        </header>

        {currentView === 'dashboard' ? (
          <section className="market-section glass fade-in">
            <h3 className="section-title">Verified Markets</h3>
            <table>
              <thead><tr><th>Asset</th><th>LTV</th><th>Supply APY</th><th>Action</th></tr></thead>
              <tbody>
                {markets.map((m, i) => (
                  <tr key={i}>
                    <td><strong>{m.name}</strong></td><td>{m.ltv}</td><td style={{color:'#00ff88'}}>{m.apr}</td>
                    <td style={{display:'flex', gap:'8px'}}>
                      <button className="action-btn" onClick={() => { setActiveMarket(m); setActiveAction('Supply'); setModalOpen(true); }}>Supply</button>
                      <button className="action-btn" onClick={() => { setActiveMarket(m); setActiveAction('Borrow'); setModalOpen(true); }}>Borrow</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : (
          <div className="market-section glass fade-in">Coming Soon</div>
        )}
      </main>
      <ActionModal isOpen={modalOpen} onClose={() => setModalOpen(false)} action={activeAction} tokenName={activeMarket?.name} onExecute={() => setModalOpen(false)} />
    </div>
  );
}
export default App;
`);

console.log('Frontend restoration script complete!');
