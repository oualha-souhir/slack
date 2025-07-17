const {
	generateFundingApprovalPaymentModal,
	handleFillFundingDetails,
	handlePaymentMethodSelection,
} = require("../Caisse/Handlers/caissePaymentHandlers");
const {
	openTransferApprovalConfirmation,
	handleTransferToCaisse,
} = require("../Caisse/Transfer/transferHandlers");

const {
	createSlackResponse,
	postSlackMessage,
	postSlackMessageWithRetry,
	postSlackMessage2,
} = require("../Common/slackUtils");

const {
	handlePaymentVerification,
	handleOrderStatus,
} = require("../Order/Handlers/orderApprovalHandlers");
const {
	handleOpenFundingForm,
} = require("../Caisse/Handlers/caisseFundingRequestHandlers");
const { proforma_form } = require("../Order/Proforma/proformaForm");
const {
	handleDeleteProformaConfirmation,
} = require("../Order/Proforma/proformaDelete");
const {
	handleProformaValidationRequest,
	validateProforma,
} = require("../Order/Proforma/ProformaValidation");
const { handleFinancePaymentForm } = require("../Order/Payment/paymentForm");
const {
	handlePaymentFormModeSelection,
	handlePaymentProblemModal,
	handleModifyPayment,
} = require("../Order/Payment/paymentHandlers");
const { fetchEntity } = require("../Common/utils");
const {
	handleFundProblemModal,
} = require("../Caisse/Handlers/caisseProblemHandlers");

const { view_order } = require("../Order/orderSubcommands");
const { WebClient } = require("@slack/web-api");
const {
	openRejectionReasonModal,
	handleDeleteOrder,
	handleDeleteOrderConfirmed,
} = require("../Order/Handlers/orderRejectionHandlers");
const {
	handleEditProforma,
} = require("../Order/Proforma/proformaModification");
const {
	openTransferRejectionReason,
} = require("../Caisse/Transfer/transferRejection");
const { handleEditOrder } = require("../Order/Handlers/orderModification");
const { notifyTechSlack } = require("../Common/notifyProblem");
const {
	handleEditPayment,
} = require("../Payment Request/Handlers/paymentRequestEdition");
const {
	handlePaymentMethodSelection1,
	handleOpenPaymentForm,
} = require("../Payment Request/Handlers/paymentRequestHandlers");
const { Caisse } = require("../Database/dbModels/Caisse");
const { generateCorrectionModal } = require("../Caisse/Handlers/caisseCorrectionHandlers");
const { openRejectionReasonModalFund } = require("../Caisse/Handlers/caisseRejectionHandlers");

async function handleReportProblem(payload, context) {
	console.log("** handleReportProblem");
	console.log("=== payload.actions", payload.actions);
	console.log("=== payload", payload);
	let entityId, selectedCaisseId;
	const actionValue = payload.actions[0].value;
	const actionId = payload.actions[0].action_id;
	const messageTs = payload.container.message_ts;

	// Parse the action value which might be JSON or a simple string
	try {
		const parsedValue = JSON.parse(actionValue);
		if (actionId === "report_fund_problem") {
			entityId = parsedValue.requestId; // Use requestId for fund problems
			selectedCaisseId = parsedValue.caisseType || null;
		} else {
			entityId = parsedValue.entityId;
			selectedCaisseId = parsedValue.selectedCaisseId;
		}
	} catch (parseError) {
		await notifyTechSlack(parseError);

		// If parsing fails, assume it's a simple entityId string
		entityId = actionValue;
		selectedCaisseId = null;
	}
	const entity = await fetchEntity(entityId, context);
	if (!entity) {
		throw new Error(`Entity ${entityId} not found`);
	}
	// Determine the callback_id based on which action triggered this handler
	const callback_id =
		actionId === "report_fund_problem"
			? "fund_problem_submission"
			: "payment_problem_submission";

	try {
		let entity;
		let request;
		if (callback_id == "payment_problem_submission") {
			return await handlePaymentProblemModal(
				payload,
				context,
				messageTs,
				callback_id,
				entityId,
				selectedCaisseId,
				entity
			);
		} else if (callback_id == "fund_problem_submission") {
			return await handleFundProblemModal(
				payload,
				context,
				messageTs,
				callback_id
			);
		}
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`Error handling report problem: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				_error: `Une erreur s'est produite: ${error.message}`,
			},
		};
	}
}

async function handleBlockActions(payload, context) {
	console.log("*------------------------------ handleBlockActions");

	const action = payload.actions[0];
	console.log("** payload.actions", action);
	const actionId = action.action_id;
	console.log("** actionId", actionId);
	const userName = payload.user.username;

	try {
		// Handle different payload types
		if (payload.type === "dialog_submission") {
			return await handleDialogSubmission(payload, context);
		}
		if (actionId === "transfer_to_caisse") {
			return await handleTransferToCaisse(action, payload);
		}
		if (payload.type === "interactive_message") {
			return await handleInteractiveMessage(payload, context, action);
		}

		if (payload.type === "block_actions") {
			return await handleBlockActionsByType(payload, context, action, actionId);
		}

		return createSlackResponse(400, "Type d'action non supporté");
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`Error in handleBlockActions: ${error.message}`);
		return createSlackResponse(500, "Erreur interne du serveur");
	}
}

