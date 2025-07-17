const { WebClient } = require("@slack/web-api");
const { generatePaymentForm } = require("../../Order/Payment/paymentForm");
const { generatePaymentRequestForm, getPaymentRequestBlocks } = require("./paymentRequestForm");
const {
	postSlackMessage9,
	createSlackResponse,
} = require("../../Common/slackUtils");
const axios = require("axios");
const { notifyTechSlack } = require("../../Common/notifyProblem");


async function handlePaymentMethodSelection1(payload, context) {
	console.log("** handlePaymentMethodSelection1");
	const { view, actions } = payload;
	const selectedValue = actions[0].selected_option.value;
	console.log("selectedValue", selectedValue);
	const client = new WebClient(process.env.SLACK_BOT_TOKEN);

	// Parse the existing metadata
	const metadata = JSON.parse(view.private_metadata);

	// Update the modal with the new selection
	// const updatedView = await createPaymentConfirmationModal(
	// 	metadata.paymentId,
	// 	metadata.action === "accept",
	// 	metadata.message_ts,
	// 	selectedValue
	// );

	const orderId = metadata.orderId; // This will be "PAY/2025/07/0078"

	console.log("Order ID:", orderId);
	console.log("payload.actions[0]", payload.actions[0]);
	console.log("** payment_method_selection");
	const updatedView = await generatePaymentForm({
		payload,
		action: payload.actions[0],
		context,
		selectedPaymentMode: selectedValue,
		orderId,
		selectedCaisseId: null,
	});
	// Update the modal view
	await client.views.update({
		view_id: payload.view.id,
		view: updatedView,
	});
}
async function handleOpenPaymentForm(payload, context) {
	console.log("** handleOpenPaymentForm");
	context.res = {
		status: 200,
		body: "", // Empty response acknowledges receipt
	};

	// Then process the command asynchronously after acknowledgment
	setImmediate(async () => {
		try {
			console.log("aaaa ");
			const view = generatePaymentRequestForm({});
			console.log("view", view);
			console.log(".private_metadata", view.private_metadata);
			if (payload.channel && payload.channel.id) {
				view.private_metadata = JSON.stringify({
					channelId: payload.channel.id,
				});
			}

			const response = await postSlackMessage9(
				"https://slack.com/api/views.open",
				{ trigger_id: payload.trigger_id, view },
				process.env.SLACK_BOT_TOKEN
			);
			console.log("Full postSlackMessage response:", JSON.stringify(response));
			console.log("Returning context.res:", JSON.stringify(context.res));
			context.log(`views.open response: ${JSON.stringify(response)}`);
			if (!response.ok) {
				context.log(`views.open error: ${response.error}`);
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: `❌ Erreur: ${response.error}`,
				});
			}
			if (response.warning) {
				console.log("views.open warning:", response.warning);
				// Optionally handle warnings without showing an error to the user
			}
			return createSlackResponse(200, "");
		} catch (error) {
			await notifyTechSlack(error);

			context.log(
				`❌ Error opening payment form: ${error.message}\nStack: ${error.stack}`
			);
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: `❌ Erreur: Impossible d'ouvrir le formulaire de paiement (${error.message})`,
			});
		}
	});
	return context.res;
}
//* ? payment_modif_submission
async function handlePaymentModifSubmission(payload, context) {
	console.log("? payment_modif_submission");

	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		try {
			const view = payload.view;

			// Parse private metadata
			const metadata = JSON.parse(view.private_metadata || "{}");
			const { paymentId, originalMessage } = metadata;

			if (!paymentId || !originalMessage) {
				throw new Error("Missing paymentId or originalMessage in metadata");
			}

			context.log(`Processing submission for payment ID: ${paymentId}`);

			// Extract form values
			const stateValues = view.state.values;
			const formData = {
				request_title: stateValues.request_title?.input_request_title?.value,
				request_date:
					stateValues.request_date?.input_request_date?.selected_date,
				payment_reason: stateValues.payment_reason?.input_payment_reason?.value,
				amount_to_pay: stateValues.amount_to_pay?.input_amount_to_pay?.value,
				po_number: stateValues.po_number?.input_po_number?.value,
				justificatif_url:
					stateValues.justificatif_url?.input_justificatif_url?.value,
				justificatif_files:
					stateValues.justificatif?.input_justificatif?.files || [],
				existing_justificatifs: Object.keys(stateValues)
					.filter((key) => key.startsWith("existing_justificatif_"))
					.map((key) => stateValues[key][`input_${key}`]?.value)
					.filter((url) => url && url.trim()), // Filter out empty or null values
			};

			// Validate required fields
			if (
				!formData.request_title ||
				!formData.request_date ||
				!formData.payment_reason ||
				!formData.amount_to_pay ||
				!formData.po_number
			) {
				throw new Error("Missing required fields in form submission");
			}

			// Extract amount and currency
			const amountMatch = formData.amount_to_pay.match(
				/^(\d+(\.\d+)?)\s*([A-Z]{3})$/
			);
			if (!amountMatch) {
				throw new Error(
					"Invalid amount format. Expected: 'number CURRENCY' (e.g., 1000 USD)"
				);
			}
			const amount = parseFloat(amountMatch[1]);
			const currency = amountMatch[3];

			// Fetch existing payment
			const payment = await PaymentRequest.findOne({ id_paiement: paymentId });
			if (!payment) {
				throw new Error(`Payment with ID ${paymentId} not found`);
			}

			if (payment.statut !== "En attente") {
				await axios.post(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: originalMessage.channel,
						user: payload.user.id,
						text: `⚠️ Demande de paiement traitée par l'Administrateur, vous ne pouvez pas la modifier.`,
					},
					{
						headers: {
							Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
						},
					}
				);
				return { statusCode: 200, body: "" };
			}

			// Prepare justificatifs: combine existing files, new files, and new URL
			const existingFiles = payment.justificatif.filter(
				(j) => j.type === "file"
			);
			const existingUrl =
				payment.justificatif.find((j) => j.type === "url") || null;
			const newFiles = formData.justificatif_files.map((file) => ({
				url: file.permalink,
				type: "file",
				createdAt: new Date(),
			}));
			const newUrl = formData.justificatif_url
				? { url: formData.justificatif_url, type: "url", createdAt: new Date() }
				: null;
			const existingUrls = formData.existing_justificatifs.map((url) => ({
				url,
				type: payment.justificatif.find((j) => j.url === url)?.type || "url", // Preserve original type if exists
				createdAt:
					payment.justificatif.find((j) => j.url === url)?.createdAt ||
					new Date(),
			}));
			const updatedJustificatifs = [
				...existingUrls, // Keep URLs from input fields
				...newFiles, // Add new files
				...(newUrl ? [newUrl] : []), // Add new URL if provided
			];

			// Update payment in database
			const updatedPayment = await PaymentRequest.findOneAndUpdate(
				{ id_paiement: paymentId },
				{
					titre: formData.request_title,
					date_requete: new Date(formData.request_date),
					motif: formData.payment_reason,
					montant: amount,
					devise: currency,
					bon_de_commande: formData.po_number,
					justificatif: updatedJustificatifs,
					updatedAt: new Date(),
				},
				{ new: true }
			);

			context.log(`Updated payment: ${JSON.stringify(updatedPayment)}`);

			// Generate updated blocks for both messages using getPaymentRequestBlocks
			const demandeurBlocks = [
				...getPaymentRequestBlocks(updatedPayment, null),
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: { type: "plain_text", text: "Modifier", emoji: true },
							style: "primary",
							action_id: "edit_payment",
							value: paymentId,
						},
					],
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: "✅ Votre demande de paiement a été mise à jour. En attente de validation par un administrateur.",
						},
					],
				},
			];
			const adminBlocks = [
				...getPaymentRequestBlocks(updatedPayment, null),
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: { type: "plain_text", text: "Approuver", emoji: true },
							style: "primary",
							action_id: "payment_verif_accept",
							value: paymentId,
						},
						{
							type: "button",
							text: { type: "plain_text", text: "Rejeter", emoji: true },
							style: "danger",
							action_id: "reject_order",
							value: paymentId,
						},
					],
				},
				{
					type: "context",
					elements: [{ type: "mrkdwn", text: "⏳ En attente de validation" }],
				},
			];

			// Update Demandeur's message
			const demandeurUpdateResponse = await axios.post(
				"https://slack.com/api/chat.update",
				{
					channel: originalMessage.channel,
					ts: originalMessage.ts,
					text: `Demande de paiement *${paymentId}* mise à jour`,
					blocks: demandeurBlocks,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);

			if (!demandeurUpdateResponse.data.ok) {
				throw new Error(
					`Failed to update demandeur message: ${demandeurUpdateResponse.data.error}`
				);
			}
			context.log(
				`Updated demandeur message: ${JSON.stringify(
					demandeurUpdateResponse.data
				)}`
			);

			// Update Admin message
			if (
				updatedPayment.admin_message?.channel &&
				updatedPayment.admin_message?.ts
			) {
				const adminUpdateResponse = await axios.post(
					"https://slack.com/api/chat.update",
					{
						channel: updatedPayment.admin_message.channel,
						ts: updatedPayment.admin_message.ts,
						text: `Demande de paiement *${paymentId}* mise à jour par <@${updatedPayment.demandeur}>`,
						blocks: adminBlocks,
					},
					{
						headers: {
							Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
						},
					}
				);

				if (!adminUpdateResponse.data.ok) {
					throw new Error(
						`Failed to update admin message: ${adminUpdateResponse.data.error}`
					);
				}

				context.log(
					`Updated admin message: ${JSON.stringify(adminUpdateResponse.data)}`
				);
			} else {
				context.log(
					"⚠️ Admin message details not found, skipping admin message update"
				);
			}

			return { statusCode: 200, body: "" };
		} catch (error) {
			await notifyTechSlack(error);

			context.log(
				`❌ Error in handlePaymentFormSubmission: ${error.message}\nStack: ${error.stack}`
			);

			await axios.post(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: process.env.SLACK_ADMIN_ID,
					user: payload.user.id,
					text: `🛑 Échec de la soumission du formulaire: ${error.message}`,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);

			return {
				statusCode: 400,
				body: JSON.stringify({
					response_type: "ephemeral",
					text: `Erreur lors de la soumission: ${error.message}`,
				}),
				headers: { "Content-Type": "application/json" },
			};
		}
	});
}
module.exports = {
	handlePaymentMethodSelection1,
	handleOpenPaymentForm,
	handlePaymentModifSubmission,
};
