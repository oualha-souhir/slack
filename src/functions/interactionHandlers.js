// src/interactionHandlers.js
const { verifySlackSignature } = require("./utils");
const { createSlackResponse, postSlackMessage } = require("./utils");
const orderService = require("./formService");
const axios = require("axios");

const {
	handleBlockActions,
	validateProforma,
	postSlackMessage2,
} = require("./formService");
const { PaymentRequest, Order, Caisse } = require("./db");
const {
	getPaymentRequestBlocks,
	notifyAdmin,
	getOrderBlocks,
	getProformaBlocks,
	postSlackMessageWithRetry,
} = require("./notificationService");
const { updateSlackMessage1 } = require("./orderStatusService");
const { handleViewSubmission } = require("./orderUtils");
const {
	handleFinanceDetailsSubmission,
	handlePreApproval,
	syncCaisseToExcel,
	generateFundingDetailsBlocks,
} = require("./caisseService");
const {
	handleOrderStatus,
	reopenOrder,
	handleRejectionReasonSubmission,
} = require("./orderStatusService");
let payload;

async function notifyFinancePayment(paymentRequest, context, validatedBy) {
	console.log("** notifyFinancePayment");
	try {
		context.log(
			`Sending payment notification to finance channel: ${process.env.SLACK_FINANCE_CHANNEL_ID}`
		);
		const response = await postSlackMessage(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
				text: `💰 Demande de paiement *${paymentRequest.id_paiement}* validée par admin`,
				blocks: getFinancePaymentBlocks(paymentRequest, validatedBy),
			},
			process.env.SLACK_BOT_TOKEN
		);

		context.log(`notifyFinancePayment response: ${JSON.stringify(response)}`);
		if (!response.ok) {
			throw new Error(`Slack API error: ${response.error}`);
		}
		return response; // Optional, if you need the response elsewhere
	} catch (error) {
		context.log(`❌ notifyFinancePayment failed: ${error.message}`);
		throw error; // Rethrow to handle in caller if needed
	}
}
const getFinancePaymentBlocks = (paymentRequest, validatedBy) => [
	// Titre and validated by in the same section

	...getPaymentRequestBlocks(paymentRequest, validatedBy),
	{ type: "divider" },
	{
		type: "actions",
		elements: [
			{
				type: "button",
				text: {
					type: "plain_text",
					text: "Enregistrer paiement",
					emoji: true,
				},
				style: "primary",
				action_id: "finance_payment_form",
				value: paymentRequest.id_paiement,
			},
		],
	},
	// Block context supplémentaire demandé
	{
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: `✅ *Validé par:* <@${validatedBy}>`,
			},
		],
	},
];
async function handleProformaValidationConfirm(payload, context) {
	console.log("** handleProformaValidationConfirm");
	try {
		console.log("payload1", payload);
		const values = payload.view.state.values;
		const comment = values.validation_data?.comment?.value || "";
		const metadata = JSON.parse(payload.view.private_metadata || "{}");
		const { orderId, proformaIndex } = metadata;

		console.log("Validation1");
		await validateProforma(
			{
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
			},
			context
		);

		return {
			response_action: "clear",
		};
	} catch (error) {
		context.log(
			`Error in handleProformaValidationConfirm: ${error.message}`,
			error.stack
		);
		throw error;
	}
}
async function updateSlackPaymentMessage(messageTs, orderId, status, order) {
	console.log("** updateSlackPaymentMessage");

	console.log("orderId", orderId);
	console.log("status", status);
	console.log("order", order);
	console.log("messageTs", messageTs);

	await postSlackMessage(
		"https://slack.com/api/chat.update",
		{
			channel: process.env.SLACK_ADMIN_ID,
			ts: messageTs,
			text: `Demande *${orderId}* - *${status}*`,
			blocks: [
				...getPaymentRequestBlocks(order, order.demandeurId),
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `✅ Demande *${status}* avec succèes`,
					},
				},

				// {
				//   type: "actions",
				//   elements: [
				//     {
				//       type: "button",
				//       text: { type: "plain_text", text: "Rouvrir" },
				//       action_id: "reopen_order",
				//       value: orderId
				//     }
				//   ]
				// }
			],
		},
		process.env.SLACK_BOT_TOKEN
	);
}

