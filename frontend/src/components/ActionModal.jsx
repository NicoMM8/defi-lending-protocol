import React, { useState } from 'react';

const ActionModal = ({ isOpen, onClose, action, tokenName, onExecute, loading }) => {
  const [amount, setAmount] = useState('');

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content glass fade-in">
        <header className="modal-header">
          <h3>{action} {tokenName}</h3>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </header>

        <div className="modal-body">
          <div className="input-group">
            <label>Amount</label>
            <div className="input-wrapper">
              <input 
                type="number" 
                placeholder="0.00" 
                value={amount} 
                onChange={(e) => setAmount(e.target.value)} 
              />
              <span className="token-symbol">{tokenName}</span>
            </div>
          </div>

          <div className="modal-info">
            <div className="info-row">
              <span>Transaction Fee</span>
              <span>~0.001 ETH</span>
            </div>
            <div className="info-row">
              <span>New Health Factor</span>
              <span className="hf-preview">1.42</span>
            </div>
          </div>

          <button 
            className="execute-btn" 
            disabled={loading || !amount}
            onClick={() => onExecute(amount)}
          >
            {loading ? 'Processing...' : `Confirm ${action}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ActionModal;
