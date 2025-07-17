const { notifyTechSlack } = require("../Common/notifyProblem");
const {
	postSlackMessage,
	postSlackMessageWithRetry,
} = require("../Common/slackUtils");
const { Order } = require("../Database/dbModels/Order");
const {
	getProformaBlocks,
	getProformaBlocks1,
	getOrderBlocks,
} = require("../Order/Handlers/orderMessageBlocks");

async function sendDelayReminder(order, context, type = "admin") {
	console.log("** sendDelayReminder");
	const reminderId = `REMINDER-${order.id_commande}-${Date.now()}`;
	console.log(
		`sendDelayReminder1 for order ${order.id_commande}, type: ${type}, reminderId: ${reminderId}`
	);

	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];
	const normalizedType = type.toLowerCase();

	console.log(
		`Received type: '${type}' for order ${order.id_commande}, normalized to '${normalizedType}', reminderId: ${reminderId}`
	);

	let inferredType = normalizedType;
	if (
		order.statut === "Validé" &&
		order.proformas.length === 0 &&
		normalizedType === "admin"
	) {
		console.log(
			`Order ${order.id_commande} has no proformas but is validated, inferring type as 'proforma'`
		);
		inferredType = "proforma";
	} else if (
		order.statut === "Validé" &&
		order.payments.length === 0 &&
		order.proformas.some((p) => p.validated === true) &&
		normalizedType === "admin"
	) {
		console.log(
			`Order ${order.id_commande} has validated proformas but no payments, inferring type as 'payment'`
		);
		inferredType = "payment";
	}

	const channel =
		inferredType === "proforma"
			? process.env.SLACK_ACHAT_CHANNEL_ID
			: inferredType === "payment"
			? process.env.SLACK_FINANCE_CHANNEL_ID
			: process.env.SLACK_ADMIN_ID;

	if (!channel) {
		console.log(
			`Error: Channel is undefined for type '${inferredType}', reminderId: ${reminderId}`
		);
		throw new Error(`No valid channel defined for type '${inferredType}'`);
	}

	console.log(
		`Sending delay reminder for order ${order.id_commande} with type '${inferredType}' to channel ${channel}`
	);

	// Get the existing message timestamp to delete it
	let existingMessageTs = null;
	if (inferredType === "proforma" && order.achatMessage?.ts) {
		existingMessageTs = order.achatMessage.ts;
	} else if (inferredType === "payment" && order.financeMessage?.ts) {
		existingMessageTs = order.financeMessage.ts;
	} else if (inferredType === "admin" && order.adminMessage?.ts) {
		existingMessageTs = order.adminMessage.ts;
	}

	const blocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*⚠️ Alerte : ${
					inferredType === "proforma"
						? "Proforma"
						: inferredType === "payment"
						? "Paiement"
						: "Commande"
				} en attente*\n\nLa commande *${order.id_commande}* est ${
					inferredType === "payment" ? "validée" : "en attente"
				} depuis plus de 24 heures.`,
			},
		},
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Date de création:* ${order.createdAt.toLocaleString()}`,
			},
		},
		...getOrderBlocks(order, requestDate),

		// Payment type blocks
		...(inferredType === "payment"
			? [
					...getProformaBlocks1(order),
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
								value: order.id_commande,
							},
						],
					},
			  ]
			: []),
		// Proforma type blocks
		...(inferredType === "proforma"
			? [
					...getProformaBlocks(order),
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: {
									type: "plain_text",
									text: "Ajouter des proformas",
									emoji: true,
								},
								style: "primary",
								action_id: "proforma_form",
								value: order.id_commande,
							},
						],
					},
			  ]
			: []),
		// Admin type blocks (neither proforma nor payment)
		...(inferredType !== "proforma" && inferredType !== "payment"
			? [
					...getProformaBlocks(order),
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: { type: "plain_text", text: "Approuver", emoji: true },
								style: "primary",
								action_id: "payment_verif_accept",
								value: order.id_commande,
							},
							{
								type: "button",
								text: { type: "plain_text", text: "Rejeter", emoji: true },
								style: "danger",
								action_id: "reject_order",
								value: order.id_commande,
							},
						],
					},
			  ]
			: []),
	];

	try {
		// Delete the existing message if it exists
		if (existingMessageTs) {
			try {
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.delete",
					{
						channel,
						ts: existingMessageTs,
					},
					process.env.SLACK_BOT_TOKEN,
					context
				);
				console.log(
					`Successfully deleted existing message for order ${order.id_commande} in channel ${channel}`
				);
			} catch (deleteError) {
				await notifyTechSlack(deleteError);

				console.log(
					`Warning: Failed to delete existing message for order ${order.id_commande}: ${deleteError.message}`
				);
				// Continue with sending the reminder even if deletion fails
			}
		}

		// Send the new reminder message
		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel,
				text: `⏰ Commande en attente dépassant 24h (${inferredType}) [reminderId: ${reminderId}]`,
				blocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		console.log(
			`Successfully sent reminder for ${order.id_commande} to ${channel}, reminderId: ${reminderId}`
		);

		// Update the message timestamp in the database with the new reminder message
		const updateField = {};
		if (inferredType === "proforma") {
			updateField.achatMessage = {
				ts: response.ts,
				createdAt: new Date(),
				isReminder: true,
				reminderId: reminderId,
			};
		} else if (inferredType === "payment") {
			updateField.financeMessage = {
				ts: response.ts,
				createdAt: new Date(),
				isReminder: true,
				reminderId: reminderId,
			};
		} else {
			updateField.adminMessage = {
				ts: response.ts,
				createdAt: new Date(),
				isReminder: true,
				reminderId: reminderId,
			};
		}

		await Order.findOneAndUpdate(
			{ id_commande: order.id_commande },
			{
				$set: {
					...updateField,
					[`${inferredType}_reminder_sent`]: true,
				},
				$push: {
					delay_history: {
						type: `${inferredType}_reminder`,
						timestamp: new Date(),
						reminderId,
						originalMessageDeleted: existingMessageTs ? true : false,
						newMessageTs: response.ts,
					},
				},
			}
		);
	} catch (error) {
		await notifyTechSlack(error);

		console.log(
			`Failed to send reminder for ${order.id_commande} to ${channel}: ${error.message}, reminderId: ${reminderId}`
		);
		throw error;
	}
}
let isScheduled = false;

