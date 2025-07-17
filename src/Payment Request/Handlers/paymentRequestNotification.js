const { notifyTechSlack } = require("../../Common/notifyProblem");
const { postSlackMessage, postSlackMessageWithRetry } = require("../../Common/slackUtils");
const { Caisse } = require("../../Database/dbModels/Caisse");
const PaymentRequest = require("../../Database/dbModels/PaymentRequest");
const { getFinancePaymentBlocks, getPaymentRequestBlocks } = require("./paymentRequestForm");

async function updateSlackPaymentMessage(messageTs, orderId, status, order) {
	console.log("** updateSlackPaymentMessage");

	console.log("orderId", orderId);
	console.log("status", status);
	console.log("order", order);
	console.log("messageTs", messageTs);

	await postSlackMessage(
		"https://slack.com/api/chat.update",
		{
			channel: process.env.SLACK_ADMIN_ID,
			ts: messageTs,
			text: `Demande *${orderId}* - *${status}*`,
			blocks: [
				...getPaymentRequestBlocks(order, order.demandeurId),
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `✅ Demande *${status}* avec succèes`,
					},
				},

				// {
				//   type: "actions",
				//   elements: [
				//     {
				//       type: "button",
				//       text: { type: "plain_text", text: "Rouvrir" },
				//       action_id: "reopen_order",
				//       value: orderId
				//     }
				//   ]
				// }
			],
		},
		process.env.SLACK_BOT_TOKEN
	);
}
async function notifyPaymentRequest(
	paymentRequest,
	context,
	validatedBy = null
) {
	console.log("** notifyPaymentRequest");
	const adminBlocks = [
		...getPaymentRequestBlocks(paymentRequest, validatedBy, true),
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Approuver", emoji: true },
					style: "primary",
					action_id: "payment_verif_accept",
					value: paymentRequest.id_paiement,
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Rejeter", emoji: true },
					style: "danger",
					action_id: "reject_order",
					value: paymentRequest.id_paiement,
				},
			],
		},
		{
			type: "context",
			elements: [{ type: "mrkdwn", text: "⏳ En attente de validation" }],
		},
	];
	console.log("paymentRequest.statut", paymentRequest);

	const demandeurBlocks = [
		...getPaymentRequestBlocks(paymentRequest, validatedBy),
		// Add edit button only if payment is still pending
		// ...(paymentRequest.statut === "En attente"
		//   ? [
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Modifier", emoji: true },
					style: "primary",
					action_id: "edit_payment",
					value: paymentRequest.id_paiement,
				},
			],
		},

		// : []),
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "✅ Votre demande de paiement a été soumise. En attente de validation par un administrateur.",
				},
			],
		},
	];

	try {
		// Notify Admin
		context.log(
			`Sending payment request notification to admin channel: ${process.env.SLACK_ADMIN_ID}`
		);
		const adminResponse = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `Nouvelle demande de paiement *${paymentRequest.id_paiement}* par <@${paymentRequest.demandeur}>`,
				blocks: adminBlocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		await PaymentRequest.findOneAndUpdate(
			{ id_paiement: paymentRequest.id_paiement },
			{
				adminMessage: {
					ts: adminResponse.ts,
					createdAt: new Date(),
				},
			}
		);
		if (!adminResponse.ok)
			throw new Error(`Admin notification failed: ${adminResponse.error}`);

		// Notify Demandeur
		context.log(
			`Sending payment request notification to demandeur: ${paymentRequest.demandeur}`
		);
		console.log("paymentRequest.demandeur", paymentRequest.demandeur);
		const demandeurResponse = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: paymentRequest.demandeurId,
				text: `Demande de paiement *${paymentRequest.id_paiement}* soumise`,
				blocks: demandeurBlocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		// Save message details in the database
		await PaymentRequest.findOneAndUpdate(
			{ id_paiement: paymentRequest.id_paiement },
			{
				demandeur_message: {
					channel: paymentRequest.demandeurId,
					ts: demandeurResponse.ts,
				},
				admin_message: {
					channel: process.env.SLACK_ADMIN_ID,
					ts: adminResponse.ts,
				},
			},
			{ new: true }
		);
		if (!demandeurResponse.ok)
			throw new Error(
				`Demandeur notification failed: ${demandeurResponse.error}`
			);

		return { adminResponse, demandeurResponse };
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`❌ notifyPaymentRequest failed: ${error.message}`);
		throw error;
	}
}
async function notifyFinancePayment(
	paymentRequest,
	context,
	validatedBy,
	selectedCaisseId = null,
	selectedPaymentMethod = null
) {
	console.log("** notifyFinancePayment");
	console.log("== selectedPaymentMethod", selectedPaymentMethod);
	console.log("== selectedCaisseId", selectedCaisseId);
	try {
		// const availableCaisses = await Caisse.find({}).exec();

		let targetChannelId = process.env.SLACK_FINANCE_CHANNEL_ID; // default fallback

		const caisseId = await Caisse.findOne({ type: "Centrale" }, "_id").then(
			(caisse) => caisse?._id || null
		);
		// Get caisse types from cache (fast)
		// const caisseOptions = await getCaisseTypes();

		// if (!caisseOptions || caisseOptions.length === 0) {
		// 	throw new Error("Aucune caisse disponible dans la base de données.");
		// }
		console.log("Caisse ID:", caisseId);
		// Determine which channel to send to based on caisse selection
		if (selectedPaymentMethod === "caisse_transfer" && selectedCaisseId) {
			console.log(`Using selected caisse ID: ${selectedCaisseId}`);
			// Admin selected "Transfert Caisse" and chose a specific caisse
			const selectedCaisse = await Caisse.findById(selectedCaisseId);
			console.log(`Selected caisse: ${JSON.stringify(selectedCaisse)}`);
			if (selectedCaisse && selectedCaisse.channelId) {
				console.log(`Selected caisse channel ID: ${selectedCaisse.channelId}`);
				console.log(`Selected caisse type: ${selectedCaisse}`);
				targetChannelId = selectedCaisse.channelId;
				context.log(
					`Using selected caisse channel: ${targetChannelId} for caisse type: ${selectedCaisse.type}`
				);
			} else {
				context.log(
					`⚠️ Selected caisse not found or no channelId, using default finance channel`
				);
			}
		} else {
			// Admin didn't select "Transfert Caisse" or no caisse selected
			// Find the "principal" caisse
			const principalCaisse = await Caisse.findOne({ type: "principal" });
			if (principalCaisse && principalCaisse.channelId) {
				targetChannelId = principalCaisse.channelId;
				context.log(`Using principal caisse channel: ${targetChannelId}`);
			} else {
				context.log(
					`⚠️ Principal caisse not found, using default finance channel`
				);
			}
		}

		context.log(
			`Sending payment notification to finance channel: ${targetChannelId}`
		);
		// ...existing code...
		const availableCaisses = await Caisse.find({}).exec();
		const caisseOptions = availableCaisses
			.filter((caisse) => caisse._id.toString() !== selectedCaisseId)
			.map((caisse) => ({
				text: {
					type: "plain_text",
					text: `${caisse.type} (${caisse.channelName})`,
					emoji: true,
				},
				value: JSON.stringify({
					entityId: paymentRequest.id_paiement,
					fromCaisseId: selectedCaisseId,
					toCaisseId: caisse._id.toString(),
					toChannelId: caisse.channelId,
				}),
			}));

		const actionsElements = [
			{
				type: "button",
				text: {
					type: "plain_text",
					text: "Enregistrer paiement",
					emoji: true,
				},
				style: "primary",
				action_id: "finance_payment_form",
				value: JSON.stringify({
					entityId: paymentRequest.id_paiement,
					selectedCaisseId: selectedCaisseId,
				}),
			},
		];

		if (caisseOptions.length > 0) {
			actionsElements.push({
				type: "static_select",
				placeholder: {
					type: "plain_text",
					text: "Affecter la transaction",
					emoji: true,
				},
				action_id: "transfer_to_caisse",
				options: caisseOptions,
			});
		}

		const finalCaisseId = selectedCaisseId || caisseId;
		console.log("Final Caisse ID:", finalCaisseId);
		const response = await postSlackMessage(
			"https://slack.com/api/chat.postMessage",
			{
				channel: targetChannelId,
				text: `💰 Demande de paiement ${paymentRequest.id_paiement} validée par admin`,
				blocks: getFinancePaymentBlocks(
					paymentRequest,
					validatedBy,
					finalCaisseId,
					actionsElements
				),
				metadata: {
					selectedCaisseId: finalCaisseId, // Include selectedCaisseId in metadata
				},
			},
			process.env.SLACK_BOT_TOKEN
		);

		context.log(`notifyFinancePayment response: ${JSON.stringify(response)}`);
		await PaymentRequest.findOneAndUpdate(
			{ id_paiement: paymentRequest.id_paiement },
			{
				financeMessage: {
					ts: response.ts,
					createdAt: new Date(),
				},
			}
		);
		if (!response.ok) {
			throw new Error(`Slack API error: ${response.error}`);
		}

		return response;
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`❌ notifyFinancePayment failed: ${error.message}`);
		throw error;
	}
}
module.exports = {
	notifyFinancePayment,
	notifyPaymentRequest,
	updateSlackPaymentMessage,
};
