const mongoose = require("mongoose");
const { createSlackResponse } = require("./utils");
const { Order, PaymentRequest, Caisse } = require("./db");
const { bankOptions } = require("./form");
const { checkFormErrors } = require("./aiService");
const { postSlackMessageWithRetry } = require("./notificationService");
const axios = require("axios");
require("dotenv").config();
const { getSiteId, getDriveId, getGraphClient } = require("./excelReportORDER");
const { getFileId } = require("./excelReportPAY");

// Generate Funding Request Modal
async function generateFundingRequestForm(context, trigger_id, params) {
	console.log("** generateFundingRequestForm");
	// Validate inputs
	if (!trigger_id) {
		context.log("Error: trigger_id is missing");
		throw new Error("trigger_id is required to open a modal");
	}

	const channelId = params.get("channel_id");
	if (!channelId) {
		context.log(
			"Warning: channel_id is missing in params, falling back to default"
		);
		// Fallback to a default channel or user DM if needed
		// channelId = process.env.SLACK_FINANCE_CHANNEL_ID || "unknown";
	}
	const finalChannelId =
		channelId || process.env.SLACK_FINANCE_CHANNEL_ID || "unknown";
	context.log(
		`Generating funding request form with channelId: ${finalChannelId}`
	);

	const modal = {
		type: "modal",
		callback_id: "submit_funding_request",
		title: { type: "plain_text", text: "Demande de fonds" },
		private_metadata: JSON.stringify({
			channelId: channelId, // Pass the channel ID
		}),
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: [
			{
				type: "input",
				block_id: "funding_amount",
				element: {
					type: "plain_text_input",
					action_id: "input_funding_amount",
					placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
				},
				label: { type: "plain_text", text: "Montant" },
			},
			{
				type: "input",
				block_id: "funding_reason",
				element: {
					type: "plain_text_input",
					action_id: "input_funding_reason",
				},
				label: { type: "plain_text", text: "Motif" },
			},
			{
				type: "input",
				block_id: "funding_date",
				element: {
					type: "datepicker",
					action_id: "input_funding_date",
				},
				label: { type: "plain_text", text: "Date Requise" },
			},
		],
	};

	try {
		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id, view: modal },
			process.env.SLACK_BOT_TOKEN
		);

		console.log("Modal open response:", JSON.stringify(response));

		if (!response.ok) {
			throw new Error(`Slack API error: ${response.error}`);
		}

		return response;
	} catch (error) {
		console.error(`Error opening funding request modal: ${error.message}`);
		throw error;
	}
}

// Function to generate modal for check details
async function generateChequeDetailsModal(context, triggerId, requestId) {
	console.log("** generateChequeDetailsModal");
	const modal = {
		type: "modal",
		callback_id: "submit_cheque_details",
		private_metadata: requestId, // Store requestId for use in submission
		title: { type: "plain_text", text: "Détails du Chèque" },
		submit: { type: "plain_text", text: "Approuver" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `Veuillez saisir les détails du chèque pour la demande *${requestId}*`,
				},
			},
			{
				type: "input",
				block_id: "cheque_number",
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_number",
				},
				label: { type: "plain_text", text: "Numéro du Chèque" },
			},
			{
				type: "input",
				block_id: "bank_name",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_bank_name",
				},
				label: { type: "plain_text", text: "Banque" },
			},
		],
	};

	await postSlackMessageWithRetry(
		"https://slack.com/api/views.open",
		{ trigger_id: triggerId, view: modal },
		process.env.SLACK_BOT_TOKEN
	);
}

