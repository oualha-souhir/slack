const {
	createSlackResponse,
	postSlackMessage,
	postSlackMessageWithRetry,
} = require("../../Common/slackUtils");
const { Caisse } = require("../../Database/dbModels/Caisse.js");
const { checkFormErrors } = require("../../Common/aiService");
const { syncCaisseToExcel } = require("../../Excel/report");
const { notifyTechSlack } = require("../../Common/notifyProblem.js");

let caisseTypesCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
function getPaymentMethodText(method) {
	console.log("** getPaymentMethodText");
	const methodMap = {
		cash: "Espèces",
		cheque: "Chèque",
		transfer: "Virement",
	};
	return methodMap[method] || method;
}
function generateFundingDetailsBlocks(
	request,
	paymentMethod,
	paymentNotes,
	paymentDetails,
	userId,
	caisseType
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
		...generateRequestDetailBlocks(request, caisseType),
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
function generateRequestDetailBlocks(request, caisseType) {
	console.log("** generateRequestDetailBlocks");
	console.log("requestmm ", request);
	return [
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Caisse:*\n${caisseType || "N/A"}`, // Use caisseType if request.type is unavailable
				},
				{
					type: "mrkdwn",
					text: `*Montant:*\n${request.amount} ${request.currency}`,
				},
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Motif:*\n${request.reason}`,
				},
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
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Demandeur:*\n${request.submitterName || request.submittedBy}`,
				},
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
async function getCaisseTypes() {
	const now = Date.now();

	// Check if cache is valid
	if (
		caisseTypesCache &&
		cacheTimestamp &&
		now - cacheTimestamp < CACHE_DURATION
	) {
		return caisseTypesCache;
	}

	// Refresh cache
	try {
		const caisses = await Caisse.find({}, "type").exec();
		caisseTypesCache = caisses.map((caisse) => ({
			text: { type: "plain_text", text: caisse.type },
			value: caisse.type,
		}));
		cacheTimestamp = now;
		return caisseTypesCache;
	} catch (error) {
		await notifyTechSlack(error);

		// Return cached data if available, otherwise throw
		if (caisseTypesCache) {
			console.warn("Database query failed, using cached caisse types");
			return caisseTypesCache;
		}
		throw error;
	}
}
//* 1 open_funding_form*
async function handleOpenFundingForm(payload, context) {
	console.log("** handleOpenFundingForm");
	console.log("** open_funding_form");
	try {
		const triggerId = payload.trigger_id;
		const channelId = payload.channel?.id;
		if (!triggerId || !channelId) {
			throw new Error("Missing trigger_id or channel_id");
		}
		const mockParams = new Map();
		mockParams.set("channel_id", channelId);
		mockParams.set("trigger_id", triggerId);

		await generateFundingRequestForm(context, triggerId, mockParams);

		return createSlackResponse(200, "");
	} catch (error) {
		await notifyTechSlack(error);

		context.log(
			`❌ Error opening funding form: ${error.message}\nStack: ${error.stack}`
		);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "❌ Erreur lors de l'ouverture du formulaire. Veuillez réessayer.",
		});
	}
}
//* 2 open_funding_form*
async function generateFundingRequestForm(context, trigger_id, params) {
	console.log("** generateFundingRequestForm");

	// Validate inputs immediately
	if (!trigger_id) {
		context.log("Error: trigger_id is missing");
		throw new Error("trigger_id is required to open a modal");
	}

	const channelId = params.get("channel_id");
	const finalChannelId =
		channelId || process.env.SLACK_FINANCE_CHANNEL_ID || "unknown";

	context.log(
		`Generating funding request form with channelId: ${finalChannelId}`
	);

	try {
		// Get caisse types from cache (fast)
		const caisseOptions = await getCaisseTypes();

		if (!caisseOptions || caisseOptions.length === 0) {
			throw new Error("Aucune caisse disponible dans la base de données.");
		}

		const modal = {
			type: "modal",
			callback_id: "submit_funding_request",
			title: { type: "plain_text", text: "Demande de fonds" },
			private_metadata: JSON.stringify({
				channelId: channelId,
			}),
			submit: { type: "plain_text", text: "Soumettre" },
			close: { type: "plain_text", text: "Annuler" },
			blocks: [
				{
					type: "input",
					block_id: "caisse_type",
					element: {
						type: "static_select",
						action_id: "input_caisse_type",
						options: caisseOptions,
					},
					label: { type: "plain_text", text: "Caisse à approvisionner" },
				},
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
		await notifyTechSlack(error);

		console.error(`Error opening funding request modal: ${error.message}`);
		throw error;
	}
}
//* 3 submit_funding_request
async function handleFundingRequestSubmission(payload, context, userName) {
	console.log("**1 submit_funding_request");
	console.log("payload.user.id", payload.user.id);
	const formData = payload.view.state.values;
	// Validate date
	const requestedDate = formData.funding_date.input_funding_date.selected_date;

	console.log("requestedDate", requestedDate);
	const selectedDateObj = new Date(requestedDate);
	console.log("selectedDateObj", selectedDateObj);
	const todayObj = new Date();
	selectedDateObj.setHours(0, 0, 0, 0);
	todayObj.setHours(0, 0, 0, 0);
	const Metadata = JSON.parse(payload.view.private_metadata);
	console.log("Metadata", Metadata);

	console.log("Metadata.channelId", Metadata.channelId);
	if (!requestedDate || selectedDateObj < todayObj) {
		// Send a direct message to the user explaining the error
		try {
			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: Metadata.channelId, // This sends a DM to the user
					text: "⚠️ *Erreur*: La date sélectionnée est dans le passé. Veuillez rouvrir le formulaire et sélectionner une date d'aujourd'hui ou future.",
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "⚠️ *Erreur*: La date sélectionnée est dans le passé.",
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "Veuillez créer une nouvelle demande et sélectionner une date d'aujourd'hui ou future.",
							},
						},
					],
				},
				process.env.SLACK_BOT_TOKEN
			);

			context.log("Error notification sent to user");
		} catch (error) {
			await notifyTechSlack(error);

			context.log(`Failed to send error notification: ${error}`);
		}
		return {
			response_action: "errors",
			errors: {
				request_date: "La date ne peut pas être dans le passé",
			},
		};
	}

	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		console.log("userName1", userName);
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
		const requestedDate =
			formData.funding_date.input_funding_date.selected_date;
		const caisseType =
			formData.caisse_type.input_caisse_type.selected_option.value;
		console.log("caisseType", caisseType);
		const caisse = await Caisse.findOne({ type: caisseType });
		if (!caisse) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: userId,
					user: userId,
					text: `Caisse de type "${caisseType}" introuvable.`,
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		}
		// const caisse =
		// 	(await Caisse.findOne()) ||
		// 	new Caisse({
		// 		balances: { XOF: 0, USD: 0, EUR: 0 },
		// 		currency: "XOF",
		// 	});

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
			await notifyTechSlack(error);

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
		const request = caisse.fundingRequests.find(
			(r) => r.requestId === requestId
		);

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
					...generateRequestDetailBlocks(request, caisseType),
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
								text: {
									type: "plain_text",
									text: "Pré-approuver",
									emoji: true,
								},
								style: "primary",
								value: JSON.stringify({ requestId, caisseType }), // Include caisseType in the value
								action_id: "pre_approve_funding", // New action for initial approval
							},
							{
								type: "button",
								text: { type: "plain_text", text: "Rejeter", emoji: true },
								style: "danger",
								value: JSON.stringify({ requestId, caisseType }), // Include caisseType in the value
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
					...generateRequestDetailBlocks(request, caisseType),
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
	});

	return context.res;
}
module.exports = {
	handleOpenFundingForm,
	generateFundingRequestForm,
	handleFundingRequestSubmission,
	generateFundingDetailsBlocks,
	generateRequestDetailBlocks,
	getPaymentMethodText,
	generateFundingRequestBlocks,
	getCaisseTypes,
};
