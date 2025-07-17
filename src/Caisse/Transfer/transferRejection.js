const { notifyTechSlack } = require("../../Common/notifyProblem");
const {
	createSlackResponse,
	postSlackMessage2,
	postSlackMessageWithRetry,
} = require("../../Common/slackUtils");
const { Caisse } = require("../../Database/dbModels/Caisse");

// Function to open rejection reason modal
async function openTransferRejectionReason(payload, context) {
	console.log("** openTransferRejectionReason");

	try {
		const transferId = payload.actions[0].value;

		// Find the caisse containing the transfer request to show details
		const caisse = await Caisse.findOne({
			"transferRequests.transferId": transferId,
		});

		if (!caisse) {
			console.error(`Caisse not found for transfer ${transferId}`);
			return createSlackResponse(200, {
				text: "❌ Demande de transfert introuvable",
			});
		}

		const transferRequest = caisse.transferRequests.find(
			(r) => r.transferId === transferId
		);

		if (!transferRequest) {
			console.error(`Transfer ${transferId} not found`);
			return createSlackResponse(200, {
				text: "❌ Demande de transfert introuvable",
			});
		}

		const view = {
			type: "modal",
			callback_id: "transfer_rejection_reason",
			title: {
				type: "plain_text",
				text: "Motif de rejet",
				emoji: true,
			},
			submit: {
				type: "plain_text",
				text: "Rejeter",
				emoji: true,
			},
			close: {
				type: "plain_text",
				text: "Annuler",
				emoji: true,
			},
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `⚠️ *Êtes-vous sûr de vouloir rejeter ce transfert ?*`,
					},
				},
				{
					type: "divider",
				},

				{
					type: "input",
					block_id: "rejection_reason_block",
					label: {
						type: "plain_text",
						text: "Motif du rejet",
						emoji: true,
					},
					element: {
						type: "plain_text_input",
						action_id: "rejection_reason_input",
						multiline: true,
						placeholder: {
							type: "plain_text",
							text: "Expliquez pourquoi ce transfert est rejeté...",
						},
					},
				},
			],
			private_metadata: JSON.stringify({
				transferId: transferId,
				channelId: payload.channel.id,
				messageTs: payload.message.ts,
			}),
		};

		const response = await postSlackMessage2(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);

		if (!response.data.ok) {
			throw new Error(`Slack API error: ${response.data.error}`);
		}

		return createSlackResponse(200, "");
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error opening transfer rejection reason:", error.message);
		return createSlackResponse(200, {
			text: `❌ Erreur lors de l'ouverture du formulaire de rejet: ${error.message}`,
		});
	}
}

