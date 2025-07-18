const { app } = require("@azure/functions");
const {
	checkPendingOrderDelays,
	checkPaymentDelays,
	checkProformaDelays,
} = require("./src/Delays/handledelay.js");
const { OpenAI } = require("openai");
const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

require("dotenv").config();
const { handleAICommand } = require("./src/Order/orderSubcommands.js");
const { handleOrderSlackApi } = require("./src/MainHandlers/orderSlackApi.js");
const {
	handleSlackInteractions,
} = require("./src/MainHandlers/slackInteractions.js");
const {
	analyzeTrends,
	generateReport,
} = require("./src/Excel/Caisse/reportService.js");
const { createSlackResponse } = require("./src/Common/slackUtils.js");
const {
	notifyUserAI,
} = require("./src/Order/Handlers/orderNotificationService.js");
const { Order } = require("./src/Database/dbModels/Order.js");
const { notifyTechSlack } = require("./src/Common/notifyProblem.js");
const {
	checkPendingPaymentRequestDelays,
	checkPaymentRequestApprovalDelays,
} = require("./src/Delays/handledelayPayment.js");
require("./src/Database/config/database.js");

app.http("orderSlackApi", {
	methods: ["POST"],
	authLevel: "anonymous",
	handler: async (request, context) => {
		try {
			console.log("** New Version 2.2 **");
			// setupDelayMonitoring();
			// setupReporting(context);
			console.log("⚡ Order Management System is running!");

			return await handleOrderSlackApi(request, context);
		} catch (error) {
			context.log(`❌ Erreur interne : ${error}`);
			await notifyTechSlack(error);
			return { status: 500, body: "Erreur interne du serveur" };
		}
	},
});

app.http("slackInteractions", {
	methods: ["POST"],
	authLevel: "anonymous",
	handler: async (request, context) => {
		try {
			console.log("** slackInteractions");
			return await handleSlackInteractions(request, context);
		} catch (error) {
			context.log(`❌ Erreur interne : ${error}`);
			await notifyTechSlack(error);
			return { status: 500, body: "Erreur interne du serveur" };
		}
	},
});

if (process.env.NODE_ENV === "production") {
	console.log("🚀 Production environment detected - registering timers");

	// 9:00 AM Ivory Coast time (GMT+0) - Morning delay monitoring
	app.timer("delayMonitoringMorning", {
		schedule: "0 0 9 * * *", // 9:00 AM UTC (same as Ivory Coast time)
		handler: async (timer, context) => {
			context.log(
				"Running morning delay monitoring (9:00 AM Ivory Coast time)"
			);
			await checkPendingOrderDelays(context);
			await checkPaymentDelays(context);
			await checkProformaDelays(context);
			await checkPendingPaymentRequestDelays(context);
			await checkPaymentRequestApprovalDelays(context);
			context.log("Morning delay monitoring completed");
		},
	});
	// 3:00 PM Ivory Coast time (GMT+0) - Afternoon delay monitoring
	app.timer("delayMonitoringAfternoon", {
		schedule: "0 0 15 * * *", // 3:00 PM UTC (same as Ivory Coast time)
		handler: async (timer, context) => {
			context.log(
				"Running afternoon delay monitoring (3:00 PM Ivory Coast time)"
			);
			await checkPendingOrderDelays(context);
			await checkPaymentDelays(context);
			await checkProformaDelays(context);
			await checkPendingPaymentRequestDelays(context);
			await checkPaymentRequestApprovalDelays(context);
			context.log("Afternoon delay monitoring completed");
		},
	});
	app.timer("dailyReport", {
		schedule: "0 5 9 * * *", // Daily at 9:05 AM

		handler: async (timer, context) => {
			context.log("Running daily report");
			await generateReport(context);
			await analyzeTrends(context);
			await handleAICommand(
				context, // Assuming logger is correctly defined
				openai, // OpenAI client instance
				Order, // Mongoose model for orders
				notifyUserAI, // Function for sending notifications
				createSlackResponse // Function for formatting Slack responses
			);
			context.log("Daily report completed");
		},
	});
} else {
	console.log(
		`🔧 Non-production environment (${
			process.env.NODE_ENV || "undefined"
		}) detected - timers disabled`
	);
}
