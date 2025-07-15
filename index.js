// src/index.js
const { app } = require("@azure/functions");
const { handleOrderSlackApi, handleAICommand } = require("./orderHandlers.js");
const { handleSlackInteractions } = require("./interactionHandlers.js");

const {
	checkPendingOrderDelays,
	checkPaymentDelays,
	checkProformaDelays,
} = require("./handledelay");
const { generateReport, analyzeTrends } = require("./reportService");
const { Order } = require("./db");
const { notifyUserAI } = require("./notificationService");
const { createSlackResponse } = require("./utils");
const { OpenAI } = require("openai");
const {
	checkPaymentRequestApprovalDelays,
	checkPendingPaymentRequestDelays,
} = require("./handledelayPayment.js");
const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});
require("dotenv").config(); // Load environment variables from .env file

app.http("orderSlackApi", {
	methods: ["POST"],
	authLevel: "anonymous",
	handler: async (request, context) => {
		try {
			console.log("** VERSION 2.9 **");
			// setupDelayMonitoring();
			// setupReporting(context);
			console.log("⚡ Order Management System is running!");

			return await handleOrderSlackApi(request, context);
		} catch (error) {
			context.log(`❌ Erreur interne : ${error}`);
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
			return { status: 500, body: "Erreur interne du serveur" };
		}
	},
});

if (process.env.NODE_ENV === "production") {
	console.log("🚀 Production environment detected - registering timers");

	app.timer("delayMonitoring", {

		schedule: "0 0 9 * * *", // Every day at 9:00 AM
		handler: async (timer, context) => {
			context.log("Running delay monitoring");

			await checkPendingOrderDelays(context);
			await checkPaymentDelays(context);
			await checkProformaDelays(context);
			await checkPendingPaymentRequestDelays(context);
			await checkPaymentRequestApprovalDelays(context);

			context.log("Delay monitoring completed");
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