// Modified handleRejectTransfer to accept rejection reason
async function handleRejectTransfer(payload, context, rejectionReason = null) {
	console.log("** handleRejectTransfer");

	try {
		const transferId = payload.actions[0].value;
		const userId = payload.user.id;
		const userName = payload.user.username;

		// Find the caisse containing the transfer request
		const caisse = await Caisse.findOne({
			"transferRequests.transferId": transferId,
		});

		if (!caisse) {
			console.error(`Caisse not found for transfer ${transferId}`);
			return createSlackResponse(200, {
				text: "❌ Demande de transfert introuvable",
			});
		}

		// Find the specific transfer request
		const transferIndex = caisse.transferRequests.findIndex(
			(r) => r.transferId === transferId
		);

		if (transferIndex === -1) {
			console.error(`Transfer ${transferId} not found`);
			return createSlackResponse(200, {
				text: "❌ Demande de transfert introuvable",
			});
		}

		const transferRequest = caisse.transferRequests[transferIndex];

		// Check if already processed
		if (transferRequest.status !== "En attente") {
			return createSlackResponse(200, {
				text: `❌ Cette demande de transfert a déjà été ${transferRequest.status.toLowerCase()}`,
			});
		}

		// Update transfer request status
		transferRequest.status = "Rejeté";
		transferRequest.rejectedBy = userName;
		transferRequest.rejectedAt = new Date();
		if (rejectionReason) {
			transferRequest.rejectionReason = rejectionReason;
		}
		transferRequest.workflow.stage = "rejected";
		transferRequest.workflow.history.push({
			stage: "rejected",
			timestamp: new Date(),
			actor: userName,
			details: `Demande de transfert rejetée${
				rejectionReason ? ` - Motif: ${rejectionReason}` : ""
			}`,
		});

		// Save the updated caisse with transfer request
		await Caisse.findOneAndUpdate(
			{ "transferRequests.transferId": transferId },
			{ $set: { [`transferRequests.${transferIndex}`]: transferRequest } },
			{ new: true }
		);

		// Update the original message
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: payload.channel.id,
				ts: payload.message.ts,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `❌ Transfert rejeté: ${transferRequest.transferId}`,
							emoji: true,
						},
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*ID:*\n${transferRequest.transferId}`,
							},
							{
								type: "mrkdwn",
								text: `*Montant:*\n${transferRequest.amount} ${transferRequest.currency}`,
							},
						],
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*De:*\n<#${transferRequest.fromCaisse}>`,
							},
							{
								type: "mrkdwn",
								text: `*Vers:*\n<#${transferRequest.toCaisse}>`,
							},
						],
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*Rejeté par:*\n<@${userName}>`,
							},
							{
								type: "mrkdwn",
								text: `*Date de rejet:*\n${new Date().toLocaleString("fr-FR")}`,
							},
						],
					},
					...(rejectionReason
						? [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `*Motif du rejet:*\n${rejectionReason}`,
									},
								},
						  ]
						: []),
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: "❌ Cette demande de transfert a été rejetée",
							},
						],
					},
				],
				text: `Transfert ${transferId} rejeté par ${userName}`,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		// Notify the requester
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: transferRequest.submittedByID,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: "❌ Demande de transfert rejetée",
							emoji: true,
						},
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*ID:*\n${transferRequest.transferId}`,
							},
							{
								type: "mrkdwn",
								text: `*Montant:*\n${transferRequest.amount} ${transferRequest.currency}`,
							},
						],
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*De:*\n<#${transferRequest.fromCaisse}>`,
							},
							{
								type: "mrkdwn",
								text: `*Vers:*\n<#${transferRequest.toCaisse}>`,
							},
						],
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*Rejeté par:*\n<@${userName}> le ${new Date().toLocaleString(
								"fr-FR"
							)}`,
						},
					},
					...(rejectionReason
						? [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `*Motif du rejet:*\n${rejectionReason}`,
									},
								},
						  ]
						: []),
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: "❌ Votre demande de transfert a été rejetée.",
							},
						],
					},
				],
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		return createSlackResponse(200, {
			text: `❌ Transfert ${transferId} rejeté`,
		});
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error rejecting transfer:", error.message);
		return createSlackResponse(200, {
			text: `❌ Erreur lors du rejet du transfert: ${error.message}`,
		});
	}
}
// Function to handle transfer rejection reason submission
async function handleTransferRejectionReason(payload, context) {
	console.log("** handleTransferRejectionReason");

	try {
		const metadata = JSON.parse(payload.view.private_metadata);
		const transferId = metadata.transferId;
		const rejectionReason =
			payload.view.state.values.rejection_reason_block.rejection_reason_input
				.value;

		if (!rejectionReason || rejectionReason.trim() === "") {
			return {
				response_action: "errors",
				errors: {
					rejection_reason_block: "Le motif du rejet est requis",
				},
			};
		}

		// Create a modified payload for the existing handleRejectTransfer function
		const modifiedPayload = {
			...payload,
			actions: [{ value: transferId }],
			channel: { id: metadata.channelId },
			message: { ts: metadata.messageTs },
		};

		// Call the existing reject transfer function with the rejection reason
		const result = await handleRejectTransfer(
			modifiedPayload,
			context,
			rejectionReason
		);

		return result;
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error handling transfer rejection reason:", error.message);
		return createSlackResponse(200, {
			text: `❌ Erreur lors du rejet du transfert: ${error.message}`,
		});
	}
}
module.exports = {
	openTransferRejectionReason,
	handleTransferRejectionReason,
};
