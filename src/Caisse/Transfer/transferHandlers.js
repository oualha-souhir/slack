const {
	createSlackResponse,
	postSlackMessageWithRetry,
	postSlackMessage2,
} = require("../../Common/slackUtils");
const { WebClient } = require("@slack/web-api");

const { Caisse } = require("../../Database/dbModels/Caisse.js");
const PaymentRequest = require("../../Database/dbModels/PaymentRequest");
// Excel sync functionality
const { syncCaisseToExcel } = require("../../Excel/report");
const { Order } = require("../../Database/dbModels/Order.js");
const {
	getTransferredPaymentBlocks,
	getFinancePaymentBlocksForTransfer,
} = require("./transferForms.js");
const { notifyTechSlack } = require("../../Common/notifyProblem.js");
const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// Function to open approval confirmation modal
async function openTransferApprovalConfirmation(payload, context) {
	console.log("** openTransferApprovalConfirmation");

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

		// Get caisse details for display
		const fromCaisse = await Caisse.findOne({
			channelId: transferRequest.fromCaisse,
		});
		const toCaisse = await Caisse.findOne({
			channelId: transferRequest.toCaisse,
		});

		const view = {
			type: "modal",
			callback_id: "transfer_approval_confirmation",
			title: {
				type: "plain_text",
				text: "Confirmer l'approbation",
				emoji: true,
			},
			submit: {
				type: "plain_text",
				text: "Approuver",
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
						text: `⚠️ *Êtes-vous sûr de vouloir approuver ce transfert ?*`,
					},
				},

				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Solde source actuel: ${
								fromCaisse?.balances[transferRequest.currency] || 0
							} ${transferRequest.currency}`,
						},
					],
				},
				{
					type: "input",
					block_id: "approval_comment_block",
					optional: true,
					label: {
						type: "plain_text",
						text: "Commentaire",
						emoji: true,
					},
					element: {
						type: "plain_text_input",
						action_id: "approval_comment_input",
						multiline: true,
						placeholder: {
							type: "plain_text",
							text: "Ajouter un commentaire pour cette approbation...",
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

		console.error(
			"Error opening transfer approval confirmation:",
			error.message
		);
		return createSlackResponse(200, {
			text: `❌ Erreur lors de l'ouverture de la confirmation: ${error.message}`,
		});
	}
}

