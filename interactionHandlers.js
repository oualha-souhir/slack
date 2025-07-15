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

// async function notifyFinancePayment(paymentRequest, context, validatedBy) {
// 	console.log("** notifyFinancePayment");
// 	try {
// 		context.log(
// 			`Sending payment notification to finance channel: ${process.env.SLACK_FINANCE_CHANNEL_ID}`
// 		);
// 		const response = await postSlackMessage(
// 			"https://slack.com/api/chat.postMessage",
// 			{
// 				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
// 				text: `💰 Demande de paiement *${paymentRequest.id_paiement}* validée par admin`,
// 				blocks: getFinancePaymentBlocks(paymentRequest, validatedBy),
// 			},
// 			process.env.SLACK_BOT_TOKEN
// 		);

// 		context.log(`notifyFinancePayment response: ${JSON.stringify(response)}`);
// 		if (!response.ok) {
// 			throw new Error(`Slack API error: ${response.error}`);
// 		}
// 		return response; // Optional, if you need the response elsewhere
// 	} catch (error) {
// 		context.log(`❌ notifyFinancePayment failed: ${error.message}`);
// 		throw error; // Rethrow to handle in caller if needed
// 	}
// }
// Updated notifyFinancePayment function
let caisseTypesCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

async function getCaisseTypes() {
	const now = Date.now();

	// Check if cache is valid
	if (
		caisseTypesCache &&
		cacheTimestamp &&
		now - cacheTimestamp < CACHE_DURATION
	) {
		return caisseTypesCache;
	}

	// Refresh cache
	try {
		const caisses = await Caisse.find({}, "type").exec();
		caisseTypesCache = caisses.map((caisse) => ({
			text: { type: "plain_text", text: caisse.type },
			value: caisse.type,
		}));
		cacheTimestamp = now;
		return caisseTypesCache;
	} catch (error) {
		// Return cached data if available, otherwise throw
		if (caisseTypesCache) {
			console.warn("Database query failed, using cached caisse types");
			return caisseTypesCache;
		}
		throw error;
	}
}


async function notifyFinancePayment(
	paymentRequest,
	context,
	validatedBy,
	selectedCaisseId = null,
	selectedPaymentMethod = null
) {
	console.log("** notifyFinancePayment");
	console.log("== selectedPaymentMethod", selectedPaymentMethod);
	console.log("== selectedCaisseId", selectedCaisseId);
	try {
		const availableCaisses = await Caisse.find({}).exec();

		let targetChannelId = process.env.SLACK_FINANCE_CHANNEL_ID; // default fallback

		const caisseId = await Caisse.findOne({ type: "Centrale" }, "_id").then(
			(caisse) => caisse?._id || null
		);
		// Get caisse types from cache (fast)
		const caisseOptions = await getCaisseTypes();

		if (!caisseOptions || caisseOptions.length === 0) {
			throw new Error("Aucune caisse disponible dans la base de données.");
		}
		console.log("Caisse ID:", caisseId);
		// Determine which channel to send to based on caisse selection
		if (selectedPaymentMethod === "caisse_transfer" && selectedCaisseId) {
			console.log(`Using selected caisse ID: ${selectedCaisseId}`);
			// Admin selected "Transfert Caisse" and chose a specific caisse
			const selectedCaisse = await Caisse.findById(selectedCaisseId);
			console.log(`Selected caisse: ${JSON.stringify(selectedCaisse)}`);
			if (selectedCaisse && selectedCaisse.channelId) {
				console.log(`Selected caisse channel ID: ${selectedCaisse.channelId}`);
				console.log(`Selected caisse type: ${selectedCaisse}`);
				targetChannelId = selectedCaisse.channelId;
				context.log(
					`Using selected caisse channel: ${targetChannelId} for caisse type: ${selectedCaisse.type}`
				);
			} else {
				context.log(
					`⚠️ Selected caisse not found or no channelId, using default finance channel`
				);
			}
		} else {
			// Admin didn't select "Transfert Caisse" or no caisse selected
			// Find the "principal" caisse
			const principalCaisse = await Caisse.findOne({ type: "principal" });
			if (principalCaisse && principalCaisse.channelId) {
				targetChannelId = principalCaisse.channelId;
				context.log(`Using principal caisse channel: ${targetChannelId}`);
			} else {
				context.log(
					`⚠️ Principal caisse not found, using default finance channel`
				);
			}
		}

		context.log(
			`Sending payment notification to finance channel: ${targetChannelId}`
		);
		const finalCaisseId = selectedCaisseId || caisseId;
		console.log("Final Caisse ID:", finalCaisseId);
		const response = await postSlackMessage(
			"https://slack.com/api/chat.postMessage",
			{
				channel: targetChannelId,
				text: `💰 Demande de paiement ${paymentRequest.id_paiement} validée par admin`,
				blocks: getFinancePaymentBlocks(
					paymentRequest,
					validatedBy,
					finalCaisseId,
					availableCaisses
				),
				metadata: {
					selectedCaisseId: finalCaisseId, // Include selectedCaisseId in metadata
				},
			},
			process.env.SLACK_BOT_TOKEN
		);

		context.log(`notifyFinancePayment response: ${JSON.stringify(response)}`);
		await PaymentRequest.findOneAndUpdate(
			{ id_paiement: paymentRequest.id_paiement },
			{
				financeMessage: {
					ts: response.ts,
					createdAt: new Date(),
				},
			}
		);
		if (!response.ok) {
			throw new Error(`Slack API error: ${response.error}`);
		}

		return response;
	} catch (error) {
		context.log(`❌ notifyFinancePayment failed: ${error.message}`);
		throw error;
	}
}