// Handle dialog submissions
async function handleDialogSubmission(payload, context) {
	console.log("** dialog_submission");

	const callbackId = payload.callback_id;

	switch (callbackId) {
		case "delete_order_confirm":
			return await handleDeleteOrderConfirmed(payload, context);
		default:
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "Action de dialogue non reconnue.",
			});
	}
}

// Handle interactive messages
async function handleInteractiveMessage(payload, context, action) {
	if (action.value === "open") {
		if (action.name === "open_form") {
			const {
				handleOpenOrderForm,
			} = require("../Order/Handlers/orderFormHandlers");
			return await handleOpenOrderForm(payload, context);
		} else if (action.name === "finance_payment_form") {
			return await handleOpenPaymentForm(payload, context);
		}
	}
	return createSlackResponse(200, "");
}

// Handle block actions by type
async function handleBlockActionsByType(payload, context, action, actionId) {
	// Handle view_order actions
	if (actionId.startsWith("view_order_")) {
		return await view_order(payload, action, context);
	}

	// Handle transfer actions
	if (actionId === "approve_transfer") {
		console.log("** approve_transfer");
		return await openTransferApprovalConfirmation(payload, context);
	}

	if (actionId === "reject_transfer") {
		console.log("** reject_transfer");
		return await openTransferRejectionReason(payload, context);
	}

	// Handle order actions
	if (isOrderAction(actionId)) {
		return await handleOrderActions(payload, context, action, actionId);
	}

	// Handle payment actions
	if (isPaymentAction(actionId)) {
		return await handlePaymentActions(payload, context, action, actionId);
	}

	// Handle funding actions
	if (isFundingAction(actionId)) {
		return await handleFundingActions(payload, context, action, actionId);
	}

	// Handle proforma actions
	if (isProformaAction(actionId)) {
		return await handleProformaActions(payload, context, action, actionId);
	}

	// Handle problem reporting
	if (isProblemReportingAction(actionId)) {
		return await handleProblemReporting(payload, context, action, actionId);
	}

	// Handle miscellaneous actions
	return await handleMiscellaneousActions(payload, context, action, actionId);
}

// Order-related actions
function isOrderAction(actionId) {
	return [
		"edit_order",
		"accept_order",
		"reject_order",
		"delete_order",
		"delete_order_confirmed",
		"process_delayed_order",
	].includes(actionId);
}

async function handleOrderActions(payload, context, action, actionId) {
	action = action || (payload.actions && payload.actions[0]);
	console.log("** action", action);
	switch (actionId) {
		case "edit_order":
			return await handleEditOrder(payload, context);
		case "accept_order":
			return await handleOrderStatus(payload, action, context);
		case "reject_order":
			return openRejectionReasonModal(payload, action, context);
		case "delete_order":
			return await handleDeleteOrder(payload, context);
		case "delete_order_confirmed":
			return await handleDeleteOrderConfirmed(payload, context);
		case "process_delayed_order":
			return await handleDelayedOrderAction(payload, action, context);
		default:
			return createSlackResponse(200, "");
	}
}

// Payment-related actions
function isPaymentAction(actionId) {
	return [
		"edit_payment",
		"accept_payment",
		"reject_payment",
		"payment_method_selection",
		"select_payment_mode",
		"confirm_payment_mode",
		"confirm_payment_mode_2",
		"Modifier_paiement",
		"modify_payment",
		"payment_verif_accept",
		"payment_verif_reject",
		"finance_payment_form",
		"input_payment_method",
	].includes(actionId);
}