// Generate Approval Modal
async function generateFundingApprovalForm(context, trigger_id, requestId) {
	console.log("** generateFundingApprovalForm");
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);

	const modal = {
		type: "modal",
		callback_id: "approve_funding_request",
		title: {
			type: "plain_text",
			text: "Approuver Demande de fonds",
		},
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Demande*: ${request.amount} ${request.currency}\n*Motif*: ${request.reason}`,
				},
			},
			{
				type: "input",
				block_id: "approval_action",
				element: {
					type: "static_select",
					action_id: "select_approval_action",
					options: [
						{
							text: { type: "plain_text", text: "Approuver (Espèces)" },
							value: "approve_cash",
						},
						{
							text: { type: "plain_text", text: "Approuver (Chèque)" },
							value: "approve_cheque",
						},
						{ text: { type: "plain_text", text: "Rejeter" }, value: "reject" },
					],
				},
				label: { type: "plain_text", text: "Action" },
			},
			{
				type: "input",
				block_id: "cheque_details",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_details",
				},
				label: { type: "plain_text", text: "Numéro du Chèque" },
			},
		],
	};

	await postSlackMessageWithRetry(
		"https://slack.com/api/views.open",
		{ trigger_id, view: modal },
		process.env.SLACK_BOT_TOKEN
	);
}

// Handle Approval Submission
async function handleFundingApprovalSubmission(payload, context, userName) {
	console.log("** handleFundingApprovalSubmission");
	const formData = payload.view.state.values;
	const userId = userName;
	const requestId =
		payload.view.private_metadata ||
		formData.request_id?.input_request_id?.value;
	const action =
		formData.approval_action.select_approval_action.selected_option.value;
	const chequeDetails = formData.cheque_details?.input_cheque_details?.value;

	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);

	if (!request) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{ channel: userId, user: userId, text: "Demande introuvable." },
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}

	if (action === "reject") {
		request.status = "Rejeté";
		request.approvedBy = userId;
		request.approvedAt = new Date();
	} else {
		request.status = "Validé";
		request.approvedBy = userId;
		request.approvedAt = new Date();
		request.disbursementType = action === "approve_cash" ? "Espèces" : "Chèque";
		if (chequeDetails) request.chequeDetails = chequeDetails;

		caisse.balance += request.amount;
		caisse.transactions.push({
			type: "Funding",
			amount: request.amount,
			currency: request.currency,
			requestId,
			details: `Approuvée par ${userId} (${request.disbursementType})`,
		});
	}

	await caisse.save();
	await syncCaisseToExcel(caisse);

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: request.submittedByID,
			text: `Demande ${requestId} ${request.status}: ${request.amount} ${
				request.currency
			} (${request.disbursementType || "Rejeté"})`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, "");
}
function generateFundingRequestBlocks({
	requestId,
	amount,
	currency,
	reason,
	requestedDate,
	userName,
	submittedAt = new Date(),
}) {
	return [
		{
			type: "divider",
		},
		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*ID:*\n${requestId}` },
				{ type: "mrkdwn", text: `*Montant:*\n${amount} ${currency}` },
				{ type: "mrkdwn", text: `*Motif:*\n${reason}` },
				{
					type: "mrkdwn",
					text: `*Date requise:*\n${
						new Date(requestedDate).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
						}) || new Date().toISOString()
					}`,
				},
				{ type: "mrkdwn", text: `*Demandeur:*\n${userName}` },
				{
					type: "mrkdwn",
					text: `*Date de soumission:*\n${new Date().toLocaleString("fr-FR", {
						weekday: "long",
						year: "numeric",
						month: "long",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
						timeZoneName: "short",
					})}`,
				},
			],
		},
	];
}
// Deduct Cash for Espèces Payments
async function deductCashForPayment(orderId, payment, context) {
	console.log("** deductCashForPayment");
	const caisse = await Caisse.findOne();
	if (!caisse || caisse.balances[payment.currency] < payment.amountPaid) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
				text: `Erreur: Solde caisse insuffisant pour paiement ${payment.amountPaid} ${payment.currency}`,
			},
			process.env.SLACK_BOT_TOKEN
		);
		throw new Error("Solde caisse insuffisant");
	}
	if (caisse.balances[payment.currency] < 50000) {
		// Example threshold
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
				text: `⚠️ Alerte: Solde caisse bas (${
					caisse.balances[payment.currency]
				} ${payment.currency}). Envisagez de faire une demande de fonds.`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
	caisse.balances[payment.currency] -= payment.amountPaid;
	caisse.transactions.push({
		type: "Payment",
		amount: payment.amountPaid,
		currency: payment.currency,
		orderId,
		details: `Paiement Espèces pour commande ${orderId}`,
	});

	await caisse.save();
	await syncCaisseToExcel(caisse);
}
// Step 1: Handle initial funding request submission
async function handleFundingRequestSubmission(payload, context, userName) {
	console.log("** handleFundingRequestSubmission");
	const formData = payload.view.state.values;
	const userId = payload.channel?.id || payload.user.id;

	const errors = await checkFormErrors(formData, [], context);
	if (errors.errors.length) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: `Erreurs: ${errors.errors.join(", ")}`,
			},
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}

	// Parse amount and currency from input (e.g., "1000 USD")
	const amountInput = formData.funding_amount.input_funding_amount.value;
	const amountMatch = amountInput.match(/(\d+(?:\.\d+)?)\s*([A-Z]{3})/i);
	console.log("amountMatch", amountMatch);
	console.log("amountInput", amountInput);

	if (!amountMatch) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: "Format du montant incorrect. Exemple: 1000 XOF",
			},
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}

	const amount = parseFloat(amountMatch[1]);
	const currency = amountMatch[2].toUpperCase();
	if (!["XOF", "USD", "EUR"].includes(currency.toUpperCase())) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: "Devise non reconnue. Utilisez XOF, USD ou EUR.",
			},
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}

	const reason = formData.funding_reason.input_funding_reason.value;
	const requestedDate = formData.funding_date.input_funding_date.selected_date;

	const caisse =
		(await Caisse.findOne()) ||
		new Caisse({
			balances: { XOF: 0, USD: 0, EUR: 0 },
			currency: "XOF",
		});

	// Generate requestId in format FUND/YYYY/MM/XXXX
	const now = new Date();
	const year = now.getFullYear();
	const month = (now.getMonth() + 1).toString().padStart(2, "0");
	const existingRequests = caisse.fundingRequests.filter((req) =>
		req.requestId.startsWith(`FUND/${year}/${month}/`)
	);
	const sequence = existingRequests.length + 1;
	const sequenceStr = sequence.toString().padStart(4, "0");
	const requestId = `FUND/${year}/${month}/${sequenceStr}`;

	// Push new funding request with "En attente" status
	caisse.fundingRequests.push({
		requestId,
		amount,
		currency,
		reason,
		requestedDate,
		submittedBy: userName,
		submittedByID: payload.user.id,

		submitterName: userName,
		status: "En attente",
		submittedAt: new Date(),
		workflow: {
			stage: "initial_request", // Track workflow stage
			history: [
				{
					stage: "initial_request",
					timestamp: new Date(),
					actor: userName,
					details: "Demande initiale soumise",
				},
			],
		},
	});

	await caisse.save();

	// Sync to Excel
	try {
		await syncCaisseToExcel(caisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.user.id,
				user: payload.user.id,
				text: "Erreur lors de la synchronisation avec Excel. La demande a été enregistrée, mais contactez l'administrateur.",
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);

	if (!request) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{ channel: userId, user: userId, text: "Demande introuvable." },
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}
	// Generate funding request blocks
	const fundingRequestBlocks = generateFundingRequestBlocks({
		requestId,
		amount,
		currency,
		reason,
		requestedDate,
		userName,
		submittedAt: new Date(),
	});
	// Notify admin with initial approval buttons
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: Demande de fonds: ${requestId}`,
						emoji: true,
					},
				},
				{
					type: "divider",
				},
				// ...fundingRequestBlocks,
				...generateRequestDetailBlocks(request),
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
						},
					],
				},
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: { type: "plain_text", text: "Pré-approuver", emoji: true },
							style: "primary",
							value: requestId,
							action_id: "pre_approve_funding", // New action for initial approval
						},
						{
							type: "button",
							text: { type: "plain_text", text: "Rejeter", emoji: true },
							style: "danger",
							value: requestId,
							action_id: "reject_fund",
						},
					],
				},
			],
			text: `Nouvelle demande de fonds: ${amount} ${currency} pour "${reason}" (ID: ${requestId})`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Notify the requester
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: payload.user.id,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: ":heavy_dollar_sign: Demande de fonds",
						emoji: true,
					},
				},
				...generateRequestDetailBlocks(request),
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

	return createSlackResponse(200, "");
}

// Step 2: Admin pre-approves and notifies finance
async function handlePreApproval(payload, context) {
	console.log("** handlePreApproval");
	// Parse the private metadata to get request info
	const metadata = JSON.parse(payload.view.private_metadata);
	console.log("metadata1", metadata);

	const requestId = metadata.requestId;
	console.log("requestId", requestId);
	const messageTs = metadata.messageTs;
	console.log("messageTs", messageTs);
	const channelId = metadata.channelId;
	const userId = payload.user.id;
	const userName = payload.user.username || userId;

	// Find the funding request
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
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
				...generateRequestDetailBlocks(request),
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
				...generateRequestDetailBlocks(request),

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
							value: requestId,
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
}
const types = {
	wrong_amount: "Montant incorrect",
	wrong_payment_mode: "Mode de paiement incorrect",
	wrong_proof: "Justificatif manquant ou incorrect",
	wrong_bank_details: "Détails bancaires incorrects",
	other: "Autre problème",
};

function getProblemTypeText(problemType) {
	return types[problemType] || problemType;
}

// Handle problem report submission
async function handleProblemSubmission(payload, context) {
	console.log("** handleProblemSubmission");
	const metadata = JSON.parse(payload.view.private_metadata);
	const requestId = metadata.entityId;
	const channelId = process.env.SLACK_FINANCE_CHANNEL_ID;
	const messageTs = metadata.messageTs;
	console.log("messageTs1", messageTs);
	const userId = payload.user.id;

	const formData = payload.view.state.values;
	let problemType =
		formData.problem_type.select_problem_type.selected_option.value;
	const problemDescription =
		formData.problem_description.input_problem_description.value;
	console.log("problemType", problemType);
	problemType = getProblemTypeText(problemType);
	console.log("problemType", problemType);

	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	const request = caisse.fundingRequests[requestIndex];

	// Check if the request is already approved
	if (request.status === "Validé") {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: "Impossible de signaler un problème : la demande a déjà été approuvée.",
			},
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	}

	// Store the problem report
	request.issues = request.issues || [];
	request.issues.push({
		type: problemType,
		description: problemDescription,
		reportedBy: userId,
		reportedAt: new Date(),
	});

	request.workflow.history.push({
		stage: "problem_reported",
		timestamp: new Date(),
		actor: userId,
		details: `Problème signalé: ${problemType} - ${problemDescription}`,
	});

	await caisse.save();
	console.log("request1", request);
	console.log("request.paymentDetails1", request.paymentDetails);
	let chequeDetailsText = "";
	console.log("request1", request);
	if (
		request.paymentDetails.method === "cheque" &&
		request.paymentDetails.cheque
	) {
		// Send notification to admin
		chequeDetailsText = request.paymentDetails?.cheque
			? `\n• Numéro: ${request.paymentDetails.cheque.number}\n• Banque: ${request.paymentDetails.cheque.bank}\n• Date: ${request.paymentDetails.cheque.date}\n• Ordre: ${request.paymentDetails.cheque.order}`
			: "";
	}
	const block = generateFundingDetailsBlocks(
		request,
		request.paymentDetails.method,
		request.paymentDetails.notes,
		request.paymentDetails,
		userId
	);
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_FINANCE_CHANNEL_ID,
			text: `✅ Problème signalé sur la demande de fonds ${requestId}`,
		},
		process.env.SLACK_BOT_TOKEN
	);
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: Problème Signalé sur Demande de fonds: ${requestId}`,
						emoji: true,
					},
				},
				...block,
				// {
				//   type: "section",
				//   fields: [
				//     { type: "mrkdwn", text: `*ID:*\n${requestId}` },
				//     {
				//       type: "mrkdwn",
				//       text: `*Montant:*\n${request.amount} ${request.currency}`,
				//     },
				//     { type: "mrkdwn", text: `*Motif:*\n${request.reason}` },
				//     {
				//       type: "mrkdwn",
				//       text: `*Demandeur:*\n${
				//         request.submitterName || request.submittedBy
				//       }`,
				//     },
				//     {
				//       type: "mrkdwn",
				//       text: `*Méthode:*\n${getPaymentMethodText(
				//         request.paymentDetails.method
				//       )}\n${chequeDetailsText}`,
				//     },
				//     {
				//       type: "mrkdwn",
				//       text: `*Notes:*\n${request.paymentDetails.notes || "Aucune"}`,
				//     },
				//     {
				//       type: "mrkdwn",
				//       text: `*Détails fournis par:*\n<@${request.paymentDetails.filledByName}>`,
				//     },
				//   ],
				// },
				{
					type: "divider",
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*Problème*: ${problemType} `,
						},
						{
							type: "mrkdwn",
							text: `*Description*: ${problemDescription}`,
						},
						{
							type: "mrkdwn",
							text: `*Signalé par:* <@${userId}>`,
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
								text: "Corriger les détails",
								emoji: true,
							},
							style: "primary",
							value: JSON.stringify({ requestId, channelId, messageTs }),
							action_id: "correct_funding_details",
						},
					],
				},
			],
			text: `Problème signalé sur demande ${requestId}`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, { response_action: "clear" });
}
// Helper function to truncate strings
function truncate(str, max) {
	return str.length > max ? str.slice(0, max) + "..." : str;
}
// New function to generate common request detail blocks
function generateRequestDetailBlocks(request) {
	return [
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Montant:*\n${request.amount} ${request.currency}`,
				},
				{
					type: "mrkdwn",
					text: `*Motif:*\n${request.reason}`,
				},
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Date requise:*\n${new Date(
						request.requestedDate
					).toLocaleString("fr-FR", {
						weekday: "long",
						year: "numeric",
						month: "long",
						day: "numeric",
					})}`,
				},
				{
					type: "mrkdwn",
					text: `*Demandeur:*\n${request.submitterName || request.submittedBy}`,
				},
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Date de soumission:*\n${request.submittedAt.toLocaleString(
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
					)}`,
				},
			],
		},
	];
}

