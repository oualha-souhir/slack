const { notifyTechSlack } = require("../../Common/notifyProblem");
const {
	createSlackResponse,
	postSlackMessage,
	postSlackMessageWithRetry,
} = require("../../Common/slackUtils");

const { processFundingApproval } = require("./caisseApprovalHandlers");

//* 4 reject_fund
async function openRejectionReasonModalFund(payload) {
	console.log("** openRejectionReasonModalFund");
	const { requestId, caisseType } = JSON.parse(payload.actions[0].value);
	console.log("** openRejectionReasonModalFund");
	try {
		await postSlackMessage(
			"https://slack.com/api/views.open",
			{
				trigger_id: payload.trigger_id,
				view: {
					type: "modal",
					callback_id: "reject_funding",

					private_metadata: JSON.stringify({
						requestId: requestId,
						caisseType: caisseType,
						channel_id: payload.channel.id,
						message_ts: payload.message.ts,
					}),
					title: {
						type: "plain_text",
						text: "Motif de rejet",
						emoji: true,
					},
					submit: {
						type: "plain_text",

						text: "Confirmer",
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
								text: `Veuillez indiquer la raison du rejet de la demande *${requestId}*`,
							},
						},
						{
							type: "input",
							block_id: "rejection_reason_block",
							element: {
								type: "plain_text_input",
								action_id: "rejection_reason_input",
								multiline: true,
							},
							label: {
								type: "plain_text",
								text: "Motif du rejet",
								emoji: true,
							},
						},
					],
				},
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, "");
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error opening rejection modal:", error);
		return createSlackResponse(500, "Error opening rejection modal");
	}
}
//* 5 reject_funding*
async function handleRejectFunding(
	payload,
	context,
	userName,
	newPrivateMetadata
) {
	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		console.log("** reject_funding");
		console.log("payload.view", payload.view);

		const privateMetadata = JSON.parse(payload.view.private_metadata);
		const requestId = privateMetadata.requestId;
		const caisseType = privateMetadata.caisseType;
		console.log("caisseType", caisseType);
		console.log("parsed requestId", requestId); // entityId: requestId
		const metadata = JSON.parse(newPrivateMetadata);

		const rejectionReason =
			metadata.formData.rejection_reason_block.rejection_reason_input.value;

		console.log(rejectionReason);
		console.log("ùù1 requestId", requestId);

		await processFundingApproval(
			requestId,
			caisseType,
			"reject",
			rejectionReason,
			privateMetadata.message_ts,
			privateMetadata.channel_id,
			userName
		);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: payload.user.id,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text:
								":heavy_dollar_sign: ❌ Demande de fonds ID: " +
								requestId +
								" - Rejetée" +
								` par <@${userName}> le ${new Date().toLocaleDateString()}, Raison: ${rejectionReason}`,
							emoji: true,
						},
					},
				],
			},
			process.env.SLACK_BOT_TOKEN
		);
		return createSlackResponse(200, "");
	});

	return context.res;
}

module.exports = {
	openRejectionReasonModalFund,
	handleRejectFunding,
};
