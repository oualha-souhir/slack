const { notifyTechSlack } = require("../Common/notifyProblem");
const { postSlackMessage } = require("../Common/slackUtils");
const PaymentRequest = require("../Database/dbModels/PaymentRequest");

let isScheduledPaymentRequest = false;

async function checkPendingPaymentRequestDelays(context) {
	try {
		console.log("** checkPendingPaymentRequestDelays");

		const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		console.log(
			`Checking for pending payment requests created before: ${twentyFourHoursAgo}`
		);

		const pendingPaymentRequests = await PaymentRequest.find({
			statut: "En attente",
			createdAt: { $lte: twentyFourHoursAgo },
			// admin_reminder_sent: false,
		});

		console.log(
			`Found ${pendingPaymentRequests.length} delayed pending payment requests`
		);
		if (pendingPaymentRequests.length > 0) {
			let summary = `:warning: *Rappel quotidien - demandes de paiement en attente*\n\n`;
			summary += `*Demande de paiement non traitées depuis plus de 24h:*\n`;
			pendingPaymentRequests.forEach((PaymentRequest) => {
				const msgObj = PaymentRequest.adminMessage;
				const channelId =
					process.env.SLACK_ADMIN_ID || (msgObj && msgObj.channel);
				const ts = msgObj?.ts;
				let link = "";
				if (channelId && ts) {
					// Slack message links use the format: https://slack.com/app_redirect?channel=CHANNEL_ID&message_ts=TS
					link = `(<https://slack.com/archives/${channelId}/p${ts.replace(
						".",
						""
					)}|Voir message>)`;
				}
				summary += `• *${PaymentRequest.id_paiement}* - ${
					PaymentRequest.titre || "Sans titre"
				} (Demandeur: <@${PaymentRequest.demandeurId}>) ${link}\n`;
			});
			summary += `\nMerci de traiter ces demandes de paiement dès que possible.`;

			const adminchannel = process.env.SLACK_ADMIN_ID || "CXXXXXXX";
			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: adminchannel,
					text: summary,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
		for (const paymentRequest of pendingPaymentRequests) {
			console.log(
				`Attempting to process pending payment request: ${paymentRequest.id_paiement}`
			);

			const updatedPaymentRequest = await PaymentRequest.findOneAndUpdate(
				{
					id_paiement: paymentRequest.id_paiement,
					admin_reminder_sent: false,
				},
				{
					$set: { admin_reminder_sent: true },
					$push: {
						delay_history: {
							type: "admin_reminder",
							timestamp: new Date(),
						},
					},
				},
				{ new: true }
			);

			if (updatedPaymentRequest) {
				console.log(
					`Claimed payment request ${paymentRequest.id_paiement} for reminder`
				);
				// await sendDelayReminder(updatedPaymentRequest, context, "admin");
			} else {
				console.log(
					`Payment request ${paymentRequest.id_paiement} already claimed by another process`
				);
			}
		}
	} catch (error) {
		await notifyTechSlack(error);

		console.log(
			`Error in pending payment request delay monitoring: ${error.message}`
		);
		throw error;
	}
}

async function checkPaymentRequestApprovalDelays(context) {
	try {
		console.log("** 2 checkPaymentRequestApprovalDelays");

		const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		console.log(
			`Checking for payment requests awaiting approval before: ${twentyFourHoursAgo}`
		);

		const delayedApprovalRequests = await PaymentRequest.find({
			statut: "Validé",
			createdAt: { $lte: twentyFourHoursAgo },
			// payment_reminder_sent: false,
			$or: [
				{ paymentDone: "false" },
				{ paymentDone: false },
				{ paymentDone: { $exists: false } },
			],
		});
		// const delayedApprovalRequests =await PaymentRequest.find({
		// 	statut: "Validé",
		// 	$or: [
		// 		{ paymentDone: "false" },
		// 		{ paymentDone: false },
		// 		{ paymentDone: { $exists: false } },
		// 	],
		// });
		console.log(
			`Found ${delayedApprovalRequests.length} payment requests awaiting approval`
		);

		if (delayedApprovalRequests.length === 0) {
			console.log("No delayed payment requests found");
			return;
		}

		// Group orders by channel to send targeted messages
		const PaymentRequestByChannel = new Map();

		delayedApprovalRequests.forEach((PaymentRequest) => {
			// Prefer financeMessageTransfer, fallback to financeMessage
			const msgObj = PaymentRequest.financeMessageTransfer?.ts
				? PaymentRequest.financeMessageTransfer
				: PaymentRequest.financeMessage;

			const channelId = PaymentRequest.financeMessageTransfer?.ts
				? PaymentRequest.financeMessageTransfer.channel
				: process.env.SLACK_FINANCE_CHANNEL_ID;

			if (!PaymentRequestByChannel.has(channelId)) {
				PaymentRequestByChannel.set(channelId, []);
			}
			PaymentRequestByChannel.get(channelId).push({ PaymentRequest, msgObj });
		});

		// Send messages to each channel
		for (const [channelId, requests] of PaymentRequestByChannel) {
			let summary = `:warning: *Rappel quotidien - demandes de paiement en attente*\n\n`;
			summary += `*Demandes de paiement validées sans paiement depuis plus de 24h:*\n`;

			requests.forEach(({ PaymentRequest, msgObj }) => {
				const ts = msgObj?.ts;
				let link = "";

				if (channelId && ts) {
					// Create proper Slack message link
					link = ` (<https://slack.com/archives/${channelId}/p${ts.replace(
						".",
						""
					)}|Voir message>)`;
				}

				summary += `• *${PaymentRequest.id_paiement}* - ${
					PaymentRequest.titre || "Sans titre"
				} (Demandeur: <@${PaymentRequest.demandeurId}>)${link}\n`;
			});

			summary += `\nMerci de traiter ces demandes de paiement dès que possible.`;

			// Post message to the appropriate channel
			const targetChannelId = channelId;
			console.log("Posting to channel:", targetChannelId);

			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: targetChannelId,
					text: summary,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
		console.log(`Found ${delayedApprovalRequests.length} payment `);

		for (const paymentRequest of delayedApprovalRequests) {
			console.log(
				`Attempting to process pending payment request: ${paymentRequest.id_paiement}`
			);

			const updatedPaymentRequest = await PaymentRequest.findOneAndUpdate(
				{
					id_paiement: paymentRequest.id_paiement,
					admin_reminder_sent: false,
				},
				{
					$set: { admin_reminder_sent: true },
					$push: {
						delay_history: {
							type: "admin_reminder",
							timestamp: new Date(),
						},
					},
				},
				{ new: true }
			);

			if (updatedPaymentRequest) {
				console.log(
					`Claimed payment request ${paymentRequest.id_paiement} for reminder`
				);
				// await sendDelayReminder(updatedPaymentRequest, context, "admin");
			} else {
				console.log(
					`Payment request ${paymentRequest.id_paiement} already claimed by another process`
				);
			}
		}
	} catch (error) {
		await notifyTechSlack(error);

		console.log(
			`Error in pending payment request delay monitoring: ${error.message}`
		);
		throw error;
	}
}

function setupPaymentRequestDelayMonitoring(context) {
	console.log("** setupPaymentRequestDelayMonitoring");
	if (isScheduledPaymentRequest) {
		console.log(
			"Payment request delay monitoring already scheduled, skipping duplicate setup."
		);
		return;
	}
	cron.schedule("0 * * * *", () => {
		console.log("Running scheduled payment request delay check...");
		checkPendingPaymentRequestDelays(context);
		checkPaymentRequestApprovalDelays(context);
	});
	isScheduledPaymentRequest = true;
	console.log("Payment request delay monitoring scheduled to run every hour.");
}
module.exports = {
	checkPendingPaymentRequestDelays,
	checkPaymentRequestApprovalDelays,
	setupPaymentRequestDelayMonitoring,
};