// Modified original function
function generateFundingDetailsBlocks(
	request,
	paymentMethod,
	paymentNotes,
	paymentDetails,
	userId
) {
	console.log("** generateFundingDetailsBlocks");
	console.log(
		'paymentMethod === "cheque" && paymentDetails.cheque',
		paymentMethod === "cheque" && paymentDetails.cheque
	);
	console.log("paymentMethod", paymentMethod);
	const rawDbMethod = request.paymentDetails?.method;
	console.log("$$ Raw payment method from DB:", rawDbMethod);
	if (rawDbMethod) {
		const normalized = rawDbMethod.trim().toLowerCase().replace(/è/g, "e"); // Normalize accented 'è' to 'e'
		if (normalized === "cheque" || normalized === "chèque") {
			paymentMethod = "cheque";
		} else if (
			normalized === "cash" ||
			normalized === "espèces" ||
			normalized === "especes"
		) {
			paymentMethod = "cash";
		}
	}
	console.log("$$ Normalized payment method:", paymentMethod);
	// Build cheque details for display if applicable
	const additionalDetails =
		paymentMethod === "cheque" && paymentDetails.cheque
			? [
					{
						type: "mrkdwn",
						text: `*Numéro de chèque:*\n${
							paymentDetails.cheque.number || "N/A"
						}`,
					},
					{
						type: "mrkdwn",
						text: `*Banque:*\n${paymentDetails.cheque.bank || "N/A"}`,
					},
					{
						type: "mrkdwn",
						text: `*Date du chèque:*\n${paymentDetails.cheque.date || "N/A"}`,
					},
					{
						type: "mrkdwn",
						text: `*Ordre:*\n${paymentDetails.cheque.order || "N/A"}`,
					},
			  ]
			: [];

	const blocks = [
		{
			type: "divider",
		},
		// Call the new function to include the common request detail blocks
		...generateRequestDetailBlocks(request),
		{
			type: "divider",
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Méthode:* ${getPaymentMethodText(paymentMethod)}`,
				},
				{ type: "mrkdwn", text: `*Notes:* ${paymentNotes || "Aucune"}` },
			],
		},
	];
	console.log("additionalDetails", additionalDetails);
	console.log("additionalDetails.length > 0", additionalDetails.length > 0);

	// Add cheque details sections only if there are additional details
	if (additionalDetails.length > 0) {
		blocks.push({
			type: "section",
			fields: additionalDetails.slice(0, 2), // First 2 fields
		});

		if (additionalDetails.length > 2) {
			blocks.push({
				type: "section",
				fields: additionalDetails.slice(2), // Remaining fields
			});
		}
	}

	// Add proof sections for cheque payments
	if (
		paymentMethod === "cheque" &&
		paymentDetails.cheque &&
		(paymentDetails.cheque.file_ids?.length > 0 ||
			paymentDetails.cheque.urls?.length > 0)
	) {
		blocks.push(
			{ type: "divider" },
			{
				type: "section",
				text: { type: "mrkdwn", text: `*Justificatif(s)*` },
			}
		);
	}

	if (
		paymentMethod === "cheque" &&
		paymentDetails.cheque?.file_ids?.length > 0
	) {
		blocks.push({
			type: "section",
			text: {
				type: "mrkdwn",
				text: `${paymentDetails.cheque.file_ids
					.map((proof, index) => `<${proof}|Preuve ${index + 1}>`)
					.join("\n")}`,
			},
		});
	}

	if (paymentMethod === "cheque" && paymentDetails.cheque?.urls?.length > 0) {
		blocks.push({
			type: "section",
			text: {
				type: "mrkdwn",
				text: `${paymentDetails.cheque.urls
					.map(
						(proof) =>
							`<${proof}|Preuve ${paymentDetails.cheque.file_ids?.length + 1}>`
					)
					.join("\n")}`,
			},
		});
	}

	// Add context block
	blocks.push({
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: `✅ *Détails fournis par <@${userId}>* le ${new Date().toLocaleString(
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
				)}`,
			},
		],
	});

	return blocks;
}
// Step 4: Process finance details submission and notify admin for final approval
async function handleFinanceDetailsSubmission(payload, context) {
	console.log("** handleFinanceDetailsSubmission - START");

	const formData = payload.view.state.values;
	const userId = payload.user.id;
	const userName = payload.user.username || userId;

	// Log metadata to verify values
	const metadata = JSON.parse(payload.view.private_metadata);
	console.log("METADATA:", metadata);
	const requestId = metadata.requestId;
	const originalMessageTs = metadata.messageTs;
	const originalChannelId = metadata.channelId;
	// const channelId = process.env.SLACK_FINANCE_CHANNEL_ID;
	// const messageTs = metadata.messageTs;

	console.log(
		`MessageTs: ${originalMessageTs}, ChannelId: ${originalChannelId}`
	);

	// Find the funding request
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { payment_method: "Demande introuvable" },
		});
	}

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { payment_method: "Demande introuvable" },
		});
	}

	const request = caisse.fundingRequests[requestIndex];

	// Extract form data
	const paymentMethod =
		formData.payment_method.input_payment_method.selected_option.value;
	const paymentNotes = formData.payment_notes?.input_payment_notes?.value || "";
	console.log("Payment Method:", paymentMethod);
	const disbursementType = paymentMethod === "cash" ? "Espèces" : "Chèque";

	// Build payment details object
	const paymentDetails = {
		method: paymentMethod,
		notes: paymentNotes,
		approvedBy: userId,
		approvedAt: new Date(),
		filledBy: userId,
		filledByName: userName,
		filledAt: new Date(),
	};

	// Add cheque details if method is cheque
	if (paymentMethod === "cheque") {
		if (
			!formData.cheque_number ||
			!formData.cheque_bank ||
			!formData.cheque_date ||
			!formData.cheque_order
		) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					text: "❌ Veuillez remplir tous les champs requis pour le chèque (numéro, banque, date, ordre).",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		}
		// Extract file IDs from file_input
		const fileIds =
			formData.cheque_files?.input_cheque_files?.files?.map(
				(file) => file.url_private
			) || [];
		console.log("File IDs:", fileIds);
		// Process URLs (comma-separated string to array)
		const urlsString = formData.cheque_urls?.input_cheque_urls?.value || "";
		const urls = urlsString
			? urlsString
					.split(",")
					.map((url) => url.trim())
					.filter((url) => /^https?:\/\/[^\s,]+$/.test(url))
			: [];
		console.log("URLs:", urls);
		paymentDetails.cheque = {
			number: formData.cheque_number.input_cheque_number.value,
			bank: formData.cheque_bank.input_cheque_bank.selected_option.value,
			date: formData.cheque_date.input_cheque_date.selected_date,
			order: formData.cheque_order.input_cheque_order.value,
			urls: urls,
			file_ids: fileIds,
		};
	}

	request.paymentDetails = paymentDetails;
	request.disbursementType = disbursementType;

	// Update workflow status
	request.status = "Détails fournis";
	request.workflow.stage = "details_submitted";
	request.workflow.history.push({
		stage: "details_submitted",
		timestamp: new Date(),
		actor: userId,
		details: "Détails financiers fournis",
	});

	await caisse.save();

	// Log the message update attempt
	console.log("Attempting to update message...");
	console.log(`Channel: ${originalChannelId}, TS: ${originalMessageTs}`);
	// Build cheque details text for display if applicable
	let chequeDetailsText = "";

	// Generate blocks for Slack message
	const block = generateFundingDetailsBlocks(
		request,
		paymentMethod,
		paymentNotes,
		paymentDetails,
		userId
	);

	//! const additionalDetails =
	//   paymentMethod === "cheque" && paymentDetails.cheque
	//     ? [
	//         {
	//           type: "mrkdwn",
	//           text: `*Numéro de chèque:*\n${
	//             paymentDetails.cheque.number || "N/A"
	//           }`,
	//         },
	//         {
	//           type: "mrkdwn",
	//           text: `*Banque:*\n${paymentDetails.cheque.bank || "N/A"}`,
	//         },
	//         {
	//           type: "mrkdwn",
	//           text: `*Date du chèque:*\n${paymentDetails.cheque.date || "N/A"}`,
	//         },
	//         {
	//           type: "mrkdwn",
	//           text: `*Ordre:*\n${paymentDetails.cheque.order || "N/A"}`,
	//         },
	//       ]
	// !    : [];

	//! const block = [
	//   {
	//     type: "divider",
	//   },
	//   {
	//     type: "section",
	//     fields: [
	//       {
	//         type: "mrkdwn",
	//         text: `*Montant:*\n${request.amount} ${request.currency}`,
	//       },
	//       {
	//         type: "mrkdwn",
	//         text: `*Motif:*\n${request.reason}`,
	//       },
	//     ],
	//   },
	//   {
	//     type: "section",
	//     fields: [
	//       {
	//         type: "mrkdwn",
	//         text: `*Date requise:*\n${new Date(
	//           request.requestedDate
	//         ).toLocaleString("fr-FR", {
	//           weekday: "long",
	//           year: "numeric",
	//           month: "long",
	//           day: "numeric",
	//         })}`,
	//       },
	//       {
	//         type: "mrkdwn",
	//         text: `*Demandeur:*\n${request.submitterName || request.submittedBy}`,
	//       },
	//     ],
	//   },

	//   {
	//     type: "section",
	//     fields: [
	//       {
	//         type: "mrkdwn",
	//         text: `*Méthode:* ${getPaymentMethodText(paymentMethod)}`,
	//       },
	//       { type: "mrkdwn", text: `*Notes:* ${paymentNotes || "Aucune"}` },
	//     ],
	//   },
	//   {
	//     type: "section",
	//     fields: additionalDetails.slice(0, 2), // First 2 fields
	//   },
	//   ...(additionalDetails.length > 2
	//     ? [
	//         {
	//           type: "section",
	//           fields: additionalDetails.slice(2), // Remaining fields
	//         },
	//       ]
	//     : []),
	//   ...(paymentMethod === "cheque" && (paymentDetails.cheque.file_ids.length > 0 ||
	//   paymentDetails.cheque.urls.length > 0)
	//     ? [
	//         { type: "divider" },
	//         {
	//           type: "section",
	//           text: { type: "mrkdwn", text: `*Justificatif(s)*` },
	//         },
	//       ]
	//     : []),
	//   ...(paymentMethod === "cheque" && paymentDetails.cheque.file_ids.length > 0
	//     ? [
	//         {
	//           type: "section",
	//           text: {
	//             type: "mrkdwn",
	//             text: `${paymentDetails.cheque.file_ids
	//               .map((proof, index) => `<${proof}|Preuve ${index + 1}>`)
	//               .join("\n")}`,
	//           },
	//         },
	//       ]
	//     : []),
	//   ...(paymentMethod === "cheque" && paymentDetails.cheque.urls.length > 0
	//     ? [
	//         {
	//           type: "section",
	//           text: {
	//             type: "mrkdwn",
	//             text: `${paymentDetails.cheque.urls
	//               .map(
	//                 (proof) =>
	//                   `<${proof}|Preuve ${
	//                     paymentDetails.cheque.file_ids.length + 1
	//                   }>`
	//               )
	//               .join("\n")}`,
	//           },
	//         },
	//       ]
	//     : []),
	//   {
	//     type: "context",
	//     elements: [
	//       {
	//         type: "mrkdwn",
	//         text: `✅ *Détails fournis par <@${userId}>* le ${new Date().toLocaleString(
	//           "fr-FR",
	//           {
	//             weekday: "long",
	//             year: "numeric",
	//             month: "long",
	//             day: "numeric",
	//             hour: "2-digit",
	//             minute: "2-digit",
	//             timeZoneName: "short",
	//           }
	//         )} `,
	//       },
	//     ],
	//   },
	//! ];

	// Update finance team message - IMPORTANT: Remove the button from the message
	if (originalMessageTs && originalChannelId) {
		try {
			const updatedMessage = {
				channel: originalChannelId,
				ts: originalMessageTs,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `:heavy_dollar_sign: Demande de fonds: ${
								requestId || "N/A"
							}`,
							emoji: true,
						},
					},
					...block,

					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: {
									type: "plain_text",
									text: "Signaler un problème",
									emoji: true,
								},
								style: "danger",
								action_id: "report_fund_problem",
								value: requestId || "N/A", // Ensure requestId is defined
							},
						],
					},
				],

				text: `Demande de fonds ${
					requestId || "N/A"
				} - Détails fournis, en attente d'approbation finale`,
			};

			console.log("Update message payload:", JSON.stringify(updatedMessage));

			const response = await postSlackMessageWithRetry(
				"https://slack.com/api/chat.update",
				updatedMessage,
				process.env.SLACK_BOT_TOKEN
			);

			console.log("Slack update response:", JSON.stringify(response));

			if (!response.ok) {
				console.error(`Failed to update message: ${response.error}`);
			}
		} catch (error) {
			console.error(`Error updating message: ${error.message}`);
		}
	} else {
		console.log("Missing messageTs or channelId - cannot update message");
	}

	// Sync to Excel
	try {
		await syncCaisseToExcel(caisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
	}

	// Create rich notification for admin final approval
	console.log("Sending admin notification...");
	try {
		const adminResponse = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
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
					// {
					//   type: "section",
					//   fields: [
					//     {
					//       type: "mrkdwn",
					//       text: `*Montant:*\n${request.amount} ${request.currency}`,
					//     },
					//     {
					//       type: "mrkdwn",
					//       text: `*Motif:*\n${request.reason}` ,
					//     },
					//   ],
					// },
					// {
					//   type: "section",
					//   fields: [
					//     {
					//       type: "mrkdwn",
					//       text: `*Demandeur:*\n${
					//         request.submitterName || request.submittedBy
					//       }`,
					//     },
					//     {
					//       type: "mrkdwn",
					//       text: `*Méthode:*\n${getPaymentMethodText(
					//         paymentMethod
					//       )}\n${chequeDetailsText}`,
					//     },
					//   ],
					// },
					// {
					//   type: "section",
					//   fields: [
					//     {
					//       type: "mrkdwn",
					//       text: `*Notes:*\n${paymentNotes || "Aucune"}`,
					//     },
					//     {
					//       type: "mrkdwn",
					//       text: `*Détails fournis par:*\n<@${userId}>`,
					//     },
					//   ],
					// },

					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: { type: "plain_text", text: "Approuver", emoji: true },
								style: "primary",
								value: requestId,
								action_id: "funding_approval_payment",
							},
							{
								type: "button",
								text: { type: "plain_text", text: "Rejeter", emoji: true },
								style: "danger",
								value: requestId,
								action_id: "reject_fund",
							},
						],
					},
				],
				text: `Demande de fonds ${requestId} - Approbation finale requise`,
			},
			process.env.SLACK_BOT_TOKEN
		);
		console.log("Admin notification response:", JSON.stringify(adminResponse));
	} catch (error) {
		console.error(`Error sending admin notification: ${error.message}`);
	}

	console.log("** handleFinanceDetailsSubmission - END");
	return createSlackResponse(200, { response_action: "clear" });
}

