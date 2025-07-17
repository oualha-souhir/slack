function getPaymentRequestBlocks(
	paymentRequest,
	validatedBy = null,
	isNew = false
) {
	try {
		// Create blocks for notification
		const blocks = [
			{
				type: "header",
				text: {
					type: "plain_text",

					text: isNew
						? `➡️ Nouvelle demande de paiement: ${paymentRequest.id_paiement}`
						: `💳 Demande de paiement: ${paymentRequest.id_paiement}`,
					emoji: true,
				},
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*Titre:*\n${paymentRequest.titre}`,
					},
					{
						type: "mrkdwn",
						text: `*Date:*\n${new Date(paymentRequest.date).toLocaleString(
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
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*Demandeur:*\n<@${paymentRequest.demandeur}>`,
					},
					{
						type: "mrkdwn",
						text: `*Canal:*\n<#${paymentRequest.id_projet}>`,
					},
				],
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*Référence:*\n${
							paymentRequest.bon_de_commande || "Non spécifié"
						}`,
					},
					{
						type: "mrkdwn",
						text: `*Date requise:*\n${new Date(
							paymentRequest.date_requete
						).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
						})}`,
					},
				],
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*Montant:*\n${paymentRequest.montant} ${paymentRequest.devise}`,
					},
					{
						type: "mrkdwn",
						text: `*Motif:*\n${paymentRequest.motif || "Non spécifié"}`,
					},
				],
			},
			// ...(paymentRequest.justificatif ? [{
			//   type: "section",
			//   text: { type: "mrkdwn", text: `*Justificatif:*\n<${paymentRequest.justificatif}|Voir le document>` },
			// }] : []),
			// { type: "divider" },
		];

		// Add justificatifs section if any exist
		if (paymentRequest.justificatif && paymentRequest.justificatif.length > 0) {
			let justificatifsText = "*Justificatifs:*\n";

			paymentRequest.justificatif.forEach((doc, index) => {
				if (doc.type === "file") {
					// Use public URL prioritization
					const publicUrl =
						doc.url || doc.permalink || doc.url_private_download;
					justificatifsText += `• <${publicUrl}|Justificatif ${index + 1}>\n`;
				} else if (doc.type === "url") {
					justificatifsText += `• <${doc.url}|Lien externe ${index + 1}>\n`;
				}
			});

			blocks.push({
				type: "section",
				text: {
					type: "mrkdwn",
					text: justificatifsText,
				},
			});
		}

		// Add approval buttons for admin
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Approuver",
						emoji: true,
					},
					style: "primary",
					action_id: "approve_payment",
					value: paymentRequest.id_paiement,
				},
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Rejeter",
						emoji: true,
					},
					style: "danger",
					action_id: "reject_order",
					value: paymentRequest.id_paiement,
				},
			],
		});

		// Send confirmation to requester
		const userBlocks = [...blocks];
		// Remove action buttons for user notification
		userBlocks.pop();

		console.log(
			`Payment request notification sent: ${paymentRequest.id_paiement}`
		);
		return userBlocks;
	} catch (error) {
		console.log(`Error: ${error}`);
		throw error;
	}

	return [];
}
//* ?
async function generatePaymentForm1(formData = {}) {
	console.log("** generatePaymentForm1");

	const view = {
		type: "modal",
		callback_id: "payment_modif_submission",
		title: {
			type: "plain_text",
			text: "Modifier Paiement",
			emoji: true,
		},
		submit: {
			type: "plain_text",
			text: "Soumettre",
			emoji: true,
		},
		close: {
			type: "plain_text",
			text: "Annuler",
			emoji: true,
		},
		blocks: [
			{
				type: "input",
				block_id: "request_title",
				element: {
					type: "plain_text_input",
					action_id: "input_request_title",
					initial_value:
						formData.payment_title?.input_payment_title?.value || "",
				},
				label: {
					type: "plain_text",
					text: "Titre de la demande",
					emoji: true,
				},
			},
			{
				type: "input",
				block_id: "request_date",
				element: {
					type: "datepicker",
					action_id: "input_request_date",
					initial_date:
						formData.payment_date?.input_payment_date?.selected_date ||
						new Date().toISOString().split("T")[0],
				},
				label: {
					type: "plain_text",
					text: "Date de la requête",
					emoji: true,
				},
			},
			{
				type: "input",
				block_id: "payment_reason",
				element: {
					type: "plain_text_input",
					action_id: "input_payment_reason",
					multiline: true,
					initial_value:
						formData.payment_description?.input_payment_description?.value ||
						"",
				},
				label: {
					type: "plain_text",
					text: "Motif du paiement",
					emoji: true,
				},
			},
			{
				type: "input",
				block_id: "amount_to_pay",
				label: {
					type: "plain_text",
					text: "Montant",
				},
				element: {
					type: "plain_text_input",
					action_id: "input_amount_to_pay",
					placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
					initial_value:
						formData.payment_amount?.input_payment_amount?.value &&
						formData.currency
							? `${formData.payment_amount.input_payment_amount.value} ${formData.currency}`
							: "",
				},
				hint: {
					type: "plain_text",
					text: "Entrez un montant suivi de la devise (XOF, USD, EUR)",
				},
			},
			{
				type: "input",
				block_id: "po_number",
				optional: false,
				element: {
					type: "plain_text_input",
					action_id: "input_po_number",
					initial_value: formData.po_number?.input_po_number?.value || "",
				},
				label: {
					type: "plain_text",
					text: "Référence",
					emoji: true,
				},
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Justificatifs existants*",
				},
			},
			...(formData.existing_justificatifs?.length > 0
				? formData.existing_justificatifs.map((url, index) => ({
						type: "input",
						block_id: `existing_justificatif_${index}`,
						optional: true,
						label: {
							type: "plain_text",
							text: `Justificatif ${index + 1}`,
							emoji: true,
						},
						element: {
							type: "plain_text_input",
							action_id: `input_existing_justificatif_${index}`,
							placeholder: {
								type: "plain_text",
								text: "URL du justificatif",
							},
							initial_value: url,
						},
				  }))
				: []),
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Ajouter des justificatifs*",
				},
			},
			{
				type: "input",
				block_id: "justificatif",
				optional: true,
				label: {
					type: "plain_text",
					text: "Fichiers justificatifs",
					emoji: true,
				},
				element: {
					type: "file_input",
					action_id: "input_justificatif",
					filetypes: ["pdf", "doc", "docx", "jpg", "jpeg", "png"],
					max_files: 10,
				},
			},
			{
				type: "input",
				block_id: "justificatif_url",
				optional: true,
				label: {
					type: "plain_text",
					text: "URL du justificatif",
					emoji: true,
				},
				element: {
					type: "plain_text_input",
					action_id: "input_justificatif_url",
					placeholder: {
						type: "plain_text",
						text: "https://...",
					},
					initial_value:
						formData.justificatif_url?.input_justificatif_url?.value || "",
				},
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "Vous pouvez ajouter plusieurs fichiers ou une URL externe. Au moins un justificatif est recommandé.",
					},
				],
			},
		],
	};

	return view;
}
//* ???

