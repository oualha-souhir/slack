const { notifyTechSlack } = require("../../Common/notifyProblem");
const { postSlackMessageWithRetry } = require("../../Common/slackUtils");
const { fetchEntity } = require("../../Common/utils");
const { Caisse } = require("../../Database/dbModels/Caisse");

async function notifyPayment(
	entityId,
	notifyPaymentData,
	totalAmountDue,
	remainingAmount,
	paymentStatus,
	context,
	target,
	userId,
	targetChannelId,
	selectedCaisseId,
	paymentNumber,
	decaissementNumber
) {
	try {
		console.log("** notifyPayment");
		console.log("target", target);
		const entity = await fetchEntity(entityId, context);
		console.log("userId", userId);
		console.log("pppp targetChannelId", targetChannelId);
		console.log("pppp selectedCaisseId", selectedCaisseId);
		const caisse = selectedCaisseId
			? await Caisse.findById(selectedCaisseId)
			: null;
		const validatedBy = entityId.validatedBy || "unknown";
		if (!entity) {
			console.error(
				`[notifyPayment][${target}] Entity not found for ID:`,
				entityId
			);
			return;
		}

		const blocks = await getPaymentBlocks(
			entity,
			notifyPaymentData,
			remainingAmount,
			paymentStatus,
			selectedCaisseId,
			paymentNumber,
			decaissementNumber
		);
		console.log("FIN getPaymentBlocks");
		console.log(" targetChannelId", targetChannelId);
		const channel =
			target === "finance"
				? targetChannelId
				: target === "admin"
				? process.env.SLACK_ADMIN_ID
				: entity.demandeurId;
		const text = `💲 Paiement Enregistré pour ${entityId}`;
		console.log("  remainingAmount", remainingAmount);
		if (target === "finance" && remainingAmount > 0) {
			console.log("target === finance");
			blocks.push({
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
							entityId: entityId,
							selectedCaisseId: selectedCaisseId,
						}),
					},
					{
						type: "button",
						text: {
							type: "plain_text",
							text: "Signaler un problème",
							emoji: true,
						},
						style: "danger",
						action_id: "report_problem",
						value: JSON.stringify({
							entityId: entityId,
							selectedCaisseId: selectedCaisseId,
						}),
					},
				],
			});
		}
		if (target === "user" || target === "admin") {
			console.log("target === user || target === admin");
			blocks.push({
				type: "actions",
				elements: [
					{
						type: "button",
						text: {
							type: "plain_text",
							text: "Signaler un problème",
							emoji: true,
						},
						style: "danger",
						action_id: "report_problem",
						value: JSON.stringify({
							entityId: entityId,
							selectedCaisseId: selectedCaisseId,
						}),
					},
				],
			});
		}
		if (target === "finance" && remainingAmount == 0) {
			console.log("target === finance && remainingAmount == 0");
			blocks.push({
				type: "actions",
				elements: [
					{
						type: "button",
						text: {
							type: "plain_text",
							text: "Signaler un problème",
							emoji: true,
						},
						style: "danger",
						action_id: "report_problem",
						value: JSON.stringify({
							entityId: entityId,
							selectedCaisseId: selectedCaisseId,
						}),
					},
				],
			});
		}
		// else if (target === "admin") {
		//   blocks.push({
		//     type: "actions",
		//     elements: [
		//       {
		//         type: "button",
		//         text: { type: "plain_text", text: "Modifier paiement", emoji: true },
		//         style: "primary",
		//         action_id: "Modifier_paiement",
		//         value: entityId,
		//       },
		//     ],
		//   });
		// }

		blocks.push({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: `✅ *Détails financiers fournis par <@${userId}>* le ${new Date().toLocaleString(
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
					)}`,
				},
			],
		});
		if (caisse && caisse.balances) {
			blocks.push({
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: `Caisse: *${caisse.type}* - Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
					},
				],
			});
		}
		let financeMsgTs, financeMsgChannel;
		if (entity.financeMessageTransfer && entity.financeMessageTransfer.ts) {
			console.log("==: Transfer");
			console.log(
				"entity.financeMessageTransfer.ts",
				entity.financeMessageTransfer
			);
			financeMsgTs = entity.financeMessageTransfer.ts;
			financeMsgChannel = entity.financeMessageTransfer.channel;
		} else if (entity.financeMessage && entity.financeMessage.ts) {
			console.log("==: Finance Message");
			console.log("entity.financeMessage.ts", entity.financeMessage);
			financeMsgTs = entity.financeMessage.ts;
			financeMsgChannel = process.env.SLACK_FINANCE_CHANNEL_ID;
		}

		if (financeMsgTs && financeMsgChannel) {
			// Slack message links require removing the dot from ts
			const slackMsgLink = `https://slack.com/archives/${financeMsgChannel}/p${financeMsgTs.replace(
				".",
				""
			)}`;
			blocks.push({
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: `🔗 <${slackMsgLink}|Voir le message original>`,
					},
				],
			});
		}
		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{ channel, text, blocks },
			process.env.SLACK_BOT_TOKEN,
			context
		);
		if (target === "finance") {
			const messageTs = response.ts;
			console.log("))) messageTs finance", messageTs);

			// Find and update the correct payment in the payments array
			if (
				entity.payments &&
				entity.payments.length > 0 &&
				notifyPaymentData.paymentNumber
			) {
				const payment = entity.payments.find(
					(p) => p.paymentNumber === notifyPaymentData.paymentNumber
				);
				if (payment) {
					payment.slackFinanceMessageTs = messageTs;
					await entity.save();
					console.log(
						`Saved slackFinanceMessageTs for payment ${payment.paymentNumber}`
					);
				}
			}
		}
		if (target === "admin") {
			const messageTs = response.ts;
			console.log("))) messageTs admin", messageTs);

			// Find and update the correct payment in the payments array
			if (
				entity.payments &&
				entity.payments.length > 0 &&
				notifyPaymentData.paymentNumber
			) {
				const payment = entity.payments.find(
					(p) => p.paymentNumber === notifyPaymentData.paymentNumber
				);
				if (payment) {
					payment.slackAdminMessageTs = messageTs;
					await entity.save();
					console.log(
						`Saved slackAdminMessageTs for payment ${payment.paymentNumber}`
					);
				}
			}
		}
		console.log("1Slack API response:", response);
		if (!response.ok) {
			console.error(
				`❌ Failed to notify ${target} about payment for ${entityId}: ${response.error}`
			);
		}

		console.log(`${target} notified about payment for ${entityId}`);
	} catch (err) {
		await notifyTechSlack(err);

		console.error(`[notifyPayment][${target}] Exception:`, err);
	}
}
async function getPaymentBlocks(
	entity,
	paymentData,
	remainingAmount,
	paymentStatus,
	paymentNumber,
	decaissementNumber
) {
	console.log("** getPaymentBlocks");
	//console.log("entity111",entity);
	console.log("** entity", entity);
	console.log("** paymentData", paymentData);
	console.log("** remainingAmount", remainingAmount);
	console.log("** paymentStatus", paymentStatus);
	console.log("** paymentNumber", paymentNumber);
	console.log("** decaissementNumber", decaissementNumber);

	const isOrder = entity && "id_commande" in entity;
	const isPaymentRequest = entity && "id_paiement" in entity;
	// console.log("paymentData1", paymentData);
	console.log("remainingAmount1", remainingAmount);

	console.log("isOrder1", isOrder);
	const currency =
		isOrder && entity.proformas?.[0]?.devise
			? entity.proformas[0].devise
			: entity.devise || "N/A";
	let total;
	if (isOrder) {
		const validatedProformas = entity.proformas.filter((p) => p.validated);
		//  console.log("validated", validatedProformas);

		if (validatedProformas.length > 0) {
			total = validatedProformas[0].montant;
		}
	} else if (isPaymentRequest) {
		total = entity.montant;
	}
	console.log("entity.amountPaid1", entity.amountPaid);

	const totalAmountPaid =
		isOrder && entity.amountPaid !== undefined
			? entity.amountPaid
			: isPaymentRequest && entity.amountPaid !== undefined
			? entity.amountPaid
			: "N/A";
	console.log("totalAmountPaid1", totalAmountPaid);
	console.log("paymentData", paymentData);
	// Handle Mobile Money fee logic
	let adjustedRemainingAmount = remainingAmount;
	let adjustedTotalAmountPaid = totalAmountPaid;
	let mobileMoneyFee = null;

	if (paymentData.mode === "Mobile Money" && remainingAmount < 0) {
		// Adjust amounts for Mobile Money overpayment
		adjustedRemainingAmount = 0;
	}
	const amountPaid1 = entity.amountPaid || 0;
	const remainingAmount1 = totalAmountPaid - amountPaid1;
	const additionalDetails = [];
	if (paymentData.mode === "Chèque" && paymentData.details) {
		additionalDetails.push([
			{
				type: "mrkdwn",
				text: `*Numéro de chèque:*\n${
					paymentData.details?.cheque_number || "N/A"
				}`,
			},
			{
				type: "mrkdwn",
				text: `*Banque:*\n${paymentData.details?.cheque_bank || "N/A"}`,
			},
			{
				type: "mrkdwn",
				text: `*Date du chèque:*\n${paymentData.details?.cheque_date || "N/A"}`,
			},
			{
				type: "mrkdwn",
				text: `*Ordre:*\n${paymentData.details?.cheque_order || "N/A"}`,
			},
		]);
	} else if (paymentData.mode === "Virement" && paymentData.details) {
		additionalDetails.push([
			{
				type: "mrkdwn",
				text: `*Numéro de virement:*\n${
					paymentData.details?.virement_number || "N/A"
				}`,
			},
			{
				type: "mrkdwn",
				text: `*Banque:*\n${paymentData.details?.virement_bank || "N/A"}`,
			},
			{
				type: "mrkdwn",
				text: `*Date de virement:*\n${
					paymentData.details?.virement_date || "N/A"
				}`,
			},
			{
				type: "mrkdwn",
				text: `*Ordre:*\n${paymentData.details?.virement_order || "N/A"}`,
			},
		]);
	} else if (paymentData.mode === "Mobile Money" && paymentData.details) {
		additionalDetails.push([
			{
				type: "mrkdwn",
				text: `*Numéro de téléphone bénéficiaire:*\n${
					paymentData.details?.mobilemoney_recipient_phone || "N/A"
				}`,
			},
			{
				type: "mrkdwn",
				text: `*Numéro envoyeur:*\n${
					paymentData.details?.mobilemoney_sender_phone || "N/A"
				}`,
			},
			{
				type: "mrkdwn",
				text: `*Montant des frais:*\n${
					paymentData.details?.mobilemoney_fees || "N/A"
				}`,
			},

			{
				type: "mrkdwn",
				text: `*Date:*\n${paymentData.details?.mobilemoney_date || "N/A"}`,
			},
		]);
	} else if (paymentData.mode === "Julaya" && paymentData.details) {
		additionalDetails.push([
			{
				type: "mrkdwn",
				text: `*Bénéficiaire:*\n${
					paymentData.details?.julaya_recipient || "N/A"
				}`,
			},
			{
				type: "mrkdwn",
				text: `*Numéro:*\n${
					paymentData.details?.julaya_transaction_number || "N/A"
				}`,
			},

			{
				type: "mrkdwn",
				text: `*Date:*\n${paymentData.details?.julaya_date || "N/A"}`,
			},
		]);
	}
	// Build proof fields array
	const proofFields = [];
	console.log("paymentData.url", paymentData.url);
	// console.log("paymentData.url.length", paymentData.url.length);
	// Add main payment URL if exists
	if (paymentData.url) {
		if (paymentData.url.length > 0) {
			proofFields.push({
				type: "mrkdwn",
				text: `*Preuve 1:*\n<${paymentData.url}|Voir le justificatif>`,
			});
		}
	}

	// Add additional proofs from paymentData.proofs array
	if (paymentData.proofs && Array.isArray(paymentData.proofs)) {
		paymentData.proofs.forEach((proof, index) => {
			if (proof && proof.trim()) {
				const proofNumber =
					paymentData.url && paymentData.url.length > 0 ? index + 2 : index + 1;
				proofFields.push({
					type: "mrkdwn",
					text: `*Preuve ${proofNumber}:*\n<${proof}|Voir le justificatif>`,
				});
			}
		});
	}
	console.log("paymentStatus ùùùù", paymentStatus);
	decaissementNumber =
		paymentData.decaissementNumber || paymentData.details?.decaissementNumber;
	// ...existing code...

	return [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: `✅ 💲 Paiement Enregistré: ${
					entity.id_commande || entity.id_paiement
				} - ${paymentStatus}`,
				emoji: true,
			},
		},

		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*Titre:*\n${paymentData.title}` },
				{
					type: "mrkdwn",
					text: `*Date:*\n${new Date(paymentData.date).toLocaleString("fr-FR", {
						weekday: "long",
						year: "numeric",
						month: "long",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
						timeZoneName: "short",
					})}`,
				},
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Montant payé:*\n${paymentData.amountPaid} ${currency}`,
				},
				{
					type: "mrkdwn",
					text: `*Reste à payer:*\n${adjustedRemainingAmount} ${currency}`,
				},
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Total montant payé:*\n${totalAmountPaid} ${currency}`,
				},
				{
					type: "mrkdwn",
					text: `*Montant de la demande:*\n${total} ${currency}`,
				},
			],
		},
		{ type: "divider" },
		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*Mode de paiement:*\n${paymentData.mode}` },
				{
					type: "mrkdwn",
					text: `*Numéro de transaction*\n\`${
						paymentData.paymentNumber || paymentData.details?.paymentNumber
					}\``,
				},
			],
		},
		// In getPaymentBlocks, replace the "Numéro de paiement" section with a more visually appealing layout

		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Comptabilisation:* ${decaissementNumber ? `*Oui*` : "*Non*"}`,
				},
				...(decaissementNumber
					? [
							{
								type: "mrkdwn",
								text: `*Numéro de pièce de caisse:* \`${decaissementNumber}\``,
							},
					  ]
					: []),
			],
		},
		// {
		// 	type: "section",
		// 	fields: [
		// 		{ type: "mrkdwn", text: `*Statut de paiement:*\n${paymentStatus}` },
		// 	],
		// },

		...(additionalDetails.length > 0
			? [
					{
						type: "section",
						fields: additionalDetails[0].slice(0, 2), // First 2 fields
					},
					...(additionalDetails[0].length > 2
						? [
								{
									type: "section",
									fields: additionalDetails[0].slice(2), // Remaining fields
								},
						  ]
						: []),
			  ]
			: []),
		{ type: "divider" },
		// { type: "section", text: { type: "mrkdwn", text: `*Justificatif(s)*` } },

		// ...(paymentData.proofs && paymentData.proofs.length > 0
		//   ? [
		//       {
		//         type: "section",
		//         text: {
		//           type: "mrkdwn",
		//           text: `*Justificatifs:*\n${paymentData.proofs
		//             .map((proof, index) => `<${proof}|Preuve ${index + 1}>`)
		//             .join("\n")}`,
		//         },
		//       },
		//     ]
		//   : []),
		// ...(paymentData.url
		//   ? [
		//       {
		//         type: "section",
		//         text: {
		//           type: "mrkdwn",
		//           text: `<${paymentData.url}|Preuve ${
		//             paymentData.proofs.length + 1
		//           }>`,
		//         },
		//       },
		//     ]
		//   : []),
		// Add proof sections if any proofs exist
		...(proofFields.length > 0
			? [
					{
						type: "section",
						fields: proofFields.slice(0, 2), // First 2 proof fields
					},
					...(proofFields.length > 2
						? [
								{
									type: "section",
									fields: proofFields.slice(2), // Remaining proof fields
								},
						  ]
						: []),
			  ]
			: []),
	].filter(Boolean);
}
module.exports = {
	getPaymentBlocks,
	notifyPayment,
};
