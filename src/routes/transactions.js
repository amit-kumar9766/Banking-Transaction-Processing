const express = require('express');
const router = express.Router();
const { processTransaction } = require('../services/transactionsService');
const { pushToAccount } = require('../services/SSEService');

// Input validation helper
function validateBody({ transaction_id, account_id, type, amount }) {
  const errors = [];
  if (!transaction_id)               errors.push('transaction_id is required');
  if (!account_id)                   errors.push('account_id is required');
  if (!['DEBIT', 'CREDIT'].includes(type)) errors.push('type must be DEBIT or CREDIT');
  if (!amount || isNaN(amount) || amount <= 0) errors.push('amount must be a positive number');
  return errors;
}

// POST /transactions
router.post('/', async (req, res) => {
  const { transaction_id, account_id, type, amount } = req.body;

  // Validate input
  const errors = validateBody({ transaction_id, account_id, type, amount });
  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  // Push PENDING immediately — before any processing
  // Client sees this the moment they submit
  pushToAccount(account_id, {
    type:           "PENDING",
    transaction_id,
    account_id,
    amount,
    timestamp:      new Date().toISOString(),
  });


  try {
    const result = await processTransaction({
      transaction_id,
      account_id,
      type,
      amount: parseFloat(amount),
    });

    // Map internal status → HTTP status
    if (result.status === 'DUPLICATE') {
      return res.status(409).json({ success: false, ...result });
    }
    if (result.status === 'BLOCKED') {
      pushToAccount(account_id, {
        type:           "BLOCKED",
        transaction_id,
        account_id,
        reason:         result.reason,
        timestamp:      new Date().toISOString(),
      });
      return res.status(402).json({ success: false, ...result });
    }
    if (result.status === 'ERROR') {
      return res.status(422).json({ success: false, ...result });
    }

    pushToAccount(account_id, {
      type:           "COMPLETED",
      transaction_id,
      account_id,
      amount,
      balance_after:  result.balance_after,
      timestamp:      new Date().toISOString(),
    });


    return res.status(200).json({ success: true, ...result });

  } catch (err) {
    console.error('Transaction error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;