const handleTransferToCaisse = async (action, payload) => {
	console.log("** transfer_to_caisse");

	// Use selected_option.value for static_select
	const transferValue = action.selected_option?.value;
	if (!transferValue) {
		console.error("No selected_option.value for transfer_to_caisse");
		return;
	}

	// Create action object with necessary properties
	action = {
		...action,
		value: transferValue,
		user: payload.user,
		message: payload.message,
		channel: payload.channel,
		trigger_id: payload.trigger_id, // Important for modal
	};
	try {
		const { entityId, fromCaisseId, toCaisseId, toChannelId } = JSON.parse(
			action.value
		);

		// Get caisse information for confirmation dialog
		let fromCaisse = await Caisse.findById(fromCaisseId);
		if (fromCaisse == null) {
			// Try to find the caisse with type = "Centrale"
			const centraleCaisse = await Caisse.findOne({ type: "Centrale" });
			if (centraleCaisse) {
				fromCaisse = centraleCaisse._id.toString();
			} else {
				fromCaisse = "6848a25fe472b1c054fef321";
			}
		}
		const toCaisse = await Caisse.findById(toCaisseId);
		console.log("From Caisse:", fromCaisse);
		console.log("From Caisse fromCaisseId:", fromCaisseId);

		console.log("To Caisse:", toCaisse);
		console.log("To Caisse toCaisseId:", toCaisseId);
		if (!fromCaisse || !toCaisse) {
			throw new Error("Caisse not found");
		}

		// Open confirmation dialog
		await client.views.open({
			trigger_id: action.trigger_id,
			view: {
				type: "modal",
				callback_id: "confirm_transfer_modal",
				title: {
					type: "plain_text",
					text: "Confirmer le transfert",
					emoji: true,
				},
				submit: {
					type: "plain_text",
					text: "Confirmer",
					emoji: true,
				},
				close: {
					type: "plain_text",
					text: "Annuler",
					emoji: true,
				},
				private_metadata: JSON.stringify({
					entityId,
					fromCaisseId,
					toCaisseId,
					toChannelId,
					originalChannelId: action.channel.id,
					originalMessageTs: action.message.ts,
				}),
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `Êtes-vous sûr de vouloir transférer ce paiement ?\n\n*De:* ${fromCaisse.channelName}\n*Vers:* ${toCaisse.channelName}`,
						},
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `⚠️ *Attention:* Une fois transféré, le paiement ne pourra plus être traité dans ce channel.`,
						},
					},
				],
			},
		});
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error opening transfer confirmation dialog:", error);

		// Send error message to user
		await client.chat.postEphemeral({
			channel: action.channel.id,
			user: action.user.id,
			text: `Erreur lors de l'ouverture du dialogue de confirmation: ${error.message}`,
		});
	}
};
const handleTransferConfirmation = async (payload) => {
	console.log("** confirm_transfer_modal submission");

	// Create view object with user information
	view = {
		...payload.view,
		user: payload.user,
	};
	try {
		let {
			entityId,
			fromCaisseId,
			toCaisseId,
			toChannelId,
			originalChannelId,
			originalMessageTs,
		} = JSON.parse(view.private_metadata);
		if (fromCaisseId == null) {
			// Try to find the caisse with type = "Centrale"
			const centraleCaisse = await Caisse.findOne({ type: "Centrale" });
			if (centraleCaisse) {
				fromCaisseId = centraleCaisse._id.toString();
			} else {
				fromCaisseId = "6848a25fe472b1c054fef321";
			}
		}
		let paymentRequest = null;
		let order = null;
		let transferBlocks;
		let transferredBlocks;
		let entityType = "";

		// Get caisse information
		const fromCaisse = await Caisse.findById(fromCaisseId);
		const toCaisse = await Caisse.findById(toCaisseId);

		if (!fromCaisse || !toCaisse) throw new Error("Caisse not found");

		// Detect entity type and fetch
		if (entityId.startsWith("PAY/")) {
			entityType = "payment";
			paymentRequest = await PaymentRequest.findOne({ id_paiement: entityId });
			if (!paymentRequest) throw new Error("Payment request not found");
			transferBlocks = getFinancePaymentBlocksForTransfer(
				paymentRequest,
				view.user.id,
				toCaisseId,
				fromCaisse.channelName
			);
			transferredBlocks = getTransferredPaymentBlocks(
				paymentRequest,
				view.user.id,
				view.user.id,
				toCaisse.channelName
			);
		} else if (entityId.startsWith("CMD/")) {
			entityType = "order";
			order = await Order.findOne({ id_commande: entityId });
			if (!order) throw new Error("Order not found");
			transferBlocks = getFinancePaymentBlocksForTransfer(
				order,
				view.user.id,
				toCaisseId,
				fromCaisse.channelName
			);
			transferredBlocks = getTransferredPaymentBlocks(
				order,
				view.user.id,
				view.user.id,
				toCaisse.channelName
			);
		} else {
			throw new Error("Unknown entity type");
		}

		// Send notification to the new channel
		const response = await client.chat.postMessage({
			channel: toChannelId,
			blocks: transferBlocks,
			text:
				entityType === "payment"
					? `Paiement transféré depuis ${fromCaisse.channelName}`
					: `Commande transférée depuis ${fromCaisse.channelName}`,
		});

		// Update entity with transfer info if needed
		if (entityType === "payment") {
			await PaymentRequest.findOneAndUpdate(
				{ id_paiement: paymentRequest.id_paiement },
				{
					financeMessageTransfer: {
						ts: response.ts,
						createdAt: new Date(),
						channel: toChannelId,
					},
				}
			);
		} else if (entityType === "order") {
			await Order.findOneAndUpdate(
				{ id_commande: order.id_commande },
				{
					financeMessageTransfer: {
						ts: response.ts,
						createdAt: new Date(),
						channel: toChannelId,
					},
				}
			);
		}

		// Update the original message to show it was transferred
		await client.chat.update({
			channel: originalChannelId,
			ts: originalMessageTs,
			blocks: transferredBlocks,
		});

		console.log(
			`Entity ${entityId} transferred from ${fromCaisse.channelName} to ${toCaisse.channelName}`
		);
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error confirming transfer:", error);
		return {
			response_action: "errors",
			errors: {
				general: `Erreur lors du transfert: ${error.message}`,
			},
		};
	}
};

