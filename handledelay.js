const { Order } = require("./db");
const { postSlackMessage, createSlackResponse } = require("./utils");
const { sendDelayReminder } = require("./notificationService");
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
			proformas: { $not: { $size: 0 } },
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

				summary += `• *${order.id_commande}* - ${
					order.titre || "Sans titre"
				} (Demandeur: <@${order.demandeurId}>)${link}\n`;
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
		console.log(`Error in proforma delay monitoring: ${error.message}`);
		throw error;
	}
}
// ...existing code...

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
