//src/orderHandler.js
const { Order, Caisse, PaymentRequest, Config } = require("./db");
const {
	isAdminUser,
	isPurchaseUser,
	isFinanceUser,
	addUserRole,
	removeUserRole,
} = require("./roles");
const {
	getConfigValues,
	addConfigValue,
	removeConfigValue,
	// generateConfigModal,
	// generateManagementModal
} = require("./config");

const { createSlackResponse, postSlackMessage } = require("./utils");
const { syncAllOrdersToExcel } = require("./excelReportORDER");
const { syncOrderToExcel } = require("./excelReportORDER");
const {
	generateFundingRequestForm,
	generateRequestDetailBlocks,
	syncCaisseToExcel,
} = require("./caisseService");

const orderService = require("./orderService");

const { exportReport, exportPaymentReport } = require("./exportService");

const { generateReport, analyzeTrends } = require("./reportService");
const {
	checkPendingOrderDelays,
	checkPaymentDelays,
	checkProformaDelays,
} = require("./handledelay");
const { handleFrequentQuestions } = require("./aiService");

const { OpenAI } = require("openai");
const {
	summarizeOrdersWithChat,
	parseOrderFromText,
	getOrderSummary,
} = require("./aiService");
const {
	notifyAdmin,
	notifyUser,
	notifyUserAI,
	postSlackMessageWithRetry,
	notifyPaymentRequest,
} = require("./notificationService");
const {
	createAndSaveOrder,
	generatePaymentRequestId,
} = require("./orderUtils");
const axios = require("axios");
const querystring = require("querystring");
const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});
// src/orderUtils.js or src/notificationService.js
// Helper function to create payment request blocks
const getPaymentRequestBlocks = (paymentRequest, validatedBy) => [
	{
		type: "section",
		fields: [
			{ type: "mrkdwn", text: `*Titre:*\n${paymentRequest.titre}` },
			{
				type: "mrkdwn",
				text: `*Date:*\n${paymentRequest.date}`,
			},
		],
	},
	{
		type: "section",
		fields: [
			{ type: "mrkdwn", text: `*Demandeur:*\n<@${paymentRequest.demandeur}>` },
			{ type: "mrkdwn", text: `*Channel:*\n<#${paymentRequest.id_projet}>` },
		],
	},
	{
		type: "section",
		fields: [
			{
				type: "mrkdwn",
				text: `*Référence:*\n${paymentRequest.bon_de_commande}`,
			},
			{
				type: "mrkdwn",
				text: `*Date requise:*\n${paymentRequest.date_requete}`,
			},
		],
	},
	{
		type: "section",
		fields: [
			{
				type: "mrkdwn",
				text: `*Montant:*\n${paymentRequest.montant} ${paymentRequest.devise}`,
			},
			{
				type: "mrkdwn",
				text: `*Motif:*\n${paymentRequest.motif || "Non spécifié"}`,
			},
		],
	},
	// New section for justificatif
	...(paymentRequest.justificatif
		? [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `*Justificatif:*\n<${paymentRequest.justificatif}|Voir le document>`,
					},
				},
		  ]
		: []),

	{ type: "divider" },
];
async function processAISummaryAsync(orders, userId, openai, logger) {
	try {
		logger.log("Starting async AI summary processing...");

		const response = await summarizeOrdersWithChat(orders, openai, logger);
		const summaryText = response.text || response;

		logger.log(`Async summary generated: ${summaryText}`);

		const result = await notifyUserAI(
			{ id_commande: "AI_SUMMARY_ASYNC" },
			userId,
			logger,
			summaryText
		);

		logger.log(`Async notification sent: ${JSON.stringify(result)}`);
	} catch (error) {
		logger.log(`Error in async AI processing: ${error.stack}`);

		// Send error notification to user
		await notifyUserAI(
			{ id_commande: "AI_ERROR" },
			userId,
			logger,
			"❌ Erreur lors de la génération du résumé AI."
		);
	}
}
// Enhanced usage example with the improved function
async function handleAICommand(
	logger,
	openai,
	Order,
	notifyUserAI,
	createSlackResponse
) {
	console.log("** handleAICommand");

	try {
		// Fetch orders with better error handling
		const orders = await Order.find({}).sort({ date: -1 }).lean(); // Use lean for better performance

		if (!orders?.length) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "📋 Aucune commande trouvée dans la base de données.",
			});
		}

		logger.log(`Found ${orders.length} orders, generating AI summary...`);

		// Generate summary with enhanced options
		const summaryText = await summarizeOrdersWithChat(orders, openai, logger, {
			model: "gpt-3.5-turbo",
			maxTokens: 350,
			temperature: 0.4,
		});

		logger.log(
			`Summary generated successfully: ${summaryText.substring(0, 100)}...`
		);

		// Send notification
		const notificationResult = await notifyUserAI(
			{ id_commande: "AI_SUMMARY" },
			process.env.SLACK_ADMIN_ID,
			logger,
			summaryText
		);

		logger.log(
			`Notification sent with result: ${
				notificationResult?.success ? "SUCCESS" : "FAILED"
			}`
		);

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "✅ Résumé AI généré et envoyé dans votre DM!",
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `✅ *Résumé AI généré avec succès*\n📊 ${orders.length} commandes analysées\n💬 Résumé envoyé dans votre DM`,
					},
				},
			],
		});
	} catch (error) {
		logger.log(`Error in AI command processing: ${error.message}`);
		logger.log(`Error stack: ${error.stack}`);

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "❌ Erreur lors de la génération du résumé AI. Veuillez réessayer dans quelques instants.",
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "❌ *Erreur lors de la génération du résumé*\n🔄 Veuillez réessayer dans quelques instants\n📞 Contactez le support si le problème persiste",
					},
				},
			],
		});
	}
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
			setTimeout(() => reject(new Error("Request timed out")), 2000)
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
	const now = new Date();
	const year = now.getFullYear();
	const month = (now.getMonth() + 1).toString().padStart(2, "0");
	const existingRequests = caisse.fundingRequests.filter((req) =>
		req.requestId.startsWith(`FUND/${year}/${month}/`)
	);
	const sequence = existingRequests.length + 1;
	const sequenceStr = sequence.toString().padStart(4, "0");
	const requestId = `FUND/${year}/${month}/${sequenceStr}`;

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
				...generateRequestDetailBlocks(request),
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
				...generateRequestDetailBlocks(request),
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

// Helper function to generate request detail blocks (if not already exists)
// function generateRequestDetailBlocks(request) {
//   return [
//     {
//       type: "section",
//       fields: [
//         {
//           type: "mrkdwn",
//           text: `*ID:*\n${request.requestId}`,
//         },
//         {
//           type: "mrkdwn",
//           text: `*Montant:*\n${request.amount} ${request.currency}`,
//         },
//       ],
//     },
//     {
//       type: "section",
//       fields: [
//         {
//           type: "mrkdwn",
//           text: `*Motif:*\n${request.reason}`,
//         },
//         {
//           type: "mrkdwn",
//           text: `*Date Requise:*\n${request.requestedDate}`,
//         },
//       ],
//     },
//     {
//       type: "section",
//       fields: [
//         {
//           type: "mrkdwn",
//           text: `*Demandeur:*\n${request.submitterName}`,
//         },
//         {
//           type: "mrkdwn",
//           text: `*Statut:*\n${request.status}`,
//         },
//       ],
//     },
//     {
//       type: "section",
//       text: {
//         type: "mrkdwn",
//         text: `*Soumis le:*\n${new Date(request.submittedAt).toLocaleString(
//           "fr-FR"
//         )}`,
//       },
//     },
//   ];
// }
// Function to normalize team names by removing accents and converting to lowercase
function normalizeTeamName(teamName) {
	if (!teamName) return "Non spécifié";

	return teamName
		.normalize("NFD") // Decompose accented characters
		.replace(/[\u0300-\u036f]/g, "") // Remove accent marks
		.toLowerCase() // Convert to lowercase
		.trim(); // Remove leading/trailing spaces
}

