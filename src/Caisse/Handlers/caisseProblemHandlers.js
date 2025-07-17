const { Caisse } = require("../../Database/dbModels/Caisse.js");
const {
	postSlackMessage,
	createSlackResponse,
	postSlackMessageWithRetry,
	postSlackMessage2,
} = require("../../Common/slackUtils");

const {
	generateFundingDetailsBlocks,
} = require("./caisseFundingRequestHandlers");
const { fetchEntity } = require("../../Common/utils");
const { Order } = require("../../Database/dbModels/Order.js");
const PaymentRequest = require("../../Database/dbModels/PaymentRequest.js");
const {
	getPaymentBlocks,
} = require("../../Order/Payment/paymentNotifications.js");
const { notifyTechSlack } = require("../../Common/notifyProblem.js");

function getProblemTypeText(problemType) {
	console.log("** getProblemTypeText");
	const types = {
		wrong_amount: "Montant incorrect",
		wrong_payment_mode: "Mode de paiement incorrect",
		wrong_proof: "Justificatif manquant ou incorrect",
		wrong_bank_details: "Détails bancaires incorrects",
		other: "Autre problème",
	};
	return types[problemType] || problemType;
}

async function handleFundProblemModal(
	payload,
	context,
	messageTs,
	callback_id
) {
	const { requestId, caisseType } = JSON.parse(payload.actions[0].value);
	console.log("requestId mmmmmm2", requestId);
	console.log("caisseType mmmmmm2", caisseType);
	entity = await Caisse.findOne({
		type: caisseType, // Match by caisseType
		"fundingRequests.requestId": requestId, // Match by requestId within fundingRequests
	});

	if (!entity) {
		context.log(`Caisse not found for request ${requestId}`);
		return {
			response_action: "errors",
			errors: {
				_error: `Caisse not found for request ${requestId}`,
			},
		};
	}

	request = entity.fundingRequests.find((r) => r.requestId === requestId);

	if (!request) {
		context.log(`Request ${requestId} not found in caisse`);
		return {
			response_action: "errors",
			errors: {
				_error: `Request ${requestId} not found in caisse`,
			},
		};
	}

	// Check for both "Validé" and "Rejeté" status
	if (request.status === "Validé") {
		context.log(`Funding blocked for request ${requestId} - already validated`);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
				user: payload.user.id,
				text: `🚫 La demande a été finalisée`,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		return {};
	}

	// Add check for rejected status
	if (request.status === "Rejeté") {
		context.log(`Funding blocked for request ${requestId} - already rejected`);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
				user: payload.user.id,
				text: `🚫 La demande a déjà été rejetée${
					request.rejectionReason ? ` (Raison: ${request.rejectionReason})` : ""
				}`,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		return {};
	}

	// Only allow problem reporting for requests with status "En attente" or "Pré-approuvé"
	if (
		!["En attente", "Pré-approuvé", "Détails fournis"].includes(request.status)
	) {
		context.log(
			`Funding blocked for request ${requestId} - invalid status: ${request.status}`
		);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
				user: payload.user.id,
				text: `🚫 Impossible de signaler un problème pour une demande avec le statut: ${request.status}`,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		return {};
	}

	// Now open the modal for fund problem reporting
	const view = {
		type: "modal",
		callback_id: callback_id,
		private_metadata: JSON.stringify({
			requestId: requestId,
			caisseType: caisseType,
			channelId: payload.channel.id,
			userId: payload.user.username,
			messageTs: messageTs,
		}),
		title: {
			type: "plain_text",
			text: "Signaler un problème",
			emoji: true,
		},
		submit: {
			type: "plain_text",
			text: "Envoyer",
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
					text: `*Signalement d'un problème pour ${requestId}*`,
				},
			},
			{
				type: "divider",
			},
			{
				type: "input",
				block_id: "problem_type",
				element: {
					type: "static_select",
					action_id: "select_problem_type",
					options: [
						{
							text: {
								type: "plain_text",
								text: "Mode de paiement incorrect",
							},
							value: "wrong_payment_mode",
						},
						{
							text: {
								type: "plain_text",
								text: "Justificatif manquant ou incorrect",
							},
							value: "wrong_proof",
						},
						{
							text: {
								type: "plain_text",
								text: "Détails bancaires incorrects",
							},
							value: "wrong_bank_details",
						},
						{
							text: {
								type: "plain_text",
								text: "Autre problème",
							},
							value: "other",
						},
					],
				},
				label: {
					type: "plain_text",
					text: "Type de problème",
					emoji: true,
				},
			},
			{
				type: "input",
				block_id: "problem_description",
				element: {
					type: "plain_text_input",
					action_id: "input_problem_description",
					multiline: true,
				},
				label: {
					type: "plain_text",
					text: "Description du problème",
					emoji: true,
				},
			},
		],
	};

	const response = await postSlackMessage2(
		"https://slack.com/api/views.open",
		{ trigger_id: payload.trigger_id, view },
		process.env.SLACK_BOT_TOKEN
	);
	if (!response.data.ok) {
		throw new Error(`Slack API error: ${response.data.error}`);
	}
	context.log(`Problem report modal opened for ${requestId}`);
	return { response_action: "update" };
}

