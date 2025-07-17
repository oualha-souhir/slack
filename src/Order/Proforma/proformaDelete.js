const { notifyTechSlack } = require("../../Common/notifyProblem");
const { postSlackMessage } = require("../../Common/slackUtils");
const { Order } = require("../../Database/dbModels/Order");
const { notifyAdminProforma } = require("./proformaNotificationService");

async function handleDeleteProforma(payload, context) {
	try {
		console.log("** handleDeleteProforma");
		// Extract data from the modal submission
		const { orderId, proformaIndex, msgts } = JSON.parse(
			payload.view.private_metadata
		);

		// Get the order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			throw new Error(`Order ${orderId} not found`);
		}

		// Check if the proforma exists
		if (!order.proformas || !order.proformas[proformaIndex]) {
			throw new Error(
				`Proforma index ${proformaIndex} not found in order ${orderId}`
			);
		}

		// Check if the proforma is already validated
		if (order.proformas[proformaIndex].validated) {
			return {
				response_action: "errors",
				errors: {
					delete_proforma_confirmation:
						"Cette proforma a déjà été validée et ne peut pas être supprimée.",
				},
			};
		}

		// Store the proforma details for the notification
		const deletedProforma = order.proformas[proformaIndex];

		// Remove the proforma from the array
		order.proformas.splice(proformaIndex, 1);

		// Save the updated order
		await order.save();
		console.log("Notifying admin about proforma submission... 2");

		// Notify admin about the deletion
		await notifyAdminProforma(context, order, msgts);

		// Post confirmation message to achat channel
		await postSlackMessage(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ACHAT_CHANNEL_ID,
				text: `✅ Proforma supprimée par <@${payload.user.id}>: *${deletedProforma.nom}* - ${deletedProforma.montant} ${deletedProforma.devise} pour la commande ${orderId}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		return { response_action: "clear" };
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`Error in handleDeleteProforma: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				delete_proforma_confirmation: `❌ Erreur lors de la suppression: ${error.message}`,
			},
		};
	}
}
async function handleDeleteProformaConfirmation(payload, context) {
	console.log("** handleDeleteProformaConfirmation");
	try {
		// Extract data from the button value
		const { orderId, proformaIndex } = JSON.parse(payload.actions[0].value);
		const msgts = payload.container.message_ts;
		console.log("msgts", msgts);
		// Fetch the order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			throw new Error(`Order ${orderId} not found`);
		}

		// Check if the proforma exists
		if (!order.proformas || !order.proformas[proformaIndex]) {
			throw new Error(
				`Proforma index ${proformaIndex} not found in order ${orderId}`
			);
		}

		const proforma = order.proformas[proformaIndex];

		// Check if any proforma in the order is already validated
		const hasValidatedProforma = order.proformas.some((p) => p.validated);
		if (hasValidatedProforma) {
			// Post Slack message to the designated channel
			const slackResponse = await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ACHAT_CHANNEL_ID,
					text: "⚠️ Une proforma a été validée.",
				},
				process.env.SLACK_BOT_TOKEN
			);
			// return {
			//   text: ,
			//   replace_original: false,
			//   response_type: "ephemeral"
			// };
		} else {
			// Open a confirmation dialog
			const modalView = {
				type: "modal",
				callback_id: "delete_proforma_confirmation",
				title: {
					type: "plain_text",
					text: "Confirmer la suppression",
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
							text: "⚠️ Êtes-vous sûr de vouloir supprimer cette proforma ? Cette action est irréversible.",
						},
					},
				],
				private_metadata: JSON.stringify({ orderId, proformaIndex, msgts }),
			};

			const response = await postSlackMessage(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: modalView,
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!response.ok) {
				throw new Error(
					`Failed to open deletion confirmation: ${response.error}`
				);
			}
		}

		return { text: "Chargement de la confirmation de suppression..." };
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`Error in handleDeleteProformaConfirmation: ${error.message}`);
		return {
			text: `❌ Erreur lors de la confirmation de suppression: ${error.message}`,
		};
	}
}
module.exports = {
	handleDeleteProforma,
	handleDeleteProformaConfirmation,
};
