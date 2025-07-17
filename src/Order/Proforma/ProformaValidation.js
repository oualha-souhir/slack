const { Order } = require("../../Database/dbModels/Order");
const {
	postSlackMessage,
	createSlackResponse,
} = require("../../Common/slackUtils");
const { notifyAdminProforma } = require("./proformaNotificationService");
const { notifyTeams } = require("../Handlers/orderNotificationService");
const { notifyTechSlack } = require("../../Common/notifyProblem");

async function handleProformaValidationRequest(payload, context) {
	console.log("** handleProformaValidationRequest");
	try {
		const value = JSON.parse(payload.actions[0].value);
		const order = await Order.findOne({ id_commande: value.orderId });
		if (!order) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Erreur : Commande non trouvée.",
			});
		}
		const msgts = payload.container.message_ts;
		console.log("msgts", msgts);
		// Check if a proforma is already validated
		const alreadyValidated = order.proformas.some((p) => p.validated);
		if (alreadyValidated) {
			return await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					text: "❌ Une proforma a déjà été validée pour cette commande.",
				},
				process.env.SLACK_BOT_TOKEN
			);
		} else {
			console.log("value1", value);

			const response = await postSlackMessage(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: {
						type: "modal",
						callback_id: "proforma_validation_confirm",
						private_metadata: JSON.stringify({
							orderId: value.orderId,
							proformaIndex: value.proformaIndex,
							proformaName: value.proformaName, // Optional, for display
							proformaAmount: value.proformaAmount, // Optional, for display
							msgts: msgts,
						}),
						title: {
							type: "plain_text",
							text: " Validation",
							emoji: true,
						},
						submit: {
							type: "plain_text",
							text: "Valider",
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
									text: `Êtes-vous sûr de vouloir valider cette proforma?`,
								},
							},
							{
								type: "section",
								text: {
									type: "mrkdwn",

									text: `*Commande:* ${
										value.orderId
									}\n*Proforma:*\n*URLs:*\n${order.proformas?.[
										value.proformaIndex
									]?.urls
										.map((url, j) => `  ${j + 1}. <${url}|Page ${j + 1}>`)
										.join("\n")} \n*Montant:* ${
										order.proformas?.[value.proformaIndex]?.montant
									} ${order.proformas?.[value.proformaIndex]?.devise}`,
								},
							},
							{
								type: "input",
								block_id: "validation_data",
								optional: true,
								label: {
									type: "plain_text",
									text: "Commentaire ",
									emoji: true,
								},
								element: {
									type: "plain_text_input",
									action_id: "comment",
								},
							},
						],
					},
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!response.ok) {
				context.log(`Failed to open confirmation modal: ${response.error}`);
				throw new Error(`Modal open failure: ${response.error}`);
			}

			return response;
		}
	} catch (error) {
		await notifyTechSlack(error);

		context.log(
			`Error in handleProformaValidationRequest: ${error.message}`,
			error.stack
		);
		throw error;
	}
}
async function validateProforma(payload, context) {}
//* proforma_validation_confirm
async function ProformaValidationConfirm(payload, context) {
	console.log("** handleProformaValidationConfirm");
	try {
		console.log("payload1", payload);
		const values = payload.view.state.values;
		const comment = values.validation_data?.comment?.value || "";
		const metadata = JSON.parse(payload.view.private_metadata || "{}");
		const { orderId, proformaIndex } = metadata;

		console.log("Validation1");
		payload = {
			...payload,
			actions: [
				{
					value: JSON.stringify({
						orderId: orderId,
						proformaIndex: proformaIndex,
						comment: comment,
					}),
				},
			],
		};
		console.log("** validateProforma");
		try {
			const value = JSON.parse(payload.actions[0].value);
			const { orderId, proformaIndex, comment } = value;
			console.log("val11");
			// Find the order
			const order = await Order.findOne({ id_commande: orderId });
			if (!order) {
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "❌ Erreur : Commande non trouvée.",
				});
			}

			// Check if any proforma is already validated
			const alreadyValidated = order.proformas.some((p) => p.validated);
			if (alreadyValidated) {
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "❌ Une proforma a déjà été validée pour cette commande.",
				});
			}

			// Validate the proforma
			const proformaToValidate = order.proformas[proformaIndex];
			if (!proformaToValidate) {
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "❌ Erreur : Proforma non trouvée.",
				});
			}

			// Update the proforma with validation info
			proformaToValidate.validated = true;
			proformaToValidate.validatedAt = new Date();
			proformaToValidate.validatedBy = payload.user.id;
			if (comment) {
				proformaToValidate.validationComment = comment;
			}
			console.log("proformaToValidate", proformaToValidate);

			// Save the updated order
			await order.save();
			console.log("Notifying admin about proforma submission... 1");

			// Notify both admin and achat channels with updated message
			await notifyAdminProforma(context, order, "", proformaIndex);

			const actionValue = JSON.parse(payload.actions[0].value);
			// Extract the orderId from the parsed object
			const orderId1 = actionValue.orderId;
			// Query the Order collection with a proper filter object
			const order2 = await Order.findOne({ id_commande: orderId1 });
			console.log("order111", order2);
			return await notifyTeams(payload, comment, order2, context);
		} catch (error) {
			await notifyTechSlack(error);

			context.log(`Error in validateProforma: ${error.message}`, error.stack);
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: `❌ Erreur lors de la validation: ${error.message}`,
			});
		}
		return {
			response_action: "clear",
		};
	} catch (error) {
		await notifyTechSlack(error);

		context.log(
			`Error in handleProformaValidationConfirm: ${error.message}`,
			error.stack
		);
		throw error;
	}
}
module.exports = {
	handleProformaValidationRequest,
	validateProforma,
	ProformaValidationConfirm,
};