// Step 5: Process final approval and recharge caisse
async function handleFinalApproval(payload, context) {
	console.log("** handleFinalApproval");
	// Extract data from the view submission payload
	const viewSubmission = payload.view;
	const metadata = JSON.parse(viewSubmission.private_metadata);
	const requestId = metadata.requestId;
	const userId = payload.user.id;
	const userName = payload.user.username || userId;
	const messageTs = metadata.messageTs;
	const channelId = metadata.channelId;

	// Get selected payment method
	const paymentMethod =
		viewSubmission.state.values.payment_method.input_payment_method
			.selected_option.value;

	// Get optional payment notes
	const paymentNotes =
		viewSubmission.state.values.payment_notes.input_payment_notes.value || "";

	// Find the funding request
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
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

	const request = caisse.fundingRequests[requestIndex];

	// Update request status
	request.status = "Validé";
	request.approvedBy = userId;
	request.approvedAt = new Date();
	request.workflow.stage = "approved";
	request.workflow.history.push({
		stage: "approved",
		timestamp: new Date(),
		actor: userId,
		details: "Demande approuvée finalement",
	});

	// Create payment details based on the form submission
	request.paymentDetails = {
		method: paymentMethod,
		sourceAccountText: paymentNotes || "N/A",
	};

	// Update caisse balance for the specific currency
	caisse.balances[request.currency] =
		(caisse.balances[request.currency] || 0) + request.amount;

	// Record transaction
	caisse.transactions.push({
		type: "Funding",
		amount: request.amount,
		currency: request.currency,
		requestId,
		details: `Approuvée par <@${userId}> (${getPaymentMethodText(
			paymentMethod
		)})`,
		timestamp: new Date(),
	});

	await caisse.save();

	// Update admin message
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.update",
		{
			channel: channelId,
			ts: messageTs,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: ":heavy_dollar_sign: Demande de fonds (APPROUVÉE)",
						emoji: true,
					},
				},
				{
					type: "divider",
				},
				{
					type: "section",
					fields: [
						{ type: "mrkdwn", text: `*ID:*\n${requestId}` },
						{
							type: "mrkdwn",
							text: `*Montant:*\n${request.amount} ${request.currency}`,
						},
						{ type: "mrkdwn", text: `*Motif:*\n${request.reason}` },
						{
							type: "mrkdwn",
							text: `*Demandeur:*\n${
								request.submitterName || request.submittedBy
							}`,
						},
						{
							type: "mrkdwn",
							text: `*Méthode:*\n${getPaymentMethodText(paymentMethod)}`,
						},
						{ type: "mrkdwn", text: `*Source:*\n${paymentNotes || "N/A"}` },
						{ type: "mrkdwn", text: `*Approuvée par:*\n<@${userId}>` },
						{
							type: "mrkdwn",
							text: `*Date d'approbation:*\n${new Date().toLocaleDateString()}`,
						},
					],
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `✅ *APPROUVÉ* - Caisse rechargée de ${request.amount} ${
								request.currency
							}. Nouveau solde: ${caisse.balances[request.currency]} ${
								request.currency
							}`,
						},
					],
				},
			],
			text: `Demande de fonds ${requestId} APPROUVÉE - Caisse rechargée`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Sync to Excel
	try {
		await syncCaisseToExcel(caisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `Erreur lors de la synchronisation Excel pour ${requestId}. Contactez l'administrateur.`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}

	// Notify finance team
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_FINANCE_CHANNEL_ID,
			text: `✅ Demande de fonds ${requestId} APPROUVÉE par <@${userId}>. La caisse a été rechargée de ${
				request.amount
			} ${request.currency}. Nouveau solde: ${
				caisse.balances[request.currency]
			} ${request.currency}`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Notify the requester
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: request.submittedByID,
			text: `✅ Votre demande de fonds (ID: ${requestId}) a été APPROUVÉE! Le montant de ${
				request.amount
			} ${request.currency} a été disponibilisé via ${getPaymentMethodText(
				paymentMethod
			)}.`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, "");
}

