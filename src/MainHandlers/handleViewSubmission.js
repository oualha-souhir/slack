// Core Node.js modules
const axios = require("axios");
const querystring = require("querystring");
const {
	postSlackMessage,
	createSlackResponse,
} = require("../Common/slackUtils");
const { WebClient } = require("@slack/web-api");
const {
	handleFundingRequestSubmission,
} = require("../Caisse/Handlers/caisseFundingRequestHandlers");
const {
	processFundingApproval,
} = require("../Caisse/Handlers/caisseApprovalHandlers");
const {
	handleRejectFunding,
} = require("../Caisse/Handlers/caisseRejectionHandlers");
const {
	handleFundProblemSubmission,
	handlePaymentProblemSubmission,
} = require("../Caisse/Handlers/caisseProblemHandlers");
const {
	handleCorrectionSubmission,
} = require("../Caisse/Handlers/caisseCorrectionHandlers");
// Payment handlers
const {
	handlePaymentModificationSubmission,
	
} = require("../Caisse/Handlers/caissePaymentHandlers");

const {
	handleTransferApprovalConfirmation,
	createAndSaveTransferRequest,

	handleTransferConfirmation,
} = require("../Caisse/Transfer/transferHandlers");

const {
	handleProformaSubmission,
} = require("../Order/Proforma/proformaSubmission");
const {
	handleEditProformaSubmission,
} = require("../Order/Proforma/proformaModification");
const { handleDeleteProforma } = require("../Order/Proforma/proformaDelete");
const {
	processPaymentSubmission,
	handlePaymentRequestSubmission,
} = require("../Order/Payment/paymentHandlers");
const {
	executeOrderDeletion,
} = require("../Order/Handlers/orderRejectionHandlers");
const {
	notifyAdminTransfer,
	notifyUserTransfer,
} = require("../Caisse/Transfer/transferNotifications");
const {
	handleTransferRejectionReason,
} = require("../Caisse/Transfer/transferRejection");
const { notifyTechSlack } = require("../Common/notifyProblem");
const { handlePaymentModifSubmission } = require("../Payment Request/Handlers/paymentRequestHandlers");

