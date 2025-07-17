const { postSlackMessageWithRetry } = require("../../Common/slackUtils");
const { Caisse } = require("../../Database/dbModels/Caisse");

// Notify admin about transfer request
async function notifyAdminTransfer(request, context) {
	console.log("** notifyAdminTransfer");

	// Get current caisse balances
	const fromCaisse = await Caisse.findOne({ channelId: request.fromCaisse });
	const toCaisse = await Caisse.findOne({ channelId: request.toCaisse });

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `🔀 Demande de transfert: ${request.transferId}`,
						emoji: true,
					},
				},
				{
					type: "divider",
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*ID:*\n${request.transferId}`,
						},
						{
							type: "mrkdwn",
							text: `*Montant:*\n${request.amount} ${request.currency}`,
						},
					],
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*De:*\n<#${request.fromCaisse}>`,
						},
						{
							type: "mrkdwn",
							text: `*Vers:*\n<#${request.toCaisse}>`,
						},
					],
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*Motif:*\n${request.motif}`,
						},
						{
							type: "mrkdwn",
							text: `*Mode de paiement:*\n${request.paymentMode}`,
						},
					],
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*Demandeur:*\n${request.submittedBy}`,
						},
						{
							type: "mrkdwn",
							text: `*Statut:*\n${request.status}`,
						},
					],
				},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `*Soumis le:*\n${new Date(request.submittedAt).toLocaleString(
							"fr-FR"
						)}`,
					},
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Solde source actuel: ${
								fromCaisse?.balances[request.currency] || 0
							} ${request.currency} | Solde cible actuel: ${
								toCaisse?.balances[request.currency] || 0
							} ${request.currency}`,
						},
					],
				},
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: { type: "plain_text", text: "Approuver", emoji: true },
							style: "primary",
							value: request.transferId,
							action_id: "approve_transfer",
						},
						{
							type: "button",
							text: { type: "plain_text", text: "Rejeter", emoji: true },
							style: "danger",
							value: request.transferId,
							action_id: "reject_transfer",
						},
					],
				},
			],
			text: `Nouvelle demande de transfert: ${request.amount} ${request.currency} de <#${request.fromCaisse}> vers <#${request.toCaisse}> (ID: ${request.transferId})`,
		},
		process.env.SLACK_BOT_TOKEN,
		context
	);
}
// Notify user about transfer request
async function notifyUserTransfer(request, userId, context) {
	console.log("** notifyUserTransfer");

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: userId,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: "🔀 Demande de transfert soumise",
						emoji: true,
					},
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*ID:*\n${request.transferId}`,
						},
						{
							type: "mrkdwn",
							text: `*Montant:*\n${request.amount} ${request.currency}`,
						},
					],
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*De:*\n<#${request.fromCaisse}>`,
						},
						{
							type: "mrkdwn",
							text: `*Vers:*\n<#${request.toCaisse}>`,
						},
					],
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*Motif:*\n${request.motif}`,
						},
						{
							type: "mrkdwn",
							text: `*Statut:*\n${request.status}`,
						},
					],
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: "✅ Votre demande de transfert a été soumise. Vous serez notifié lorsqu'elle sera traitée.",
						},
					],
				},
			],
		},
		process.env.SLACK_BOT_TOKEN,
		context
	);
}
module.exports = {
	notifyAdminTransfer,
	notifyUserTransfer,
};