const getFinancePaymentBlocks = (
	paymentRequest,
	validatedBy,
	selectedCaisseId,
	availableCaisses = []
) => [
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
				value: JSON.stringify({
					entityId: paymentRequest.id_paiement,
					selectedCaisseId: selectedCaisseId,
				}),
			},
			// Add transfer button
			{
				type: "static_select",
				placeholder: {
					type: "plain_text",
					text: "Affecter la transaction",
					emoji: true,
				},
				action_id: "transfer_to_caisse",
				options: availableCaisses
					.filter((caisse) => caisse._id.toString() !== selectedCaisseId) // Exclude current caisse
					.map((caisse) => ({
						text: {
							type: "plain_text",
							text: `${caisse.type} (${caisse.channelName})`,
							emoji: true,
						},
						value: JSON.stringify({
							entityId: paymentRequest.id_paiement,
							fromCaisseId: selectedCaisseId,
							toCaisseId: caisse._id.toString(),
							toChannelId: caisse.channelId,
						}),
					})),
			},
			// Add transfer button
			// {
			// 	type: "static_select",
			// 	placeholder: {
			// 		type: "plain_text",
			// 		text: "Transférer vers une autre caisse",
			// 		emoji: true,
			// 	},
			// 	action_id: "transfer_to_caisse",
			// 	options: availableCaisses
			// 		.filter((caisse) => caisse._id.toString() !== selectedCaisseId) // Exclude current caisse
			// 		.map((caisse) => ({
			// 			text: {
			// 				type: "plain_text",
			// 				text: `${caisse.type} (${caisse.channelName})`,
			// 				emoji: true,
			// 			},
			// 			value: JSON.stringify({
			// 				entityId: paymentRequest.id_paiement,
			// 				fromCaisseId: selectedCaisseId,
			// 				toCaisseId: caisse._id.toString(),
			// 				toChannelId: caisse.channelId,
			// 			}),
			// 		})),
			// },
		],
	},
	// Block context supplémentaire demandé
	{
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: `✅ *Validé par:* <@${validatedBy}> le ${new Date(paymentRequest.validatedAt).toLocaleString("fr-FR", {
					timeZone: "Europe/Paris",
					day: "2-digit",
					month: "2-digit",
					year: "numeric",
					hour: "2-digit",
					minute: "2-digit",
				})}`,
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
	console.log("request", request);
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
					await postSlackMessage(
						"https://slack.com/api/chat.postEphemeral",
						{
							channel: process.env.SLACK_ADMIN_ID,
							user: payload.user.id, // Specify the user ID to make the message ephemeral
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
						const caisseType = metadata.caisseType; // Get caisseType from metadata
						console.log("caisseType PP", caisseType);
						console.log("requestId PP", requestId);
						const messageTs = metadata.messageTs;
						const channelId = metadata.channelId;
						const userId = payload.user.username;

						// Find the funding request
						const caisse = await Caisse.findOne({
							type: caisseType, // Match by caisseType
							"fundingRequests.requestId": requestId, // Match by requestId within fundingRequests
						});
						console.log("caisse PP", caisse);
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
							userId,
							caisse.type
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
					const { paymentId, action, message_ts, selectedPaymentMethod } =
						JSON.parse(payload.view.private_metadata);
					const { orderId, channel_id } = JSON.parse(
						payload.view.private_metadata
					);

					const comment =
						payload.view.state.values.validation_data?.comment?.value || "";

					console.log("payload", payload);
					// Get selected caisse from the form submission
					let selectedCaisseId = null;
					if (payload.view.state && payload.view.state.values) {
						// Look for caisse selection in the form state
						for (const blockId in payload.view.state.values) {
							const block = payload.view.state.values[blockId];
							if (
								block.caisse_selection &&
								block.caisse_selection.selected_option
							) {
								selectedCaisseId = block.caisse_selection.selected_option.value;
								break;
							}
						}
					}
					console.log("selectedCaisseId", selectedCaisseId);
					console.log("selectedPaymentMethod", selectedPaymentMethod);
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
									...(comment
										? [
												{
													type: "section",
													text: {
														type: "mrkdwn",
														text: `💬 *Commentaire:*\n> ${comment}`,
													},
												},
										  ]
										: []),
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
						console.log("** accept payment_verif_confirm");
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
											validatedAt: new Date(),
											validatedBy: payload.user.id,
											updatedAt: new Date(),
											isApprovedOnce: true,
										},
										{ new: true }
									);
									return await handleOrderStatus(
										payload,
										comment,
										action,
										context
									);
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
											validatedAt: new Date(),
											validatedBy: payload.user.id,
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
										payload.user.id,
										selectedCaisseId,
										selectedPaymentMethod,
										comment
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
										text: `Background processing error: ${error.message}\nStack: ${error.stack}`,
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

//*
module.exports = { handleSlackInteractions };
