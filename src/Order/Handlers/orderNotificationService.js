const axios = require("axios");

const {
	getProformaBlocks,
	getOrderBlocks,
	getProformaBlocks1,
} = require("./orderMessageBlocks");

const { postSlackMessageWithRetry } = require("../../Common/slackUtils");
const { Order } = require("../../Database/dbModels/Order");
const {
	saveOrderMessageToDB,
	getOrderMessageFromDB,
	saveMessageReference,
} = require("../../Database/databaseUtils");
const { Caisse } = require("../../Database/dbModels/Caisse");
const { notifyTechSlack } = require("../../Common/notifyProblem");

async function notifyAdmin(
	order,
	context,
	isEdit = false,
	admin_action = false,
	status
) {
	console.log("** notifyAdmin");
	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];

	// Determine if this is a new order (not edit and no admin action)
	const isNewOrder = !isEdit && !admin_action;

	const blocks = [
		...(isEdit
			? [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*Commande modifiée: ${order.id_commande}*`,
						},
					},
			  ]
			: []),
		...getOrderBlocks(order, requestDate, isNewOrder),
		...getProformaBlocks(order),
		...(!admin_action
			? [
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
					{
						type: "context",
						elements: [
							{ type: "mrkdwn", text: "⏳ En attente de votre validation" },
						],
					},
			  ]
			: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `Demande ${status}e avec succès`,
						},
					},
			  ]),
	];

	const existingMessage = await getOrderMessageFromDB(order.id_commande);
	if (existingMessage && isEdit) {
		return await postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: existingMessage.channel,
				ts: existingMessage.ts,
				text: `Commande modifiée: ${order.id_commande}`,
				blocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
	} else {
		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: isNewOrder
					? `Nouvelle commande reçue: ${order.id_commande}`
					: `Commande reçue: ${order.id_commande}`,
				blocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		await saveOrderMessageToDB(order.id_commande, {
			channel: response.channel,
			ts: response.ts,
			orderId: order.id_commande,
		});
		return response;
	}
}
async function notifyUser(order, userId, context) {
	console.log("** notifyUser");
	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];
	// Ajouter les blocs des photos
	// const productPhotoBlocks = generateProductPhotosBlocks(order.productPhotos);
	const blocks = [
		...getOrderBlocks(order, requestDate),
		// ...productPhotoBlocks,
		...getProformaBlocks(order),
		...(order.statut === "En attente"
			? [
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: { type: "plain_text", text: "Modifier", emoji: true },
								style: "primary",
								action_id: "edit_order",
								value: order.id_commande,
							},
						],
					},
			  ]
			: []),
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "⏳ Votre commande est soumise avec succès ! Un administrateur va la vérifier sous 24h.",
				},
			],
		},
	];

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{ channel: userId, text: `✅ Commande *${order.id_commande}*`, blocks },
		process.env.SLACK_BOT_TOKEN,
		context
	);
}
async function notifyUserAI(order, userId, logger, messageOverride) {
	console.log("** notifyUserAI");
	logger.log(`Sending notification to ${userId}: ${messageOverride}`);

	try {
		const slackToken = process.env.SLACK_BOT_TOKEN;

		if (!slackToken) {
			throw new Error("SLACK_BOT_TOKEN not configured");
		}

		const slackMessage = {
			channel: userId, // Make sure this is the correct Slack user ID (starts with U) or channel ID
			text: messageOverride,
		};

		logger.log(`Posting to Slack: ${JSON.stringify(slackMessage)}`);

		const response = await axios.post(
			"https://slack.com/api/chat.postMessage",
			slackMessage,
			{
				headers: {
					Authorization: `Bearer ${slackToken}`,
					"Content-Type": "application/json",
				},
			}
		);

		logger.log(`Slack response: ${JSON.stringify(response.data)}`);

		if (!response.data.ok) {
			throw new Error(`Slack API error: ${response.data.error}`);
		}

		return { success: true, data: response.data };
	} catch (error) {
		await notifyTechSlack(error);

		logger.log(`Notification error: ${error.message}`);
		return { success: false, error: error.message };
	}
}
async function notifyTeams(payload, comment, order, context) {
	console.log("^^^payload:", payload);
	console.log("** notifyTeams");
	console.log("notifyTeams1", notifyTeams);
	console.log("comment", comment);
	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];
	const validatedBy = payload.user.id;
	console.log("validatedBy1", validatedBy);
	let selectedCaisseId;
	if (selectedCaisseId == null) {
		// Try to find the caisse with type = "Centrale"
		const centraleCaisse = await Caisse.findOne({ type: "Centrale" });
		if (centraleCaisse) {
			selectedCaisseId = centraleCaisse._id.toString();
		} else {
			selectedCaisseId = "6848a25fe472b1c054fef321";
		}
	}
	const channel =
		order.proformas.length === 0
			? process.env.SLACK_ACHAT_CHANNEL_ID
			: process.env.SLACK_FINANCE_CHANNEL_ID;

	const text =
		order.proformas.length === 0
			? `🛒 Commande ${order.id_commande} à traiter - Validé par: <@${validatedBy}>`
			: `💰 Commande ${order.id_commande} en attente de validation financière - Validé par: <@${validatedBy}>`;

	console.log("text:", text);
	// const productPhotoBlocks = generateProductPhotosBlocks(order.productPhotos);
	const validatedProforma = order.proformas.find((p) => p.validated === true);
	// const validationComment = validatedProforma?.validationComment;
	const availableCaisses = await Caisse.find({}).exec();
	const caisseOptions = availableCaisses
		.filter((caisse) => caisse._id.toString() !== selectedCaisseId)
		.map((caisse) => ({
			text: {
				type: "plain_text",
				text: `${caisse.type} (${caisse.channelName})`,
				emoji: true,
			},
			value: JSON.stringify({
				entityId: order.id_commande,
				fromCaisseId: selectedCaisseId,
				toCaisseId: caisse._id.toString(),
				toChannelId: caisse.channelId,
			}),
		}));
	const actionsElements = [
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
	];

	if (caisseOptions.length > 0) {
		actionsElements.push({
			type: "static_select",
			placeholder: {
				type: "plain_text",
				text: "Affecter la transaction",
				emoji: true,
			},
			action_id: "transfer_to_caisse",
			options: caisseOptions,
		});
	}
	const blocks =
		order.proformas.length === 0
			? [
					...getOrderBlocks(order, requestDate),

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
					{
						type: "context",
						elements: [
							// {
							// 	type: "mrkdwn",
							// 	text: `:white_check_mark: Approuvée le ${new Date().toLocaleString(
							// 		"fr-FR",
							// 		{
							// 			weekday: "long",
							// 			year: "numeric",
							// 			month: "long",
							// 			day: "numeric",
							// 			hour: "2-digit",
							// 			minute: "2-digit",
							// 			timeZoneName: "short",
							// 		}
							// 	)} ${validatedBy ? `par <@${validatedBy}>` : ""}${
							// 		validationComment && validationComment.trim() !== ""
							// 			? `\n💬 *Note:* ${validationComment}`
							// 			: ""
							// 	}`,
							// },
							{
								type: "mrkdwn",
								text: `:white_check_mark: Approuvée le ${new Date().toLocaleString(
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
								)} ${validatedBy ? `par <@${validatedBy}>` : ""}${
									comment && comment.trim() !== ""
										? `\n💬 *Note:* ${comment}`
										: ""
								}`,
							},
						],
					},
			  ]
			: [
					...getOrderBlocks(order, requestDate),
					// ...productPhotoBlocks,
					...getProformaBlocks1(order),
					// {
					// 	type: "actions",
					// 	elements: [
					// 		{
					// 			type: "button",
					// 			text: {
					// 				type: "plain_text",
					// 				text: "Enregistrer paiement",
					// 				emoji: true,
					// 			},
					// 			style: "primary",
					// 			action_id: "finance_payment_form",
					// 			value: order.id_commande,
					// 		},
					// 	],
					// },
					// ...inside notifyTeams, in the blocks array...
					{
						type: "actions",
						elements: actionsElements,
					},
					// {
					// 	type: "context",
					// 	elements: [
					// 		{
					// 			type: "mrkdwn",
					// 			text: `✅ MMValidé par: <@${validatedBy}>${
					// 				validationComment && validationComment.trim() !== ""
					// 					? `\n💬 *Note:* ${validationComment}`
					// 					: ""
					// 			}`,
					// 		},
					// 	],
					// },
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `:white_check_mark: Approuvée le ${new Date().toLocaleString(
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
								)} ${validatedBy ? `par <@${validatedBy}>` : ""}${
									comment && comment.trim() !== ""
										? `\n💬 *Note:* ${comment}`
										: ""
								}`,
							},
						],
					},
			  ];

	const response = await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{ text, channel, blocks },
		process.env.SLACK_BOT_TOKEN,
		context
	);

	console.log("Slack API response:", response);

	// Sauvegardez la référence du message pour le canal approprié
	// ...existing code...
	if (response.ok) {
		const messageType =
			channel === process.env.SLACK_ACHAT_CHANNEL_ID ? "achat" : "finance";

		await saveMessageReference(
			order.id_commande,
			response.ts,
			channel,
			messageType
		);

		// Update the appropriate message field based on the messageType
		if (messageType === "achat") {
			await Order.findOneAndUpdate(
				{ id_commande: order.id_commande },
				{
					achatMessage: {
						ts: response.ts,
						createdAt: new Date(),
					},
				}
			);
		} else {
			await Order.findOneAndUpdate(
				{ id_commande: order.id_commande },
				{
					financeMessage: {
						ts: response.ts,
						createdAt: new Date(),
					},
				}
			);
		}
	}
	// ...existing code...
	return response;
}
module.exports = {
	notifyAdmin,
	notifyUserAI,
	notifyUser,
	notifyTeams,
};