// Modified handleApproveTransfer to accept optional comment
async function handleApproveTransfer(payload, context, approvalComment = null) {
	console.log("** handleApproveTransfer");

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

		// Get source and destination caisses
		const fromCaisse = await Caisse.findOne({
			channelId: transferRequest.fromCaisse,
		});
		const toCaisse = await Caisse.findOne({
			channelId: transferRequest.toCaisse,
		});

		if (!fromCaisse || !toCaisse) {
			return createSlackResponse(200, {
				text: "❌ Caisse source ou destination introuvable",
			});
		}

		// Check if source caisse has sufficient balance
		const currentBalance = fromCaisse.balances[transferRequest.currency] || 0;
		if (currentBalance < transferRequest.amount) {
			return createSlackResponse(200, {
				text: `❌ Solde insuffisant dans la caisse source. Solde actuel: ${currentBalance} ${transferRequest.currency}`,
			});
		}

		// Perform the transfer
		const transferUpdate = {
			$inc: {
				[`balances.${transferRequest.currency}`]: -transferRequest.amount,
			},
			$push: {
				transactions: {
					type: "transfer_out",
					amount: -transferRequest.amount,
					currency: transferRequest.currency,
					transferId: transferId,
					details: `Transfert sortant vers <#${transferRequest.toCaisse}> - ${transferRequest.motif}`,
					timestamp: new Date(),
					transferDetails: {
						to: transferRequest.toCaisse,
						motif: transferRequest.motif,
						approvedBy: userName,
						approvalComment: approvalComment,
					},
				},
			},
		};

		const receiveUpdate = {
			$inc: {
				[`balances.${transferRequest.currency}`]: transferRequest.amount,
			},
			$push: {
				transactions: {
					type: "transfer_in",
					amount: transferRequest.amount,
					currency: transferRequest.currency,
					transferId: transferId,
					details: `Transfert entrant de <#${transferRequest.fromCaisse}> - ${transferRequest.motif}`,
					timestamp: new Date(),
					transferDetails: {
						from: transferRequest.fromCaisse,
						motif: transferRequest.motif,
						approvedBy: userName,
						approvalComment: approvalComment,
					},
				},
			},
		};

		// Update both caisses
		await Promise.all([
			Caisse.findOneAndUpdate(
				{ channelId: transferRequest.fromCaisse },
				transferUpdate,
				{ new: true }
			),
			Caisse.findOneAndUpdate(
				{ channelId: transferRequest.toCaisse },
				receiveUpdate,
				{ new: true }
			),
		]);

		// Update transfer request status
		transferRequest.status = "Approuvé";
		transferRequest.approvedBy = userName;
		transferRequest.approvedAt = new Date();
		if (approvalComment) {
			transferRequest.approvalComment = approvalComment;
		}
		transferRequest.workflow.stage = "approved";
		transferRequest.workflow.history.push({
			stage: "approved",
			timestamp: new Date(),
			actor: userName,
			details: `Demande de transfert approuvée et exécutée${
				approvalComment ? ` - Commentaire: ${approvalComment}` : ""
			}`,
		});

		// Save the updated caisse with transfer request
		await Caisse.findOneAndUpdate(
			{ "transferRequests.transferId": transferId },
			{ $set: { [`transferRequests.${transferIndex}`]: transferRequest } },
			{ new: true }
		);

		// Get updated balances for notifications
		const updatedFromCaisse = await Caisse.findOne({
			channelId: transferRequest.fromCaisse,
		});
		const updatedToCaisse = await Caisse.findOne({
			channelId: transferRequest.toCaisse,
		});

		// Sync to Excel
		try {
			await syncCaisseToExcel(updatedFromCaisse, transferId);
			await syncCaisseToExcel(updatedToCaisse, transferId);
		} catch (error) {
			await notifyTechSlack(error);

			console.error(`Excel sync failed: ${error.message}`);
		}

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
							text: `✅ Transfert approuvé: ${transferRequest.transferId}`,
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
								text: `*Approuvé par:*\n<@${userName}>`,
							},
							{
								type: "mrkdwn",
								text: `*Date d'approbation:*\n${new Date().toLocaleString(
									"fr-FR"
								)}`,
							},
						],
					},
					...(approvalComment
						? [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `*Commentaire:*\n${approvalComment}`,
									},
								},
						  ]
						: []),
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `Nouveau solde source: ${
									updatedFromCaisse.balances[transferRequest.currency]
								} ${transferRequest.currency} | Nouveau solde destination: ${
									updatedToCaisse.balances[transferRequest.currency]
								} ${transferRequest.currency}`,
							},
						],
					},
				],
				text: `Transfert ${transferId} approuvé par ${userName}`,
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
							text: "✅ Demande de transfert approuvée",
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
							text: `*Approuvé par:*\n<@${userName}> le ${new Date().toLocaleString(
								"fr-FR"
							)}`,
						},
					},
					...(approvalComment
						? [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `*Commentaire:*\n${approvalComment}`,
									},
								},
						  ]
						: []),
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: "✅ Votre demande de transfert a été approuvée et exécutée avec succès.",
							},
						],
					},
				],
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		// Notify both caisse channels
		const notifications = [
			{
				channel: transferRequest.fromCaisse,
				text: `📤 Transfert sortant exécuté: ${transferRequest.amount} ${
					transferRequest.currency
				} vers <#${transferRequest.toCaisse}>. Nouveau solde: ${
					updatedFromCaisse.balances[transferRequest.currency]
				} ${transferRequest.currency}${
					approvalComment ? `\nCommentaire: ${approvalComment}` : ""
				}`,
			},
			{
				channel: transferRequest.toCaisse,
				text: `📥 Transfert entrant reçu: ${transferRequest.amount} ${
					transferRequest.currency
				} de <#${transferRequest.fromCaisse}>. Nouveau solde: ${
					updatedToCaisse.balances[transferRequest.currency]
				} ${transferRequest.currency}${
					approvalComment ? `\nCommentaire: ${approvalComment}` : ""
				}`,
			},
		];

		for (const notification of notifications) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: notification.channel,
					text: notification.text,
				},
				process.env.SLACK_BOT_TOKEN,
				context
			);
		}

		return createSlackResponse(200, {
			text: `✅ Transfert ${transferId} approuvé et exécuté avec succès`,
		});
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error approving transfer:", error.message);
		return createSlackResponse(200, {
			text: `❌ Erreur lors de l'approbation du transfert: ${error.message}`,
		});
	}
}
// Function to handle transfer approval confirmation submission
async function handleTransferApprovalConfirmation(payload, context) {
	console.log("** handleTransferApprovalConfirmation");

	try {
		const metadata = JSON.parse(payload.view.private_metadata);
		const transferId = metadata.transferId;
		const comment =
			payload.view.state.values.approval_comment_block?.approval_comment_input
				?.value || "";

		// Create a modified payload for the existing handleApproveTransfer function
		const modifiedPayload = {
			...payload,
			actions: [{ value: transferId }],
			channel: { id: metadata.channelId },
			message: { ts: metadata.messageTs },
		};

		// Call the existing approve transfer function
		const result = await handleApproveTransfer(
			modifiedPayload,
			context,
			comment
		);

		return result;
	} catch (error) {
		await notifyTechSlack(error);

		console.error(
			"Error handling transfer approval confirmation:",
			error.message
		);
		return createSlackResponse(200, {
			text: `❌ Erreur lors de l'approbation du transfert: ${error.message}`,
		});
	}
}

