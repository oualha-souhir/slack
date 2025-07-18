const { Caisse } = require("../Database/dbModels/Caisse.js");
const {
	createSlackResponse,
	postSlackMessage,
	postSlackMessageWithRetry,
} = require("../Common/slackUtils");

const { OpenAI } = require("openai");
const { syncCaisseToExcel } = require("../Excel/report");
const {
	generateRequestDetailBlocks,
} = require("./Handlers/caisseFundingRequestHandlers");
const { notifyUserAI } = require("../Order/Handlers/orderNotificationService");
const { notifyTechSlack } = require("../Common/notifyProblem.js");

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

async function handleCaisseWelcomeMessage(
	userId,
	channelId,
	text,
	params,
	context,
	userName
) {
	console.log("** handleCaisseWelcomeMessage");
	setImmediate(async () => {
		try {
			// const financeUsers = process.env.FINANCE_USER_IDS?.split(",") || [];
			// if (!financeUsers.includes(userId)) {
			// 	console.log("userId", userId);
			// 	await postSlackMessageWithRetry(
			// 		"https://slack.com/api/chat.postEphemeral",
			// 		{
			// 			channel: userId,
			// 			user: userId,
			// 			text: "Erreur: Seuls les membres de Finance peuvent demander des fonds.",
			// 		},
			// 		process.env.SLACK_BOT_TOKEN
			// 	);
			// 	return;
			// }

			// Check if there's text after the command (for text-based creation)
			if (text && text.trim() && text.toLowerCase().includes("montant")) {
				// Handle text-based refund request
				context.log(`Received refund request text: "${text}"`);
				context.log("Starting AI parsing for refund request...");

				try {
					const parsedRequest = await parseRefundFromText(text, context);
					context.log(
						`Parsed refund request: ${JSON.stringify(parsedRequest)}`
					);

					if (
						parsedRequest.montant &&
						parsedRequest.devise &&
						parsedRequest.motif
					) {
						const channelId = params.get("channel_id");
						const channelName = params.get("channel_name");
						context.log(`Channel name resolved: ${channelName}`);

						const newRefundRequest = await createAndSaveRefundRequest(
							userId,
							userName,
							channelName,
							parsedRequest,
							context
						);

						context.log(
							`Refund request created: ${JSON.stringify(newRefundRequest)}`
						);

						await Promise.all([
							notifyAdminRefund(newRefundRequest, context),
							notifyUserRefund(newRefundRequest, userId, context),
						]);

						// Send success confirmation
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: userId,
								user: userId,
								text: `✅ Demande de fonds ${newRefundRequest.requestId} créée avec succès !`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					} else {
						context.log("Invalid refund request - missing required fields.");
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: userId,
								user: userId,
								text: "❌ Erreur: Montant, devise ou motif manquant dans votre demande de remboursement.",
							},
							process.env.SLACK_BOT_TOKEN
						);
					}
				} catch (error) {
					context.log(
						`Background refund request creation error: ${error.stack}`
					);
					await notifyTechSlack(error);
				}
				return;
			}

			// If no text or doesn't contain "montant", show options
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: channelId,
					user: userId,
					blocks: [
						{
							type: "header",
							text: {
								type: "plain_text",
								text: "💰 Demande de fonds",
								emoji: true,
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: `Bonjour <@${userId}> ! Voici comment créer une demande de remboursement :`,
							},
						},
						{
							type: "divider",
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "*Option 1:* Créez une demande rapide avec la syntaxe suivante:",
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "```\n/caisse montant: [montant] devise: [XOF/USD/EUR] motif: [raison] date requise: yyyy-mm-dd\n```",
							},
						},
						{
							type: "context",
							elements: [
								{
									type: "mrkdwn",
									text: "💡 *Exemple:* `/caisse montant: 15000 devise: XOF motif: Solde XOF insuffisant date requise: 2025-12-12`",
								},
							],
						},

						{
							type: "divider",
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "*Option 2:* Utilisez le formulaire interactif ci-dessous",
							},
						},
						{
							type: "actions",
							elements: [
								{
									type: "button",
									text: {
										type: "plain_text",
										text: "📋 Ouvrir le formulaire",
										emoji: true,
									},
									style: "primary",
									action_id: "open_funding_form",
									value: "open_form",
								},
							],
						},
						{
							type: "context",
							elements: [
								{
									type: "mrkdwn",
									text: "ℹ️ *Devises acceptées:* XOF, USD, EUR",
								},
							],
						},
					],
					text: `💰 Bonjour <@${userId}> ! Pour créer une demande de remboursement, utilisez la commande directe ou le formulaire.`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		} catch (error) {
			console.error("Error in async processing:", error);
			// Send error notification to user
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: userId,
					user: userId,
					text: "❌ Une erreur inattendue s'est produite. Veuillez réessayer plus tard.",
				},
				process.env.SLACK_BOT_TOKEN
			);
			await notifyTechSlack(error);
		}
	});
}
// AI parsing function for refund requests
async function parseRefundFromText(text, context) {
	console.log("** parseRefundFromText");
	try {
		const prompt = `
Parse the following text into a structured refund request object with these fields:
{
  "montant": "number",
  "devise": "string (XOF, USD, EUR)",
  "motif": "string",
  "date_requise": "string, in YYYY-MM-DD format"
}

The input uses labels like "montant:", "devise:", "motif:", "date requise:" followed by values. 
Extract only these fields and return a valid JSON string. 
If a field is missing, use reasonable defaults:
- devise defaults to "XOF" if not specified
- date_requise defaults to today's date if not specified
- motif is required

Input text:
"${text}"
`;

		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error("Request timed out")), 15000)
		);

		const openaiPromise = openai.chat.completions.create({
			model: "gpt-3.5-turbo",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 300,
			temperature: 0.5,
		});

		const response = await Promise.race([openaiPromise, timeoutPromise]);
		const rawContent = response.choices[0].message.content.trim();
		context.log(`Raw OpenAI response: ${rawContent}`);

		let result;
		try {
			result = JSON.parse(rawContent);
		} catch (parseError) {
			context.log(
				`Failed to parse OpenAI response as JSON: ${parseError.message}`
			);
			await notifyTechSlack(parseError, context);

			throw new Error(`Invalid JSON from OpenAI: ${rawContent}`);
		}

		// Validate currency
		if (
			result.devise &&
			!["XOF", "USD", "EUR"].includes(result.devise.toUpperCase())
		) {
			result.devise = "XOF"; // Default to XOF if invalid currency
		}

		// Ensure amount is a number
		if (typeof result.montant === "string") {
			result.montant = parseFloat(result.montant);
		}

		context.log("Parsed refund request from AI:", JSON.stringify(result));
		return result;
	} catch (error) {
		context.log(`Error parsing refund request with OpenAI: ${error.message}`);
		await notifyTechSlack(error);

		throw error;
	}
}
// Create and save refund request function
async function createAndSaveRefundRequest(
	userId,
	userName,
	channelName,
	parsedRequest,
	context
) {
	console.log("** createAndSaveRefundRequest");

	// Get or create caisse
	const caisse =
		(await Caisse.findOne()) ||
		new Caisse({
			balances: { XOF: 0, USD: 0, EUR: 0 },
			currency: "XOF",
		});

	// Generate requestId in format FUND/YYYY/MM/XXXX
	const prefix = caisse.prefix || "N/A";
	const now = new Date();
	const year = now.getFullYear();
	const month = (now.getMonth() + 1).toString().padStart(2, "0");
	const existingRequests = caisse.fundingRequests.filter((req) =>
		req.requestId.startsWith(`FUND/${prefix}/${year}/${month}/`)
	);
	const sequence = existingRequests.length + 1;
	const sequenceStr = sequence.toString().padStart(4, "0");
	const requestId = `FUND/${prefix}/${year}/${month}/${sequenceStr}`;

	// Handle date
	let requestedDate;
	if (parsedRequest.date_requise) {
		requestedDate = parsedRequest.date_requise;
	} else {
		requestedDate = new Date().toISOString().split("T")[0];
	}

	// Create refund request object
	const refundRequestData = {
		requestId,
		amount: parsedRequest.montant,
		currency: parsedRequest.devise.toUpperCase(),
		reason: parsedRequest.motif,
		requestedDate,
		submittedBy: userName,
		submittedByID: userId,
		submitterName: userName,
		status: "En attente",
		submittedAt: new Date(),
		workflow: {
			stage: "initial_request",
			history: [
				{
					stage: "initial_request",
					timestamp: new Date(),
					actor: userName,
					details: "Demande initiale soumise via commande",
				},
			],
		},
	};

	// Add to caisse
	caisse.fundingRequests.push(refundRequestData);
	await caisse.save();

	// Sync to Excel
	try {
		await syncCaisseToExcel(caisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		await notifyTechSlack(error);

		context.log(`Excel sync failed for request ${requestId}: ${error.message}`);
	}

	// Return the created request
	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);
	return request;
}
// Notify admin about refund request
async function notifyAdminRefund(request, context) {
	console.log("** notifyAdminRefund");

	// Get current caisse balances
	const caisse = await Caisse.findOne();
	const balances = caisse ? caisse.balances : { XOF: 0, USD: 0, EUR: 0 };

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: Demande de fonds: ${request.requestId}`,
						emoji: true,
					},
				},
				{
					type: "divider",
				},
				...generateRequestDetailBlocks(request, null),
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${balances.XOF}*, USD: *${balances.USD}*, EUR: *${balances.EUR}*`,
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
							value: request.requestId,
							action_id: "pre_approve_funding",
						},
						{
							type: "button",
							text: { type: "plain_text", text: "Rejeter", emoji: true },
							style: "danger",
							value: request.requestId,
							action_id: "reject_fund",
						},
					],
				},
			],
			text: `Nouvelle demande de fonds: ${request.amount} ${request.currency} pour "${request.reason}" (ID: ${request.requestId})`,
		},
		process.env.SLACK_BOT_TOKEN,
		context
	);
}
// Notify user about refund request
async function notifyUserRefund(request, userId, context) {
	console.log("** notifyUserRefund");

	// Get current caisse balances
	const caisse = await Caisse.findOne();
	const balances = caisse ? caisse.balances : { XOF: 0, USD: 0, EUR: 0 };

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: userId,
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
							text: `Soldes actuels: XOF: *${balances.XOF}*, USD: *${balances.USD}*, EUR: *${balances.EUR}*\n ✅ Votre demande de fonds a été soumise. Vous serez notifié lorsqu'elle sera traitée.`,
						},
					],
				},
			],
		},
		process.env.SLACK_BOT_TOKEN,
		context
	);
}
async function handleCaisseTextParsing(
	text,
	params,
	userId,
	userName,
	context,
	logger
) {
	console.log("** handleCaisseTextParsing");
	context.log(`Received refund request text: "${text}"`);
	context.log("Starting AI parsing for refund request...");

	setImmediate(async () => {
		try {
			const parsedRequest = await parseRefundFromText(text, logger);
			logger.log(`Parsed refund request: ${JSON.stringify(parsedRequest)}`);

			if (parsedRequest.montant && parsedRequest.devise) {
				const channelId = params.get("channel_id");
				const channelName = params.get("channel_name");
				logger.log(`Channel name resolved: ${channelName}`);
				const requestedDate = new Date(parsedRequest.date_requise);
				const currentDate = new Date();

				const normalizeDate = (date) =>
					new Date(date.toISOString().split("T")[0]);

				const normalizedRequestedDate = normalizeDate(requestedDate);
				const normalizedCurrentDate = normalizeDate(currentDate);

				if (normalizedRequestedDate < normalizedCurrentDate) {
					logger.log("Invalid order request - requested date is in the past.");
					await notifyUserAI(
						{ id: "N/A" },
						channelId,
						logger,
						"⚠️ *Erreur*: La date sélectionnée est dans le passé."
					);
					return;
				}

				const newRefundRequest = await createAndSaveRefundRequest(
					userId,
					userName,
					channelName,
					parsedRequest,
					logger
				);

				logger.log(
					`Refund request created: ${JSON.stringify(newRefundRequest)}`
				);

				await Promise.all([
					notifyAdminRefund(newRefundRequest, logger),
					notifyUserRefund(newRefundRequest, userId, logger),
				]);
			} else {
				logger.log("Invalid refund request - missing amount or currency.");
				await notifyUserAI(
					{ id: "N/A" },
					userId,
					logger,
					"Montant ou devise manquant dans votre demande de remboursement."
				);
			}
		} catch (error) {
			logger.log(`Background refund request creation error: ${error.stack}`);
			await notifyTechSlack(error);

			// await notifyUserAI(
			// 	{ id: "N/A" },
			// 	channelId,
			// 	logger,
			// 	`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
			// );
		}
	});

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "⌛ Demande de fonds en cours de traitement... Vous serez notifié(e) bientôt !",
	});
}
async function handleCaisseBalanceCommand(channelId, context) {
	const caisse = await Caisse.findOne().sort({ _id: -1 });

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: channelId,
			text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
		},

		process.env.SLACK_BOT_TOKEN
	);
	return (context.res = {
		status: 200,
		body: "", // Empty response acknowledges receipt
	});
}
async function createCaisse(
	type,
	prefix,
	channelId,
	initialBalances = { XOF: 0, USD: 0, EUR: 0 },
	channelName
) {
	console.log("prefix", prefix);
	console.log("channelId", channelId);
	console.log("channelName", channelName);
	console.log("type", type);
	const caisse = new Caisse({
		type,
		prefix,
		channelId,
		channelName,
		balances: initialBalances,
		transactions: [],
		fundingRequests: [],
	});
	await caisse.save();
	await syncCaisseToExcel(caisse, null); // Adjust requestId as needed

	return caisse;
}
async function handleCaisseCreateCommand(text, slackClient, userId, channelId) {
	console.log("Creating new caisse...");
	const args = text.split(" ");
	if (args.length < 4) {
		return createSlackResponse(200, {
			text: "❌ Usage: `/caisse create [name] [prefix] [@channel]`",
		});
	}

	const name = args[1];
	const prefix = args[2];
	const channel = args[3].replace(/[<@#>]/g, "").split("|")[0];

	// Respond immediately to avoid Slack timeout
	setImmediate(async () => {
		try {
			const existing = await Caisse.findOne({ type: name, channelId: channel });
			if (existing) {
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: channelId,
						user: userId,
						text: `❌ Une caisse "${name}" existe déjà pour le canal <#${channel}>.`,
					},
					process.env.SLACK_BOT_TOKEN
				);
				return;
			}

			const channelInfo = await slackClient.conversations.info({ channel });
			const channelName = channelInfo.channel?.name || "unknown";

			await createCaisse(
				name,
				prefix,
				channel,
				{ XOF: 0, USD: 0, EUR: 0 },
				channelName
			);
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: channelId,
					user: userId,
					text: `✅ Caisse "${name}" créée avec succès et associée au canal <#${channel}>.`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		} catch (error) {
			console.error("Error creating caisse:", error.message);
			await notifyTechSlack(error);
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: channelId,
					user: userId,
					text: `❌ Erreur lors de la création de la caisse: ${error.message}`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
	});

	return createSlackResponse(200, {
		text: "⏳ Création de la caisse en cours... Vous serez notifié(e).",
	});
}
async function handleCaisseDeleteCommand(text, slackClient, userId, channelId) {
	console.log("Deleting a caisse...");
	const args = text.split(" ");
	if (args.length < 3) {
		return createSlackResponse(200, {
			text: "❌ Usage: `/caisse delete [type] [#channel]`",
		});
	}

	const type = args[1];
	const channel = args[2].replace(/[<@#>]/g, "").split("|")[0];
	setImmediate(async () => {
		try {
			const caisse = await Caisse.findOneAndDelete({
				type,
				channelId: channel,
			});
			if (!caisse) {
				return await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: channelId,
						user: userId,

						text: `❌ Aucun caisse trouvé avec le type "${type}" et le canal <#${channel}>.`,
					},
					process.env.SLACK_BOT_TOKEN
				);
			}

			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: channelId,
					user: userId,

					text: `✅ Caisse "${type}" supprimée avec succès.`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		} catch (error) {
			console.error("Error deleting caisse:", error.message);
			await notifyTechSlack(error);

			return createSlackResponse(200, {
				text: `❌ Erreur lors de la suppression de la caisse: ${error.message}`,
			});
		}
	});

	return createSlackResponse(200, {
		text: "⏳ Création de la caisse en cours... Vous serez notifié(e).",
	});
}
async function handleCaisseListCommand() {
	console.log("Fetching all caisses...");
	try {
		const caisses = await Caisse.find({});
		if (!caisses.length) {
			return createSlackResponse(200, {
				text: "❌ Aucun caisse trouvé dans la base de données.",
			});
		}

		let responseText = "*📋 Liste des Caisses:*\n";
		caisses.forEach((caisse) => {
			responseText += `• *Caisse:* ${caisse.type}\n`;
			responseText += `  *Préfixe:* ${caisse.prefix}\n`;
			responseText += `  *Channel:* <#${caisse.channelId}>\n`;
			responseText += `  *Balances:* XOF: ${caisse.balances.XOF}, USD: ${caisse.balances.USD}, EUR: ${caisse.balances.EUR}\n`;
		});

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: responseText,
		});
	} catch (error) {
		console.error("Error fetching caisses:", error.message);
		await notifyTechSlack(error);

		return createSlackResponse(200, {
			text: `❌ Erreur lors de la récupération des caisses: ${error.message}`,
		});
	}
}
async function handleCaisseTransferCommand(params) {
	console.log("Processing fund transfer request...");

	// Show transfer form instead of processing directly
	try {
		const triggerId = params.get("trigger_id");
		if (!triggerId) {
			return createSlackResponse(200, {
				text: "❌ Trigger ID manquant. Veuillez réessayer la commande.",
			});
		}

		// Get available caisses for dropdown options
		const caisses = await Caisse.find({});
		const caisseOptions = caisses.map((caisse) => ({
			text: {
				type: "plain_text",
				text: `${caisse.type} (#${caisse.channelId})`,
				emoji: true,
			},
			value: caisse.channelId,
		}));

		if (caisseOptions.length < 2) {
			return createSlackResponse(200, {
				text: "❌ Au moins 2 caisses sont nécessaires pour effectuer un transfert.",
			});
		}

		// Open transfer form modal
		const modalResponse = await postSlackMessage(
			"https://slack.com/api/views.open",
			{
				trigger_id: triggerId,
				view: {
					type: "modal",
					callback_id: "transfer_form",
					title: {
						type: "plain_text",
						text: "Transfert de fonds",
						emoji: true,
					},
					submit: {
						type: "plain_text",
						text: "Soumettre",
						emoji: true,
					},
					close: {
						type: "plain_text",
						text: "Annuler",
						emoji: true,
					},
					blocks: [
						{
							type: "input",
							block_id: "from_caisse_block",
							label: {
								type: "plain_text",
								text: "Caisse source",
								emoji: true,
							},
							element: {
								type: "static_select",
								action_id: "from_caisse_select",
								placeholder: {
									type: "plain_text",
									text: "Sélectionnez la caisse source",
									emoji: true,
								},
								options: caisseOptions,
							},
						},
						{
							type: "input",
							block_id: "to_caisse_block",
							label: {
								type: "plain_text",
								text: "Caisse destination",
								emoji: true,
							},
							element: {
								type: "static_select",
								action_id: "to_caisse_select",
								placeholder: {
									type: "plain_text",
									text: "Sélectionnez la caisse destination",
									emoji: true,
								},
								options: caisseOptions,
							},
						},
						{
							type: "input",
							block_id: "currency_block",
							label: {
								type: "plain_text",
								text: "Devise",
								emoji: true,
							},
							element: {
								type: "static_select",
								action_id: "currency_select",
								placeholder: {
									type: "plain_text",
									text: "Sélectionnez la devise",
									emoji: true,
								},
								options: [
									{
										text: {
											type: "plain_text",
											text: "XOF",
											emoji: true,
										},
										value: "XOF",
									},
									{
										text: {
											type: "plain_text",
											text: "USD",
											emoji: true,
										},
										value: "USD",
									},
									{
										text: {
											type: "plain_text",
											text: "EUR",
											emoji: true,
										},
										value: "EUR",
									},
								],
							},
						},
						{
							type: "input",
							block_id: "amount_block",
							label: {
								type: "plain_text",
								text: "Montant",
								emoji: true,
							},
							element: {
								type: "plain_text_input",
								action_id: "amount_input",
								placeholder: {
									type: "plain_text",
									text: "Entrez le montant à transférer",
									emoji: true,
								},
							},
						},
						{
							type: "input",
							block_id: "motif_block",
							label: {
								type: "plain_text",
								text: "Motif du transfert",
								emoji: true,
							},
							element: {
								type: "plain_text_input",
								action_id: "motif_input",
								multiline: true,
								placeholder: {
									type: "plain_text",
									text: "Expliquez la raison du transfert",
									emoji: true,
								},
							},
						},
						{
							type: "input",
							block_id: "payment_mode_block",
							label: {
								type: "plain_text",
								text: "Mode de paiement",
								emoji: true,
							},
							element: {
								type: "static_select",
								action_id: "payment_mode_select",
								placeholder: {
									type: "plain_text",
									text: "Sélectionnez le mode de paiement",
									emoji: true,
								},
								options: [
									{
										text: {
											type: "plain_text",
											text: "Espèce",
											emoji: true,
										},
										value: "espece",
									},
								],
							},
						},
					],
				},
			},
			process.env.SLACK_BOT_TOKEN
		);

		if (!modalResponse.ok) {
			throw new Error(
				`Erreur lors de l'ouverture du formulaire: ${modalResponse.error}`
			);
		}

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "📋 Formulaire de transfert ouvert !",
		});
	} catch (error) {
		console.error("Error opening transfer form:", error.message);
		await notifyTechSlack(error);

		return createSlackResponse(200, {
			text: `❌ Erreur lors de l'ouverture du formulaire: ${error.message}`,
		});
	}
}
module.exports = {
	handleCaisseTextParsing,
	handleCaisseBalanceCommand,
	handleCaisseCreateCommand,
	handleCaisseDeleteCommand,
	handleCaisseListCommand,
	handleCaisseTransferCommand,
	handleCaisseWelcomeMessage,
};