async function handlePaymentActions(payload, context, action, actionId) {
	switch (actionId) {
		case "edit_payment":
			return await handleEditPayment(payload, context);
		case "accept_payment":
			return await handleAcceptPayment(payload, context, action);
		case "reject_payment":
			return await handleRejectPayment(payload, context, action);
		case "payment_method_selection":
			await handlePaymentMethodSelection1(payload, context);
			return createSlackResponse(200, "");
		case "select_payment_mode":
			// Check if this is from the payment form modal
			if (payload.view?.callback_id === "payment_form_submission") {
				console.log("** select_payment_mode");
				console.log("Handling payment mode selection for payment form");
				await handlePaymentFormModeSelection(payload, context);
				return createSlackResponse(200, "");
			}
			// Check if this is from the payment modification modal
			else if (
				payload.view?.callback_id === "payment_modification_submission"
			) {
				console.log(
					"===/ Handling payment mode selection for payment modification"
				);
				await handleModifyPayment(payload, context);
				return createSlackResponse(200, "");
			}
			// Existing logic for other cases
			break;
		case "confirm_payment_mode":
			console.log("** confirm_payment_mode");
			const selectedMode =
				payload.view.state.values.payment_mode.select_payment_mode
					.selected_option?.value;
			if (!selectedMode) {
				context.log("No payment mode selected");
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "Veuillez sélectionner un mode de paiement avant de confirmer.",
				});
			}
			const privateMetadata = JSON.parse(payload.view.private_metadata || "{}");
			return await generatePaymentForm({
				payload,
				action,
				context,
				selectedPaymentMode: selectedMode,
				orderId: privateMetadata.entityId,
			});
		case "confirm_payment_mode_2":
			console.log("** confirm_payment_mode_2");
			const selectedMode2 =
				payload.view.state.values.payment_mode.select_payment_mode
					.selected_option?.value;
			if (!selectedMode2) {
				context.log("No payment mode selected");
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "Veuillez sélectionner un mode de paiement avant de confirmer.",
				});
			}
			return await handleModifyPayment(payload, context, selectedMode2);
		case "Modifier_paiement":
			return await handlePaymentModification(payload, context);
		case "modify_payment":
			return await handleModifyPayment(payload, context);
		case "payment_verif_accept":
		case "payment_verif_reject":
			return await handlePaymentVerification(payload, action, context);
		case "finance_payment_form":
			return await handleFinancePaymentForm(payload, action, context);
		case "input_payment_method":
			await handlePaymentMethodSelection(payload, context);
			return createSlackResponse(200, "");
		default:
			return createSlackResponse(200, "");
	}
}

// Funding-related actions
function isFundingAction(actionId) {
	return [
		"fill_funding_details",
		"approve_funding",
		"pre_approve_funding",
		"funding_approval_payment",
		"reject_fund",
		"correct_funding_details",
		"open_funding_form",
	].includes(actionId);
}

async function handleFundingActions(payload, context, action, actionId) {
	switch (actionId) {
		case "fill_funding_details":
			return await handleFillFundingDetails(payload, context);
		case "approve_funding":
			const messageTs = payload.message?.ts;
			console.log("approve_funding");
			requestId = action.value; // e.g., FUND/2025/04/0070

			await generateFundingApprovalPaymentModal(
				context,
				payload.trigger_id,
				messageTs,
				requestId
			);
			return createSlackResponse(200, "");
		case "pre_approve_funding":
			const {
				openPreApprovalConfirmationDialog,
			} = require("../Caisse/Handlers/caisseApprovalHandlers");
			// Instead of directly handling pre-approval, open a confirmation dialog
			await openPreApprovalConfirmationDialog(payload);
			return createSlackResponse(200, "");

		case "funding_approval_payment":
			const {
				openFinalApprovalConfirmationDialog,
			} = require("../Caisse/Handlers/caisseApprovalHandlers");
			await openFinalApprovalConfirmationDialog(payload);
			return createSlackResponse(200, "");

		case "reject_fund":
			return await openRejectionReasonModalFund(payload);
		case "correct_funding_details":
			
			return await generateCorrectionModal(payload, context);

		case "open_funding_form":
			return await handleOpenFundingForm(payload, context);
		default:
			return createSlackResponse(200, "");
	}
}

// Proforma-related actions
function isProformaAction(actionId) {
	return [
		"confirm_validate_proforma",
		"proforma_form",
		"validate_proforma",
		"delete_confirmation",
		"edit_proforma",
		"confirm_delete_proforma",
	].includes(actionId);
}

async function handleProformaActions(payload, context, action, actionId) {
	switch (actionId) {
		case "confirm_validate_proforma":
			return await handleProformaValidationRequest(payload, context);
		case "proforma_form":
			return await proforma_form(payload, action, context);
		case "validate_proforma":
			return await validateProforma(payload, context);
		case "delete_confirmation":
			return await cancelValidation(payload, context);
		case "edit_proforma":
			return await handleEditProforma(payload, context);
		case "confirm_delete_proforma":
			return await handleDeleteProformaConfirmation(payload, context);
		default:
			return createSlackResponse(200, "");
	}
}

// Problem reporting actions
function isProblemReportingAction(actionId) {
	return ["report_problem", "report_fund_problem"].includes(actionId);
}

async function handleProblemReporting(payload, context, action, actionId) {
	switch (actionId) {
		case "report_problem":
			// Process in background
			setImmediate(async () => {
				return await handleReportProblem(payload, context);
			});
			return createSlackResponse(200, "");
		case "report_fund_problem":
			return await handleReportProblem(payload, context);
		default:
			return createSlackResponse(200, "");
	}
}

// Handle miscellaneous actions
async function handleMiscellaneousActions(payload, context, action, actionId) {
	switch (actionId) {
		case "caisse_selection":
			return createSlackResponse(200, "");
		default:
			const {
				handleDynamicFormUpdates,
			} = require("../Order/Handlers/orderFormHandlers");
			return await handleDynamicFormUpdates(payload, action, context);
	}
}

module.exports = {
	handleBlockActions,
};
