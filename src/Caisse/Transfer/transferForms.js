const { getOrderBlocks, getProformaBlocks1 } = require("../../Order/Handlers/orderMessageBlocks");
const { getPaymentRequestBlocks } = require("../../Payment Request/Handlers/paymentRequestForm");


const getTransferredPaymentBlocks = (
	entity,
	validatedBy,
	transferredBy,
	toChannelName
) => {
	// If it's an order
	if (entity.id_commande) {
		const requestDate = entity.date_requete || entity.date || new Date();
		return [
			...getOrderBlocks(entity, requestDate),
			// ...productPhotoBlocks,
			...getProformaBlocks1(entity),
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `:package: *Commande transférée vers:* ${toChannelName}`,
				},
			},
			// {
			// 	type: "section", // <-- FIXED: was type: "mrkdwn"
			// 	text: {
			// 		type: "mrkdwn",
			// 		text: `✅ Validé par: <@${entity.validatedBy}> le ${new Date(
			// 			entity.validatedAt
			// 		).toLocaleString("fr-FR", {
			// 			timeZone: "Europe/Paris",
			// 			day: "2-digit",
			// 			month: "2-digit",
			// 			year: "numeric",
			// 			hour: "2-digit",
			// 			minute: "2-digit",
			// 		})}`,
			// 	},
			// },
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: `🔄 Transférée par <@${transferredBy}> le ${new Date().toLocaleString(
							"fr-FR",
							{
								timeZone: "Europe/Paris",
								day: "2-digit",
								month: "2-digit",
								year: "numeric",
								hour: "2-digit",
								minute: "2-digit",
							}
						)}`,
					},
				],
			},
		];
	}
	// Else, it's a payment request
	return [
		...getPaymentRequestBlocks(entity, validatedBy),
		{ type: "divider" },
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `🔄 *Paiement transféré vers:* ${toChannelName}`,
			},
		},
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: `✅ Validé par: <@${validatedBy}> le ${new Date(
						entity.validatedAt
					).toLocaleString("fr-FR", {
						timeZone: "Europe/Paris",
						day: "2-digit",
						month: "2-digit",
						year: "numeric",
						hour: "2-digit",
						minute: "2-digit",
					})}`,
				},
				{
					type: "mrkdwn",
					text: `🔄 Transaction affecté par <@${transferredBy}> le ${new Date().toLocaleString(
						"fr-FR",
						{
							timeZone: "Europe/Paris",
							day: "2-digit",
							month: "2-digit",
							year: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						}
					)}`,
				},
			],
		},
	];
};
const getFinancePaymentBlocksForTransfer = (
	entity,
	transferredBy,
	selectedCaisseId,
	fromChannelName
) => {
	let blocks = [];
	if (entity.id_commande) {
		// It's an order
		const requestDate = entity.date_requete || entity.date || new Date();
		blocks = [
			...getOrderBlocks(entity, requestDate),
			// ...productPhotoBlocks,
			...getProformaBlocks1(entity),

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
							entityId: entity.id_commande,
							selectedCaisseId: selectedCaisseId,
						}),
					},
					// No transfer button for transferred payments
				],
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: `🔄 *Commande transférée depuis:* ${fromChannelName} par <@${transferredBy}> le ${new Date().toLocaleString(
							"fr-FR",
							{
								timeZone: "Europe/Paris",
								day: "2-digit",
								month: "2-digit",
								year: "numeric",
								hour: "2-digit",
								minute: "2-digit",
							}
						)}`,
					},
				],
			},
		];
	} else {
		blocks = [
			...getPaymentRequestBlocks(entity, transferredBy),
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
							entityId: entity.id_paiement,
							selectedCaisseId: selectedCaisseId,
						}),
					},
					// No transfer button for transferred payments
				],
			},
			// Block context supplémentaire demandé
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: `✅ Validé par: <@${entity.validatedBy}> le ${new Date(
							entity.validatedAt
						).toLocaleString("fr-FR", {
							timeZone: "Europe/Paris",
							day: "2-digit",
							month: "2-digit",
							year: "numeric",
							hour: "2-digit",
							minute: "2-digit",
						})}`,
					},
					{
						type: "mrkdwn",
						text: `🔄 Transaction affecté de : ${fromChannelName} par: <@${transferredBy}> le ${new Date().toLocaleString(
							"fr-FR",
							{
								timeZone: "Europe/Paris",
								day: "2-digit",
								month: "2-digit",
								year: "numeric",
								hour: "2-digit",
								minute: "2-digit",
							}
						)}`,
					},
				],
			},
		];
	}
	return blocks;
};
module.exports = {
	getTransferredPaymentBlocks,
	getFinancePaymentBlocksForTransfer,
};
