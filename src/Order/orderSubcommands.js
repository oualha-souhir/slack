const axios = require("axios");
const {
	isAdminUser,
	addUserRole,
	removeUserRole,
} = require("../Configurations/roles");
const {
	createSlackResponse,
	postSlackMessage,
	postSlackMessageWithRetry,
} = require("../Common/slackUtils");

const { OpenAI } = require("openai");

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});
const {
	getConfigValues,
	addConfigValue,
	removeConfigValue,
} = require("../Configurations/config");
const { exportReport, exportPaymentReport } = require("../Excel/exportService");
const {
	generateReport,
	analyzeTrends,
} = require("../Excel/Caisse/reportService");

const {
	parseOrderFromText,
	getOrderSummary,
	handleFrequentQuestions,
	summarizeOrdersWithChat,
} = require("../Common/aiService");
const {
	notifyAdmin,
	notifyUserAI,
	notifyUser,
} = require("./Handlers/orderNotificationService");
const { createAndSaveOrder } = require("./Handlers/orderFormHandlers");
const { Order } = require("../Database/dbModels/Order");
const UserRole = require("../Database/dbModels/UserRole");
const { notifyTechSlack } = require("../Common/notifyProblem");

async function handleOrderList(isAdmin, context) {
	console.log("** handleOrderList");
	if (!isAdmin) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "🚫 Vous n'êtes pas autorisé à voir la liste des commandes.",
		});
	}

	const orders = await Order.find({}).sort({ date: -1 }).limit(10);
	context.log("Orders fetched for handleOrderList:", JSON.stringify(orders));

	if (orders.length === 0) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "📭 Aucune commande trouvée.",
		});
	}

	let responseText = "*📋 Rapport des Dernières Commandes*\n\n";

	orders.forEach((order, index) => {
		context.log("Processing order:", JSON.stringify(order));

		responseText += `* Commande #${order.id_commande}*\n`;

		// Order Header Information
		const headerDetails = [
			`👤 *Demandeur:* <@${order.demandeur}>`,
			`📌 *Titre:* ${order.titre}`,
			`#️⃣ *Canal:* #${order.channel || "Non spécifié"}`,
			`👥 *Équipe:* ${order.equipe || "Non spécifié"}`,
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
				responseText += `| *fichiers:* ${proforma.file_ids || "N/A"}\n`;
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
				responseText += `    • *Statut:* ${
					payment.paymentStatus || "Partiel"
				}\n`;
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

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: responseText,
	});
}
async function handleOrderWelcomeMessage(userId) {
	console.log("** handleOrderWelcomeMessage");
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
async function handleOrderMyOrderCommand(userId, channelId) {
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
		return createSlackResponse(200, "");
	}
}
async function handleOrderReportCommand(
	text,
	userId,
	channelId,
	isUserAdmin,
	context
) {
	// Move the "report" handling logic

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
			await notifyTechSlack(error);

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

async function handleOrderSummaryCommand(context) {
	// Move the "summary" handling logic

	console.log("** summary");
	await generateReport(context);
	await analyzeTrends(context);

	return createSlackResponse(200, "summary completed!");
}
async function handleOrderRemoveCommands(
	textArgs,
	userId,
	channelId,
	isUserAdmin,
	context
) {
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
			await notifyTechSlack(error);

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
			await notifyTechSlack(error);

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
async function view_order(payload, action, context) {
	console.log("** view_order");
	const orderId = action.value.split("order_details_")[1];
	context.log(`Fetching details for order ID: ${orderId}`);

	const order = await Order.findOne({ id_commande: orderId });
	if (!order) {
		context.log(`Order ${orderId} not found`);
		return axios.post(payload.response_url, {
			response_type: "ephemeral",
			text: `⚠️ Commande #${orderId} non trouvée.`,
		});
	}

	// Construct the response text in the same style as handleOrderList
	let responseText = `*📦 Commande #${order.id_commande}*\n\n`;

	// Order Header Information
	const headerDetails = [
		`👤 *Demandeur:* <@${order.demandeur}>`,
		`📌 *Titre:* ${order.titre || "Sans titre"}`,
		`#️⃣ *Canal:* ${order.channel || "Non spécifié"}`,
		`👥 *Équipe:* ${order.equipe || "Non spécifié"}`,
		`📅 *Date:* ${order.date.toLocaleString()}`,
		`⚙️ *Statut:* ${order.statut || "Non défini"}`,
		`🔐 *Autorisation Admin:* ${
			order.autorisation_admin ? "✅ Autorisé" : "❌ Non autorisé"
		}`,
	];
	responseText += headerDetails.join("\n") + "\n";

	// Rejection Reason (if applicable)
	if (order.rejection_reason) {
		responseText += `\n🚫 *Raison du Rejet:* ${order.rejection_reason}\n`;
	}

	// Articles Details
	responseText += "\n*📦 Articles Commandés:*\n";
	if (order.articles.length > 0) {
		order.articles.forEach((article, i) => {
			responseText += `  ${i + 1}. ${article.quantity} ${
				article.unit || ""
			} - ${article.designation}\n`;
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
			responseText += `| *fichiers:* ${proforma.file_ids || "N/A"}\n`;
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
			responseText += `    • *Montant:* ${payment.amountPaid}\n`;
			responseText += `    • *Statut:* ${payment.paymentStatus || "Partiel"}\n`;
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

	try {
		console.log("payload.channel.id", payload.channel.id);
		console.log("payload.channel.id", payload);
		try {
			console.log("payload.channel.id", payload.channel.id);

			// Post as a new message in the channel (visible to everyone)
			const slackResponse = await axios.post(
				"https://slack.com/api/chat.postMessage",
				{
					channel: payload.channel.id,
					text: responseText,
					// Optional: make it a thread reply to the original message
					thread_ts: payload.container.message_ts,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
						"Content-Type": "application/json",
					},
				}
			);

			context.log(`Slack response: ${JSON.stringify(slackResponse.data)}`);

			if (!slackResponse.data.ok) {
				throw new Error(`Slack API error: ${slackResponse.data.error}`);
			}

			return createSlackResponse(200, "");
		} catch (error) {
			await notifyTechSlack(error);

			context.log(`Error sending to Slack API: ${error.message}`);
			if (error.response) {
				context.log(
					`Slack error response: ${JSON.stringify(error.response.data)}`
				);
			}

			// Fallback to response_url if channel posting fails
			try {
				await axios.post(payload.response_url, {
					response_type: "ephemeral",
					text: responseText,
				});
			} catch (fallbackError) {
				await notifyTechSlack(fallbackError);

				context.log(`Fallback also failed: ${fallbackError.message}`);
			}

			return createSlackResponse(200, "");
		}

		context.log(`Slack response: ${JSON.stringify(slackResponse.data)}`);
	} catch (error) {
		await notifyTechSlack(error);
		context.log(`Error sending to Slack API: ${error.message}`);
		if (error.response) {
			context.log(
				`Slack error response: ${JSON.stringify(error.response.data)}`
			);
		}
	}
	return {
		statusCode: statusCode,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(content),
	};
}
async function handleOrderListUsersCommand(userId) {
	console.log("** listusers");
	if (!(await isAdminUser(userId))) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "🚫 Seuls les administrateurs peuvent voir la liste des utilisateurs et rôles.",
		});
	}

	// Fetch all users and their roles

	const users = await UserRole.find({});
	console.log("users", users);

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
		await notifyTechSlack(error);

		console.error("Error fetching Slack user info:", error);
		return null;
	}
}
async function handleOrderRoleCommands(text, userId, channelId, isUserAdmin) {
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
		return createSlackResponse(200, "");
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
	console.log(`Adding role ${role} to user ${userIdToAdd} (${userNameToAdd})`);
	await addUserRole(userIdToAdd, role, userNameToAdd); // Update your addUserRole to accept and store the name
	return createSlackResponse(200, {
		text: `✅ Rôle ${role} ajouté à <@${userIdToAdd}>.`,
	});
}
async function handleOrderRemoveRoleCommand(text, userId) {
	if (!(await isAdminUser(userId))) {
		return createSlackResponse(200, {
			text: "🚫 Seuls les admins peuvent gérer les rôles.",
		});
	}

	const [, mention, role] = text.trim().split(" ");
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
async function handleOrderAddCommands(
	textArgs,
	userId,
	channelId,
	isUserAdmin,
	context
) {
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
			await notifyTechSlack(error);

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

async function handleOrderConfigCommands(
	textArgs,
	userId,
	channelId,
	isUserAdmin,
	context
) {
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
			const fournisseurOptions = await getConfigValues("fournisseur_options", [
				"Fournisseur A",
				"Fournisseur B",
				"Fournisseur C",
			]);

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
			await notifyTechSlack(error);

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

async function handleOrderHelpCommand(
	userId,
	isUserAdmin,
	isUserFinance,
	isUserPurchase
) {
	console.log("** help");
	// const isUserAdmin = await isAdminUser(userId);
	// const isUserFinance = await isFinanceUser(userId);
	// const isUserPurchase = await isPurchaseUser(userId);

	let helpText = "*🛠️ Commandes disponibles:*\n\n";

	if (isUserAdmin) {
		helpText += "*Commandes pour les administrateurs:*\n";
		helpText += "*Configuration:*\n";
		helpText += "• `/order config` - Ouvrir le panneau de configuration\n";
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
		helpText += "• `/order list detailed` - Liste détaillée des commandes\n";
		helpText += "• `/order list` - Liste des commandes récentes\n";
		helpText +=
			"• `/order filterby [titre|status|demandeur|équipe]:<valeur>` - Filtrer les commandes\n";
		helpText += "• `/order resume` - Résumé IA des commandes\n";
	}
	if (isUserAdmin || isUserFinance) {
		helpText += "*Commandes pour les finances:*\n";
		helpText += "• `/caisse` - Créer une demande de fonds\n";
		helpText += "• `/caisse list` - Lister les caisses\n";
		helpText +=
			"• `/caisse create [name] [prefix] #channel` - Créer une nouvelle caisse \n";
		helpText +=
			"• `/caisse delete [name] #channel` - Supprimer une caisse \n";
		helpText += "• `/caisse transfer` - Transfert de solde entre caisses. \n";
	}
	// Add general commands for all users
	helpText += "*Commandes générales:*\n";

	helpText += "• `/order ask ai: <question>` - Poser une question à l'IA\n";
	helpText += "• `/order my order` - Voir votre dernière commande\n";
	helpText += "• `/payment` - Créer une demande de paiement\n";
	helpText += "• `/order` - Créer une commande\n";

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: helpText,
	});
}
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
		await notifyTechSlack(error);

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
async function handleOrderResumeCommand(logger) {
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
function removeAccents(str) {
	console.log("** removeAccents");
	return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
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
async function handleOrderListCommands(
	userId,
	textArgs,
	isUserAdmin,
	context,
	logger
) {
	// Move "list" and "filterby" handling
	try {
		if (textArgs[0] === "list") {
			if (textArgs[1] === "detailed") {
				// Handle "/order list brief"
				return await handleOrderList(isUserAdmin, context);
			}
			// Default "/order list" (detailed version)
			return await handleOrderListSlack(isUserAdmin, context);
		} else if (textArgs[0] === "filterby") {
			const argsToParse = textArgs.slice(1);
			context.log(`🧩 Args to parse: ${JSON.stringify(argsToParse)}`);
			const filters = parseFilters(argsToParse);
			context.log(`🔍 Filters parsed: ${JSON.stringify(filters)}`);
			const response = await handleOrderOverview(isUserAdmin, filters, context);
			context.log(`📤 Response to Slack: ${JSON.stringify(response)}`);
			return response; // Ensure the response is returned
		}
	} catch (error) {
		await notifyTechSlack(error);

		logger.log(`Background list processing error: ${error.stack}`);
		await notifyUserAI(
			{ id_commande: "N/A" },
			userId,
			logger,
			`Erreur : ${error.message}`
		);
	}
}

// Function to normalize team names by removing accents and converting to lowercase
function normalizeTeamName(teamName) {
	if (!teamName) return "Non spécifié";

	return teamName
		.normalize("NFD") // Decompose accented characters
		.replace(/[\u0300-\u036f]/g, "") // Remove accent marks
		.toLowerCase() // Convert to lowercase
		.trim(); // Remove leading/trailing spaces
}
async function handleOrderTextParsing(
	text,
	params,
	userId,
	userName,
	channelId,
	logger
) {
	// Move the AI text parsing logic (equipe handling)
	logger.log(`Received text: "${text}"`);
	logger.log("Starting AI parsing...");
	
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
					logger.log("Invalid refund request - requested date is in the past.");

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
			await notifyTechSlack(error);

			logger.log(`Background order creation error: ${error.stack}`);
			// await notifyUserAI(
			// 	{ id_commande: "N/A" },
			// 	channelId,
			// 	logger,
			// 	`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
			// );
		}
	});
	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
	});
}

async function handleOrderAICommand(text, channelId, userId, context) {
	// Move the "ask ai:" handling
	// Acknowledge Slack within 3 seconds
	setImmediate(async () => {
		try {
			const faqResponse = await handleFrequentQuestions(text, userId, context);
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
			await notifyTechSlack(error);

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
}

async function handleOrderDeleteCommand(
	text,
	userId,
	channelId,
	isUserAdmin,
	params,
	context
) {
	// Move the "delete" command handling
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
		await notifyTechSlack(error);

		context.log(`Error in delete command: ${error.message}`);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Erreur: ${error.message}`,
		});
	}
}
module.exports = {
	handleOrderWelcomeMessage,
	handleOrderMyOrderCommand,
	handleOrderReportCommand,
	handleOrderSummaryCommand,
	handleOrderRemoveCommands,
	handleOrderRoleCommands,
	handleOrderAddCommands,
	handleOrderConfigCommands,
	handleOrderHelpCommand,
	handleOrderListCommands,
	handleOrderTextParsing,
	handleOrderAICommand,
	handleOrderDeleteCommand,
	handleOrderRemoveRoleCommand,
	handleOrderListUsersCommand,
	handleOrderResumeCommand,
	handleAICommand,
	view_order,
};