// Helper function to convert payment method codes to readable text
function getPaymentMethodText(method) {
	console.log("** getPaymentMethodText");
	const methodMap = {
		cash: "Espèces",
		cheque: "Chèque",
		transfer: "Virement",
	};
	return methodMap[method] || method;
}
async function processFundingApproval(
	requestId,
	action,
	rejectionReason = null,
	messageTs = null,
	channelId = null,
	userId,
	chequeDetails = null
) {
	console.log("** processFundingApproval");
	console.log("requestId1", requestId);

	const { Caisse } = require("./db");
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
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
		}
	}
	// Sync to Excel to update the existing row
	try {
		await syncCaisseToExcel(caisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
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

async function syncCaisseToExcel(caisse, requestId) {
	console.log("** syncCaisseToExcel");
	const maxRetries = 3;
	for (let i = 0; i < maxRetries; i++) {
		try {
			const client = await getGraphClient();
			const siteId = await getSiteId();
			const driveId = await getDriveId(siteId);
			const fileId = process.env.CAISSE_EXCEL_FILE_ID;
			const tableName = "CaisseTable";

			const request = caisse.fundingRequests.find(
				(r) => r.requestId === requestId
			);
			if (!request) throw new Error(`Funding request ${requestId} not found`);
			// Prepare cheque details as a single string (if applicable)
			let paymentDetailsString = "";
			if (
				request.paymentDetails?.method &&
				["cheque", "Chèque"].includes(request.paymentDetails.method) &&
				request.paymentDetails.cheque
			) {
				const cheque = request.paymentDetails.cheque;
				const fields = [
					cheque.number ? `- Numéro du chèque: ${cheque.number}` : null,
					cheque.bank ? `- Banque: ${cheque.bank}` : null,
					cheque.date ? `- Date du chèque: ${cheque.date}` : null,
					cheque.order ? `- Ordre: ${cheque.order}` : null,
				];
				// Add file IDs information
				if (cheque.file_ids && cheque.file_ids.length > 0) {
					fields.push(
						`- Fichiers: ${cheque.file_ids.length} fichier(s) associé(s)`
					);
					// Optionally include file URLs (truncated)
					fields.push(
						`- Liens des fichiers:\n${cheque.file_ids
							.map((url) => `- ${truncate(url, 50)}`)
							.join("\n")}`
					);
				}

				// Add URLs information
				if (cheque.urls && cheque.urls.length > 0) {
					fields.push(`- URLs: ${cheque.urls.join(", ")}`);
				}
				paymentDetailsString = fields.filter(Boolean).join("\n");
			}

			const rowData = [
				request.requestId, // Request ID
				request.amount || 0, // Amount
				request.currency || "XOF", // Currency
				request.reason || "", // Reason
				request.status || "En attente", // Status
				request.rejectionReason || "", // Status

				new Date(request.requestedDate).toLocaleString("fr-FR", {
					weekday: "long",
					year: "numeric",
					month: "long",
					day: "numeric",
				}) || new Date().toISOString(), // Date requise (same as Requested Date)
				request.submittedBy || "", // Submitted By
				request.submittedAt
					? new Date(request.submittedAt).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
							timeZoneName: "short",
					  })
					: "", // Submitted At
				request.approvedBy || "", // Approved By
				request.approvedAt
					? new Date(request.approvedAt).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
							timeZoneName: "short",
					  })
					: "", // Approved At

				request.paymentDetails.notes || "", // Notes
				request.disbursementType || "", // Disbursement Type
				paymentDetailsString || "", // 15: Détails de Paiement
				caisse.balances.XOF || 0, // Balance XOF
				caisse.balances.USD || 0, // Balance USD
				caisse.balances.EUR || 0, // Balance EUR
				"Yes", // Latest Update
			];
			console.log(
				`[Excel Integration] Updating row for request ${requestId} with data:`,
				JSON.stringify(rowData, null, 2)
			);
			// Fetch all rows to find the current and previous latest rows
			console.log(
				"[Excel Integration] Fetching table rows for requestId:",
				requestId
			);
			const tableRows = await client
				.api(
					`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows`
				)
				.get();

			// Fetch table columns
			const tableColumns = await client
				.api(
					`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/columns`
				)
				.get();
			const columnCount = tableColumns.value.length;

			// Validate rowData length
			if (rowData.length !== columnCount) {
				console.error(
					`[Excel Integration] Error: rowData has ${rowData.length} columns, but table expects ${columnCount}`
				);
				throw new Error(
					"Column count mismatch between rowData and table structure"
				);
			}
			let rowIndex = -1;
			let previousLatestIndex = -1;
			if (tableRows && tableRows.value) {
				rowIndex = tableRows.value.findIndex(
					(row) => row.values && row.values[0] && row.values[0][0] === requestId // Adjusted index: Request ID is now at 0
				);
				if (caisse.latestRequestId && caisse.latestRequestId !== requestId) {
					previousLatestIndex = tableRows.value.findIndex(
						(row) =>
							row.values &&
							row.values[0] &&
							row.values[0][0] === caisse.latestRequestId
					);
				}
			}

			// Update previous latest row to "No" (if it exists)
			if (previousLatestIndex >= 0 && previousLatestIndex !== rowIndex) {
				const previousRowValues =
					tableRows.value[previousLatestIndex].values[0];
				if (previousRowValues.length >= 15) {
					// Adjusted for 15 columns
					previousRowValues[17] = " "; // Adjusted index: Latest Update is now at 14
					console.log(
						"[Excel Integration] Updating previous latest row to 'No':",
						caisse.latestRequestId
					);
					await client
						.api(
							`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows/itemAt(index=${previousLatestIndex})`
						)
						.patch({ values: [previousRowValues] });
				}
			}

			// Update or add the current row
			if (rowIndex >= 0) {
				console.log(
					"[Excel Integration] Updating existing row for requestId:",
					requestId
				);
				await client
					.api(
						`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows/itemAt(index=${rowIndex})`
					)
					.patch({ values: [rowData] });
			} else {
				console.log(
					"[Excel Integration] Adding new row for requestId:",
					requestId
				);
				await client
					.api(
						`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows`
					)
					.post({ values: [rowData] });
			}

			// Update latestRequestId in the database
			caisse.latestRequestId = requestId;
			console.log(
				"[Excel Integration] Updating latestRequestId to:",
				requestId
			);
			await caisse.save();

			console.log(
				"[Excel Integration] Excel sync completed for requestId:",
				requestId
			);
			return;
		} catch (error) {
			console.error("[Excel Integration] Error in syncCaisseToExcel:", {
				message: error.message,
				stack: error.stack,
				attempt: i + 1,
				requestId,
			});
			if (i === maxRetries - 1) {
				throw new Error(`Excel sync failed: ${error.message}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
	}
}

// Generate Report
async function generateCaisseReport(context, format = "csv") {
	console.log("** generateCaisseReport");
	const caisse = await Caisse.findOne();
	if (!caisse) throw new Error("Caisse non initialisée");

	const reportData = [
		[
			"Date",
			"Type",
			"Montant",
			"Devise",
			"Détails",
			"Solde XOF",
			"Solde USD",
			"Solde EUR",
		],
		...caisse.transactions.map((t) => [
			t.timestamp.toISOString(),
			t.type,
			t.amount,
			t.currency,
			t.details,
			caisse.balances.XOF,
			caisse.balances.USD,
			caisse.balances.EUR,
		]),
	];

	if (format === "csv") {
		const csv = reportData.map((row) => row.join(",")).join("\n");
		return Buffer.from(csv).toString("base64");
	} else {
		// Excel export
		await syncCaisseToExcel(caisse);
		return "Report synced to Excel";
	}
}

async function postSlackMessageWithRetry1(url, payload, token, retries = 3) {
	console.log("** postSlackMessageWithRetry");
	console.log("Sending Slack message:", JSON.stringify(payload));

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(payload),
		});

		const data = await response.json();
		console.log("Slack API response:", JSON.stringify(data));

		if (!data.ok) {
			throw new Error(`Slack API error: ${data.error}`);
		}

		return data;
	} catch (error) {
		console.error(`Error posting to Slack: ${error.message}`);
		if (retries > 0) {
			console.log(`Retrying... (${retries} attempts left)`);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			return postSlackMessageWithRetry(url, payload, token, retries - 1);
		}
		throw error;
	}
}
function getPaymentMethod(method) {
	if (!method) return "Espèces"; // Handle null/undefined

	const methodMap = {
		cash: "Espèces",
		cheque: "Chèque",
	};

	// If the input is already a display text, normalize and convert back
	if (typeof method === "string") {
		const normalized = method.trim().toLowerCase();

		// Check if it's already a system code
		if (methodMap[normalized]) {
			return methodMap[normalized];
		}

		// Check if it's a display text and convert to matching code
		if (normalized === "espèces" || normalized === "especes") {
			return methodMap["cash"];
		} else if (normalized === "chèque" || normalized === "cheque") {
			return methodMap["cheque"];
		}
	}

	// Default fallback
	return "Espèces";
}
// Generate modal for correcting funding details
async function generateCorrectionModal(
	context,
	triggerId,
	requestId,
	channelId,
	messageTs
) {
	console.log("** generateCorrectionModal");
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return;
	}
	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);
	if (!request) {
		console.error(`Request ${requestId} not found`);
		return;
	}

	const chequeDetails = request.paymentDetails?.cheque || {};

	// Build bank select element
	const chequeBankElement = {
		type: "static_select",
		action_id: "input_cheque_bank",
		options: [
			{
				text: { type: "plain_text", text: "AFG BANK CI" },
				value: "AFGBANK_CI",
			},
			{
				text: { type: "plain_text", text: "AFRILAND FIRST BANK CI" },
				value: "AFRILAND_FIRST_BANK_CI",
			},
			{
				text: { type: "plain_text", text: "BOA - CÔTE D’IVOIRE" },
				value: "BOA_CI",
			},
			{
				text: { type: "plain_text", text: "BANQUE ATLANTIQUE CI (BACI)" },
				value: "BACI",
			},
			{
				text: { type: "plain_text", text: "BANQUE D’ABIDJAN" },
				value: "BANQUE_D_ABIDDAJAN",
			},
			{ text: { type: "plain_text", text: "BHCI" }, value: "BHCI" },
			{ text: { type: "plain_text", text: "BDU-CI" }, value: "BDU_CI" },
			{ text: { type: "plain_text", text: "BICICI" }, value: "BICICI" }, // Shortened from "BANQUE INTERNATIONALE POUR LE COMMERCE ET L’INDUSTRIE DE LA CÔTE D’IVOIRE"
			{ text: { type: "plain_text", text: "BNI" }, value: "BNI" },
			{
				text: { type: "plain_text", text: "BANQUE POPULAIRE CI" },
				value: "BANQUE_POPULAIRE",
			},
			{
				text: { type: "plain_text", text: "BSIC - CÔTE D’IVOIRE" },
				value: "BSIC_CI",
			}, // Shortened from "BANQUE SAHÉLO-SAHARIENNE POUR L’INVESTISSEMENT ET LE COMMERCE - CÔTE D’IVOIRE"
			{
				text: { type: "plain_text", text: "BGFIBANK-CI" },
				value: "BGFIBANK_CI",
			},
			{
				text: { type: "plain_text", text: "BRIDGE BANK GROUP CI" },
				value: "BBG_CI",
			},
			{
				text: { type: "plain_text", text: "CITIBANK CI" },
				value: "CITIBANK_CI",
			},
			{
				text: { type: "plain_text", text: "CORIS BANK INTL CI" },
				value: "CBI_CI",
			},
			{ text: { type: "plain_text", text: "ECOBANK CI" }, value: "ECOBANK_CI" },
			{ text: { type: "plain_text", text: "GTBANK-CI" }, value: "GTBANK_CI" },
			{ text: { type: "plain_text", text: "MANSA BANK" }, value: "MANSA_BANK" },
			{
				text: { type: "plain_text", text: "NSIA BANQUE CI" },
				value: "NSIA_BANQUE_CI",
			},
			{ text: { type: "plain_text", text: "ORABANK CI" }, value: "ORABANK_CI" },
			{
				text: { type: "plain_text", text: "ORANGE BANK AFRICA" },
				value: "ORANGE_BANK",
			},
			{
				text: { type: "plain_text", text: "SOCIETE GENERALE CI" },
				value: "SOCIETE_GENERALE_CI",
			},
			{ text: { type: "plain_text", text: "SIB" }, value: "SIB" },
			{
				text: { type: "plain_text", text: "STANBIC BANK" },
				value: "STANBIC_BANK",
			},
			{
				text: { type: "plain_text", text: "STANDARD CHARTERED CI" },
				value: "STANDARD_CHARTERED_CI",
			},
			{ text: { type: "plain_text", text: "UBA" }, value: "UBA" },
			{
				text: { type: "plain_text", text: "VERSUS BANK" },
				value: "VERSUS_BANK",
			},
			{ text: { type: "plain_text", text: "BMS CI" }, value: "BMS_CI" },
			{ text: { type: "plain_text", text: "BRM CI" }, value: "BRM_CI" },
			{ text: { type: "plain_text", text: "Autre" }, value: "Autre" },
		],
	};

	// Only add initial_option if there's a valid bank
	if (chequeDetails.bank) {
		bankOptions.initial_option = {
			text: { type: "plain_text", text: chequeDetails.bank },
			value: chequeDetails.bank,
		};
	}

	// Build date picker element
	const chequeDateElement = {
		type: "datepicker",
		action_id: "input_cheque_date",
	};
	// Map database payment method to modal options
	// Only add initial_date if there's a valid date
	if (chequeDetails.date && chequeDetails.date.match(/^\d{4}-\d{2}-\d{2}$/)) {
		chequeDateElement.initial_date = chequeDetails.date;
	}
	// Determine payment method code
	const validPaymentMethods = ["cash", "cheque"];
	let paymentMethod = "cash"; // Default

	// Get raw payment method from DB
	const rawDbMethod = request.paymentDetails?.method;
	console.log("$$ Raw payment method from DB:", rawDbMethod);

	// Normalize the method to a valid system code
	if (rawDbMethod) {
		const normalized = rawDbMethod.trim().toLowerCase();
		if (normalized === "cheque" || normalized === "chèque") {
			paymentMethod = "cheque";
		} else if (
			normalized === "cash" ||
			normalized === "espèces" ||
			normalized === "especes"
		) {
			paymentMethod = "cash";
		}
	}

	// Get display text for selected method
	const displayMethod = getPaymentMethodText(paymentMethod);
	console.log("$$ Selected payment method:", displayMethod);
	const modal = {
		type: "modal",
		callback_id: "correct_fund",
		private_metadata: JSON.stringify({
			entityId: requestId,
			channelId: channelId,
			messageTs: messageTs,
		}),
		title: { type: "plain_text", text: "Corriger les Détails" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Demande*: ${requestId}\n*Montant*: ${request.amount} ${request.currency}\n*Motif*: ${request.reason}`,
				},
			},

			{
				type: "input",
				block_id: "payment_method",
				label: { type: "plain_text", text: "Méthode de paiement" },
				element: {
					type: "radio_buttons",
					action_id: "input_payment_method",
					options: [
						{ text: { type: "plain_text", text: "Espèces" }, value: "cash" },
						{ text: { type: "plain_text", text: "Chèque" }, value: "cheque" },
					],
					initial_option: {
						text: { type: "plain_text", text: displayMethod },
						value: paymentMethod,
					},
				},
			},
			{
				type: "input",
				block_id: "cheque_number",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_number",
					initial_value: chequeDetails.number || "",
				},
				label: { type: "plain_text", text: "Numéro du Chèque" },
			},
			{
				type: "input",
				block_id: "cheque_bank",
				optional: true,
				element: chequeBankElement,
				label: { type: "plain_text", text: "Banque" },
			},
			{
				type: "input",
				block_id: "cheque_date",
				optional: true,
				element: chequeDateElement,
				label: { type: "plain_text", text: "Date du Chèque" },
			},
			{
				type: "input",
				block_id: "cheque_order",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_order",
					initial_value: chequeDetails.order || "",
				},
				label: { type: "plain_text", text: "Ordre" },
			},
			// Add new file upload field
			{
				type: "input",
				block_id: "cheque_files",
				optional: true,
				element: {
					type: "file_input",
					action_id: "input_cheque_files",
					filetypes: ["pdf", "png", "jpg", "jpeg"],
					max_files: 3,
				},
				label: { type: "plain_text", text: "Fichiers" },
			},
			// Add URL input field for external links
			{
				type: "input",
				block_id: "cheque_urls",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_urls",
					placeholder: {
						type: "plain_text",
						text: "URLs séparées par des virgules",
					},
				},
				// label: { type: "plain_text", text: "Liens vers les documents (séparés par des virgules)" },
				label: { type: "plain_text", text: "Lien " },
			},
		],
	};

	try {
		console.log("$$ Modal payment method:", request.paymentDetails?.method);
		console.log(
			"$$ Modal payment initial option:",
			modal.blocks[1].element.initial_option
		);
		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id: triggerId, view: modal },
			process.env.SLACK_BOT_TOKEN
		);
		console.log("Slack API response:", response);
	} catch (error) {
		console.error("Failed to open modal:", error);
	}
}

module.exports = {
	generateCorrectionModal,
	generateFundingRequestForm,
	handleFundingRequestSubmission,
	generateFundingApprovalForm,
	handleFundingApprovalSubmission,
	deductCashForPayment,
	generateCaisseReport,
	processFundingApproval,
	generateChequeDetailsModal,
	handleProblemSubmission,
	syncCaisseToExcel,
	handlePreApproval,
	handleFinalApproval,
	handleFinanceDetailsSubmission,
	getProblemTypeText,
	generateFundingDetailsBlocks,
	generateRequestDetailBlocks,
};