//* 10 report_fund_problem

//* 11 fund_problem_submission*
async function handleFundProblemSubmission(payload, context) {
	console.log("** handleFundProblemSubmission");
	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		return await handleProblemSubmission(payload, context);
	});
}
//* 12 fund_problem_submission*
async function handleProblemSubmission(payload, context) {
	console.log("** handleProblemSubmission");
	const metadata = JSON.parse(payload.view.private_metadata);
	const requestId = metadata.requestId;
	const channelId = process.env.SLACK_FINANCE_CHANNEL_ID;
	const messageTs = metadata.messageTs;
	const caisseType = metadata.caisseType;
	console.log("requestId", requestId);
	console.log("caisseType", caisseType);

	const userId = payload.user.id;

	const formData = payload.view.state.values;
	let problemType =
		formData.problem_type.select_problem_type.selected_option.value;
	const problemDescription =
		formData.problem_description.input_problem_description.value;
	console.log("problemType", problemType);
	problemType = getProblemTypeText(problemType);
	console.log("problemType", problemType);

	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	const request = caisse.fundingRequests[requestIndex];

	// Check if the request is already approved
	// if (request.status === "Validé") {
	// 	await postSlackMessageWithRetry(
	// 		"https://slack.com/api/chat.postEphemeral",
	// 		{
	// 			channel: userId,
	// 			user: userId,
	// 			text: "Impossible de signaler un problème : la demande a déjà été approuvée.",
	// 		},
	// 		process.env.SLACK_BOT_TOKEN
	// 	);
	// 	return createSlackResponse(200, "");
	// }

	// Store the problem report
	request.issues = request.issues || [];
	request.issues.push({
		type: problemType,
		description: problemDescription,
		reportedBy: userId,
		reportedAt: new Date(),
	});

	request.workflow.history.push({
		stage: "problem_reported",
		timestamp: new Date(),
		actor: userId,
		details: `Problème signalé: ${problemType} - ${problemDescription}`,
	});

	await caisse.save();
	console.log("request1", request);
	console.log("request.paymentDetails1", request.paymentDetails);
	let chequeDetailsText = "";
	console.log("request1", request);
	if (
		request.paymentDetails.method === "cheque" &&
		request.paymentDetails.cheque
	) {
		// Send notification to admin
		chequeDetailsText = request.paymentDetails?.cheque
			? `\n• Numéro: ${request.paymentDetails.cheque.number}\n• Banque: ${request.paymentDetails.cheque.bank}\n• Date: ${request.paymentDetails.cheque.date}\n• Ordre: ${request.paymentDetails.cheque.order}`
			: "";
	}
	const block = generateFundingDetailsBlocks(
		request,
		request.paymentDetails.method,
		request.paymentDetails.notes,
		request.paymentDetails,
		userId,
		caisse.type
	);
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_FINANCE_CHANNEL_ID,
			text: `✅ Problème signalé sur la demande de fonds ${requestId}`,
		},
		process.env.SLACK_BOT_TOKEN
	);
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: Problème Signalé sur Demande de fonds: ${requestId}`,
						emoji: true,
					},
				},
				...block,
				// {
				//   type: "section",
				//   fields: [
				//     { type: "mrkdwn", text: `*ID:*\n${requestId}` },
				//     {
				//       type: "mrkdwn",
				//       text: `*Montant:*\n${request.amount} ${request.currency}`,
				//     },
				//     { type: "mrkdwn", text: `*Motif:*\n${request.reason}` },
				//     {
				//       type: "mrkdwn",
				//       text: `*Demandeur:*\n${
				//         request.submitterName || request.submittedBy
				//       }`,
				//     },
				//     {
				//       type: "mrkdwn",
				//       text: `*Méthode:*\n${getPaymentMethodText(
				//         request.paymentDetails.method
				//       )}\n${chequeDetailsText}`,
				//     },
				//     {
				//       type: "mrkdwn",
				//       text: `*Notes:*\n${request.paymentDetails.notes || "Aucune"}`,
				//     },
				//     {
				//       type: "mrkdwn",
				//       text: `*Détails fournis par:*\n<@${request.paymentDetails.filledByName}>`,
				//     },
				//   ],
				// },
				{
					type: "divider",
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*Problème*: ${problemType} `,
						},
						{
							type: "mrkdwn",
							text: `*Description*: ${problemDescription}`,
						},
						{
							type: "mrkdwn",
							text: `*Signalé par:* <@${userId}>`,
						},
					],
				},

				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: {
								type: "plain_text",
								text: "Corriger les détails",
								emoji: true,
							},
							style: "primary",
							value: JSON.stringify({ requestId, channelId, messageTs }),
							action_id: "correct_funding_details",
						},
					],
				},
			],
			text: `Problème signalé sur demande ${requestId}`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, { response_action: "clear" });
}
//* ? payment_problem_submission
async function handlePaymentProblemSubmission(payload, context) {
	console.log("* ? payment_problem_submission");
	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};
	console.log("mmmm");

	// Process in background
	setImmediate(async () => {
		try {
			console.log("===+ 4 handlePaymentProblemSubmission");
			const formData = payload.view.state.values;
			const metadata = JSON.parse(payload.view.private_metadata);
			console.log("===+ metadata", metadata);
			console.log("===+ payload", payload);
			const entityId = metadata.entityId;
			const selectedCaisseId = metadata.selectedCaisseId;

			let targetChannelId = process.env.SLACK_FINANCE_CHANNEL_ID;

			console.log("::== Selected caisse ID: 2", selectedCaisseId);

			// Add null check and better error handling
			if (selectedCaisseId) {
				try {
					const selectedCaisse = await Caisse.findById(selectedCaisseId);
					if (selectedCaisse && selectedCaisse.channelId) {
						targetChannelId = selectedCaisse.channelId;
						console.log("::== targetChannelId", targetChannelId);
					} else {
						console.log(
							"::== selectedCaisse not found or has no channelId, using default"
						);
						console.log("::== using default targetChannelId", targetChannelId);
					}
				} catch (error) {
					await notifyTechSlack(error);

					console.log("::== Error fetching caisse:", error.message);
					console.log("::== using default targetChannelId", targetChannelId);
				}
			} else {
				console.log("::== selectedCaisseId is null/undefined, using default");
				console.log("::== using default targetChannelId", targetChannelId);
			}
			console.log("mmmm &");

			const paymentIndex = metadata.paymentIndex;
			console.log("m== Payment index:", paymentIndex);
			// Extract problem details
			const problemType =
				formData.problem_type.select_problem_type.selected_option.value;
			console.log("m== Problem type:", problemType);
			const problemDescription =
				formData.problem_description.input_problem_description.value;
			console.log("m== Problem description:", problemDescription);
			// Fetch the entity
			const entity = await fetchEntity(entityId, context);
			if (!entity) {
				throw new Error(`Entity ${entityId} not found`);
			}
			console.log("entity111", entity);
			console.log("entity111", entityId);
			if (entityId.startsWith("CMD/")) {
				const updateResult = await Order.updateOne(
					{ id_commande: entityId },
					{
						$set: {
							blockPayment: true,
						},
					}
				);
				console.log(`Update result: ${JSON.stringify(updateResult)}`);
				console.log("mmmm dd");

				console.log("mmmm ddmm");
			} else if (entityId.startsWith("PAY/")) {
				await PaymentRequest.findOneAndUpdate(
					{ id_paiement: entityId },
					{
						$set: {
							blockPayment: true,
						},
					}
				);
			}
			console.log("mmmm aa");

			// Get payment data
			const paymentData = entity.payments[paymentIndex];

			// Create blocks for admin notification
			const blocks = [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `⚠️ Problème de paiement signalé: ${entityId}`,
						emoji: true,
					},
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*ID:*\n${entityId}`,
						},
						{
							type: "mrkdwn",
							text: `*Signalé par:*\n<@${payload.user.id}>`,
						},
					],
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*Type de problème:*\n${getProblemTypeText(problemType)}`,
						},
						{
							type: "mrkdwn",
							text: `*Date du signalement:*\n${new Date().toLocaleString(
								"fr-FR",
								{
									weekday: "long",
									year: "numeric",
									month: "long",
									day: "numeric",
									hour: "2-digit",
									minute: "2-digit",
									timeZoneName: "short",
								}
							)}
            `,
						},
					],
				},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `*Description du problème:*\n${problemDescription}`,
					},
				},
				{
					type: "divider",
				},
			];

			// Add payment details to blocks
			const paymentBlocks = await getPaymentBlocks(
				entity,
				{
					title: paymentData.paymentTitle || paymentData.title,
					mode: paymentData.paymentMode || paymentData.mode,
					amountPaid: paymentData.amountPaid,
					date: paymentData.dateSubmitted || paymentData.date,
					url: paymentData.paymentUrl || paymentData.url,
					proofs: paymentData.paymentProofs || paymentData.proofs || [],

					details: paymentData.details,
				},
				entity.remainingAmount,
				entity.paymentStatus || entity.statut
			);

			// Add all payment details except header (which is blocks[0])
			blocks.push(...paymentBlocks.slice(1));

			// Add modify payment button for admin
			blocks.push({
				type: "actions",
				elements: [
					{
						type: "button",
						text: {
							type: "plain_text",
							text: "Modifier paiement",
							emoji: true,
						},
						style: "primary",
						action_id: "modify_payment",
						value: JSON.stringify({
							entityId: entityId,
							paymentIndex: paymentIndex,
							problemType: problemType,
							problemDescription: problemDescription,
							reporterId: payload.user.id,
							selectedCaisseId: selectedCaisseId,
						}),
					},
				],
			});
			// Send notification to admin channel
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					text: `⚠️ Problème de paiement signalé pour ${entityId}`,
					blocks,
				},
				process.env.SLACK_BOT_TOKEN,
				context
			)
				.then((res) => {
					console.log("Slack admin notification response:", res?.data);
				})
				.catch((err) => {
					console.error("Slack admin notification error:", err);
				});

			// Also notify the finance channel that the problem has been reported
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: targetChannelId,
					text: `✅ Le problème de paiement pour ${entityId} a été signalé aux administrateurs`,
				},
				process.env.SLACK_BOT_TOKEN,
				context
			)
				.then((res) => {
					console.log("Slack finance notification response:", res?.data);
				})
				.catch((err) => {
					console.error("Slack finance notification error:", err);
				});

			return { response_action: "clear" };
		} catch (error) {
			await notifyTechSlack(error);

			context.log(
				`Error handling payment problem submission: ${error.message}`
			);
			return {
				response_action: "errors",
				errors: {
					problem_description: `Une erreur s'est produite: ${error.message}`,
				},
			};
		}
	});
}
module.exports = {
	handleFundProblemSubmission,
	handlePaymentProblemSubmission,
	handleFundProblemModal,
	getProblemTypeText,
};