function generatePaymentRequestForm(existingData = {}) {
	console.log("** xx generatePaymentRequestForm");
	const view = {
		type: "modal",
		callback_id: "payment_request_submission",
		title: { type: "plain_text", text: "Demande de Paiement", emoji: true },
		submit: { type: "plain_text", text: "Soumettre", emoji: true },
		close: { type: "plain_text", text: "Annuler", emoji: true },
		blocks: [
			{
				type: "input",
				block_id: "request_title",
				element: {
					type: "plain_text_input",
					action_id: "input_request_title",
					// initial_value:
					//   // existingData.title ||
					//   "Entrez le titre",
				},
				label: { type: "plain_text", text: "Titre de la demande", emoji: true },
			},
			{
				type: "input",
				block_id: "request_date",
				element: {
					type: "datepicker",
					action_id: "input_request_date",
					initial_date:
						existingData.date || new Date().toISOString().split("T")[0],
				},
				label: { type: "plain_text", text: "Date de la requête", emoji: true },
			},
			{
				type: "input",
				block_id: "payment_reason",
				element: {
					type: "plain_text_input",
					action_id: "input_payment_reason",
					multiline: true,
					initial_value: existingData.reason || "",
				},
				label: { type: "plain_text", text: "Motif du paiement", emoji: true },
			},
			{
				type: "input",
				block_id: `amount_to_pay`,
				label: { type: "plain_text", text: "Montant" },
				element: {
					type: "plain_text_input",
					action_id: `input_amount_to_pay`,
					placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
					initial_value: existingData.amount || "",
				},
				hint: {
					type: "plain_text",
					text: "Entrez un montant suivi de la devise (XOF, USD, EUR)",
				},
			},

			{
				type: "input",
				block_id: "po_number",
				optional: false,
				element: {
					type: "plain_text_input",
					action_id: "input_po_number",

					// initial_value: existingData.poNumber || "",
				},
				label: {
					type: "plain_text",
					text: "Référence",
					emoji: true,
				},
			},

			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Justificatifs*",
				},
			},
			{
				type: "input",
				block_id: "justificatif",
				optional: true,
				label: {
					type: "plain_text",
					text: "Fichiers justificatifs",
					emoji: true,
				},
				element: {
					type: "file_input",
					action_id: "input_justificatif",
					filetypes: ["pdf", "doc", "docx", "jpg", "jpeg", "png"],
					max_files: 10, // Allow multiple files
				},
			},
			{
				type: "input",
				block_id: "justificatif_url",
				optional: true,
				label: {
					type: "plain_text",
					text: "URL du justificatif",
					emoji: true,
				},
				element: {
					type: "plain_text_input",
					action_id: "input_justificatif_url",
					placeholder: {
						type: "plain_text",
						text: "https://...",
					},
				},
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "Vous pouvez ajouter plusieurs fichiers ou une URL externe. Au moins un justificatif est recommandé.",
					},
				],
			},

			// Include these blocks in your payment request modal
		],
	};
	return view;
}

const getFinancePaymentBlocks = (
	paymentRequest,
	validatedBy,
	selectedCaisseId,
	actionsElements
) => [
	// Titre and validated by in the same section

	...getPaymentRequestBlocks(paymentRequest, validatedBy),
	{ type: "divider" },
	{
		type: "actions",
		elements: actionsElements,
	},
	// Block context supplémentaire demandé
	{
		type: "context",
		elements: [
			{
				type: "mrkdwn",
				text: `✅ *Validé par:* <@${validatedBy}> le ${new Date(
					paymentRequest.validatedAt
				).toLocaleString("fr-FR", {
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

module.exports = {
	generatePaymentForm1,
	getFinancePaymentBlocks,
	generatePaymentRequestForm,
	getPaymentRequestBlocks,
};