// Helper to get Slack user info
async function getSlackUserName(userId) {
	try {
		const response = await axios.get("https://slack.com/api/users.info", {
			params: { user: userId },
			headers: {
				Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
			},
		});
		if (response.data.ok) {
			return response.data.user.real_name || response.data.user.name;
		}
		return null;
	} catch (error) {
		console.error("Error fetching Slack user info:", error);
		return null;
	}
}
// Helper to resolve display name to user ID and username
async function resolveUserIdAndName(identifier) {
	console.log("** resolveUserIdAndName");
	console.log(`Resolving user for identifier: ${identifier}`);

	const maxRetries = 5; // Maximum number of retries
	const baseDelay = 1000; // Initial delay in milliseconds

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const response = await axios.get("https://slack.com/api/users.list", {
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			});

			if (response.data.ok) {
				// Try by real_name or username, but check for existence first
				let user = response.data.members.find(
					(u) =>
						(u.real_name &&
							u.real_name.toLowerCase() === identifier.toLowerCase()) ||
						(u.name && u.name.toLowerCase() === identifier.toLowerCase())
				);

				// Fallback: try by email prefix (before @)
				if (!user) {
					user = response.data.members.find(
						(u) =>
							u.profile &&
							u.profile.email &&
							u.profile.email.split("@")[0].toLowerCase() ===
								identifier.toLowerCase()
					);
				}

				if (user) {
					return { userId: user.id, userName: user.real_name || user.name };
				}
			}

			// If no user is found, return null
			return { userId: null, userName: null };
		} catch (error) {
			if (error.response && error.response.status === 429) {
				// Handle rate limit (HTTP 429)
				const retryAfter = error.response.headers["retry-after"]
					? parseInt(error.response.headers["retry-after"], 10) * 1000
					: baseDelay * attempt; // Use Retry-After header if available, otherwise exponential backoff

				console.warn(
					`Rate limit hit. Retrying in ${
						retryAfter / 1000
					} seconds... (Attempt ${attempt}/${maxRetries})`
				);

				await new Promise((resolve) => setTimeout(resolve, retryAfter));
			} else {
				// For other errors, log and rethrow
				console.error("Error resolving user ID and name:", error.message);
				throw error;
			}
		}
	}

	// If all retries fail, throw an error
	throw new Error(
		`Failed to resolve user ID and name for identifier: ${identifier} after ${maxRetries} attempts`
	);
}
async function handleOrderSlackApi(request, context) {
	console.log("** handleOrderSlackApi");
	const logger = {
		log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
	};
	// Initialize OpenAI client
	const openai = new OpenAI({
		apiKey: process.env.OPENAI_API_KEY,
	});

	try {
		console.log("staging");
		context.log("staging");

		// const body = await request.json();
		// if (body.type === "url_verification") {
		//   return { status: 200, body: body.challenge };
		// }

		const body = await request.text();

		const params = new URLSearchParams(body);
		const command = params.get("command");
		const text = params.get("text") || "";
		const userId = params.get("user_id");
		const userName = params.get("user_name");
		const channelId = params.get("channel_id");

		context.log(
			`Command: ${command}, Text: ${text}, User ID: ${userId}, User Name: ${userName}, Channel ID: ${channelId}`
		);
		const isUserAdmin = await isAdminUser(userId);

		// ********************* $$$ ******************************************* */
		if ((command === "/caisset") || (command === "/caisse-test")|| (command === "/caisse")) {

			// if (command === "/caisse-test") {
			const isUserAdmin = await isAdminUser(userId);
			const isUserFinance = await isFinanceUser(userId);
			if (!isUserAdmin && !isUserFinance) {
				return createSlackResponse(200, {
					text: "🚫 Seuls les utilisateurs de la finance peuvent gérer les demandes de fonds.",
				});
			}
			if (text.toLowerCase().includes("devise")) {
				context.log(`Received refund request text: "${text}"`);
				context.log("Starting AI parsing for refund request...");

				setImmediate(async () => {
					try {
						const parsedRequest = await parseRefundFromText(text, logger);
						logger.log(
							`Parsed refund request: ${JSON.stringify(parsedRequest)}`
						);

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
								logger.log(
									"Invalid order request - requested date is in the past."
								);
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
							logger.log(
								"Invalid refund request - missing amount or currency."
							);
							await notifyUserAI(
								{ id: "N/A" },
								userId,
								logger,
								"Montant ou devise manquant dans votre demande de remboursement."
							);
						}
					} catch (error) {
						logger.log(
							`Background refund request creation error: ${error.stack}`
						);
						await notifyUserAI(
							{ id: "N/A" },
							channelId,
							logger,
							`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
						);
					}
				});

				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Demande de fonds en cours de traitement... Vous serez notifié(e) bientôt !",
				});
			}
			if (text.trim() === "balance") {
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

			context.res = {
				status: 200,
				body: "",
			};

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
								context.log(
									"Invalid refund request - missing required fields."
								);
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
							await postSlackMessageWithRetry(
								"https://slack.com/api/chat.postEphemeral",
								{
									channel: channelId,
									user: userId,
									text: `❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`,
								},
								process.env.SLACK_BOT_TOKEN
							);
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
				}
			});

			return;
			// ********************* $$$ ******************************************* */
		} else if ((command == "/paymentt") || (command == "/payment-test") || (command == "/payment")) {
			// } else if (command == "/payment-test") {
			if (text.toLowerCase().includes("montant")) {
				context.log(`Received payment text: "${text}"`);
				context.log("Starting AI payment parsing...");

				setImmediate(async () => {
					try {
						const parsedPayment = await parsePaymentFromText(text, logger);
						logger.log(`Parsed payment: ${JSON.stringify(parsedPayment)}`);

						if (parsedPayment.montant && parsedPayment.montant > 0) {
							const channelId = params.get("channel_id");
							const channelName = params.get("channel_name");
							logger.log(`Channel name resolved: ${channelId}`);
							console.log("params.get", params.get("user_id"));
							const requestedDate = new Date(parsedPayment.date_requise);
							const currentDate = new Date();

							if (requestedDate < currentDate) {
								logger.log(
									"Invalid refund request - requested date is in the past."
								);
								await notifyUserAI(
									{ id: "N/A" },
									channelId,
									logger,
									"⚠️ *Erreur*: La date sélectionnée est dans le passé."
								);
								return createSlackResponse(200, {
									response_type: "ephemeral",
									text: "❌ Erreur : La date requise ne peut pas être dans le passé.",
								});
							}
							const newPaymentRequest = await createAndSavePaymentRequest(
								userId,
								userName,
								channelId,
								channelName,
								{
									request_title: {
										input_request_title: {
											value:
												parsedPayment.titre || "Demande de paiement sans titre",
										},
									},
									request_date: {
										input_request_date: {
											selected_date:
												parsedPayment.date_requise ||
												new Date().toISOString().split("T")[0],
										},
									},
									payment_reason: {
										input_payment_reason: {
											value: parsedPayment.motif || "Motif non spécifié",
										},
									},
									amount_to_pay: {
										input_amount_to_pay: {
											value: `${parsedPayment.montant} ${
												parsedPayment.devise || "XOF"
											}`,
										},
									},
									po_number: {
										input_po_number: {
											value: parsedPayment.bon_de_commande || null,
										},
									},
								},
								logger
							);

							logger.log(
								`Payment request created: ${JSON.stringify(newPaymentRequest)}`
							);

							await Promise.all([
								notifyPaymentRequest(newPaymentRequest, logger, userId),
								// notifyUserPayment(newPaymentRequest, userId, logger),
							]);
						} else {
							logger.log("No valid payment amount found in parsed request.");
							await notifyUserAI(
								{ id_paiement: "N/A" },
								userId,
								logger,
								"Aucun montant valide détecté dans votre demande de paiement."
							);
						}
					} catch (error) {
						logger.log(
							`Background payment request creation error: ${error.stack}`
						);
						await notifyUserAI(
							{ id_paiement: "N/A" },
							channelId,
							logger,
							`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
						);
					}
				});

				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Demande de paiement en cours de traitement... Vous serez notifié(e) bientôt !",
				});
			}
			// Updated command handler for payment reports
			if (text.trim().startsWith("report")) {
				if (!isUserAdmin) {
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postEphemeral",
						{
							channel: userId,
							user: userId,
							text: "🚫 Seuls les administrateurs peuvent générer des rapports.",
						},
						process.env.SLACK_BOT_TOKEN
					);
					return { status: 200, body: "" };
				}

				setImmediate(async () => {
					const args = text.trim().split(" ").slice(1); // Remove "report" from args
					if (args.length < 2) {
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: userId,
								user: userId,
								text: "❌ Usage: /payment report [payment|project|date|status|user] [value]\nExemples:\n• /payment report payment PAY/2025/03/0001\n• /payment report project general\n• /payment report date 2025-03-01\n• /payment report status 'En attente'\n• /payment report user U1234567890",
							},
							process.env.SLACK_BOT_TOKEN
						);
						return { status: 200, body: "" };
					}

					const [reportType, ...valueParts] = args;
					const value = valueParts.join(" ");

					try {
						console.log("dddd");
						await exportPaymentReport(
							context,
							reportType,
							value,
							userId,
							channelId
						);
						return { status: 200, body: "" };
					} catch (error) {
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: userId,
								user: userId,
								text: `❌ Erreur lors de la génération du rapport de paiement : ${error.message}`,
							},
							process.env.SLACK_BOT_TOKEN
						);
						return { status: 200, body: "" };
					}
				});
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Génération du rapport en cours... Vous recevrez le fichier Excel dans quelques instants.",
				});
			}
			// } else if (command == "/payment-test") {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: "👋 Bienvenue",
							emoji: true,
						},
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `Bonjour <@${userId}> ! Voici comment passer une nouvelle demande de paiement :`,
						},
					},
					{
						type: "divider",
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "*Option 1:* Créez une demande de paiement rapide avec la syntaxe suivante :",
						},
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "```\n/payment titre: [Titre de la demande] date requise: yyyy-mm-dd motif: [Raison du paiement] montant: [Montant] [Devise] bon de commande: [Numéro de bon, optionnel]\n```",
						},
					},
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: "💡 *Exemple:* `/payment titre: Achat de matériel informatique date requise: 2025-12-12 motif: Remplacement ordinateurs défaillants montant: 50000 XOF bon de commande: PO-2025-001A`",
							},
						],
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "*Option 2:* Utilisez le formulaire ci-dessous",
						},
					},
				],
				// Fallback for older Slack clients that don't support blocks
				text: `👋 Bonjour <@${userId}> ! Pour passer une demande, vous pouvez utiliser le formulaire ci-dessous.`,
				attachments: [
					{
						callback_id: "finance_payment_form",
						actions: [
							{
								name: "finance_payment_form",
								type: "button",
								text: "💰 Demande de paiement",
								value: "open",
								action_id: "finance_payment_form",
								style: "primary",
							},
						],
					},
				],
			});

			// ********************* $$$ ******************************************* */
		} else if ((command == "/ordert") || (command == "/order-test") || (command === "/order")) {
		// } else if (command == "/order-test") {


			if (!text.trim()) {
				console.log("** no text");
				return createSlackResponse(200, {  
					response_type: "ephemeral",
					blocks: [
						{
							type: "header",
							text: {
								type: "plain_text",
								text: "👋 Bienvenue",
								emoji: true,
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: `Bonjour <@${userId}> ! Voici comment passer une nouvelle commande:`,
							},
						},
						{
							type: "divider",
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "*Option 1:* Créez une commande rapide avec la syntaxe suivante:",
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "```\n/order titre: [Votre titre] equipe: [Nom de l'équipe] date requise: yy-mm-jj articles: [quantité] [unité] Désignation: [désignation]\n```",
							},
						},
						{
							type: "context",
							elements: [
								{
									type: "mrkdwn",
									text: "💡 *Exemple:* `/order titre: Matériel Électrique equipe: Maçons date requise: 2025-12-12 articles: 10 piece Désignation: rouleaux de câble souple VGV de 2×2,5 bleu-marron`",
								},
							],
						},

						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "*Option 2:* Utilisez la formulaires ci-dessous",
							},
						},
					],
					// Fallback for older Slack clients that don't support blocks
					text: `👋 Bonjour <@${userId}> ! Pour passer une demande, vous pouvez utiliser les formulaires ou les commandes directes.`,
					attachments: [
						{
							callback_id: "order_form",
							actions: [
								{
									name: "open_form",
									type: "button",
									text: "📋 Nouvelle commande",
									value: "open",
									action_id: "open_form",
									style: "primary",
								},
							],
						},
					],
				});
			}
			if (text.trim().startsWith("report")) {
				console.log("** report");
				if (!isUserAdmin) {
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postEphemeral",
						{
							channel: userId,
							user: userId,
							text: "🚫 Seuls les administrateurs peuvent générer des rapports.",
						},
						process.env.SLACK_BOT_TOKEN
					);
					return { status: 200, body: "" };
				}
				setImmediate(async () => {
					const args = text.trim().split(" ").slice(1); // Remove "report" from args
					if (args.length < 2) {
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: userId,
								user: userId,
								text: "❌ Usage: /order report [order|team|date] [value]\nExemple: /order report order CMD/2025/03/0001 ou /order report team Maçons ou /order report date 2025-03-01",
							},
							process.env.SLACK_BOT_TOKEN
						);
						return { status: 200, body: "" };
					}

					const [reportType, ...valueParts] = args;
					const value = valueParts.join(" ");

					try {
						await exportReport(context, reportType, value, userId, channelId);
						return { status: 200, body: "" };
					} catch (error) {
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: userId,
								user: userId,
								text: `❌ Erreur lors de la génération du rapport : ${error.message}`,
							},
							process.env.SLACK_BOT_TOKEN
						);
						return { status: 200, body: "" };
					}
				});
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Génération du rapport en cours... Vous recevrez le fichier Excel dans quelques instants.",
				});
			}
			//? changed from report to summary
			if (text.trim() === "summary") {
				console.log("** summary");
				await generateReport(context);
				await analyzeTrends(context);

				return createSlackResponse(200, "summary completed!");
			}

			if (text.trim().startsWith("add-role")) {
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						text: "🚫 Seuls les admins peuvent gérer les rôles.",
					});
				}
				const [, mention, role] = text.trim().split(" ");
				if (role !== "admin" && role !== "finance" && role !== "achat") {
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postMessage",
						{
							channel: channelId,
							text: "🚫 Invalid role. Only 'admin', 'finance', or 'achat' are allowed.",
						},
						process.env.SLACK_BOT_TOKEN
					);
					return (context.res = {
						status: 200,
						body: "", // Empty response acknowledges receipt
					});
				}
				// const userIdToAdd = mention.replace(/[<@>]/g, "");
				// const userNameToAdd = await getSlackUserName(userIdToAdd);
				// If mention is not in <@Uxxxx> format, try to resolve by display name
				// ...existing code...
				let userIdToAdd, userNameToAdd;
				if (mention.startsWith("<@")) {
					userIdToAdd = mention.replace(/[<@>]/g, "");
					userNameToAdd = await getSlackUserName(userIdToAdd);
				} else {
					// Remove leading @ if present
					const identifier = mention.replace(/^@/, "");
					const resolved = await resolveUserIdAndName(identifier);
					userIdToAdd = resolved.userId;
					userNameToAdd = resolved.userName;
				}
				// ...existing code...
				console.log(
					`Adding role ${role} to user ${userIdToAdd} (${userNameToAdd})`
				);
				await addUserRole(userIdToAdd, role, userNameToAdd); // Update your addUserRole to accept and store the name
				return createSlackResponse(200, {
					text: `✅ Rôle ${role} ajouté à <@${userIdToAdd}>.`,
				});
			}
			if (text.trim().startsWith("rm-role")) {
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						text: "🚫 Seuls les admins peuvent gérer les rôles.",
					});
				}
				const [, mention, role] = text.trim().split(" ");
				// const userIdToRemove = mention.replace(/[<@>]/g, "");
				let userIdToRemove;
				if (mention.startsWith("<@")) {
					userIdToRemove = mention.replace(/[<@>]/g, "");
				} else {
					// Remove leading @ if present
					const identifier = mention.replace(/^@/, "");
					const resolved = await resolveUserIdAndName(identifier);
					userIdToRemove = resolved.userId;
				}
				await removeUserRole(userIdToRemove, role);
				return createSlackResponse(200, {
					text: `✅ Rôle ${role} retiré de <@${userIdToRemove}>.`,
				});
			}
			const textArgs = text.trim().split(" ");
			const subCommand = textArgs[0];
			if (subCommand === "list-users") {
				console.log("** listusers");
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "🚫 Seuls les administrateurs peuvent voir la liste des utilisateurs et rôles.",
					});
				}

				// Fetch all users and their roles
				const users = await require("./db").UserRole.find({});
				if (!users.length) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "Aucun utilisateur avec des rôles trouvés.",
					});
				}

				let text = "*👥 Liste des utilisateurs et rôles assignés:*\n";
				users.forEach((user) => {
					text += `• <@${user.userId}> : ${user.roles.join(", ")}\n`;
				});

				return createSlackResponse(200, {
					response_type: "ephemeral",
					text,
				});
			}

			// // Configuration management command
			if (subCommand === "config") {
				console.log("** config");
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "🚫 Seuls les administrateurs peuvent configurer les options.",
					});
				}
				setImmediate(async () => {
					try {
						// Fetch current config from DB
						const equipeOptions = await getConfigValues("equipe_options", [
							"IT",
							"Finance",
							"Achat",
							"RH",
						]);
						const unitOptions = await getConfigValues("unit_options", [
							"pièce",
							"kg",
							"litre",
							"mètre",
						]);
						const currencies = await getConfigValues("currencies", [
							"TND",
							"EUR",
							"USD",
						]);
						const fournisseurOptions = await getConfigValues(
							"fournisseur_options",
							["Fournisseur A", "Fournisseur B", "Fournisseur C"]
						);

						console.log("equipeOptions", equipeOptions);
						console.log("unitOptions", unitOptions);
						console.log("currencies", currencies);
						console.log("fournisseurOptions", fournisseurOptions);

						// Send configuration as a message visible to all
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: channelId,
								text: `*Configuration actuelle:*\n\n*👥 Équipes:*\n${
									equipeOptions.length > 0
										? equipeOptions.map((e) => `• ${e}`).join("\n")
										: "Aucune équipe configurée"
								}\n\n*📏 Unités:*\n${
									unitOptions.length > 0
										? unitOptions.map((u) => `• ${u}`).join("\n")
										: "Aucune unité configurée"
								}\n\n*💰 Devises:*\n${
									currencies.length > 0
										? currencies.map((c) => `• ${c}`).join("\n")
										: "Aucune devise configurée"
								}\n\n*🏢 Fournisseurs:*\n${
									fournisseurOptions.length > 0
										? fournisseurOptions.map((f) => `• ${f}`).join("\n")
										: "Aucun fournisseur configuré"
								}\n\n_Utilisez les commandes add/remove pour modifier._`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					} catch (error) {
						console.error("Error fetching configuration:", error);
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: channelId,
								text: "❌ Erreur lors de la récupération de la configuration. Veuillez réessayer.",
							},
							process.env.SLACK_BOT_TOKEN
						);
					}
				});
				// Return immediate response to avoid timeout
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Récupération de la configuration en cours...",
				});
			}
			// // Add configuration items
			if (subCommand === "add") {
				console.log("** add");
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "🚫 Seuls les administrateurs peuvent ajouter des configurations.",
					});
				}

				if (textArgs.length < 3) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "Usage: `/order add [equipe|unit|currency] <valeur>`",
					});
				}

				const configType = textArgs[1];
				const value = textArgs.slice(2).join(" ");

				let configKey;
				let displayName;

				switch (configType) {
					case "equipe":
						configKey = "equipe_options";
						displayName = "équipe";
						break;
					case "unit":
						configKey = "unit_options";
						displayName = "unité";
						break;
					case "currency":
						configKey = "currencies";
						displayName = "devise";
						break;
					case "fournisseur":
						configKey = "fournisseur_options";
						displayName = "fournisseur";
						break;
					default:
						return createSlackResponse(200, {
							response_type: "ephemeral",
							text: "❌ Type invalide. Utilisez: equipe, unit, ou currency",
						});
				}

				setImmediate(async () => {
					try {
						await addConfigValue(configKey, value);
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: channelId,
								text: `✅ ${
									displayName.charAt(0).toUpperCase() + displayName.slice(1)
								} "${value}" ajoutée avec succès.`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					} catch (error) {
						console.error("Error adding config value:", error);
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: channelId,
								text: `❌ Erreur lors de l'ajout de la ${displayName}: ${error.message}`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					}
				});
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: channelId,
						text: "⌛ Operation en cours...",
					},
					process.env.SLACK_BOT_TOKEN
				);
			}

			// Remove configuration items
			if (subCommand === "rm") {
				console.log("** rm");
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "🚫 Seuls les administrateurs peuvent supprimer des configurations.",
					});
				}

				if (textArgs.length < 3) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "Usage: `/order rm [equipe|unit|currency] <valeur>`",
					});
				}

				const configType = textArgs[1];
				const value = textArgs.slice(2).join(" ");

				let configKey;
				let displayName;

				switch (configType) {
					case "equipe":
						configKey = "equipe_options";
						displayName = "équipe";
						break;
					case "unit":
						configKey = "unit_options";
						displayName = "unité";
						break;
					case "currency":
						configKey = "currencies";
						displayName = "devise";
						break;
					case "fournisseur":
						configKey = "fournisseur_options";
						displayName = "fournisseur";
						break;
					default:
						return createSlackResponse(200, {
							response_type: "ephemeral",
							text: "❌ Type invalide. Utilisez: equipe, unit, ou currency",
						});
				}
				setImmediate(async () => {
					try {
						await removeConfigValue(configKey, value);
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: channelId,
								text: `✅ ${
									displayName.charAt(0).toUpperCase() + displayName.slice(1)
								} "${value}" supprimée avec succès.`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					} catch (error) {
						console.error("Error removing config value:", error);
						return createSlackResponse(200, {
							response_type: "ephemeral",
							text: `❌ Erreur lors de la suppression de la ${displayName}.`,
						});
					}
				});
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: channelId,
						text: "⌛ Operation en cours...",
					},
					process.env.SLACK_BOT_TOKEN
				);
			}

			// Help command
			if (subCommand === "help" || !subCommand) {
				console.log("** help");
				const isUserAdmin = await isAdminUser(userId);
				const isUserFinance = await isFinanceUser(userId);
				const isUserPurchase = await isPurchaseUser(userId);

				let helpText = "*🛠️ Commandes disponibles:*\n\n";

				if (isUserAdmin) {
					helpText += "*Commandes pour les administrateurs:*\n";
					helpText += "*Configuration:*\n";
					helpText +=
						"• `/order config` - Ouvrir le panneau de configuration\n";
					// helpText += "• `/order list` - Lister toutes les configurations\n";
					helpText +=
						"• `/order add [equipe|unit|currency|fournisseur] <valeur>` - Ajouter une option\n";
					helpText +=
						"• `/order rm [equipe|unit|currency|fournisseur] <valeur>` - Supprimer une option\n\n";
					helpText += "*Gestion des rôles:*\n";
					helpText += "• `/order list-users` - Lister tous les utilisateurs\n";
					helpText +=
						"• `/order add-role @user [admin|finance|achat]` - Ajouter un rôle\n";
					helpText +=
						"• `/order rm-role @user [admin|finance|achat]` - Retirer un rôle\n\n";
					helpText += "• `/order delete <order_id>` - Supprimer une commande\n";
				}
				if (isUserAdmin || isUserFinance || isUserPurchase) {
					helpText +=
						"*Commandes pour les administrateurs, les équipes financières et les équipes d'achat:*\n";

					helpText += "• `/order summary` - Générer un résumé global\n";
					helpText +=
						"• `/order report [order|channel|date|status|user|team] <valeur>` - Générer un rapport de commandes\n";
					helpText +=
						"• `/payment report [payment|channel|date|status|user] <valeur>` - Générer un rapport de paiements\n";
					helpText += "• `/order check-delays` - Vérifier les retards\n";
					helpText +=
						"• `/order list detailed` - Liste détaillée des commandes\n";
					helpText += "• `/order list` - Liste des commandes récentes\n";
					helpText +=
						"• `/order filterby [titre|status|demandeur|équipe]:<valeur>` - Filtrer les commandes\n";
					helpText += "• `/order resume` - Résumé IA des commandes\n";
				}
				if (isUserAdmin || isUserFinance) {
					helpText += "*Commandes pour les finances:*\n";
					helpText += "• `/caisse balance` - Afficher le solde de la caisse\n";
					helpText += "• `/caisse` - Créer une demande de fonds\n";
				}

				// Add general commands for all users
				helpText += "*Commandes générales:*\n";

				helpText +=
					"• `/order ask ai: <question>` - Poser une question à l'IA\n";
				helpText += "• `/order my order` - Voir votre dernière commande\n";
				helpText += "• `/payment` - Créer une demande de paiement\n";
				helpText += "• `/order` - Créer une commande\n";

				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: helpText,
				});
			}

			// !
			if (text.trim() === "my order") {
				console.log("** my order");
				const summary = await getOrderSummary(userId);
				console.log("summary", summary);
				if (summary) {
					const response = `📋 **Résumé de votre dernière commande**
 ID: ${summary.id}
📝 Titre: ${summary.title}
👥 Équipe: ${summary.team}
📊 Statut: ${summary.status}
💰 Total: ${summary.totalAmount}€
✅ Payé: ${summary.amountPaid}€
⏳ Restant: ${summary.remainingAmount}€
📄 Proformas: ${summary.validatedProformasCount}/${summary.proformasCount}`;
					// return { response };
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postMessage",
						{
							channel: channelId,
							text: response,
						},

						process.env.SLACK_BOT_TOKEN
					);
					return (context.res = {
						status: 200,
						body: "", // Empty response acknowledges receipt
					});
				}
			}
			// !
			// Simplified AI command handling
			if (textArgs[0].toLowerCase() === "resume") {
				console.log("** resume");
				await postSlackMessage(
					"https://slack.com/api/chat.postMessage",
					{
						channel: process.env.SLACK_ADMIN_ID,
						text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
					},
					process.env.SLACK_BOT_TOKEN
				);
				// Process in background
				setImmediate(async () => {
					await handleAICommand(
						logger, // Assuming logger is correctly defined
						openai, // OpenAI client instance
						Order, // Mongoose model for orders
						notifyUserAI, // Function for sending notifications
						createSlackResponse // Function for formatting Slack responses
					);
				});
				return createSlackResponse(200, "AI command processed successfully.");
			}

			if (textArgs[0] === "list" || textArgs[0] === "filterby") {
				try {
					if (textArgs[0] === "list") {
						if (textArgs[1] === "detailed") {
							// Handle "/order list brief"
							return await orderService.handleOrderList(isUserAdmin, context);
						}
						// Default "/order list" (detailed version)
						return await handleOrderListSlack(isUserAdmin, context);
					} else if (textArgs[0] === "filterby") {
						const argsToParse = textArgs.slice(1);
						context.log(`🧩 Args to parse: ${JSON.stringify(argsToParse)}`);
						const filters = parseFilters(argsToParse);
						context.log(`🔍 Filters parsed: ${JSON.stringify(filters)}`);
						const response = await handleOrderOverview(
							isUserAdmin,
							filters,
							context
						);
						context.log(`📤 Response to Slack: ${JSON.stringify(response)}`);
						return response; // Ensure the response is returned
					}
				} catch (error) {
					logger.log(`Background list processing error: ${error.stack}`);
					await notifyUserAI(
						{ id_commande: "N/A" },
						userId,
						logger,
						`Erreur : ${error.message}`
					);
				}

				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Liste en cours de génération... Vous recevrez un résumé bientôt !",
				});
			}

			if (text.toLowerCase().includes("equipe")) {
				context.log(`Received text: "${text}"`);
				context.log("Starting AI parsing...");
				setImmediate(async () => {
					try {
						const parsedOrder = await parseOrderFromText(text, logger);
						logger.log(`Parsed order: ${JSON.stringify(parsedOrder)}`);
						if (parsedOrder.articles && parsedOrder.articles.length > 0) {
							const channelId = params.get("channel_id");
							const channelName = params.get("channel_name");
							logger.log(`Channel name resolved: ${channelId}`);
							logger.log(`Channel name resolved: ${channelName}`);
							const requestedDate = new Date(parsedOrder.date_requise);
							const currentDate = new Date();

							if (requestedDate < currentDate) {
								logger.log(
									"Invalid refund request - requested date is in the past."
								);

								await notifyUserAI(
									{ id: "N/A" },
									channelId,
									logger,
									"⚠️ *Erreur*: La date sélectionnée est dans le passé."
								);
								return createSlackResponse(200, {
									response_type: "ephemeral",
									text: "❌ Erreur : La date requise ne peut pas être dans le passé.",
								});
							}
							console.log("parsedOrder ", parsedOrder);
							// Normalize the team name before using it
							const normalizedEquipe = normalizeTeamName(parsedOrder.equipe);

							const newOrder = await createAndSaveOrder(
								userId,
								userName,
								channelName,
								channelId,
								{
									request_title: {
										input_request_title: {
											value: parsedOrder.titre || "Commande sans titre",
										},
									},
									equipe_selection: {
										select_equipe: {
											selected_option: {
												text: {
													text: parsedOrder.equipe, // Ensure `normalizedEquipe` is assigned to the nested `text` property
												},
											},
										},
									},
									request_date: {
										input_request_date: {
											selected_date:
												parsedOrder.date_requise ||
												new Date().toISOString().split("T")[0],
										},
									},
								},
								parsedOrder.articles.map((article) => ({
									quantity: article.quantity || 1, // Default to 1 if missing
									unit: article.unit || undefined,
									designation: article.designation || "Article non spécifié", // Default if missing
								})),
								[],
								[],
								logger
							);

							logger.log(`Order created: ${JSON.stringify(newOrder)}`);
							await Promise.all([
								notifyAdmin(newOrder, logger),
								notifyUser(newOrder, userId, logger),
							]);
						} else {
							logger.log("No articles found in parsed order.");
							await notifyUserAI(
								{ id_commande: "N/A" },
								channelId,
								logger,
								"Aucun article détecté dans votre commande."
							);
						}
					} catch (error) {
						logger.log(`Background order creation error: ${error.stack}`);
						await notifyUserAI(
							{ id_commande: "N/A" },
							channelId,
							logger,
							`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
						);
					}
				});
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
				});
			}
			if (text.toLowerCase().includes("ask ai:")) {
				// Acknowledge Slack within 3 seconds
				setImmediate(async () => {
					try {
						const faqResponse = await handleFrequentQuestions(
							text,
							userId,
							context
						);
						if (faqResponse.response) {
							// Format the JSON response into a readable string
							const formattedResponse =
								typeof faqResponse.response === "string"
									? faqResponse.response
									: Object.entries(faqResponse.response)
											.map(([key, value]) => `*${key}:* ${value}`)
											.join("\n");

							await postSlackMessageWithRetry(
								"https://slack.com/api/chat.postMessage",
								{ channel: channelId, text: formattedResponse },

								process.env.SLACK_BOT_TOKEN
							);

							context.log(`FAQ response sent: ${formattedResponse}`);
						}
					} catch (error) {
						context.log(`FAQ processing error: ${error.stack}`);
						await postSlackMessage(
							"https://slack.com/api/chat.postEphemeral",
							{
								user: userId,
								text: `Erreur: ${error.message}`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					}
				});

				// Immediate acknowledgment
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Vérification en cours... Réponse bientôt !",
				});
			}
			if (text.trim() === "check-delays") {
				await checkPendingOrderDelays();
				await checkPaymentDelays();
				await checkProformaDelays();
				return createSlackResponse(200, "Delay check completed!");
			}

			// Add delete command handler
			if (text.trim().startsWith("delete")) {
				const orderId = text.trim().split(" ")[1];
				console.log("orderId1", orderId);
				if (!orderId) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "❌ Usage: /order delete [order_id]\nExemple: /order delete CMD/2025/03/0001",
					});
				}
				const existingOrder = await Order.findOne({ id_commande: orderId });

				if (!existingOrder) {
					throw new Error(`Commande ${orderId} non trouvée`);
				}

				if (existingOrder.deleted === true) {
					// Send notification that order is already deleted
					await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: channelId,
							text: `⚠️ La commande ${orderId} a déjà été supprimée.`,
							blocks: [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `⚠️ La commande ${orderId} a déjà été supprimée.`,
									},
								},
							],
						},
						process.env.SLACK_BOT_TOKEN
					);
					return createSlackResponse(200);
				}

				// Check if user is admin
				if (!isUserAdmin) {
					return createSlackMessage(
						"https://slack.com/api/chat.postEphemeral",
						{
							channel: channelId,
							user: userId,
							text: "🚫 Seuls les administrateurs peuvent supprimer des commandes.",
						},
						process.env.SLACK_BOT_TOKEN
					);
				}

				// Show confirmation dialog
				try {
					const triggerId = params.get("trigger_id");
					if (!triggerId) {
						throw new Error("Trigger ID is required for opening the dialog");
					}

					const dialogResponse = await postSlackMessage(
						"https://slack.com/api/views.open",
						{
							trigger_id: triggerId,
							view: {
								type: "modal",
								callback_id: "delete_order_confirmation",
								title: {
									type: "plain_text",
									text: "Suppression de commande",
									emoji: true,
								},
								submit: {
									type: "plain_text",
									text: "Supprimer",
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
											text: `:warning: *Êtes-vous sûr de vouloir supprimer la commande ${orderId} ?*\n\nCette action est irréversible.`,
										},
									},
									{
										type: "input",
										block_id: "delete_reason_block",
										label: {
											type: "plain_text",
											text: "Raison de la suppression",
											emoji: true,
										},
										element: {
											type: "plain_text_input",
											action_id: "delete_reason_input",
											multiline: true,
											placeholder: {
												type: "plain_text",
												text: "Entrez la raison de la suppression (optionnel)",
												emoji: true,
											},
										},
									},
								],
								private_metadata: JSON.stringify({
									orderId: orderId,
									channelId: channelId,
								}),
							},
						},
						process.env.SLACK_BOT_TOKEN
					);

					console.log("dialogResponse", dialogResponse);
					if (!dialogResponse.ok) {
						throw new Error(
							`Unable to open confirmation dialog: ${dialogResponse.error}`
						);
					}

					// Send notification to channel about pending deletion
					await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: channelId,
							text: `:hourglass: *Demande de suppression en cours*\nLa commande ${orderId} est en cours de suppression par <@${userId}>.`,
							blocks: [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `:hourglass: *Demande de suppression en cours*\nLa commande ${orderId} est en cours de suppression par <@${userId}>.`,
									},
								},
							],
						},
						process.env.SLACK_BOT_TOKEN
					);

					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "⌛ Ouverture de la confirmation de suppression...",
					});
				} catch (error) {
					context.log(`Error in delete command: ${error.message}`);
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: `❌ Erreur: ${error.message}`,
					});
				}
			}
		} else if (
			command !== "/order" &&
			command !== "/payment" &&
			command !== "/caisse"
		) {
			// Default response for unknown commands
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❓ Commande inconnue. Utilisez `/order help` pour voir les commandes disponibles.",
			});
			// return createSlackResponse(400, "Commande inconnue");
		}

		// Add this condition to handle payment request text parsing
	} catch (error) {
		context.log(`❌ Erreur: ${error.stack}`);
		return createSlackResponse(500, "Erreur interne");
	}
}

async function parsePaymentFromText(text, context) {
	console.log("** parsePaymentFromText");
	try {
		const prompt = `
Parse the following text into a structured payment request object with these fields:
{
  "titre": "string",
  "date_requise": "string, in YYYY-MM-DD format",
  "motif": "string, reason for payment",
  "montant": "number, payment amount",
  "devise": "string, currency code (XOF, EUR, USD)",
  "bon_de_commande": "string, optional achat order number"
}

The input uses labels like "titre:", "date requise:", "motif:", "montant:", "devise:", "bon de commande:" followed by values. 
Extract only these fields and return a valid JSON string. If a field is missing, use reasonable defaults:
- devise defaults to 'XOF' if not specified
- date_requise defaults to today if not specified
- If montant includes currency (like "1000 XOF"), separate the amount and currency

Input text:
"${text}"
`;

		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error("Request timed out")), 10000)
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
			throw new Error(`Invalid JSON from OpenAI: ${rawContent}`);
		}

		// Validate currency
		if (result.devise && !["XOF", "EUR", "USD"].includes(result.devise)) {
			result.devise = "XOF"; // Default to XOF if invalid currency
		}

		// Validate amount
		if (result.montant && (isNaN(result.montant) || result.montant <= 0)) {
			throw new Error("Invalid payment amount detected");
		}

		context.log("Parsed payment from AI:", JSON.stringify(result));
		return result;
	} catch (error) {
		context.log(`Error parsing payment with OpenAI: ${error.message}`);
		throw error;
	}
}

async function createAndSavePaymentRequest(
	demandeurId,
	userName,
	channelId,
	channelName,
	formData,
	context
) {
	console.log("** createAndSavePaymentRequest");
	console.log("formData", userName);
	console.log("formData", formData);
	console.log("formData", formData);

	// Get the selected date string from the form data
	let requestDate;
	if (formData.request_date?.input_request_date?.selected_date) {
		const dateStr = formData.request_date.input_request_date.selected_date;
		requestDate = new Date(dateStr);
	} else {
		requestDate = new Date();
	}

	// Parse amount and currency from the amount field
	const amountInput = formData.amount_to_pay.input_amount_to_pay.value;
	const amountMatch = amountInput.match(/(\d+(?:\.\d+)?)\s*([A-Z]{3})/);

	if (!amountMatch) {
		throw new Error("Invalid amount format");
	}

	const amount = parseFloat(amountMatch[1]);
	const currency = amountMatch[2];

	if (!["XOF", "EUR", "USD"].includes(currency)) {
		throw new Error("Invalid currency");
	}

	// Validate date is not in the past
	if (requestDate < new Date().setHours(0, 0, 0, 0)) {
		throw new Error("Request date cannot be in the past");
	}

	// Generate payment ID
	const paymentId = await generatePaymentRequestId();

	const paymentData = {
		id_paiement: paymentId,
		project: channelName,
		id_projet: channelId,
		titre: formData.request_title?.input_request_title?.value,
		demandeur: userName,
		demandeurId: demandeurId,

		date_requete: requestDate,
		motif: formData.payment_reason?.input_payment_reason?.value,
		montant: amount,
		bon_de_commande: formData.po_number?.input_po_number?.value || null,
		justificatif: [], // No justificatifs from text parsing
		devise: currency,
		status: "En attente",
	};

	const paymentRequest = new PaymentRequest(paymentData);
	const savedPaymentRequest = await paymentRequest.save();
	return savedPaymentRequest;
}

async function handleOrderOverview(isAdmin, filters, context) {
	console.log("** handleOrderOverview");
	let orders = await Order.find({}).sort({ date: -1 }).limit(100);
	context.log(
		"Orders fetched for handleOrderOverview:",
		JSON.stringify(orders)
	);

	if (!orders || orders.length === 0) {
		return createSlackResponse(200, "Aucune commande trouvée.");
	}

	// Apply filters
	if (filters.titre) {
		orders = orders.filter((order) =>
			order.titre.toLowerCase().includes(filters.titre.toLowerCase())
		);
	}
	if (filters.statut) {
		const normalizedFilterStatus = removeAccents(filters.statut.toLowerCase());
		orders = orders.filter((order) => {
			const normalizedOrderStatus = removeAccents(
				(order.statut || "Non défini").toLowerCase()
			);
			const matches = normalizedOrderStatus === normalizedFilterStatus;
			context.log(
				`🔎 Comparing statut: ${normalizedOrderStatus} vs ${normalizedFilterStatus} -> ${matches}`
			);
			return matches;
		});
	}

	if (filters.date) {
		context.log(`Filtering by date: ${filters.date}`);
		const filterDate = new Date(filters.date);
		context.log(`Parsed filter date: ${filterDate.toLocaleDateString()}`);
		orders = orders.filter(
			(order) =>
				order.date.toLocaleDateString() === filterDate.toLocaleDateString()
		);
		console.log("orders", orders);
	}
	if (filters.demandeur) {
		orders = orders.filter(
			(order) =>
				order.demandeur.toLowerCase() === filters.demandeur.toLowerCase()
		);
	}
	if (filters.equipe) {
		orders = orders.filter((order) =>
			order.equipe.id.toLowerCase().includes(filters.equipe.toLowerCase())
		);
	}
	if (filters.autorisation_admin) {
		const authFilter = filters.autorisation_admin.toLowerCase() === "true";
		orders = orders.filter((order) => order.autorisation_admin === authFilter);
	}
	if (filters.paymentStatus) {
		const normalizedPaymentStatus = removeAccents(
			filters.paymentStatus.toLowerCase()
		);
		orders = orders.filter((order) =>
			order.payments.some(
				(payment) =>
					removeAccents((payment.paymentStatus || "").toLowerCase()) ===
					normalizedPaymentStatus
			)
		);
	}

	// // Generate overview response
	let responseText = "*Vue des Commandes filtré*\n\n";
	responseText +=
		"Filtres appliqués : " +
		(filters.titre ? `Titre: ${filters.titre}` : "Aucun titre") +
		", " +
		(filters.statut ? `Statut: ${filters.statut}` : "Aucun statut") +
		", " +
		(filters.date ? `Date: ${filters.date}` : "Aucune date") +
		", " +
		(filters.demandeur
			? `Demandeur: ${filters.demandeur}`
			: "Aucun demandeur") +
		", " +
		(filters.equipe ? `Équipe: ${filters.equipe}` : "Aucune équipe") +
		", " +
		(filters.autorisation_admin
			? `Autorisation Admin: ${filters.autorisation_admin}`
			: "Aucune autorisation") +
		", " +
		(filters.paymentStatus
			? `Statut Paiement: ${filters.paymentStatus}`
			: "Aucun statut paiement") +
		"\n\n";

	if (orders.length === 0) {
		responseText += "Aucune commande ne correspond aux filtres.";
	} else {
		// orders.forEach((order) => {
		//   const totalPaid = order.amountPaid || 0;
		//   responseText +=
		//     `📋 *${order.titre}* (Statut: ${order.statut || "Non défini"}) - <@${order.demandeur}>\n` +
		//     `   Équipe: ${order.equipe} | Date: ${order.date.toLocaleDateString()} | Total Payé: ${totalPaid}€ | Admin: ${order.autorisation_admin ? "✅" : "❌"}\n`;
		// });

		orders.forEach((order, index) => {
			context.log("Processing order:", JSON.stringify(order));

			responseText += `* Commande #${order.id_commande}*\n`;

			// Order Header Information
			const headerDetails = [
				`👤 *Demandeur:* <@${order.demandeur}>`,
				`📌 *Titre:* ${order.titre}`,
				`#️⃣ *Canal:* #${order.channel || "Non spécifié"}`,
				`👥 *Équipe:* ${order.equipe.displayName || "Non spécifié"}`,
				`📅 *Date:* ${order.date.toLocaleString()}`,
				`⚙️ *Statut:* ${order.statut || "Non défini"}`,
				`🔐 *Autorisation Admin:* ${
					order.autorisation_admin ? "✅ Autorisé" : "❌ Non autorisé"
				}`,
			];

			responseText += headerDetails.join("\n") + "\n";

			// Rejection Reason (if applicable)
			if (order.rejection_reason) {
				responseText += `🚫 *Raison du Rejet:* ${order.rejection_reason}\n`;
			}

			// Articles Details
			responseText += "\n*📦 Articles Commandés:*\n";
			if (order.articles.length > 0) {
				order.articles.forEach((article, i) => {
					responseText += `  ${i + 1}. ${article.quantity} ${article.unit} - ${
						article.designation
					}\n`;
				});
			} else {
				responseText += "  - Aucun article\n";
			}

			// Proformas
			responseText += "\n*📝 Proformas:*\n";
			if (order.proformas.length > 0) {
				order.proformas.forEach((proforma, i) => {
					responseText += `  ${i + 1}. `;
					responseText += `*Nom:* <${proforma.urls}|${
						proforma.nom || `Proforma ${i + 1}`
					}> `;
					responseText += `| *Montant:* ${proforma.montant} ${proforma.devise} `;
					responseText += `| *Fichiers:* ${proforma.file_ids || "N/A"}\n`;
				});
			} else {
				responseText += "  - Aucun\n";
			}

			// Payments
			responseText += "\n*💰 Détails des Paiements:*\n";
			if (order.payments.length > 0) {
				order.payments.forEach((payment, i) => {
					responseText += `  *Paiement ${i + 1}:*\n`;
					responseText += `    • *Mode:* ${payment.paymentMode}\n`;
					responseText += `    • *Titre:* ${payment.paymentTitle}\n`;
					responseText += `    • *Montant:* ${payment.amountPaid}€\n`;
					responseText += `    • *Statut:* ${payment.paymentStatus || "N/A"}\n`;
					responseText += `    • *Date:* ${payment.dateSubmitted.toLocaleString()}\n`;

					// Payment Proof
					if (payment.paymentProofs?.length > 0) {
						responseText += `    • *Preuve:* <${payment.paymentProofs}|Justificatif>\n`;
					} else if (payment.paymentUrl) {
						responseText += `    • *Lien:* <${payment.paymentUrl}|Lien de Paiement>\n`;
					} else {
						responseText += `    • *Preuve:* Aucune\n`;
					}

					// Payment Details
					responseText += "    • *Détails Supplémentaires:*\n";
					if (payment.details && Object.keys(payment.details).length > 0) {
						Object.entries(payment.details).forEach(([key, value]) => {
							responseText += `      - ${key}: ${value}\n`;
						});
					} else {
						responseText += "      - Aucun détail supplémentaire\n";
					}
				});
			} else {
				responseText += "  - Aucun paiement\n";
			}

			// Total Amount Paid
			responseText += `\n*Total Payé:* ${order.amountPaid || 0}€\n`;

			// Separator between orders
			responseText += "\n" + "=".repeat(40) + "\n\n";
		});
	}

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: responseText,
	});
}

