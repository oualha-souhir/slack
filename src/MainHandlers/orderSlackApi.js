const { WebClient } = require("@slack/web-api");
const {
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
} = require("../Order/orderSubcommands");
const {
	isAdminUser,
	isFinanceUser,
	isPurchaseUser,
} = require("../Configurations/roles");
const { createSlackResponse } = require("../Common/slackUtils");
const {
	checkPendingOrderDelays,
	checkPaymentDelays,
	checkProformaDelays,
} = require("../Delays/handledelay");
const {
	handlePaymentWelcomeMessage,
	handlePaymentReportCommand,
	handlePaymentTextParsing,
} = require("../Payment Request/PaymentSubcommands");
const {
	handleCaisseTextParsing,
	handleCaisseBalanceCommand,
	handleCaisseCreateCommand,
	handleCaisseDeleteCommand,
	handleCaisseListCommand,
	handleCaisseTransferCommand,
	handleCaisseWelcomeMessage,
} = require("../Caisse/CaisseSubcommands");
const { notifyTechSlack } = require("../Common/notifyProblem");
const {
	checkPendingPaymentRequestDelays,
	checkPaymentRequestApprovalDelays,
} = require("../Delays/handledelayPayment");
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

//* Main handler for order Slack API interactions
async function handleOrderSlackApi(request, context) {
	console.log("** handleOrderSlackApi");
	const logger = {
		log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
	};

	try {
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

		const commands = getCommandsForEnvironment();
		console.log("Commands:", commands);
		// ********************* $$$ ******************************************* */

		if (command === commands.caisse) {
			return await handleCaisseCommand(
				params,
				text,
				userId,
				userName,
				channelId,
				isUserAdmin,
				context,
				logger
			);
		} else if (command === commands.payment) {
			return await handlePaymentCommand(
				params,
				text,
				userId,
				userName,
				channelId,
				isUserAdmin,
				context,
				logger
			);
		} else if (command === commands.order) {
			return await handleOrderCommand(
				params,
				text,
				userId,
				userName,
				channelId,
				isUserAdmin,
				context,
				logger
			);
		} else {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❓ Commande inconnue. Utilisez `/order help` pour voir les commandes disponibles.",
			});
		}

		// Add this condition to handle payment request text parsing
	} catch (error) {
		context.log(`❌ Erreur: ${error.stack}`);
		await notifyTechSlack(error);

		return createSlackResponse(500, "Erreur interne");
	}
}
function getCommandsForEnvironment() {
	const env = process.env.NODE_ENV;
	console.log(`**** Environment: ${env}`);

	if (env === "staging") {
		return {
			caisse: "/caisse-test",
			payment: "/payment-test",
			order: "/order-test",
		};
	} else if (env === "dev") {
		return {
			caisse: "/caisset",
			payment: "/paymentt",
			order: "/ordert",
		};
	} else {
		// production
		return {
			caisse: "/caisse",
			payment: "/payment",
			order: "/order",
		};
	}
}

// CAISSE COMMAND HANDLER
async function handleCaisseCommand(
	params,
	text,
	userId,
	userName,
	channelId,
	isUserAdmin,
	context,
	logger
) {
	// const isUserAdmin = await isAdminUser(userId);
	const isUserFinance = await isFinanceUser(userId);
	if (!isUserAdmin && !isUserFinance) {
		return createSlackResponse(200, {
			text: "🚫 Seuls les utilisateurs de la finance peuvent gérer les demandes de fonds.",
		});
	}
	const args = text.split(" ");
	const subCommand = args[0];
	if (text.toLowerCase().includes("devise")) {
		return await handleCaisseTextParsing(
			text,
			params,
			userId,
			userName,
			context,
			logger
		);
	}
	//! /caisse balance
	if (text.trim() === "balance") {
		return await handleCaisseBalanceCommand(channelId, context);
	}

	//! /caisse create admin-caisse #dept-admin 100000 200 300
	if (subCommand === "create") {
		return await handleCaisseCreateCommand(
			text,
			slackClient,
			userId,
			channelId
		);
	}
	//! /caisse delete #dept-admin
	if (subCommand === "delete") {
		return await handleCaisseDeleteCommand(text);
	}
	//! /caisse list

	if (subCommand === "list") {
		return await handleCaisseListCommand();
	}
	//! /caisse transfer
	if (subCommand === "transfer") {
		return await handleCaisseTransferCommand(params);
	}

	//** welcome message
	return await handleCaisseWelcomeMessage(
		userId,
		channelId,
		text,
		params,
		context,
		userName
	);
}