async function checkPendingOrderDelays(context) {
	try {
		console.log("** checkPendingOrderDelays");

		const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		console.log(
			`Checking for pending orders created before: ${twentyFourHoursAgo}`
		);

		const pendingOrders = await Order.find({
			statut: "En attente",
			createdAt: { $lte: twentyFourHoursAgo },
			// admin_reminder_sent: false,
		});
		if (pendingOrders.length > 0) {
			let summary = `:warning: *Rappel quotidien - commandes en attente*\n\n`;
			summary += `*Commandes non traitées depuis plus de 24h:*\n`;
			pendingOrders.forEach((order) => {
				const msgObj = order.adminMessage;
				const channelId =
					process.env.SLACK_ADMIN_ID || (msgObj && msgObj.channel);
				const ts = msgObj?.ts;
				let link = "";
				if (channelId && ts) {
					// Slack message links use the format: https://slack.com/app_redirect?channel=CHANNEL_ID&message_ts=TS
					link = `(<https://slack.com/archives/${channelId}/p${ts.replace(
						".",
						""
					)}|Voir message>)`;
				}
				summary += `• *${order.id_commande}* - ${
					order.titre || "Sans titre"
				} (Demandeur: <@${order.demandeurId}>) ${link}\n`;
			});
			summary += `\nMerci de traiter ces commandes dès que possible.`;

			const adminchannel = process.env.SLACK_ADMIN_ID || "CXXXXXXX";
			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: adminchannel,
					text: summary,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
		console.log(`Found ${pendingOrders.length} delayed pending orders`);

		for (const order of pendingOrders) {
			console.log(`Attempting to process pending order: ${order.id_commande}`);

			const updatedOrder = await Order.findOneAndUpdate(
				{
					id_commande: order.id_commande,
					admin_reminder_sent: false,
				},
				{
					$set: { admin_reminder_sent: true },
					$push: {
						delay_history: {
							type: "admin_reminder",
							timestamp: new Date(),
						},
					},
				},
				{ new: true }
			);

			if (updatedOrder) {
				console.log(`Claimed order ${order.id_commande} for reminder`);
				// await sendDelayReminder(updatedOrder, context, "admin");
			} else {
				console.log(
					`Order ${order.id_commande} already claimed by another process`
				);
			}
		}
	} catch (error) {
		await notifyTechSlack(error);

		console.log(`Error in pending order delay monitoring: ${error.message}`);
		throw error;
	}
}
async function checkPaymentDelays(context) {
	try {
		console.log("** checkPaymentDelays");

		const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		console.log(
			`Checking for orders missing payments before: ${twentyFourHoursAgo}`
		);

		// Find orders that need payment reminders
		const delayedPaymentOrders = await Order.find({
			statut: "Validé",
			createdAt: { $lte: twentyFourHoursAgo },
			proformas: { $elemMatch: { validated: true } },
			// payment_reminder_sent: false,
			$or: [
				{ paymentDone: "false" },
				{ paymentDone: false },
				{ paymentDone: { $exists: false } },
			],
		});

		console.log(`Found ${delayedPaymentOrders.length} orders missing payments`);

		if (delayedPaymentOrders.length === 0) {
			console.log("No delayed payment orders found");
			return;
		}

		// Group orders by channel to send targeted messages
		const ordersByChannel = new Map();

		delayedPaymentOrders.forEach((order) => {
			// Prefer financeMessageTransfer, fallback to financeMessage
			const msgObj = order.financeMessageTransfer?.ts
				? order.financeMessageTransfer
				: order.financeMessage;

			const channelId = order.financeMessageTransfer?.ts
				? order.financeMessageTransfer.channel
				: process.env.SLACK_FINANCE_CHANNEL_ID;

			if (!ordersByChannel.has(channelId)) {
				ordersByChannel.set(channelId, []);
			}
			ordersByChannel.get(channelId).push({ order, msgObj });
		});

		// Send messages to each channel
		for (const [channelId, orders] of ordersByChannel) {
			let summary = `:warning: *Rappel quotidien - commandes en attente de paiement*\n\n`;
			summary += `*Commandes validées sans paiement depuis plus de 24h:*\n`;

			orders.forEach(({ order, msgObj }) => {
				const ts = msgObj?.ts;
				let link = "";

				if (channelId && ts) {
					// Create proper Slack message link
					link = ` (<https://slack.com/archives/${channelId}/p${ts.replace(
						".",
						""
					)}|Voir message>)`;
				}
				let montantRestant = order.remainingAmount;

				summary += `• *${order.id_commande}* - ${
					order.titre || "Sans titre"
				} (Demandeur: <@${order.demandeurId}>)${link}\n`;
				summary += `   - Montant payé: ${order.amountPaid ?? "N/A"}\n`;
				if (montantRestant === 0 && Array.isArray(order.proformas)) {
					const validatedProforma = order.proformas.find(
						(p) => p.validated === true
					);
					if (
						validatedProforma &&
						typeof validatedProforma.montant === "number"
					) {
						montantRestant = validatedProforma.montant;
					}
				}

				summary += `   - Montant restant: ${montantRestant ?? "N/A"}\n`;
			});

			summary += `\nMerci de traiter ces commandes dès que possible.`;

			// Post message to the appropriate channel
			const targetChannelId = channelId || process.env.SLACK_FINANCE_CHANNEL_ID;
			console.log("Posting to channel:", targetChannelId);

			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: targetChannelId,
					text: summary,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		// Update orders to mark reminder as sent
		for (const order of delayedPaymentOrders) {
			console.log(
				`Attempting to process payment delay for order: ${order.id_commande}`
			);

			const updatedOrder = await Order.findOneAndUpdate(
				{
					id_commande: order.id_commande,
					payment_reminder_sent: false,
				},
				{
					$set: { payment_reminder_sent: true },
					$push: {
						delay_history: {
							type: "payment_reminder",
							timestamp: new Date(),
						},
					},
				},
				{ new: true }
			);

			if (updatedOrder) {
				console.log(`Marked reminder sent for order ${order.id_commande}`);
			} else {
				console.log(
					`Order ${order.id_commande} already processed by another instance`
				);
			}
		}
	} catch (error) {
		await notifyTechSlack(error);

		console.log(`Error in payment delay monitoring: ${error.message}`);
		throw error;
	}
}

async function checkProformaDelays(context) {
	try {
		console.log("** checkProformaDelays");

		const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		console.log(
			`Checking for orders missing proformas before: ${twentyFourHoursAgo}`
		);

		// 1. Orders with no proformas at all
		const noProformaOrders = await Order.find({
			statut: "Validé",
			createdAt: { $lte: twentyFourHoursAgo },
			proformas: { $size: 0 },
			// proforma_reminder_sent: false,
		});

		// 2. Orders with proformas, but none validated
		const unvalidatedProformaOrders = await Order.find({
			statut: "Validé",
			createdAt: { $lte: twentyFourHoursAgo },
			proformas: { $not: { $elemMatch: { validated: true } } },
		});

		let summary = `:warning: *Rappel quotidien - commandes en attente de proforma*\n\n`;

		if (noProformaOrders.length > 0) {
			summary += `:warning: *Commandes validées sans proforma depuis plus de 24h:*\n\n`;
			noProformaOrders.forEach((order) => {
				const msgObj = order.achatMessage;
				const channelId = process.env.SLACK_ACHAT_CHANNEL_ID;
				const ts = msgObj?.ts;
				let link = "";
				if (channelId && ts) {
					link = `(<https://slack.com/archives/${channelId}/p${ts.replace(
						".",
						""
					)}|Voir message>)`;
				}
				summary += `• *${order.id_commande}* - ${
					order.titre || "Sans titre"
				} (Demandeur: <@${order.demandeurId}>)${link}\n`;
			});
			summary += `\n`;
		}

		if (unvalidatedProformaOrders.length > 0) {
			summary += `:warning: *Aucune proforma n'est validée pour cette commande depuis plus de 24h:*\n\n`;
			unvalidatedProformaOrders.forEach((order) => {
				const msgObj = order.achatMessage;
				const channelId = process.env.SLACK_ACHAT_CHANNEL_ID;
				const ts = msgObj?.ts;
				let link = "";
				if (channelId && ts) {
					link = `(<https://slack.com/archives/${channelId}/p${ts.replace(
						".",
						""
					)}|Voir message>)`;
				}
				summary += `• *${order.id_commande}* - ${
					order.titre || "Sans titre"
				} (Demandeur: <@${order.demandeurId}>)${link}\n`;
			});
			summary += `\n`;
		}

		if (summary) {
			summary += `Merci de traiter ces commandes dès que possible.`;
			const achat = process.env.SLACK_ACHAT_CHANNEL_ID || "CXXXXXXX";
			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: achat,
					text: summary,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		// Combine both arrays for updating reminder flags
		const allDelayedOrders = [
			...noProformaOrders,
			...unvalidatedProformaOrders,
		];
		for (const order of allDelayedOrders) {
			console.log(
				`Attempting to process proforma delay for order: ${order.id_commande}`
			);

			const updatedOrder = await Order.findOneAndUpdate(
				{
					id_commande: order.id_commande,
					proforma_reminder_sent: false,
				},
				{
					$set: { proforma_reminder_sent: true },
					$push: {
						delay_history: {
							type: "proforma_reminder",
							timestamp: new Date(),
						},
					},
				},
				{ new: true }
			);

			if (updatedOrder) {
				console.log(`Claimed order ${order.id_commande} for reminder`);
				// await sendDelayReminder(updatedOrder, context, "proforma");
			} else {
				console.log(
					`Order ${order.id_commande} already claimed by another process`
				);
			}
		}
	} catch (error) {
		await notifyTechSlack(error);
		//
		console.log(`Error in proforma delay monitoring: ${error.message}`);
		throw error;
	}
}

function setupDelayMonitoring(context) {
	console.log("** setupDelayMonitoring");
	if (isScheduled) {
		console.log(
			"Delay monitoring already scheduled, skipping duplicate setup."
		);
		return;
	}
	cron.schedule("0 * * * *", () => {
		console.log("Running scheduled delay check...");
		checkPendingOrderDelays(context);
		checkPaymentDelays(context);
		checkProformaDelays(context);
	});
	isScheduled = true;
	console.log("Delay monitoring scheduled to run every hour.");
}

module.exports = {
	checkPendingOrderDelays,
	sendDelayReminder,
	checkPaymentDelays,
	checkProformaDelays,
	setupDelayMonitoring,
};