// Helper function to remove accents
function removeAccents(str) {
	console.log("** removeAccents");
	return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Parse filter arguments
function parseFilters(args) {
	console.log("** parseFilters");
	const filters = {};
	args.forEach((arg) => {
		const [key, ...valueParts] = arg.split(":");
		const value = valueParts.join(":"); // Handle values with colons
		if (key && value) {
			const trimmedKey = key.trim().toLowerCase();
			const trimmedValue = value.trim();
			if (trimmedKey === "titre") filters.titre = trimmedValue;
			if (trimmedKey === "statut" || trimmedKey === "status")
				filters.statut = trimmedValue; // Accept both
			if (trimmedKey === "date") filters.date = trimmedValue;
			if (trimmedKey === "demandeur") filters.demandeur = trimmedValue;
			if (trimmedKey === "equipe") filters.equipe = trimmedValue;
			if (trimmedKey === "autorisation_admin")
				filters.autorisation_admin = trimmedValue;
			if (trimmedKey === "paymentstatus") filters.paymentStatus = trimmedValue;
		}
	});
	return filters;
}

async function handleOrderListSlack(isAdmin, context) {
	console.log("** handleOrderListSlack");
	// Fetch the most recent 10 orders (adjust limit as needed)
	const orders = await Order.find({}).sort({ date: -1 }).limit(10);
	context.log(
		"Orders fetched for handleOrderListSlack:",
		JSON.stringify(orders)
	);

	if (!orders || orders.length === 0) {
		return createSlackResponse(200, {
			response_type: "in_channel",
			text: "Aucune commande trouvée.",
		});
	}

	// Build Block Kit response
	const blocks = [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: "📋 Liste des Commandes Récentes",
				emoji: true,
			},
		},
		{
			type: "divider",
		},
	];

	// Add each order as a section with fields
	orders.forEach((order) => {
		blocks.push({
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*ID:*\n#${order.id_commande}` },
				{ type: "mrkdwn", text: `*Titre:*\n${order.titre || "Sans titre"}` },
				{ type: "mrkdwn", text: `*Date:*\n${order.date}` },

				{ type: "mrkdwn", text: `*Demandeur:*\n<@${order.demandeur}>` },
				{
					type: "mrkdwn",
					text: `*Équipe:*\n${order.equipe.displayName || "N/A"}`,
				},
				{ type: "mrkdwn", text: `*Date:*\n${order.date.toLocaleDateString()}` },
				{ type: "mrkdwn", text: `*Statut:*\n${order.statut || "Non défini"}` },
				{ type: "mrkdwn", text: `*Total Payé:*\n${order.amountPaid || 0}€` },
				{ type: "mrkdwn", text: `*Articles:*\n${order.articles.length}` },
			],
		});

		// Optional: Add action buttons (e.g., view details)
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Voir Détails",
						emoji: true,
					},
					value: `order_details_${order.id_commande}`,
					action_id: `view_order_${order.id_commande}`,
				},
			],
		});

		blocks.push({ type: "divider" });
	});

	return createSlackResponse(200, {
		response_type: "ephemeral", // Use "in_channel" if you want it visible to all
		blocks: blocks,
	});
}

module.exports = { handleOrderSlackApi, handleAICommand };
