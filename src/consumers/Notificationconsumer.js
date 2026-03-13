const { createConsumer } = require("../kafka/consumer");
const { TOPICS } = require("../kafka/topics");

async function handleMessage({ event }) {
  const { transaction_id, account_id, amount, balance_after } = event;

  if (event.event_type === "TransactionCompleted") {
    console.log(`[Notification] 📧 Email sent to account ${account_id}`);
    console.log(`[Notification]    Transaction ${transaction_id} completed`);
    console.log(`[Notification]    Amount: ₹${amount} | Balance: ₹${balance_after}`);
  }

  if (event.event_type === "TransactionBlocked") {
    console.log(`[Notification] 🚨 Fraud alert sent to account ${account_id}`);
    console.log(`[Notification]    Transaction ${transaction_id} was blocked`);
    console.log(`[Notification]    Reason: ${event.reason}`);
  }
}

async function startNotificationConsumer() {
  await createConsumer("notification-service", TOPICS.TRANSACTIONS_EVENTS, handleMessage);
  await createConsumer("notification-service-blocked", TOPICS.TRANSACTIONS_BLOCKED, handleMessage);
}

module.exports = { startNotificationConsumer };