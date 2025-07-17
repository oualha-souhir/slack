
const axios = require("axios");
const { notifyTechSlack } = require("../../Common/notifyProblem");
const { postSlackMessage2 } = require("../../Common/slackUtils");
const PaymentRequest = require("../../Database/dbModels/PaymentRequest");
const { generatePaymentForm1 } = require("./paymentRequestForm");

async function handleEditPayment(payload, context) {
	console.log("** edit_payment");

	try {
		const paymentId = payload.actions[0].value;
		context.log(`Editing payment with ID: ${paymentId}`);

		const payment = await PaymentRequest.findOne({ id_paiement: paymentId });
		if (!payment) {
			throw new Error(`Payment with ID ${paymentId} not found`);
		}
		console.log("Payment request object:", payment);

		console.log(`payment.status ${payment.statut}`);

		if (payment.statut === "En attente") {
			// Separate files and URLs from justificatifs
			const justificatifs = payment.justificatif.map((j) => j.url); // Include all justificatifs (files and URLs)
			const urlJustificatif =
				payment.justificatif.find((j) => j.type === "url")?.url || "";
			const formData = {
				payment_title: {
					input_payment_title: {
						value: payment.titre || "",
					},
				},
				payment_date: {
					input_payment_date: {
						selected_date: payment.date_requete
							? new Date(payment.date_requete).toISOString().split("T")[0]
							: new Date().toISOString().split("T")[0],
					},
				},
				payment_description: {
					input_payment_description: {
						value: payment.motif || "",
					},
				},
				payment_amount: {
					input_payment_amount: {
						value: payment.montant ? String(payment.montant) : "",
					},
				},
				po_number: {
					input_po_number: {
						value: payment.bon_de_commande || "",
					},
				},
				justificatif_url: {
					input_justificatif_url: {
						value: urlJustificatif,
					},
				},
				existing_justificatifs: justificatifs,
				currency: payment.devise || "", // Store file URLs for display
			};
			console.log("Payment formData:", formData);

			const metadata = {
				formData: formData,
				originalViewId: payload.trigger_id,
				paymentId: paymentId,
				isEdit: true,
				originalMessage: {
					channel: payload.channel?.id || payload.channel || payload.user.id,
					ts: payload.message?.ts,
				},
			};
			console.log("$ payment metadata", metadata);

			const view = await generatePaymentForm1(formData);

			const response = await postSlackMessage2(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: {
						...view,
						private_metadata: JSON.stringify(metadata),
					},
				},
				process.env.SLACK_BOT_TOKEN
			);

			context.log(
				`Edit payment form response: ${JSON.stringify(response.data)}`
			);

			if (!response.data.ok) {
				throw new Error(`Slack API error: ${response.data.error}`);
			}
		} else {
			await axios.post(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel?.id || payload.channel || payload.user.id,
					user: payload.user.id,
					text: `⚠️ Demande de paiement ${payment.statut}e par l'Administrateur, vous ne pouvez pas la modifier`,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);
		}
	} catch (error) {
		await notifyTechSlack(error);

		context.log(
			`❌ Error in edit_payment: ${error.message}\nStack: ${error.stack}`
		);

		await axios.post(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.channel?.id || payload.channel || payload.user.id,
				user: payload.user.id,
				text: `🛑 Échec de l'édition de la demande de paiement: ${error.message}`,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			}
		);
	}
}
module.exports = {
    handleEditPayment,

};