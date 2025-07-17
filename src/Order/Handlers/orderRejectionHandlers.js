const { notifyTechSlack } = require("../../Common/notifyProblem");
const {
	postSlackMessage,
	postSlackMessageWithRetry,
	createSlackResponse,
} = require("../../Common/slackUtils");
const { fetchEntity } = require("../../Common/utils");
const { Order } = require("../../Database/dbModels/Order");
const { getPaymentRequestBlocks } = require("../../Payment Request/Handlers/paymentRequestForm");
const { getOrderBlocks, getProformaBlocks } = require("./orderMessageBlocks");

//* ??
async function updateSlackMessageWithReason1(
	user,
	channelId,
	messageTs,
	orderId,
	status,
	reason,
	order
) {
	console.log("** updateSlackMessageWithReason1");
	await postSlackMessage(
		"https://slack.com/api/chat.update",
		{
			channel: channelId,
			ts: messageTs,
			text: `Commande *${orderId}* - *${status}*`,
			blocks: [
				...getPaymentRequestBlocks(order),
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `❌ - *REJETÉE* par <@${user}> le ${new Date().toLocaleString(
							"fr-FR"
						)}`,
					},
				},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Motif de rejet: ${reason}`,
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
async function updateSlackMessageWithReason(
	user,
	channelId,
	messageTs,
	orderId,
	status,
	reason,
	order
) {
	console.log("** updateSlackMessageWithReason");
	await postSlackMessage(
		"https://slack.com/api/chat.update",
		{
			channel: channelId,
			ts: messageTs,
			text: `Commande *${orderId}* - *${status}*`,
			blocks: [
				...getOrderBlocks(order),
				...getProformaBlocks(order),
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `❌ - *REJETÉE par* <@${user}> le ${new Date().toLocaleString(
							"fr-FR"
						)}`,
					},
				},

				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Motif de rejet: ${reason}`,
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
//* ? rejection_reason_modal
async function RejectionReasonSubmission(payload, context) {
	// console.log("//* ? rejection_reason_modal");
	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		try {
			const { entityId, channel_id, message_ts } = JSON.parse(
				payload.view.private_metadata
			);
			console.log("payload5", payload);
			console.log("message_ts", message_ts);

			const rejectionReason =
				payload.view.state.values.rejection_reason_block.rejection_reason_input
					.value;
			if (entityId.startsWith("CMD/")) {
				const order = await Order.findOne({ id_commande: entityId });
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
										":package:  ❌ Commande: " +
										entityId +
										" - Rejetée" +
										` par <@${
											payload.user.username
										}> le ${new Date().toLocaleDateString()}, Raison: ${rejectionReason}`,
									emoji: true,
								},
							},
						],
					},
					process.env.SLACK_BOT_TOKEN
				);
				// Update order with rejection status and reason
				const updatedOrder = await Order.findOneAndUpdate(
					{ id_commande: entityId },
					{
						$set: {
							statut: "Rejeté",
							rejection_reason: rejectionReason,
							validatedBy: payload.user.id,
							autorisation_admin: false,
						},
					},
					{ new: true }
				);

				if (!updatedOrder) {
					context.log("Commande non trouvée:", entityId);
					return createSlackResponse(404, "Commande non trouvée");
				}

				// Update the original message
				await updateSlackMessageWithReason(
					payload.user.username,
					channel_id,
					message_ts,
					entityId,
					"Rejeté",
					rejectionReason,
					updatedOrder
				);
				context.log("Message Slack mis à jour avec succès");

				// Notify the requester with rejection reason
				await notifyRequesterWithReason(updatedOrder, rejectionReason);

				return { response_action: "clear" };
			}
			// For payment requests (PAY/xxx)
			else if (entityId.startsWith("PAY/")) {
				await PaymentRequest.findOne({ id_paiement: entityId });
				// Update order with rejection status and reason
				const updatedPAY = await PaymentRequest.findOneAndUpdate(
					{ id_paiement: entityId },
					{
						$set: {
							statut: "Rejeté",
							rejectedById: payload.user.id,
							rejectedByName: payload.user.username,
							rejection_reason: rejectionReason,
							autorisation_admin: false,
						},
					},
					{ new: true }
				);

				if (!updatedPAY) {
					context.log("Commande non trouvée:", entityId);
					return createSlackResponse(404, "Commande non trouvée");
				}

				// Update the original message
				await updateSlackMessageWithReason1(
					payload.user.username,
					channel_id,
					message_ts,
					entityId,
					"Rejeté",
					rejectionReason,
					updatedPAY
				);
				context.log("Message Slack mis à jour avec succès");

				// Notify the requester with rejection reason
				await notifyRequesterWithReason(updatedPAY, rejectionReason);

				return { response_action: "clear" };
			}
			// Invalid entity ID format
			else {
				context.log(`Invalid entity ID format: ${entityId}`);
				return null;
			}
		} catch (error) {
			await notifyTechSlack(error);

			context.log(
				"Erreur lors de la mise à jour du message Slack:",
				error.message
			);

			console.error("Error handling rejection reason submission:", error);
			return createSlackResponse(500, "Error handling rejection");
		}
	});

	return context.res;
}
async function updateSlackMessage(payload, orderId, status, reason = null) {
	console.log("** updateSlackMessage");
	const blocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Commande ID:* ${orderId}\n*Statut:* *${status}*${
					reason ? `Motif de rejet: ${reason}` : ""
				}`,
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
	];

	// await postSlackMessage(
	//   "https://slack.com/api/chat.update",
	//   {
	//     channel: payload.channel.id,
	//     ts: payload.message.ts,
	//     text: `Commande *${orderId}* - *${status}*`,
	//     blocks
	//   },
	//   process.env.SLACK_BOT_TOKEN
	// );
}
async function notifyRequesterWithReason(order, rejectionReason) {
	console.log("** notifyRequesterWithReason");
	console.log("order", order);
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
							"❌ Demande de paiement: " +
							order.id_paiement +
							" - Rejetée" +
							` par <@${
								order.rejectedByName
							}> le ${new Date().toLocaleDateString()}, Raison: ${rejectionReason}`,
						emoji: true,
					},
				},
			],
		},
		process.env.SLACK_BOT_TOKEN
	);
	// await postSlackMessage(
	//   "https://slack.com/api/chat.postMessage",
	//   {
	//     channel: order.demandeur,
	//     text: `Bonjour <@${order.demandeur}>, votre demande a été *rejetée* par l'administrateur.`,
	//     blocks: [
	//       {
	//         type: "section",
	//         text: {
	//           type: "mrkdwn",
	//           text: `Bonjour <@${order.demandeur}>, votre demande a été *rejetée* par l'administrateur.`,
	//         },
	//       },
	//       {
	//         type: "section",
	//         text: {
	//           type: "mrkdwn",
	//           text: `*Motif du rejet:*\n${rejectionReason}`,
	//         },
	//       },
	//     ],
	//   },
	//   process.env.SLACK_BOT_TOKEN
	// );
}
async function openRejectionReasonModal(payload, action, context) {
	console.log("paymentId", action.value);
	console.log("action&", action);

	const entity2 = await fetchEntity(action.value, context);
	if (!entity2) {
		context.log(`Entity ${action.value} not found`);
		return {
			response_action: "errors",
			errors: {
				_error: `Entity ${action.value} not found`,
			},
		};
	}

	// Check order status
	const status1 = entity2.statut;
	console.log("status1", status1);
	// Check if the order has already been approved once
	if (entity2.isApprovedOnce) {
		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id,
				text: `❌ Cet demande a déjà été ${status1}e.`,
			},
			process.env.SLACK_BOT_TOKEN
		);
		return { response_action: "clear" };
	}

	console.log("Rejecting order", action.value);
	orderId = action.value;
	console.log("** openRejectionReasonModal");
	try {
		await postSlackMessage(
			"https://slack.com/api/views.open",
			{
				trigger_id: payload.trigger_id,
				view: {
					type: "modal",
					callback_id: "rejection_reason_modal",
					private_metadata: JSON.stringify({
						entityId: orderId,
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
								text: `Veuillez indiquer la raison du rejet de la commande *${orderId}*`,
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
//* ??
async function executeOrderDeletion(payload, context) {
	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		console.log("** executeOrderDeletion");
		const metadata = JSON.parse(payload.view.private_metadata);
		const values = payload.view.state.values;
		console.log("metadata&", metadata);
		console.log("$$ values", values);
		// Extract reason if provided
		let reason = null;
		if (
			values.delete_reason_block &&
			values.delete_reason_block.delete_reason_input &&
			values.delete_reason_block.delete_reason_input.value
		) {
			reason = values.delete_reason_block.delete_reason_input.value;
		}
		console.log("$$ payload", payload);
		console.log("$$ metadata", metadata);

		try {
			context.log("Executing order deletion");
			let orderId;
			let order;
			// Parse metadata if it's a string
			const data =
				typeof metadata === "string" ? JSON.parse(metadata) : metadata;
			const { proformaIndex, messageTs, channelId } = data;
			if (messageTs) {
				order = await Order.findOne({
					"slackMessages.ts": messageTs,
					"slackMessages.channel": channelId,
				});
				console.log("$$ order", order);
				// If not found, try by the proforma validation info from the message
				if (!order) {
					// Get the user ID from the message text
					const validatorId = payload.user
						? payload.user.id
						: payload.user_id || "unknown";

					// Find orders with validated proformas by this user
					const orders = await Order.find({
						"proformas.validated": true,
						"proformas.validatedBy": validatorId,
					}).sort({ "proformas.validatedAt": -1 });

					if (orders.length > 0) {
						order = orders[0];
					}
				}

				if (!order) {
					throw new Error("Impossible de trouver la commande associée");
				}

				orderId = order.id_commande;
			} else {
				order = await Order.findOne({
					id_commande: metadata.orderId,
				});
				console.log("$$ order", order);
				orderId = metadata.orderId;
				console.log("$$ orderId", orderId);
				console.log("$$ payload.user", payload.user);
			}
			// Look up the order based on message timestamp
			// First try by slack_message_ts if you store it
			// let order = await Order.findOne({ slack_message_ts: messageTs });

			// Update order using findOneAndUpdate
			const updateData = {
				statut: "Supprimée",
				deleted: true,
				deletedAt: new Date(),
				deletedBy: payload.user
					? payload.user.id
					: payload.user_id || "unknown",
				deletedByName: payload.user
					? payload.user.username
					: payload.username || "unknown",
				...(reason && { deletionReason: reason }), // Conditionally add deletionReason
			};

			const updatedOrder = await Order.findOneAndUpdate(
				{ _id: order._id },
				{ $set: updateData },
				{ new: true } // Return the updated document
			);

			// Update the original message
			if (channelId && messageTs) {
				await postSlackMessage(
					"https://slack.com/api/chat.update",
					{
						channel: channelId,
						ts: messageTs,
						text: `❌ *11SUPPRIMÉE* - Commande #${orderId}`,
						// blocks: [
						//   {
						//     type: "section",
						//     text: {
						//       type: "mrkdwn",
						//       text:
						//          `❌ *22SUPPRIMÉE* par <@${payload.user ? payload.user.username : payload.user_id || "unknown"}> le ${new Date().toLocaleString(
						//               "fr-FR"
						//             )}\n*  Raison:* ${reason || "Non spécifiée"}`
						//     },
						//   },
						// {
						//   type: "section",
						//   text: {
						//     type: "mrkdwn",
						//     text: `❌ *SUPPRIMÉE* - Commande #${orderId}`,
						//   },
						// },
						// {
						//   type: "context",
						//   elements: [
						//     {
						//       type: "mrkdwn",
						//       text:
						//         `Supprimée par <@${
						//           order.deletedBy
						//         }> le ${new Date().toLocaleString("fr-FR")}` +
						//         (reason ? `\nRaison: ${reason}` : ""),
						//     },
						//   ],
						// },
						// ],
						blocks: [
							{
								type: "header",
								text: {
									type: "plain_text",
									text:
										":package:  ❌ Commande: " +
										orderId +
										" - Supprimée" +
										` par <@${
											payload.user.username
										}> le ${new Date().toLocaleDateString()}, Raison: ` +
										(reason ? ` ${reason}` : " Non spécifiée"),
									emoji: true,
								},
							},
						],
					},
					process.env.SLACK_BOT_TOKEN
				);
			}

			// Notify admin channel
			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					// blocks: [
					//   {
					//     type: "header",
					//     text: {
					//       type: "plain_text",
					//       text:
					//         ":package:  ❌ Commande: " +
					//         orderId +
					//         " - Supprimée" +
					//         ` par <@${payload.user.username}> le ${new Date().toLocaleDateString()} `+(reason ? `\nRaison: ${reason}` : "Non spécifiée"),
					//       emoji: true,
					//     },
					//   },
					// ],
				},
				process.env.SLACK_BOT_TOKEN
			);
			const channels = [
				process.env.SLACK_FINANCE_CHANNEL_ID,
				order.demandeurId, // Assuming this is a Slack user ID for DM
				process.env.SLACK_ACHAT_CHANNEL_ID,
			];
			console.log("Channels to notify:", channels);
			for (const Channel of channels) {
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: Channel,
						blocks: [
							{
								type: "header",
								text: {
									type: "plain_text",
									text:
										":package:  ❌ Commande: " +
										orderId +
										" - Supprimée" +
										` par <@${
											payload.user.username
										}> le ${new Date().toLocaleDateString()}, Raison:` +
										(reason ? ` ${reason}` : " Non spécifiée"),
									emoji: true,
								},
							},
						],
					},
					process.env.SLACK_BOT_TOKEN
				);
			}
			// ...existing code...
			// ...existing code...
			const messageFields = ["achatMessage", "financeMessage", "adminMessage"];
			for (const field of messageFields) {
				const msg = order[field];
				if (msg && msg.ts && msg.ts.length > 0) {
					try {
						await postSlackMessage(
							"https://slack.com/api/chat.update",
							{
								channel:
									process.env[
										`SLACK_${field
											.replace("Message", "")
											.toUpperCase()}_CHANNEL_ID`
									] || msg.channel,
								ts: msg.ts,
								text: `❌ *SUPPRIMÉE* - Commande #${orderId}`,
								blocks: [
									{
										type: "header",
										text: {
											type: "plain_text",
											text:
												":package:  ❌ Commande: " +
												orderId +
												" - Supprimée" +
												` par <@${
													payload.user.username
												}> le ${new Date().toLocaleDateString()}, Raison:` +
												(reason ? ` ${reason}` : " Non spécifiée"),
											emoji: true,
										},
									},
								],
							},
							process.env.SLACK_BOT_TOKEN
						);
					} catch (err) {
						await notifyTechSlack(err);

						console.error(`Failed to update ${field}:`, err);
					}
				}
			}
			// ...existing code...
			// ...existing code...
			const result = {
				success: true,
				message: `:white_check_mark: Commande #${orderId} supprimée avec succès.`,
			};
			if (result.success) {
				return createSlackResponse(200);
			} else {
				return createSlackResponse(200, {
					response_action: "errors",
					errors: {
						delete_reason_block: result.message,
					},
				});
			}
		} catch (error) {
			await notifyTechSlack(error);

			context.log(`Error executing deletion: ${error.message}`, error.stack);
			return {
				success: false,
				message: `❌ Erreur lors de la suppression: ${error.message}`,
			};
		}
	});
}
//* ??
async function handleDeleteOrderConfirmed(payload, context) {
	console.log("** handleDeleteOrderConfirmed");
	try {
		const value = payload.actions[0].value;
		let metadata;

		try {
			metadata = JSON.parse(value);
		} catch (parseError) {
			await notifyTechSlack(parseError);

			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Erreur: Format de données invalide.",
			});
		}
		console.log("metadata", metadata);
		const result = await executeOrderDeletion(payload, metadata, null, context);

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: result.message,
		});
	} catch (error) {
		await notifyTechSlack(error);

		context.log(
			`Error in handleDeleteOrderConfirmed: ${error.message}`,
			error.stack
		);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Erreur: ${error.message}`,
		});
	}
}
//* ??
async function handleDeleteOrder(payload, context) {
	console.log("** handleDeleteOrder");
	try {
		context.log("Starting handleDeleteOrder function");

		// Extract the proforma index from the value
		const valueString = payload.actions[0].value;
		const proformaIndex = parseInt(valueString.split("_")[1]);

		// Get message info to help identify related data
		const messageTs = payload.container.message_ts;
		const channelId = payload.channel.id;

		// First, try to show a confirmation dialog
		try {
			context.log("Opening confirmation dialog");
			const dialogResponse = await postSlackMessage(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: {
						type: "modal",
						callback_id: "delete_order_confirmation",
						title: {
							type: "plain_text",
							text: "Confirmation",
						},
						submit: {
							type: "plain_text",
							text: "Supprimer",
						},
						close: {
							type: "plain_text",
							text: "Annuler",
						},
						private_metadata: JSON.stringify({
							proformaIndex,
							messageTs,
							channelId,
						}),
						blocks: [
							{
								type: "section",
								text: {
									type: "mrkdwn",
									text: `:warning: *Êtes-vous sûr de vouloir supprimer cette commande ?*\n\nCette action est irréversible.`,
								},
							},
							{
								type: "input",
								block_id: "delete_reason_block",
								optional: true,
								label: {
									type: "plain_text",
									text: "Raison de la suppression",
								},
								element: {
									type: "plain_text_input",
									action_id: "delete_reason_input",
								},
							},
						],
					},
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!dialogResponse.ok) {
				context.log(`Error opening modal: ${dialogResponse.error}`);
				throw new Error(
					`Unable to open confirmation dialog: ${dialogResponse.error}`
				);
			}

			// Return empty response as the modal is now handling the interaction
			return createSlackResponse(200);
		} catch (dialogError) {
			await notifyTechSlack(dialogError);

			// If modal fails, fall back to ephemeral message with buttons
			context.log(`Dialog error: ${dialogError.message}, using fallback`);

			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "Voulez-vous vraiment supprimer cette commande ?",
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `:warning: *Confirmation de suppression*\n\nÊtes-vous sûr de vouloir supprimer cette commande ?`,
						},
					},
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: {
									type: "plain_text",
									text: "Oui, supprimer",
									emoji: true,
								},
								style: "danger",
								value: JSON.stringify({ proformaIndex, messageTs, channelId }),
								action_id: "delete_order_confirmed",
							},
							{
								type: "button",
								text: {
									type: "plain_text",
									text: "Annuler",
									emoji: true,
								},
								value: "cancel",
								action_id: "delete_order_canceled",
							},
						],
					},
				],
			});
		}
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`Error in handleDeleteOrder: ${error.message}`, error.stack);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Erreur: ${error.message}`,
		});
	}
}
module.exports = {
	openRejectionReasonModal,
	RejectionReasonSubmission,
	handleDeleteOrder,
	executeOrderDeletion,
	handleDeleteOrderConfirmed,
};