// Create and save transfer request function
async function createAndSaveTransferRequest(
	userId,
	userName,
	formData,
	context
) {
	console.log("** createAndSaveTransferRequest");

	// Get or create caisse for storing transfer requests
	let caisse = await Caisse.findOne();
	if (!caisse) {
		caisse = new Caisse({
			balances: { XOF: 0, USD: 0, EUR: 0 },
			currency: "XOF",
			fundingRequests: [],
			transferRequests: [], // Add this field to store transfer requests
		});
	}

	// Generate transferId in format TRANS/YYYY/MM/XXXX
	const now = new Date();
	const year = now.getFullYear();
	const month = (now.getMonth() + 1).toString().padStart(2, "0");
	const existingTransfers =
		caisse.transferRequests?.filter((req) =>
			req.transferId.startsWith(`TRANS/${year}/${month}/`)
		) || [];
	const sequence = existingTransfers.length + 1;
	const sequenceStr = sequence.toString().padStart(4, "0");
	const transferId = `TRANS/${year}/${month}/${sequenceStr}`;

	// Create transfer request object
	const transferRequestData = {
		transferId,
		fromCaisse:
			formData.from_caisse_block.from_caisse_select.selected_option.value,
		toCaisse: formData.to_caisse_block.to_caisse_select.selected_option.value,
		currency: formData.currency_block.currency_select.selected_option.value,
		amount: parseFloat(formData.amount_block.amount_input.value),
		motif: formData.motif_block.motif_input.value,
		paymentMode:
			formData.payment_mode_block.payment_mode_select.selected_option.value,
		submittedBy: userName,
		submittedByID: userId,
		status: "En attente",
		submittedAt: new Date(),
		workflow: {
			stage: "initial_request",
			history: [
				{
					stage: "initial_request",
					timestamp: new Date(),
					actor: userName,
					details: "🔀 Demande de transfert soumise",
				},
			],
		},
	};

	// Validate the transfer request
	const fromCaisse = await Caisse.findOne({
		channelId: transferRequestData.fromCaisse,
	});
	const toCaisse = await Caisse.findOne({
		channelId: transferRequestData.toCaisse,
	});

	if (!fromCaisse) {
		throw new Error(`Caisse source non trouvée`);
	}

	if (!toCaisse) {
		throw new Error(`Caisse destination non trouvée`);
	}

	if (transferRequestData.fromCaisse === transferRequestData.toCaisse) {
		throw new Error(
			`La caisse source et destination ne peuvent pas être identiques`
		);
	}

	if (
		fromCaisse.balances[transferRequestData.currency] <
		transferRequestData.amount
	) {
		throw new Error(`Solde insuffisant dans la caisse source`);
	}

	// Initialize transferRequests array if it doesn't exist
	if (!caisse.transferRequests) {
		caisse.transferRequests = [];
	}

	// Add to caisse
	caisse.transferRequests.push(transferRequestData);
	await caisse.save();

	// Sync to Excel if needed
	try {
		await syncCaisseToExcel(caisse, transferId);
	} catch (error) {
		await notifyTechSlack(error);

		console.error(`Excel sync failed: ${error.message}`);
		context.log(
			`Excel sync failed for transfer ${transferId}: ${error.message}`
		);
	}

	// Return the created request
	const request = caisse.transferRequests.find(
		(r) => r.transferId === transferId
	);
	return request;
}

module.exports = {
	handleTransferApprovalConfirmation,
	createAndSaveTransferRequest,
	openTransferApprovalConfirmation,
	handleTransferToCaisse,
	handleTransferConfirmation,
};