// PAYMENT REQUEST HANDLER
async function handlePaymentCommand(
	params,
	text,
	userId,
	userName,
	channelId,
	isUserAdmin,
	context,
	logger
) {
	//! /payment titre: Achat de matériel informatique date requise: 2025-12-12 motif: Remplacement ordinateurs défaillants montant: 50000 XOF bon de commande: PO-2025-001A
	if (text.toLowerCase().includes("montant")) {
		return await handlePaymentTextParsing(
			text,
			params,
			userId,
			userName,
			context,
			logger
		);
	}

	//! /payment report  <payment,channel,date,status,user>   <value, (YYYY-MM-DD), (En attente, Validé, Rejeté)>
	if (text.trim().startsWith("report")) {
		return await handlePaymentReportCommand(
			text,
			userId,
			channelId,
			isUserAdmin,
			context
		);
	}

	//** welcome message
	return await handlePaymentWelcomeMessage(userId);
}

// ORDER COMMAND HANDLER
async function handleOrderCommand(
	params,
	text,
	userId,
	userName,
	channelId,
	isUserAdmin,
	context,
	logger
) {
	const textArgs = text.trim().split(" ");
	const subCommand = textArgs[0];
	const isUserFinance = await isFinanceUser(userId);
	const isUserPurchase = await isPurchaseUser(userId);
	//** welcome message
	if (!text.trim()) {
		return await handleOrderWelcomeMessage(userId);
	}
	//! /order report  <order,team,channel,date,status,user>   <value, (YYYY-MM-DD), (En attente, Validé, Rejeté)>
	//! /order report team Peintre
	if (text.trim().startsWith("report")) {
		return await handleOrderReportCommand(
			text,
			userId,
			channelId,
			isUserAdmin,
			context
		);
	}
	//! /order summary
	//? changed from report to summary
	if (text.trim() === "summary") {
		return await handleOrderSummaryCommand(context);
	}
	//! /order add-role @user [admin|finance|achat]
	if (text.trim().startsWith("add-role")) {
		return await handleOrderRoleCommands(text, userId, channelId, isUserAdmin);
	}
	//! /order rm-role @user [admin|finance|achat]
	if (text.trim().startsWith("rm-role")) {
		return await handleOrderRemoveRoleCommand(text, userId);
	}
	//! /order list-users
	if (subCommand === "list-users") {
		return await handleOrderListUsersCommand(userId);
	}

	//! /order config
	// // Configuration management command
	if (subCommand === "config") {
		console.log("** config");
		return await handleOrderConfigCommands(
			textArgs,
			userId,
			channelId,
			isUserAdmin,
			context
		);
	}
	//! /order add [equipe|unit|currency] <value>
	// // Add configuration items
	if (subCommand === "add") {
		return await handleOrderAddCommands(
			textArgs,
			userId,
			channelId,
			isUserAdmin,
			context
		);
	}
	//! /order rm [equipe|unit|currency] <value>
	if (subCommand === "rm") {
		return await handleOrderRemoveCommands(
			textArgs,
			userId,
			channelId,
			isUserAdmin,
			context
		);
	}

	//! /order help
	if (subCommand === "help" || !subCommand) {
		return await handleOrderHelpCommand(
			userId,
			isUserAdmin,
			isUserFinance,
			isUserPurchase
		);
	}

	//!/order my order
	if (text.trim() === "my order") {
		return await handleOrderMyOrderCommand(userId, channelId);
	}
	//! /order resume
	if (textArgs[0].toLowerCase() === "resume") {
		return await handleOrderResumeCommand(logger);
	}
	//! /order list detailed
	//! /order list
	//! /order filterby parameter:value
	/*
		status String validé, rejeté
		titre String tailored to the request
		date Date YY-MM-DD format
		demandeur String tailored to the request
		equipe String Maçons, Carreleur, Peintre, Coffreur
		autorisation_admin Boolean true, false
		**/
	if (textArgs[0] === "list" || textArgs[0] === "filterby") {
		return await handleOrderListCommands(
			userId,
			textArgs,
			isUserAdmin,
			context,
			logger
		);
	}

	//! /order titre: Matériel Électrique equipe: Maçons date requise: 2025-12-12 articles: 10 piece Désignation: rouleaux de câble souple VGV de 2×2,5 bleu-marron
	if (text.toLowerCase().includes("equipe")) {
		return await handleOrderTextParsing(
			text,
			params,
			userId,
			userName,
			channelId,
			logger
		);
	}
	//! /order ask ai: <question> (about my order)
	if (text.toLowerCase().includes("ask ai:")) {
		await handleOrderAICommand(text, channelId, userId, context);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "⌛ Vérification en cours... Réponse bientôt !",
		});
	}
	//! /order check-delays
	if (text.trim() === "check-delays") {
		console.log("** check-delays");
		await checkPendingOrderDelays();
		await checkPaymentDelays();
		await checkProformaDelays();
		await checkPendingPaymentRequestDelays(context);
		await checkPaymentRequestApprovalDelays(context);

		return createSlackResponse(200, "Delay check completed!");
	}

	//! /order delete <order_id>
	if (text.trim().startsWith("delete")) {
		return await handleOrderDeleteCommand(
			text,
			userId,
			channelId,
			isUserAdmin,
			params,
			context
		);
	}
}

module.exports = { handleOrderSlackApi };
