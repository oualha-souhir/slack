const { getOrderBlocks } = require("../Handlers/orderMessageBlocks");
const { Order } = require("../../Database/dbModels/Order");
const { postSlackMessageWithRetry } = require("../../Common/slackUtils");
const { saveMessageReference } = require("../../Database/databaseUtils");
const { notifyTechSlack } = require("../../Common/notifyProblem");

async function notifyAdminProforma(context, order, msgts, proformaIndex) {
	console.log("** notifyAdminProforma");
	console.log(
		`notifyTeams called for order ${
			order.id_commande
		} at ${new Date().toISOString()}`
	);
	console.log("proformaIndex:", proformaIndex);
	const proformas = order.proformas || [];
	const hasValidated = proformas.some((p) => p.validated);
	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];

	// Create blocks for the achat channel
	const achatBlocks = [
		...getOrderBlocks(order, requestDate),
		{
			type: "header",
			text: {
				type: "plain_text",
				text: `⇒ Proformas`,
				emoji: true,
			},
		},
		...proformas
			.map((p, i) =>
				[
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*${p.nom}* - Fournisseur: *${p.fournisseur}* - Montant: *${
								p.montant
							}* ${p.devise}\n   *URLs:*\n${p.urls
								.map((url, j) => `     ${j + 1}. <${url}|Page ${j + 1}>`)
								.join("\n")}`,
						},
					},
					p.validated
						? {
								type: "context",
								elements: [
									{
										type: "mrkdwn",
										text: `:white_check_mark: Approuvée ${
											p.validatedAt
												? `le ${new Date(p.validatedAt).toLocaleString()}`
												: ""
										} ${p.validatedBy ? `par <@${p.validatedBy}>` : ""}`,
									},
								],
						  }
						: !hasValidated // Only show buttons if no proforma is validated yet
						? {
								type: "actions",
								elements: [
									{
										type: "button",
										text: { type: "plain_text", text: "Modifier", emoji: true },
										value: JSON.stringify({
											orderId: order.id_commande,
											proformaIndex: i,
										}),
										action_id: "edit_proforma",
									},
									{
										type: "button",
										text: {
											type: "plain_text",
											text: "Supprimer",
											emoji: true,
										},
										style: "danger",
										value: JSON.stringify({
											orderId: order.id_commande,
											proformaIndex: i,
										}),
										action_id: "confirm_delete_proforma",
									},
								],
						  }
						: null,
					{ type: "divider" },
				].filter(Boolean)
			)
			.flat(),
		// {
		//   type: "context",
		//   elements: [
		//     {
		//       type: "mrkdwn",
		//       text: hasValidated
		//         ? ` `
		//         : ` `,
		//     },
		//   ],
		// },
		// Ajouter le bouton pour ajouter d'autres proformas
		// !hasValidated // Only show buttons if no proforma is validated yet
		//   ? {
		//       type: "actions",
		//       elements: [
		//         {
		//           type: "button",
		//           text: {
		//             type: "plain_text",
		//             text: "Ajouter des proformas2",
		//             emoji: true,
		//           },
		//           style: "primary",
		//           action_id: "proforma_form",
		//           value: order.id_commande,
		//         },
		//       ],
		//     }
		//   : null,
		// Ajouter le bouton pour ajouter d'autres proformas
		// {
		//   type: "actions",
		//   elements: [
		//     {
		//       type: "button",
		//       text: {
		//         type: "plain_text",
		//         text: "Ajouter des proformas",
		//         emoji: true,
		//       },
		//       style: "primary",
		//       action_id: "proforma_form",
		//       value: order.id_commande,
		//     },
		//   ],
		// },
		// !hasValidated
		// ? {
		//     type: "actions",
		//     elements: [
		//       {
		//         type: "button",
		//         text: {
		//           type: "plain_text",
		//           text: "Ajouter des proformas**",
		//           emoji: true,
		//         },
		//         style: "primary",
		//         action_id: "proforma_form",
		//         value: order.id_commande,
		//       },
		//     ],
		//   }
		// : null,
	];
	if (!hasValidated) {
		achatBlocks.push({
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
		});
	}
	console.log("$ achatBlocks", achatBlocks);
	console.log("$ hasValidated", hasValidated);

	// Create admin blocks
	const adminBlocks = [
		...getOrderBlocks(order, requestDate),
		{
			type: "header",
			text: {
				type: "plain_text",
				text: `⇒ Proformas `,
				emoji: true,
			},
		},
		...proformas
			.map((p, i) =>
				[
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*${p.nom}* - Fournisseur: *${p.fournisseur}* - Montant: *${
								p.montant
							}* ${p.devise}\n   *URLs:*\n${p.urls
								.map((url, j) => `     ${j + 1}. <${url}|Page ${j + 1}>`)
								.join("\n")}`,
						},
					},
					p.validated
						? {
								type: "context",
								elements: [
									{
										type: "mrkdwn",
										text: `:white_check_mark: Approuvée ${
											p.validatedAt
												? `le ${new Date(p.validatedAt).toLocaleString()}`
												: ""
										} ${p.validatedBy ? `par <@${p.validatedBy}>` : ""}${
											p.validationComment && p.validationComment.trim() !== ""
												? `\n💬 *Note:* ${p.validationComment}`
												: ""
										}`,
									},
								],
						  }
						: !hasValidated
						? {
								type: "actions",
								elements: [
									{
										type: "button",
										text: { type: "plain_text", text: "Valider", emoji: true },
										style: "primary",
										value: JSON.stringify({
											orderId: order.id_commande,
											proformaIndex: i,
										}),
										action_id: "confirm_validate_proforma",
									},
								],
						  }
						: null,
					{ type: "divider" },
				].filter(Boolean)
			)
			.flat(),

		// {
		//   type: "context",
		//   elements: [
		//     {
		//       type: "mrkdwn",
		//       text: hasValidated
		//         ? ` `
		//         : ` `,
		//     },
		//   ],
		// },
	];

	adminBlocks.push({
		type: "actions",
		elements: [
			{
				type: "button",
				text: {
					type: "plain_text",
					text: "Supprimer la commande",
					emoji: true,
				},
				style: "danger",
				value: `proforma_${proformaIndex}`,
				action_id: "delete_order",
			},
		],
	});

	try {
		//*
		// D'abord, mise à jour du message dans le canal achat
		// try {
		// 	// Récupérer la référence du message existant pour l'équipe achat
		// 	const achatMessageRef = await getMessageReference(
		// 		order.id_commande,
		// 		"achat"
		// 	);
		// 	console.log("achatMessageRef", achatMessageRef);

		// 	if (achatMessageRef && achatMessageRef.messageTs) {
		// 		console.log(
		// 			`Updating existing achat message for order ${order.id_commande}.`
		// 		);
		// 		// Mettre à jour le message existant
		// 		await postSlackMessageWithRetry(
		// 			"https://slack.com/api/chat.update",
		// 			{
		// 				channel: achatMessageRef.channelId,
		// 				ts: achatMessageRef.messageTs,
		// 				text: `Proformas pour ${order.id_commande} (Mis à jour)`,
		// 				blocks: achatBlocks,
		// 			},
		// 			process.env.SLACK_BOT_TOKEN,
		// 			console
		// 		);
		// 	} else {
		// 		console.log(
		// 			`No existing achat message found for order ${order.id_commande}, creating a new one.`
		// 		);
		// 		// Si aucun message existant n'est trouvé, créer un nouveau message
		// 		const achatResponse = await postSlackMessageWithRetry(
		// 			"https://slack.com/api/chat.postMessage",
		// 			{
		// 				channel: process.env.SLACK_ACHAT_CHANNEL_ID,
		// 				text: `Proformas pour ${order.id_commande}`,
		// 				blocks: achatBlocks,
		// 			},
		// 			process.env.SLACK_BOT_TOKEN,
		// 			console
		// 		);

		// 		// Sauvegarder la référence au nouveau message achat
		// 		if (achatResponse.ok) {
		// 			await saveMessageReference(
		// 				order.id_commande,
		// 				achatResponse.ts,
		// 				process.env.SLACK_ACHAT_CHANNEL_ID,
		// 				"achat"
		// 			);
		// 		}
		// 	}
		// } catch (achatError) {
		// 	console.log(
		// 		`Warning: Failed to update achat channel: ${achatError.message}`
		// 	);
		// }
		//*
		// Update the achat channel message using the message_ts and channel_id from the payload
		try {
			// Get message_ts and channel_id from the payload's container
			// const message_ts = msgts;
			const order_from_db = await Order.findOne({
				id_commande: order.id_commande,
			});
			const message_ts = order_from_db?.achatMessage?.ts;
			const channel_id = process.env.SLACK_ACHAT_CHANNEL_ID;
			console.log(
				`achat message_ts: ${message_ts}, channel_id: ${channel_id}, order.id_commande: ${order.id_commande}`
			);
			if (message_ts && channel_id) {
				console.log(
					`Updating achat message for order ${order.id_commande} with message_ts: ${message_ts}, channel_id: ${channel_id}`
				);
				// Update the existing message where the "Ajouter des proformas" button was clicked
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.update",
					{
						channel: channel_id,
						ts: message_ts,
						text: `Proformas pour ${order.id_commande} (Mis à jour)`,
						blocks: achatBlocks,
					},
					process.env.SLACK_BOT_TOKEN,
					console
				);

				// Optionally, save or update the message reference in the database for future use
				await saveMessageReference(
					order.id_commande,
					message_ts,
					channel_id,
					"achat"
				);
			} else {
				console.log(
					`No message_ts or channel_id found in payload for order ${order.id_commande}, falling back to creating a new message`
				);
				// Fallback: Create a new message if no message_ts or channel_id is found
				const achatResponse = await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: process.env.SLACK_ACHAT_CHANNEL_ID,
						text: `Proformas pour ${order.id_commande}`,
						blocks: achatBlocks,
					},
					process.env.SLACK_BOT_TOKEN,
					console
				);

				// Save the reference to the new message
				if (achatResponse.ok) {
					await saveMessageReference(
						order.id_commande,
						achatResponse.ts,
						process.env.SLACK_ACHAT_CHANNEL_ID,
						"achat"
					);
					// Also update the Order document with the achatMessage
					await Order.findOneAndUpdate(
						{ id_commande: order.id_commande },
						{
							achatMessage: {
								ts: achatResponse.ts,
								createdAt: new Date(),
							},
						}
					);
				}
			}
		} catch (achatError) {
			await notifyTechSlack(achatError);

			console.log(
				`Warning: Failed to update achat channel: ${achatError.message}`
			);
		}
		// Maintenant, gérer la notification admin
		// const adminMessageRef = await getMessageReference(
		//   order.id_commande,
		//   "admin"
		// );

		// Find the correct Slack message in the array
		// const adminMessage = order.slackMessages.find(
		// 	(msg) => msg.messageType === "notification"
		// );
		// const adminMessageRef = adminMessage ? adminMessage : undefined;

		// if (adminMessageRef && adminMessageRef.ts) {

		try {
			const order_from_db = await Order.findOne({
				id_commande: order.id_commande,
			});
			const message_ts = order_from_db?.adminMessage?.ts;
			const channel_id = process.env.SLACK_ADMIN_ID;

			console.log(
				`admin message_ts: ${message_ts}, channel_id: ${channel_id}, order.id_commande: ${order.id_commande}`
			);
			if (message_ts && channel_id) {
				// Mettre à jour le message admin existant
				try {
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.update",
						{
							channel: process.env.SLACK_ADMIN_ID,
							ts: message_ts,
							text: `Proformas pour ${order.id_commande} (Mis à jour)`,
							blocks: adminBlocks,
						},
						process.env.SLACK_BOT_TOKEN,
						console
					);
				} catch (updateError) {
					await notifyTechSlack(updateError);

					console.log(
						`❌ Error updating admin message: ${updateError.message}`
					);
				}
			} else {
				// Créer un nouveau message admin si aucune référence n'existe
				const postResponse = await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: process.env.SLACK_ADMIN_ID,
						text: `Proformas pour ${order.id_commande}`,
						blocks: adminBlocks,
					},
					process.env.SLACK_BOT_TOKEN,
					console
				);

				// Sauvegarder la référence au nouveau message admin
				if (postResponse.ok) {
					await saveMessageReference(
						order.id_commande,
						postResponse.ts,
						process.env.SLACK_ADMIN_ID,
						"admin"
					);
					// Also update the Order document with the adminMessage
					await Order.findOneAndUpdate(
						{ id_commande: order.id_commande },
						{
							adminMessage: {
								ts: postResponse.ts,
								createdAt: new Date(),
							},
						}
					);
				}
			}
		} catch (achatError) {
			await notifyTechSlack(achatError);

			console.log(
				`Warning: Failed to update admin channel: ${achatError.message}`
			);
		}

		return { success: true };
	} catch (error) {
		await notifyTechSlack(error);

		console.log(
			`❌ Error in notifyAdminProforma: ${error.message}\nStack: ${error.stack}`
		);
		return { success: false, error: error.message };
	}
}
module.exports = {
	notifyAdminProforma,
};