async function updateSlackMessageAcceptance(messageTs, orderId, status, order) {
	console.log("** updateSlackMessageAcceptance");
	await postSlackMessage(
		"https://slack.com/api/chat.update",
		{
			channel: process.env.SLACK_ADMIN_ID,
			ts: messageTs,
			text: `Demande *${orderId}* - *${status}*`,
			blocks: [
				...getOrderBlocks(order),
				...getProformaBlocks(order),

				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `✅ Demande *${status}* avec succèes`,
					},
				},

				// {
				//   type: "actions",
				//   elements: [
				//     {
				//       type: "button",
				//       text: { type: "plain_text", text: "Rouvrir" },
				//       action_id: "reopen_order",
				//       value: orderId
				//     }
				//   ]
				// }
			],
		},
		process.env.SLACK_BOT_TOKEN
	);
}

async function handleSlackInteractions(request, context) {
	console.log("** handleSlackInteractions");
	context.log("🔄 Interaction Slack reçue !");
	context.log("handleSlackInteractions function");

	try {
		const body = await request.text();
		if (!verifySlackSignature(request, body)) {
			return createSlackResponse(401, "Signature invalide");
		}

		const params = new URLSearchParams(body);
		payload = JSON.parse(params.get("payload"));
		context.log(`📥 Payload reçu : ${JSON.stringify(payload)}`);
		switch (payload.type) {
			case "view_submission":
				context.log("** view_submission");
				// In your form submission handler, add logic similar to this:

				// Add a new case for handling the confirmation dialog submission
				if (payload.view.callback_id === "pre_approval_confirmation_submit") {
					console.log("**2 pre_approval_confirmation_submit");
					const processingMessage = await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: process.env.SLACK_ADMIN_ID,
							text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
						},
						process.env.SLACK_BOT_TOKEN
					);
					// Immediate response to close modal
					context.res = {
						status: 200,
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ response_action: "clear" }),
					};

					// Process in background
					setImmediate(async () => {
						await handlePreApproval(payload, context);
						return createSlackResponse(200, "");
						console.log("va1");
					});

					return context.res;
				}
				if (payload.view.callback_id === "final_approval_confirmation_submit") {
					console.log("**5 final_approval_confirmation_submit");
					// console.log("**5 funding_approval_payment");
					console.log("funding_approval_payment");

					// Process in background
					setImmediate(async () => {
						// const requestId = action.value;
						// const userId = payload.user.username;
						// const channelId = payload.channel.id;

						// Parse the private metadata to get request info
						const metadata = JSON.parse(payload.view.private_metadata);
						const requestId = metadata.requestId;
						const messageTs = metadata.messageTs;
						const channelId = metadata.channelId;
						const userId = payload.user.username;

						// Find the funding request
						const caisse = await Caisse.findOne({
							"fundingRequests.requestId": requestId,
						});
						if (!caisse) {
							console.error(`Caisse not found for request ${requestId}`);
							return createSlackResponse(200, "Demande introuvable");
						}

						const requestIndex = caisse.fundingRequests.findIndex(
							(r) => r.requestId === requestId
						);
						if (requestIndex === -1) {
							console.error(`Request ${requestId} not found`);
							return createSlackResponse(200, "Demande introuvable");
						}

						const request = caisse.fundingRequests[requestIndex];

						// Update request for final approval
						request.status = "Validé";
						request.approvedBy = userId;
						request.approvedAt = new Date();
						request.workflow.stage = "approved";
						request.workflow.history.push({
							stage: "approved",
							timestamp: new Date(),
							actor: userId,
							details: "Demande approuvée avec détails de paiement",
						});

						// Update balance and add transaction
						// Update balance for the specific currency
						caisse.balances[request.currency] =
							(caisse.balances[request.currency] || 0) + request.amount;
						caisse.transactions.push({
							type: "Funding",
							amount: request.amount,
							currency: request.currency,
							requestId,
							details: `Approuvé par ${userId} (${request.disbursementType})`,
							timestamp: new Date(),
							paymentMethod: request.disbursementType,
							paymentDetails: request.paymentDetails, // Preserve paymentDetails in transaction
						});

						await caisse.save();

						// Sync to Excel
						try {
							await syncCaisseToExcel(caisse, requestId);
						} catch (error) {
							console.error(`Excel sync failed: ${error.message}`);
						}
						// Generate blocks for Slack message
						const block = generateFundingDetailsBlocks(
							request,
							request.disbursementType,
							request.paymentDetails.notes,
							request.paymentDetails,
							userId
						);
						// Update original message
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.update",
							{
								channel: process.env.SLACK_ADMIN_ID,
								ts: messageTs,
								blocks: [
									{
										type: "header",
										text: {
											type: "plain_text",
											text: `:heavy_dollar_sign: Demande de fonds - Approbation Finale : ${requestId}`,
											emoji: true,
										},
									},
									...block,

									{
										type: "context",
										elements: [
											{
												type: "mrkdwn",
												text: `✅ Approuvée par <@${userId}> le ${new Date().toLocaleDateString()}\n Soldes actuels: XOF: *${
													caisse.balances.XOF
												}*, USD: *${caisse.balances.USD}*, EUR: *${
													caisse.balances.EUR
												}*`,
											},
										],
									},
								],
								text: `Demande ${requestId} approuvée par ${userId}`,
							},
							process.env.SLACK_BOT_TOKEN
						);

						// Notify requester
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: request.submittedByID,
								blocks: [
									{
										type: "header",
										text: {
											type: "plain_text",
											text:
												":heavy_dollar_sign: ✅ Demande de fonds ID: " +
												requestId +
												" - Approuvée" +
												` par <@${userId}> le ${new Date().toLocaleDateString()}\n`,
											emoji: true,
										},
									},
									{
										type: "context",
										elements: [
											{
												type: "mrkdwn",
												text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
											},
										],
									},
								],
							},
							process.env.SLACK_BOT_TOKEN
						);
					});

					return context.res;
				}

				if (payload.view.callback_id === "submit_finance_details") {
					console.log("**4 submit_finance_details");

					// Immediate response to close modal
					context.res = {
						status: 200,
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ response_action: "clear" }),
					};

					// Process in background
					setImmediate(async () => {
						return await handleFinanceDetailsSubmission(payload, context);
					});

					return context.res;
				}
				if (payload.view.callback_id == "proforma_validation_confirm") {
					console.log("va2");

					// Immediate response to close modal
					context.res = {
						status: 200,
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ response_action: "clear" }),
					};

					// Process in background
					setImmediate(async () => {
						try {
							await handleProformaValidationConfirm(payload, context);
						} catch (error) {
							context.log(
								`Background processing error for proforma submission (order: ${orderId}): ${error.message}\nStack: ${error.stack}`
							);
							await postSlackMessage2(
								"https://slack.com/api/chat.postMessage",
								{
									channel: payload.user.id,
									text: `❌ Erreur lors du traitement de la proforma pour la commande ${orderId}. Veuillez contacter le support.`,
								},
								process.env.SLACK_BOT_TOKEN
							);
						}
					});

					return context.res;
				}
				if (payload.view.callback_id === "payment_verif_confirm") {
					const { paymentId, action, message_ts } = JSON.parse(
						payload.view.private_metadata
					);
					const { orderId, channel_id } = JSON.parse(
						payload.view.private_metadata
					);
					console.log("payload", payload);

					let order;
					let status;
					if (paymentId.startsWith("CMD/")) {
						order = await Order.findOne({ id_commande: paymentId });

						if (!order) {
							return createSlackResponse(200, {
								response_type: "ephemeral",
								text: "Order not found.",
							});
						}
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: order.demandeurId,
								blocks: [
									{
										type: "header",
										text: {
											type: "plain_text",
											text:
												":package:  ✅ Commande: " +
												paymentId +
												" - Approuvée" +
												` par <@${
													payload.user.username
												}> le ${new Date().toLocaleDateString()}`,
											emoji: true,
										},
									},
								],
							},
							process.env.SLACK_BOT_TOKEN
						);

						// Check order status
						status = order.statut;

						// Check if the order has already been approved once
						if (order.isApprovedOnce) {
							await postSlackMessage(
								"https://slack.com/api/chat.postEphemeral",
								{
									channel: process.env.SLACK_ADMIN_ID,
									user: payload.user.id,
									text: `❌ Cet demande a déjà été ${status}e`,
								},
								process.env.SLACK_BOT_TOKEN
							);
							return { response_action: "clear" };
						}
					}
					if (paymentId.startsWith("PAY/")) {
						order = await PaymentRequest.findOne({ id_paiement: paymentId });

						if (!order) {
							return createSlackResponse(200, {
								response_type: "ephemeral",
								text: "Order not found.",
							});
						}
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: order.demandeur,
								blocks: [
									{
										type: "header",
										text: {
											type: "plain_text",
											text:
												"✅ Demande de paiement: " +
												paymentId +
												" - Approuvée" +
												` par <@${
													payload.user.username
												}> le ${new Date().toLocaleDateString()}`,
											emoji: true,
										},
									},
								],
							},
							process.env.SLACK_BOT_TOKEN
						);
						// Check order status
						status = order.statut;
						// Check if the order has already been approved once
						if (order.isApprovedOnce) {
							await postSlackMessage(
								"https://slack.com/api/chat.postEphemeral",
								{
									channel: process.env.SLACK_ADMIN_ID,
									user: payload.user.id,
									text: `❌ Cet demande a déjà été ${status}e`,
								},
								process.env.SLACK_BOT_TOKEN
							);
							return { response_action: "clear" };
						}
					}

					// In view_submission handler for payment_verif_confirm
					if (action === "accept") {
						// await postSlackMessage(
						//   "https://slack.com/api/chat.postMessage",
						//   {
						//     channel: process.env.SLACK_ADMIN_ID,
						//     text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
						//   },
						//   process.env.SLACK_BOT_TOKEN
						// );
						// Immediate response to close modal
						context.res = {
							status: 200,
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ response_action: "clear" }),
						};
						// Process in background
						setImmediate(async () => {
							try {
								let paymentRequest;
								// Get paymentId from metadata NOT action.value
								const { paymentId } = JSON.parse(payload.view.private_metadata); // ← CORRECT SOURCE
								if (paymentId.startsWith("CMD/")) {
									console.log("Payment2", paymentId);
									// await notifyAdmin(order, context, false,true,status);
									await updateSlackMessageAcceptance(
										message_ts,
										paymentId,
										"validée",
										order
									);

									paymentRequest = await Order.findOneAndUpdate(
										{ id_commande: paymentId }, // ← Verify field name matches DB
										{
											statut: "Validé",
											autorisation_admin: true,
											updatedAt: new Date(),
											isApprovedOnce: true,
										},
										{ new: true }
									);
									return await handleOrderStatus(payload, action, context);
									// Add validation before using paymentRequest
									if (!paymentRequest) {
										context.log(`❌ order request not found: ${paymentId}`);
										await postSlackMessage2(
											"https://slack.com/api/chat.postEphemeral",
											{
												channel: process.env.SLACK_ADMIN_ID,
												user: payload.user.id,
												text: `⚠️ Demande de paiement ${paymentId} introuvable`,
											},
											process.env.SLACK_BOT_TOKEN
										);

										return { response_action: "clear" };
									}
								} else if (paymentId.startsWith("PAY/")) {
									paymentRequest = await PaymentRequest.findOneAndUpdate(
										{ id_paiement: paymentId }, // ← Verify field name matches DB
										{
											statut: "Validé",
											autorisation_admin: true,
											updatedAt: new Date(),
										},
										{ new: true }
									);
									await updateSlackPaymentMessage(
										message_ts,
										paymentId,
										"validée",
										order
									);
									// Add validation before using paymentRequest
									if (!paymentRequest) {
										context.log(`❌ Payment request not found: ${paymentId}`);
										await postSlackMessage2(
											"https://slack.com/api/chat.postEphemeral",
											{
												channel: process.env.SLACK_ADMIN_ID,
												user: payload.user.id,
												text: `⚠️ Demande de paiement ${paymentId} introuvable`,
											},
											process.env.SLACK_BOT_TOKEN
										);
										return { response_action: "clear" };
									}
									// Update the Slack message to remove buttons
									await updateSlackMessage1(payload, paymentId, "Validé");

									await notifyFinancePayment(
										paymentRequest,
										context,
										payload.user.id
									);
								}
							} catch (error) {
								context.log(
									`Background processing error: ${error.message}\nStack: ${error.stack}`
								);
								await postSlackMessage2(
									"https://slack.com/api/chat.postMessage",
									{
										channel: payload.user.id,
										text: `❌ Erreur lors du traitement de la commande ${paymentId}. Veuillez contacter le support.`,
									},
									process.env.SLACK_BOT_TOKEN
								);
							}
						});
						return context.res;
					}
				}
				// handlePaymentModificationSubmission
				// Handle the rejection reason modal submission
				if (payload.view.callback_id === "rejection_reason_modal") {
					// Immediate response to close modal
					context.res = {
						status: 200,
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ response_action: "clear" }),
					};

					// Process in background
					setImmediate(async () => {
						return await handleRejectionReasonSubmission(payload, context);
					});

					return context.res;
				}
				//  context.log(`PAY2: ${JSON.stringify(payload)}`);
				console.log("payload1", payload);
				const response = await handleViewSubmission(payload, context);
				context.res = {
					status: 200,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(response || {}),
				};
				context.log("Response sent to Slack:", context.res);
				return;
			case "block_actions":

			case "interactive_message":
				context.log("** interactive_message");

				const response1 = await handleBlockActions(payload, context);
				context.log(`Setting context.res: ${JSON.stringify(response1)}`);
				context.res = response1;
				return response1;
			default:
				return createSlackResponse(400, "Type d'interaction non supporté");
		}
	} catch (error) {
		context.log(`❌ Erreur globale: ${error.stack}`);

		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_tech_CHANNEL_ID,
				user: payload.user.id,
				text: `❌ Erreur globale: ${error.stack}`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
}

module.exports = { handleSlackInteractions };
