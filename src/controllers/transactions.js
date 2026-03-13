const transactionService = require('../services/transactionsService');

async function createTransaction(req, res) {
  try {
    const result = await transactionService.process(req.body);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

module.exports = { createTransaction };
