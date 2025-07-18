const { postSlackMessageWithRetry } = require("./src/Common/slackUtils");
const { fetchEntity } = require("./src/Common/utils");
const {
	getPaymentBlocks,
} = require("./src/Order/Payment/paymentNotifications");
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
async function updateFinancePaymentMessage() {
	const entityId = "CMD/2025/07/0024";
	//   const channel = 'C093EBZQ9PC';
	const channel = "C093EBZQ9PC";

	//   const ts = '1752753423349959'; // Slack expects the ts as a string
	const ts = "1752753423.349959"; // Slack expects the ts as a string

	const context = {}; // Fill with your context if needed
	const target = "finance";

	const entity = await fetchEntity(entityId, context);

	const payment =
		entity.payments && entity.payments.length > 0 ? entity.payments[0] : {};
	const notifyPaymentData = {
		paymentNumber: payment.paymentNumber, // 'T/2025/07/0083'
		decaissementNumber: payment.decaissementNumber, // 'PC/2025/07/0063'
		title: payment.paymentTitle, // 'aa'
		mode: payment.paymentMode, // 'Espèces'
		amountPaid: payment.amountPaid, // 10
		date: payment.dateSubmitted, // 2025-07-18T11:19:06.242Z
		url: payment.paymentUrl, // payment proof URL
		proofs: payment.paymentProofs || [],
		details: payment.details || {},
	};

	const remainingAmount = entity.remainingAmount; // 190
	const paymentStatus = "Non payé"; // or use payment.paymentStatus if available
	const selectedCaisseId = null; // set if you have a caisse
	const paymentNumber = payment.paymentNumber; // 'T/2025/07/0083'
	const decaissementNumber = payment.decaissementNumber; // 'PC/2025/07/0063'
	const blocks = await getPaymentBlocks(
		entity,
		notifyPaymentData,
		remainingAmount,
		paymentStatus,
		selectedCaisseId,
		paymentNumber,
		decaissementNumber
	);
	const text = `💲 Paiement Enregistré pour ${entityId}`;

	// Use chat.update instead of chat.postMessage
	const response = await postSlackMessageWithRetry(
		"https://slack.com/api/chat.update",
		{ channel, ts, text, blocks },
		process.env.SLACK_BOT_TOKEN,
		context
	);
	console.log("Slack update response:", response);
}

module.exports = {
	updateFinancePaymentMessage,
};