async function handleViewSubmission(payload, context) {
	console.log("*------------------------------ handleViewSubmission");
	context.log("** callback_id", payload.view.callback_id);

	const formData = payload.view.state.values;
	const userId = payload.user.id;
	const userName = payload.user.username;
	let actionId;
	// console.log("payload2", payload);
	const slackToken = process.env.SLACK_BOT_TOKEN;
	const existingMetadata = payload.view.private_metadata
		? JSON.parse(payload.view.private_metadata)
		: {};
	const newPrivateMetadata = JSON.stringify({
		channelId: existingMetadata.channelId || payload.channel?.id || "unknown",
		formData: {
			...(existingMetadata.formData || {}),
			...payload.view.state.values,
		},
		originalViewId: existingMetadata.originalViewId || payload.view.id,
	});
	context.log(`New private metadata: ${newPrivateMetadata}`);
	const channelId = existingMetadata.channelId;
	const orderId = existingMetadata.orderId;
	// Determine if this is from an edit operation
	const isFromEdit =
		existingMetadata.isEdit === true && existingMetadata.orderId;
	context.log(`Is this submission from edit_order? ${isFromEdit}`);

	// Optionally set a source variable for clarity
	const submissionSource = isFromEdit ? "edit_order" : "new_submission";
	context.log(`Submission source: ${submissionSource}`);
	let channelName = "unknown";
	if (channelId) {
		try {
			const result = await axios.post(
				"https://slack.com/api/conversations.info",
				querystring.stringify({ channel: channelId }),
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
						"Content-Type": "application/x-www-form-urlencoded",
					},
				}
			);
			if (result.data.ok) channelName = result.data.channel.name;
		} catch (error) {
			await notifyTechSlack(error);

			context.log(`Failed to get channel name: ${error.message}`);
		}
	}
	if (payload.view.callback_id === "confirm_transfer_modal") {
		return await handleTransferConfirmation(payload);
	}
	context.log(
		"*------------------------------ payload.view.callback_id",
		payload.view.callback_id
	);
	if (payload.view.callback_id === "transfer_approval_confirmation") {
		console.log("** transfer_approval_confirmation");
		return await handleTransferApprovalConfirmation(payload, context);
	}

	if (payload.view.callback_id === "transfer_rejection_reason") {
		console.log("** transfer_rejection_reason");
		return await handleTransferRejectionReason(payload, context);
	}
	// ...existing code...
	if (payload.view.callback_id === "transfer_form") {
		console.log("** transfer_form submission");

		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};

		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id,
				text: "⌛ Demande de transfert en cours de traitement... Vous serez notifié(e) bientôt !",
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Process in background
		setImmediate(async () => {
			try {
				const formData = payload.view.state.values;
				const userId = payload.user.id;
				const userName = payload.user.username;

				// Validate form data
				const errors = {};

				// Check required fields
				if (!formData.from_caisse_block?.from_caisse_select?.selected_option) {
					errors.from_caisse_block = "Caisse source requise";
				}

				if (!formData.to_caisse_block?.to_caisse_select?.selected_option) {
					errors.to_caisse_block = "Caisse destination requise";
				}

				if (!formData.currency_block?.currency_select?.selected_option) {
					errors.currency_block = "Devise requise";
				}

				if (!formData.amount_block?.amount_input?.value) {
					errors.amount_block = "Montant requis";
				}

				if (!formData.motif_block?.motif_input?.value) {
					errors.motif_block = "Motif requis";
				}

				if (
					!formData.payment_mode_block?.payment_mode_select?.selected_option
				) {
					errors.payment_mode_block = "Mode de paiement requis";
				}

				// Validate amount
				const amount = parseFloat(formData.amount_block.amount_input.value);
				if (isNaN(amount) || amount <= 0) {
					errors.amount_block = "Montant invalide";
				}

				// Check if source and destination are different
				const fromCaisse =
					formData.from_caisse_block.from_caisse_select.selected_option.value;
				const toCaisse =
					formData.to_caisse_block.to_caisse_select.selected_option.value;

				if (fromCaisse === toCaisse) {
					errors.to_caisse_block =
						"La caisse source et destination doivent être différentes";
				}

				// If there are validation errors, notify user
				if (Object.keys(errors).length > 0) {
					const errorMessages = Object.values(errors).join(", ");
					await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: userId,
							text: `❌ Erreurs dans le formulaire de transfert: ${errorMessages}`,
						},
						process.env.SLACK_BOT_TOKEN
					);
					return;
				}

				// Create and save transfer request
				const transferRequest = await createAndSaveTransferRequest(
					userId,
					userName,
					formData,
					context
				);

				// Send notifications
				await Promise.all([
					notifyAdminTransfer(transferRequest, context),
					notifyUserTransfer(transferRequest, userId, context),
				]);

				context.log(
					`Transfer request ${transferRequest.transferId} created successfully`
				);
			} catch (error) {
				await notifyTechSlack(error);

				context.log(`Error processing transfer form: ${error.message}`);

				// Notify user of error
				await postSlackMessage(
					"https://slack.com/api/chat.postMessage",
					{
						channel: payload.user.id,
						text: `❌ Erreur lors du traitement de la demande de transfert: ${error.message}`,
					},
					process.env.SLACK_BOT_TOKEN
				);
			}
		});

		return context.res;
	}
	// ...existing code...
	if (payload.view.callback_id === "payment_modif_submission") {
		console.log("** payment_modif_submission");

		await handlePaymentModifSubmission(payload, context);
	}
	if (payload.view.callback_id === "correct_fund") {
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		setImmediate(async () => {
			console.log("** correct_fund");
			
			return await handleCorrectionSubmission(payload, context);
		});
	}
	// Handle cheque details submission
	if (payload.view.callback_id === "submit_cheque_details") {
		const requestId = payload.view.private_metadata;
		const chequeNumber =
			payload.view.state.values.cheque_number.input_cheque_number.value;
		const bankName =
			payload.view.state.values.bank_name?.input_bank_name?.value || "";

		const chequeDetails = {
			number: chequeNumber,
			bank: bankName,
			date: new Date().toISOString(),
		};
		console.log("userName9", userName);
		console.log("ùù requestId", requestId);
		await processFundingApproval(
			requestId,
			"approve_cheque",
			userName,
			chequeDetails
		);

		return createSlackResponse(200, "");
	}
	// Handle cheque details submission
	if (payload.view.callback_id === "submit_cheque_details") {
		const requestId = payload.view.private_metadata;
		const chequeNumber =
			payload.view.state.values.cheque_number.input_cheque_number.value;
		const bankName =
			payload.view.state.values.bank_name?.input_bank_name?.value || "";

		const chequeDetails = {
			number: chequeNumber,
			bank: bankName,
			date: new Date().toISOString(),
		};
		console.log("userName9", userName);
		console.log("ùù requestId", requestId);

		await processFundingApproval(
			requestId,
			"approve_cheque",
			userName,
			chequeDetails
		);

		return createSlackResponse(200, "");
	}
	if (payload.view.callback_id === "reject_funding") {
		return await handleRejectFunding(
			payload,
			context,
			userName,
			newPrivateMetadata
		);
	}
	if (payload.view.callback_id === "delete_order_confirmation") {
		return await executeOrderDeletion(payload, context);
	}
	if (payload.view.callback_id === "order_form_submission") {
		const {
			handleOrderFormSubmission,
		} = require("../Order/Handlers/orderFormHandlers");
		return await handleOrderFormSubmission(
			payload,
			context,
			formData,
			userId,
			userName,
			channelId,
			existingMetadata,
			submissionSource,
			orderId
		);
	}

	if (payload.view.callback_id === "submit_funding_request") {
		return await handleFundingRequestSubmission(payload, context, userName);
	}

	if (payload.view.callback_id === "payment_form_submission") {
		console.log("** payment_form_submission");
		await processPaymentSubmission(payload, context);
	}
	if (payload.view.callback_id === "payment_problem_submission") {
		return await handlePaymentProblemSubmission(payload, context);
	}
	if (payload.view.callback_id === "fund_problem_submission") {
		return await handleFundProblemSubmission(payload, context);
	}
	if (payload.view.callback_id === "payment_modification_submission") {
		console.log("$$ payment_modification_submission");
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};

		// Process in background
		setImmediate(async () => {
			return await handlePaymentModificationSubmission(
				payload,
				context,
				userId,
				slackToken
			);
		});

		return context.res;
	}
	if (payload.view.callback_id === "proforma_submission") {
		{
			// Immediate response to close modal
			context.res = {
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ response_action: "clear" }),
			};

			// Process in background
			setImmediate(async () => {
				try {
					await handleProformaSubmission(payload, context);
				} catch (error) {
					await notifyTechSlack(error);

					console.log(
						`?????????????? Background processing error for proforma submission (order: ${orderId}): ${error.message}\nStack: ${error.stack}`
					);
					await postSlackMessage2(
						"https://slack.com/api/chat.postMessage",
						{
							channel: payload.user.id,
							text: `❌ Erreur lors du traitement de la proforma pour la commande ${orderId}. Veuillez contacter le support.${error.message}\nStack: ${error.stack}`,
						},
						process.env.SLACK_BOT_TOKEN
					);
				}
			});

			return context.res;
		}
	} else if (payload.view.callback_id === "edit_proforma_submission") {
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		setImmediate(async () => {
			return await handleEditProformaSubmission(payload, context, userId);
		});

		return context.res;
	} else if (payload.view.callback_id === "delete_proforma_confirmation") {
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		// Process in background
		setImmediate(async () => {
			return await handleDeleteProforma(payload, context);
		});
	}
	// 3. Modify your payment request submission handler to use multiple justificatifs
	if (payload.view.callback_id === "payment_request_submission") {
		return await handlePaymentRequestSubmission(
			payload,
			context,
			formData,
			userId,
			channelId,
			slackToken
		);
	}

	return createSlackResponse(200, { text: "Submission non reconnue" });
}

module.exports = {
	handleViewSubmission,
};
