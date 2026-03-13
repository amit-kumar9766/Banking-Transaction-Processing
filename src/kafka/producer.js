const { Kafka, Partitioners } = require("kafkajs");

const kafka = new Kafka({
  clientId: "banking-service",
  brokers: [process.env.KAFKA_BROKER || "localhost:9092"],
});

const producer = kafka.producer({
  createPartitioner: Partitioners.LegacyPartitioner,
});

let isConnected = false;

async function connectProducer() {
  if (!isConnected) {
    await producer.connect();
    isConnected = true;
    console.log("[Kafka] Producer connected");
  }
}

async function disconnectProducer() {
  if (isConnected) {
    await producer.disconnect();
    isConnected = false;
    console.log("[Kafka] Producer disconnected");
  }
}

async function publishEvent(topic, key, value) {
  await connectProducer();

  await producer.send({
    topic,
    messages: [
      {
        key,
        value: JSON.stringify(value),
      },
    ],
  });
}

module.exports = {
  connectProducer,
  disconnectProducer,
  publishEvent,
};