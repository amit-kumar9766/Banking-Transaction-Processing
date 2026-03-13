const { Kafka } = require("kafkajs");
const { withRetry } = require("../utils/retry");

const kafka = new Kafka({
  clientId: "banking-service",
  brokers: [process.env.KAFKA_BROKER || "localhost:9092"],
});

async function createConsumer(groupId, topic, handler) {
  const consumer = kafka.consumer({ groupId });

  await consumer.connect();
  console.log(`[Consumer:${groupId}] Connected`);

  await consumer.subscribe({
    topic,
    fromBeginning: false,
  });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;

      const event = JSON.parse(message.value.toString());

      await withRetry(groupId, event, () => handler({ message, event }));
    },
  });
}

module.exports = { createConsumer };
