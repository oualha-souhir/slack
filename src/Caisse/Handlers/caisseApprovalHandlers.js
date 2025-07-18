const {
	createSlackResponse,
	postSlackMessage,
	postSlackMessageWithRetry,
	postSlackMessage2,
} = require("../../Common/slackUtils");
const {
	generateFundingDetailsBlocks,
	generateRequestDetailBlocks,
	generateFundingRequestBlocks,
} = require("./caisseFundingRequestHandlers");
const { syncCaisseToExcel } = require("../../Excel/report");
const { Caisse } = require("../../Database/dbModels/Caisse.js");
const { notifyTechSlack } = require("../../Common/notifyProblem.js");

//* 4 pre_approve_funding
async function openPreApprovalConfirmationDialog(payload) {
	console.log("** openPreApprovalConfirmationDialog");
	console.log("payload mmmmmm", payload);
	const { requestId, caisseType } = JSON.parse(payload.actions[0].value);
	console.log("requestId mmmmmm", requestId);
	console.log("caisseType mmmmmm", caisseType);

	try {
		// Find the funding request to show details in confirmation
		const caisse = await Caisse.findOne({
			type: caisseType, // Match by caisseType
			"fundingRequests.requestId": requestId, // Match by requestId within fundingRequests
		});

		console.log("requestId1", requestId);
		if (!caisse) {
			console.error(`Caisse not found for request ${requestId}`);
			return;
		}

		const request = caisse.fundingRequests.find(
			(r) => r.requestId === requestId
		);
		if (!request) {
			console.error(`Request ${requestId} not found`);
			return;
		}

		// Open confirmation modal
		const view = {
			type: "modal",
			callback_id: "pre_approval_confirmation_submit",
			title: { type: "plain_text", text: "Confirmation" },
			submit: { type: "plain_text", text: "Confirmer" },
			close: { type: "plain_text", text: "Annuler" },
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Êtes-vous sûr de vouloir approuver cette demande ?`,
					},
				},
			],
			private_metadata: JSON.stringify({
				requestId,
				caisseType,
				action: "accept",
				messageTs: payload.message.ts,
			}),
		};

		await postSlackMessage2(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);
		return { statusCode: 200, body: "" };
	} catch (error) {
		console.error(`Error opening confirmation dialog: ${error.message}`);
		await notifyTechSlack(error);
	}
}
//* 5 pre_approval_confirmation_submit
async function handlePreApproval(payload, context) {
	console.log("** handlePreApproval");

	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		// Parse the private metadata to get request info
		const metadata = JSON.parse(payload.view.private_metadata);
		console.log("metadata1", metadata);

		const requestId = metadata.requestId;
		console.log("requestId", requestId);
		const caisseType = metadata.caisseType;
		console.log("caisseType", caisseType);
		const messageTs = metadata.messageTs;
		console.log("messageTs", messageTs);
		const channelId = metadata.channelId;
		const userId = payload.user.id;
		const userName = payload.user.username || userId;

		// Find the funding request
		// const caisse = await Caisse.findOne({
		// 	"fundingRequests.requestId": requestId,
		// });
		const caisse = await Caisse.findOne({
			type: caisseType, // Match by caisseType
			"fundingRequests.requestId": requestId, // Match by requestId within fundingRequests
		});
		if (!caisse) {
			console.error(`Caisse not found for request ${requestId}`);
			return createSlackResponse(200, "Une erreur s'est produite");
		}

		const requestIndex = caisse.fundingRequests.findIndex(
			(r) => r.requestId === requestId
		);
		if (requestIndex === -1) {
			console.error(`Request ${requestId} not found`);
			return createSlackResponse(200, "Demande non trouvée");
		}
		// const caisseType = caisse.type;
		const request = caisse.fundingRequests[requestIndex];

		// Update request status and workflow tracking
		request.status = "Pré-approuvé";
		request.preApprovedBy = userId;
		request.preApprovedAt = new Date();
		request.workflow.stage = "pre_approved";
		request.workflow.history.push({
			stage: "pre_approved",
			timestamp: new Date(),
			actor: userId,
			details: "Demande pré-approuvée par admin",
		});

		await caisse.save();

		// Update admin message
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: process.env.SLACK_ADMIN_ID,
				ts: messageTs,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `:heavy_dollar_sign: Demande de fonds - Pré-approuvée: ${requestId}`,
							emoji: true,
						},
					},
					{
						type: "divider",
					},
					...generateRequestDetailBlocks(request, caisseType),
					// {
					//   type: "section",
					//   fields: [
					//     {
					//       type: "mrkdwn",
					//       text: `*Montant:*\n${request.amount} ${request.currency}`,
					//     },
					//     { type: "mrkdwn", text: `*Motif:*\n${request.reason}` },
					//     {
					//       type: "mrkdwn",
					//       text: `*Date requise:*\n${
					//         new Date(request.requestedDate).toLocaleString("fr-FR", {
					//           weekday: "long",
					//           year: "numeric",
					//           month: "long",
					//           day: "numeric",
					//         }) || new Date().toISOString()
					//       }`,
					//     },
					//     {
					//       type: "mrkdwn",
					//       text: `*Demandeur:*\n${
					//         request.submitterName || request.submittedBy
					//       }`,
					//     },
					//     // {
					//     //   type: "mrkdwn",
					//     //   text: `*Pré-approuvé par:* <@${userId}> le ${new Date().toLocaleString(
					//     //     "fr-FR",
					//     //     {
					//     //       weekday: "long",
					//     //       year: "numeric",
					//     //       month: "long",
					//     //       day: "numeric",
					//     //       hour: "2-digit",
					//     //       minute: "2-digit",
					//     //       timeZoneName: "short",
					//     //     }
					//     //   )}`,
					//     // },
					//   ],
					// },

					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `✅ *Pré-approuvé* par <@${userId}> le ${new Date().toLocaleString(
									"fr-FR",
									{
										weekday: "long",
										year: "numeric",
										month: "long",
										day: "numeric",
										hour: "2-digit",
										minute: "2-digit",
										timeZoneName: "short",
									}
								)} - En attente des détails de la finance `,
							},
						],
					},
				],
				text: `Demande de fonds ${requestId} pré-approuvée - En attente des détails de la finance`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Notify finance team to fill details form
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `:heavy_dollar_sign: Demande de fonds - ${requestId}`,
							emoji: true,
						},
					},
					{
						type: "divider",
					},
					...generateRequestDetailBlocks(request, caisseType),

					// {
					//   type: "section",
					//   fields: [
					//     {
					//       type: "mrkdwn",
					//       text: `*Montant:*\n${request.amount} ${request.currency}`,
					//     },
					//     { type: "mrkdwn", text: `*Motif:*\n${request.reason}` },
					//     {
					//       type: "mrkdwn",
					//       text: `*Date requise:*\n${new Date(
					//         request.requestedDate
					//       ).toLocaleString("fr-FR", {
					//         weekday: "long",
					//         year: "numeric",
					//         month: "long",
					//         day: "numeric",
					//       })}`,
					//     },
					//     {
					//       type: "mrkdwn",
					//       text: `*Demandeur:*\n${
					//         request.submitterName || request.submittedBy
					//       }`,
					//     },

					//   ],
					// },
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `✅ *Pré-approuvé* par <@${userId}> le ${new Date().toLocaleString(
									"fr-FR",
									{
										weekday: "long",
										year: "numeric",
										month: "long",
										day: "numeric",
										hour: "2-digit",
										minute: "2-digit",
										timeZoneName: "short",
									}
								)} - En attente des détails de la finance `,
							},
						],
					},
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: {
									type: "plain_text",
									text: "Fournir les détails",
									emoji: true,
								},
								style: "primary",
								value: JSON.stringify({ requestId, caisseType }), // Include caisseType in the value
								action_id: "fill_funding_details",
							},
						],
					},
				],
				text: `Demande de fonds ${requestId} à traiter - Veuillez fournir les détails de paiement`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Notify requester of pre-approval
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: request.submittedByID,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text:
								":heavy_dollar_sign: ✅ Demande de fonds ID: " +
								requestId +
								" - Pré-approuvée " +
								` par <@${userName}> le ${new Date().toLocaleDateString()}`,
							emoji: true,
						},
					},
				],
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, "");
	});

	return context.res;
}
//* 15 funding_approval_payment
async function openFinalApprovalConfirmationDialog(payload) {
	console.log("** openFinalApprovalConfirmationDialog");
	const action = payload.actions[0];
	// const requestId = action.value;

	const { requestId, caisseType } = JSON.parse(payload.actions[0].value);
	console.log("requestId mmmmmm1", requestId);
	console.log("caisseType mmmmmm1", caisseType);
	try {
		// Find the funding request to show details in confirmation
		const caisse = await Caisse.findOne({
			type: caisseType, // Match by caisseType
			"fundingRequests.requestId": requestId, // Match by requestId within fundingRequests
		});
		if (!caisse) {
			console.error(`Caisse not found for request ${requestId}`);
			return;
		}

		const request = caisse.fundingRequests.find(
			(r) => r.requestId === requestId
		);
		if (!request) {
			console.error(`Request ${requestId} not found`);
			return;
		}

		// Get payment method text for display
		const paymentMethodText =
			request.disbursementType === "Espèces" ? "Espèces" : "Chèque";
		let paymentDetailsText = "";

		if (
			request.disbursementType === "Chèque" &&
			request.paymentDetails?.cheque
		) {
			const cheque = request.paymentDetails.cheque;
			paymentDetailsText = `*Numéro:* ${cheque.number}\n*Banque:* ${cheque.bank}\n*Date:* ${cheque.date}\n*Ordre:* ${cheque.order}`;
		}

		// Open confirmation modal
		const view = {
			type: "modal",
			callback_id: "final_approval_confirmation_submit",
			title: { type: "plain_text", text: "Confirmation" },
			submit: { type: "plain_text", text: "Confirmer" },
			close: { type: "plain_text", text: "Annuler" },
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Êtes-vous sûr de vouloir approuver cette demande ?`,
					},
				},
			],
			private_metadata: JSON.stringify({
				requestId: requestId,
				caisseType: caisseType,
				messageTs: payload.message.ts,
				channelId: payload.channel.id,
			}),
		};

		await postSlackMessage2(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);
		return { statusCode: 200, body: "" };
	} catch (error) {
		console.error(
			`Error opening final approval confirmation dialog: ${error.message}`
		);
		await notifyTechSlack(error);
	}
}
//* 5 reject_funding*
async function processFundingApproval(
	requestId,
	caisseType,
	action,
	rejectionReason = null,
	messageTs = null,
	channelId = null,
	userId,
	chequeDetails = null
) {
	console.log("** processFundingApproval");
	console.log("requestId1", requestId);

	const caisse = await Caisse.findOne({
		type: caisseType, // Match by caisseType
		"fundingRequests.requestId": requestId, // Match by requestId within fundingRequests
	});
	if (!caisse) throw new Error("Caisse non trouvée");

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) throw new Error("Demande non trouvée");

	const request = caisse.fundingRequests[requestIndex];
	console.log("rejectionReason", rejectionReason);
	if (action === "reject") {
		request.status = "Rejeté";
		request.approvedBy = userId;
		request.approvedAt = new Date();
		//!$$$$$$$$$$$$$$
		request.rejectionReason = rejectionReason;
	} else {
		request.status = "Validé";
		request.approvedBy = userId;
		request.approvedAt = new Date();
		request.disbursementType = action === "approve_cash" ? "Espèces" : "Chèque";

		if (chequeDetails) {
			request.chequeDetails =
				typeof chequeDetails === "string"
					? chequeDetails
					: JSON.stringify(chequeDetails);
		}

		// Update balance for the specific currency
		caisse.balances[request.currency] += request.amount;
		caisse.transactions.push({
			type: "Funding",
			amount: request.amount,
			currency: request.currency,
			requestId,
			details: `Approuvée par <@${userId}> (${request.disbursementType})`,
			timestamp: new Date(),
		});
	}

	await caisse.save();
	// Generate funding request blocks
	const fundingRequestBlocks = generateFundingRequestBlocks({
		requestId,
		amount: request.amount,
		currency: request.currency,
		reason: request.reason,
		requestedDate: request.requestedDate,
		userId,
		submittedAt: new Date(),
	});
	// Update the admin channel message if messageTs and channelId are provided
	if (messageTs && channelId) {
		try {
			// Prepare message update data based on action
			const updateData = {
				channel: channelId,
				ts: messageTs,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `:heavy_dollar_sign: Demande de fonds `,
							emoji: true,
						},
					},
					...fundingRequestBlocks,

					{
						type: "section",
						text: {
							type: "mrkdwn",
							text:
								action === "reject"
									? `❌ *REJETÉE* par <@${userId}> le ${new Date().toLocaleString(
											"fr-FR"
									  )}\n*  Raison:* ${rejectionReason || "Non spécifiée"}`
									: `✅ *APPROUVÉE* par <@${userId}> le ${new Date().toLocaleString(
											"fr-FR"
									  )}\n*Type:* ${request.disbursementType}`,
						},
					},
				],
			};

			// Update the message
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.update",
				updateData,
				process.env.SLACK_BOT_TOKEN
			);

			console.log(`Admin message updated for request ${requestId}`);
		} catch (error) {
			console.error(`Failed to update admin message: ${error.message}`);
			await notifyTechSlack(error);
		}
	}
	// Sync to Excel to update the existing row
	try {
		await syncCaisseToExcel(caisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		await notifyTechSlack(error);

		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `Erreur lors de la synchronisation Excel pour ${requestId}. Contactez l'administrateur.`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
}

//* 16 final_approval_confirmation_submit
async function handleFinalApprovalConfirmation(payload, context) {
	setImmediate(async () => {
		const metadata = JSON.parse(payload.view.private_metadata);
		const requestId = metadata.requestId;
		const caisseType = metadata.caisseType;
		console.log("caisseType PP", caisseType);
		console.log("requestId PP", requestId);
		const messageTs = metadata.messageTs;
		const channelId = metadata.channelId;
		const userId = payload.user.username;

		// Find the funding request
		const caisse = await Caisse.findOne({
			type: caisseType, // Match by caisseType
			"fundingRequests.requestId": requestId, // Match by requestId within fundingRequests
		});
		console.log("caisse PP", caisse);
		if (!caisse) {
			console.error(`Caisse not found for request ${requestId}`);
			return createSlackResponse(200, "Demande introuvable");
		}

		const requestIndex = caisse.fundingRequests.findIndex(
			(r) => r.requestId === requestId
		);
		if (requestIndex === -1) {
			console.error(`Request ${requestId} not found`);
			return createSlackResponse(200, "Demande introuvable");
		}

		const request = caisse.fundingRequests[requestIndex];

		// Update request for final approval
		request.status = "Validé";
		request.approvedBy = userId;
		request.approvedAt = new Date();
		request.workflow.stage = "approved";
		request.workflow.history.push({
			stage: "approved",
			timestamp: new Date(),
			actor: userId,
			details: "Demande approuvée avec détails de paiement",
		});

		// Update balance and add transaction
		// Update balance for the specific currency
		caisse.balances[request.currency] =
			(caisse.balances[request.currency] || 0) + request.amount;
		caisse.transactions.push({
			type: "Funding",
			amount: request.amount,
			currency: request.currency,
			requestId,
			details: `Approuvé par ${userId} (${request.disbursementType})`,
			timestamp: new Date(),
			paymentMethod: request.disbursementType,
			paymentDetails: request.paymentDetails, // Preserve paymentDetails in transaction
		});

		await caisse.save();

		// Sync to Excel
		try {
			await syncCaisseToExcel(caisse, requestId);
		} catch (error) {
			await notifyTechSlack(error);

			console.error(`Excel sync failed: ${error.message}`);
		}
		// Generate blocks for Slack message
		const block = generateFundingDetailsBlocks(
			request,
			request.disbursementType,
			request.paymentDetails.notes,
			request.paymentDetails,
			userId,
			caisse.type
		);
		// Update original message
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: process.env.SLACK_ADMIN_ID,
				ts: messageTs,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `:heavy_dollar_sign: Demande de fonds - Approbation Finale : ${requestId}`,
							emoji: true,
						},
					},
					...block,

					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `✅ Approuvée par <@${userId}> le ${new Date().toLocaleDateString()}\n Soldes actuels: XOF: *${
									caisse.balances.XOF
								}*, USD: *${caisse.balances.USD}*, EUR: *${
									caisse.balances.EUR
								}*`,
							},
						],
					},
				],
				text: `Demande ${requestId} approuvée par ${userId}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Notify requester
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: request.submittedByID,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text:
								":heavy_dollar_sign: ✅ Demande de fonds ID: " +
								requestId +
								" - Approuvée" +
								` par <@${userId}> le ${new Date().toLocaleDateString()}\n`,
							emoji: true,
						},
					},
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
							},
						],
					},
				],
			},
			process.env.SLACK_BOT_TOKEN
		);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: caisse.channelId,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `:heavy_dollar_sign: ✅ Demande de fonds approuvée: ${requestId}`,
							emoji: true,
						},
					},
					...block,
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `Approuvée par <@${userId}> le ${new Date().toLocaleDateString()}\nSoldes: XOF: *${
									caisse.balances.XOF
								}*, USD: *${caisse.balances.USD}*, EUR: *${
									caisse.balances.EUR
								}*`,
							},
						],
					},
				],
				text: `Demande ${requestId} approuvée par ${userId}`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	});

	return context.res;
}
module.exports = {
	openPreApprovalConfirmationDialog,
	handlePreApproval,
	openFinalApprovalConfirmationDialog,
	handleFinalApprovalConfirmation,
	processFundingApproval,
};
