const {
	createSlackResponse,
	verifySlackSignature,
	postSlackMessage,
	postSlackMessage2,
	postSlackMessageWithRetry,
} = require("../Common/slackUtils");

const {
	FinanceDetailsSubmission,
} = require("../Caisse/Handlers/caissePaymentHandlers");
const { handleBlockActions } = require("./handleBlockActions");

const { handleViewSubmission } = require("./handleViewSubmission");
const {
	handlePaymentVerificationConfirm,
} = require("../Order/Handlers/orderApprovalHandlers");
const {
	ProformaValidationConfirm,
} = require("../Order/Proforma/ProformaValidation");
const PaymentRequest = require("../Database/dbModels/PaymentRequest");
const { Order } = require("../Database/dbModels/Order");
const {
	RejectionReasonSubmission,
} = require("../Order/Handlers/orderRejectionHandlers");
const { notifyTechSlack } = require("../Common/notifyProblem");

let payload;

//* Main handler for Slack interactions
async function handleSlackInteractions(request, context) {
	console.log("** handleSlackInteractions");
	context.log("🔄 Interaction Slack reçue !");

	try {
		// Validate request signature
		const body = await request.text();
		if (!verifySlackSignature(request, body)) {
			return createSlackResponse(401, "Signature invalide");
		}

		// Parse payload
		const params = new URLSearchParams(body);
		const payload = JSON.parse(params.get("payload"));
		context.log(`📥 Payload reçu : ${JSON.stringify(payload)}`);
		console.log("** payload.type", payload.type);
		if (payload.view) {
			const callbackId = payload.view.callback_id;
			console.log("** callback_id", payload.view.callback_id);
		} else if (payload.callback_id) {
			// For interactive_message and other types that have callback_id directly on payload
			console.log("** payload callback_id", payload.callback_id);
		}
		if (payload.actions) {
			console.log("** action_id", payload.actions[0].action_id);
		}
		// Route to appropriate handler
		switch (payload.type) {
			case "view_submission":
				return await handleViewSubmissionRouter(payload, context);

			case "block_actions":
			case "interactive_message":
				return await handleBlockActions(payload, context);

			default:
				return createSlackResponse(400, "Type d'interaction non supporté");
		}
	} catch (error) {
		await notifyTechSlack(error);

		return await handleGlobalError(error, context, payload);
	}
}
async function handleViewSubmissionRouter(payload, context) {
	const {
		handlePreApproval,
		handleFinalApprovalConfirmation,
	} = require("../Caisse/Handlers/caisseApprovalHandlers");

	const callbackId = payload.view.callback_id;
	const VIEW_SUBMISSION_HANDLERS = {
		pre_approval_confirmation_submit: handlePreApproval,
		final_approval_confirmation_submit: handleFinalApprovalConfirmation,
		submit_finance_details: FinanceDetailsSubmission,
		proforma_validation_confirm: handleProformaValidationConfirm,
		payment_verif_confirm: handlePaymentVerificationConfirm,
		rejection_reason_modal: RejectionReasonSubmission,
	};
	const handler = VIEW_SUBMISSION_HANDLERS[callbackId];

	if (handler) {
		console.log(`Found specific handler for ${callbackId}`);

		return await handler(payload, context);
	}
	console.log(
		`No specific handler found for ${callbackId}, using default handler`
	);

	// Default handler for unmatched callback IDs
	const response = await handleViewSubmission(payload, context);
	return response;
}
// async function handleViewSubmissionRouter(payload, context) {
// 	const callbackId = payload.view.callback_id;
// 	console.log(`Processing view submission for callback_id: ${callbackId}`);

// 	// Use a switch statement for better control and error handling
// 	switch (callbackId) {
// 		case "pre_approval_confirmation_submit":
// 			return await handlePreApprovalConfirmation(payload, context);

// 		case "final_approval_confirmation_submit":
// 			return await handleFinalApprovalConfirmation(payload, context);

// 		case "submit_finance_details":
// 			return await handleFinanceDetailsSubmission(payload, context);

// 		case "proforma_validation_confirm":
// 			return await handleProformaValidationConfirm(payload, context);

// 		case "payment_verif_confirm":
// 			return await handlePaymentVerificationConfirm(payload, context);

// 		case "rejection_reason_modal":
// 			return await handleRejectionReasonSubmission(payload, context);

// 		default:
// 			console.log(
// 				`No specific handler found for ${callbackId}, using default handler`
// 			);
// 			const { handleViewSubmission } = require("../../orderUtils");
// 			return await handleViewSubmission(payload, context);
// 	}
// }
async function handleProformaValidationConfirm(payload, context) {
	console.log("** handleProformaValidationConfirm");

	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		try {
			await ProformaValidationConfirm(payload, context);
		} catch (error) {
			await notifyTechSlack(error);

			context.log(
				`????????????????? Background processing error for proforma submission (order: ): ${error.message}\nStack: ${error.stack}`
			);
			await postSlackMessage2(
				"https://slack.com/api/chat.postMessage",
				{
					channel: payload.user.id,
					text: `❌ Erreur lors du traitement de la proforma pour la commande . Veuillez contacter le support.  ${error.message}\nStack: ${error.stack}`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
	});

	return context.res;
}
async function handleGlobalError(error, context, payload) {
	context.log(`❌ Erreur globale: ${error.stack}`);

	if (payload?.user?.id) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_tech_CHANNEL_ID,
				user: payload.user.id,
				text: `❌ Erreur globale: ${error.stack}`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}

	return createSlackResponse(500, "Erreur interne du serveur");
}

module.exports = {
	handleSlackInteractions,
};
