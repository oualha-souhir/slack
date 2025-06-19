// src/notificationService.js
const { postSlackMessage } = require("./utils");
const { Order, PaymentRequest, OrderMessage } = require("./db");
const axios = require("axios");
const mongoose = require("mongoose");

// Reintroduced and optimized getPaymentRequestBlocks
function getPaymentRequestBlocks(paymentRequest, validatedBy = null) {
	try {
		// Create blocks for notification
		const blocks = [
			{
				type: "header",
				text: {
					type: "plain_text",

					text: `Demande de paiement: ${paymentRequest.id_paiement}`,
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
						text: `*Channel:*\n<#${paymentRequest.id_projet}>`,
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
					justificatifsText += `• <${doc.url}|Justificatif ${index + 1}>\n`;
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
		console.log(`Error in notifyPaymentRequest: ${error}`);
		throw error;
	}

	return [];
}

// New function to notify both admin and demandeur about payment requests
async function notifyPaymentRequest(
	paymentRequest,
	context,
	validatedBy = null
) {
	console.log("** notifyPaymentRequest");
	const adminBlocks = [
		...getPaymentRequestBlocks(paymentRequest, validatedBy),
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Autoriser", emoji: true },
					style: "primary",
					action_id: "payment_verif_accept",
					value: paymentRequest.id_paiement,
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Rejeter", emoji: true },
					style: "danger",
					action_id: "reject_order",
					value: paymentRequest.id_paiement,
				},
			],
		},
		{
			type: "context",
			elements: [{ type: "mrkdwn", text: "⏳ En attente de validation" }],
		},
	];
	console.log("paymentRequest.statut", paymentRequest);

	const demandeurBlocks = [
		...getPaymentRequestBlocks(paymentRequest, validatedBy),
		// Add edit button only if payment is still pending
		// ...(paymentRequest.statut === "En attente"
		//   ? [
		{
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Modifier", emoji: true },
					style: "primary",
					action_id: "edit_payment",
					value: paymentRequest.id_paiement,
				},
			],
		},

		// : []),
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "✅ Votre demande de paiement a été soumise. En attente de validation par un administrateur.",
				},
			],
		},
	];

	try {
		// Notify Admin
		context.log(
			`Sending payment request notification to admin channel: ${process.env.SLACK_ADMIN_ID}`
		);
		const adminResponse = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `Nouvelle demande de paiement *${paymentRequest.id_paiement}* par <@${paymentRequest.demandeur}>`,
				blocks: adminBlocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		if (!adminResponse.ok)
			throw new Error(`Admin notification failed: ${adminResponse.error}`);

		// Notify Demandeur
		context.log(
			`Sending payment request notification to demandeur: ${paymentRequest.demandeur}`
		);
		console.log("paymentRequest.demandeur", paymentRequest.demandeur);
		const demandeurResponse = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: paymentRequest.demandeurId,
				text: `Demande de paiement *${paymentRequest.id_paiement}* soumise`,
				blocks: demandeurBlocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		// Save message details in the database
		await PaymentRequest.findOneAndUpdate(
			{ id_paiement: paymentRequest.id_paiement },
			{
				demandeur_message: {
					channel: paymentRequest.demandeurId,
					ts: demandeurResponse.ts,
				},
				admin_message: {
					channel: process.env.SLACK_ADMIN_ID,
					ts: adminResponse.ts,
				},
			},
			{ new: true }
		);
		if (!demandeurResponse.ok)
			throw new Error(
				`Demandeur notification failed: ${demandeurResponse.error}`
			);

		return { adminResponse, demandeurResponse };
	} catch (error) {
		context.log(`❌ notifyPaymentRequest failed: ${error.message}`);
		throw error;
	}
}
// You may need to adjust this function to match your actual implementation
async function postSlackMessageWithRetry(
	url,
	body,
	token,
	context,
	retries = 3
) {
	console.log("** postSlackMessageWithRetry");
	let lastError = null;
	console.log(`Sending Slack message: ${JSON.stringify(body)}`);
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const response = await axios.post(url, body, {
				headers: { Authorization: `Bearer ${token}` },
			});

			// Log successful response for debugging
			if (attempt > 1) {
				console.log(`Success on retry attempt ${attempt}`);
			}

			// Return the actual response.data, not the full axios response
			return response.data;
		} catch (error) {
			lastError = error;
			console.log(`Attempt ${attempt} failed: ${error.message}`);

			if (attempt < retries) {
				// Wait with exponential backoff before retrying (100ms, 200ms, 400ms, etc.)
				await new Promise((resolve) =>
					setTimeout(resolve, 100 * Math.pow(2, attempt - 1))
				);
			}
		}
	}

	// All retries failed
	throw lastError || new Error("All retries failed with unknown error");
}

// Helper to fetch order or payment request
async function fetchEntity(id, context) {
	console.log("** fetchEntity");
	console.log("id1", id);
	let entity;
	// Ensure id is a string; convert it if possible, or handle invalid cases
	if (typeof id !== "string") {
		if (id && typeof id === "object" && id.id_paiement) {
			id = id.id_paiement; // Extract id_paiement if id is an object
		} else {
			context.log(`❌ Invalid id provided: ${id}`);
			return null; // Or throw an error, depending on your needs
		}
	}
	if (id.startsWith("CMD/")) {
		entity = await Order.findOne({ id_commande: id });
		if (!entity) context.log(`❌ Order ${id} not found`);
	} else if (id.startsWith("PAY/")) {
		entity = await PaymentRequest.findOne({ id_paiement: id });
		if (!entity) context.log(`❌ Payment request ${id} not found`);
	}
	return entity;
}
// New function to generate article blocks with photos
// ...existing code...

// Improved display format for article blocks
function generateArticleBlocks(articles) {
    if (!articles || articles.length === 0) {
        return [{
            type: "section",
            text: {
                type: "mrkdwn",
                text: "📋 *Aucun article spécifié*",
            },
        }];
    }

    return articles.flatMap((article, index) => {
        const articleNumber = index + 1;
        const blocks = [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: ` *${articleNumber}.* ${article.designation || 'Article sans nom'}\n` +
                          ` • *Quantité:* ${article.quantity || 1} ${article.unit || 'unité(s)'}`
                },
            }
        ];

        // Add photos for this specific article if they exist
        if (article.photos && article.photos.length > 0) {
            blocks.push(...generateArticlePhotosBlocks(article.photos, articleNumber));
        }

        return blocks;
    });
}

// ...existing code...


// Reusable block generation functions
function getOrderBlocks(order, requestDate) {
	console.log("** getOrderBlocks");
	return [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: `📦 Commande: ${order.id_commande}`,
				emoji: true,
			},
		},
		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*Titre:*\n${order.titre}` },
				{
					type: "mrkdwn",
					text: `*Date:*\n${new Date(order.date).toLocaleString("fr-FR", {
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
				{ type: "mrkdwn", text: `*Demandeur:*\n<@${order.demandeur}>` },
				{ type: "mrkdwn", text: `*Channel:*\n<#${order.channelId}>` },
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Équipe:*\n${order.equipe || "Non spécifié"}`,
				},
				{
					type: "mrkdwn",
					text: `*Date requise:*\n${
						new Date(order.date_requete).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
						}) || new Date().toISOString()
					}`,
				},
			],
		},
		{ type: "divider" },
		{ type: "section", text: { type: "mrkdwn", text: `*Articles*` } },
		        ...generateArticleBlocks(order.articles),

		{ type: "divider" },
	];
}
// New function to generate photo blocks for individual articles
function generateArticlePhotosBlocks(articlePhotos, articleNumber) {
    if (!articlePhotos || articlePhotos.length === 0) {
        return [];
    }

    // Create photo links separated by backslashes
    const photoLinks = articlePhotos
        .map((photo, index) => `<${photo.permalink || photo.url}|Photo ${index + 1}>`)
        .join(' | ');

    return [
        {
            type: "section",
            text: {
                type: "mrkdwn",
                text: `  • *Photo(s):* ${photoLinks}`,
            },
        },
    ];
}
function getProformaBlocks(order) {
	console.log("** getProformaBlocks");
	const proformas = order.proformas || [];
	return proformas.length > 0
		? proformas
				.map((p) => ({
					type: "section", // Ensure correct type (no typo like "s ection")
					text: {
						type: "mrkdwn",
						text: `*${p.nom}*${
							p.fournisseur ? ` - Fournisseur: *${p.fournisseur}*` : ""
						} - Montant: *${p.montant}* ${p.devise}\n   *URLs:*\n${p.urls
							.map((url, j) => `     ${j + 1}. <${url}|Page ${j + 1}>`)
							.join("\n")}`,
					},
				}))
				.concat([{ type: "divider" }])
		: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Proformas - Aucun proforma disponible*",
					},
				},
				{ type: "divider" },
		  ];
}

async function getPaymentBlocks(
	entity,
	paymentData,
	remainingAmount,
	paymentStatus
) {
	console.log("** getPaymentBlocks");
	//console.log("entity111",entity);

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
				text: `*Numéro de transaction:*\n${
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
	return [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: `💲 Paiement Enregistré: ${
					entity.id_commande || entity.id_paiement
				}`,
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
					text: `*Reste à payer:*\n${remainingAmount} ${currency}`,
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
				{ type: "mrkdwn", text: `*Statut de paiement:*\n${paymentStatus}` },
			],
		},
		...(additionalDetails.length > 0 ? [
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
] : []),
{ type: "divider" },
		{ type: "section", text: { type: "mrkdwn", text: `*Justificatif(s)*` } },

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

// Update the saveMessageReference function to include a message type
async function saveMessageReference(
	orderId,
	messageTs,
	channelId,
	messageType = "admin"
) {
	console.log("** saveMessageReference");
	try {
		// Define a schema for message references if not already defined
		if (!mongoose.models.MessageReference) {
			const MessageReferenceSchema = new mongoose.Schema({
				orderId: { type: String, required: true },
				messageTs: { type: String, required: true },
				channelId: { type: String, required: true },
				messageType: { type: String, required: true, default: "admin" },
				updatedAt: { type: Date, default: Date.now },
			});
			mongoose.model("MessageReference", MessageReferenceSchema);
		}

		const MessageReference = mongoose.model("MessageReference");

		// Try to update existing reference first
		const result = await MessageReference.findOneAndUpdate(
			{ orderId, messageType },
			{ messageTs, channelId, updatedAt: new Date() },
			{ new: true, upsert: false }
		);

		// If no document was updated, create a new one
		if (!result) {
			await MessageReference.create({
				orderId,
				messageTs,
				channelId,
				messageType,
				updatedAt: new Date(),
			});
		}

		return true;
	} catch (error) {
		console.error(`Error saving message reference: ${error.message}`);
		return false;
	}
}

// Update the getMessageReference function to filter by message type
async function getMessageReference(orderId, messageType = "admin") {
	console.log("** getMessageReference");
	try {
		if (!mongoose.models.MessageReference) {
			return null;
		}

		const MessageReference = mongoose.model("MessageReference");
		return await MessageReference.findOne({ orderId, messageType });
	} catch (error) {
		console.error(`Error retrieving message reference: ${error.message}`);
		return null;
	}
}

async function notifyPayment(
	entityId,
	notifyPaymentData,
	totalAmountDue,
	remainingAmount,
	paymentStatus,
	context,
	target,
	userId
) {
	console.log("** notifyPayment");
	console.log("target", target);
	const entity = await fetchEntity(entityId, context);
	console.log("userId", userId);

	const validatedBy = entityId.validatedBy || "unknown";
	if (!entity) return;

	const blocks = await getPaymentBlocks(
		entity,
		notifyPaymentData,
		remainingAmount,
		paymentStatus
	);
	console.log("FIN getPaymentBlocks");

	const channel =
		target === "finance"
			? process.env.SLACK_FINANCE_CHANNEL_ID
			: target === "admin"
			? process.env.SLACK_ADMIN_ID
			: entity.demandeurId;
	const text = `💲 Paiement Enregistré pour ${entityId}`;
	if (target === "finance" && remainingAmount > 0) {
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
					value: entityId,
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
					value: entityId,
				},
			],
		});
	}
	if (target === "user") {
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
					value: entityId,
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

	const response = await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{ channel, text, blocks },
		process.env.SLACK_BOT_TOKEN,
		context
	);
	console.log("1Slack API response:", response);
	if (!response.ok) {
		console.error(
			`❌ Failed to notify ${target} about payment for ${entityId}: ${response.error}`
		);
		// const response1 = await postSlackMessageWithRetry(
		//   "https://slack.com/api/chat.postMessage",
		//   {
		//     channel: process.env.SLACK_FINANCE_CHANNEL_ID,
		//     text:       `❌ Failed to notify ${target} about payment for ${entityId}: ${response.error}`        ,
		//     blocks: [
		//       {
		//         type: "context",
		//         elements: [
		//           {
		//             type: "mrkdwn",
		//             text: `*Détails:* ${response.error || "Aucun détail fourni"}`,
		//           },
		//         ],
		//       },
		//     ],
		//   },
		//   process.env.SLACK_BOT_TOKEN
		// );
		console.log("1Slack API response:", response1);
	}

	console.log(`${target} notified about payment for ${entityId}`);
}
function getProformaBlocks1(order) {
	console.log("** getProformaBlocks1");
	const proformas = order.proformas || [];
	// Filter for validated proformas only when sending to finance (proformas.length > 0 implies finance notification)
	const relevantProformas =
		proformas.length > 0
			? proformas.filter((p) => p.validated === true)
			: proformas;

	return relevantProformas.length > 0
		? relevantProformas
				.map(
					(p) => (
						{ type: "section", text: { type: "mrkdwn", text: `*Proforma*` } },
						{
							type: "section", // Ensure correct type (no typo like "s ection")
							text: {
								type: "mrkdwn",
								text: `*${p.nom}*${
									p.fournisseur ? ` - Fournisseur: *${p.fournisseur}*` : ""
								} - Montant: *${p.montant}* ${p.devise}\n   *URLs:*\n${p.urls
									.map((url, j) => `     ${j + 1}. <${url}|Page ${j + 1}>`)
									.join("\n")}`,
							},
						}
					)
				)
				.concat([{ type: "divider" }])
		: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Proformas - Aucun proforma validé disponible*",
					},
				},
				{ type: "divider" },
		  ];
}

// Modifiez notifyTeams pour sauvegarder la référence du message dans le canal achat
async function notifyTeams(payload, order, context) {
	console.log("** notifyTeams");
	console.log("notifyTeams1", notifyTeams);
	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];
	const validatedBy = payload.user.id;
	console.log("validatedBy1", validatedBy);

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
							{
								type: "mrkdwn",
								text: `✅ Validé par: <@${validatedBy}>`,
							},
						],
					},
			  ]
			: [
					...getOrderBlocks(order, requestDate),
					// ...productPhotoBlocks,
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
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `✅ Validé par: <@${validatedBy}>`,
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
	if (response.ok) {
		const messageType =
			channel === process.env.SLACK_ACHAT_CHANNEL_ID ? "achat" : "finance";
		await saveMessageReference(
			order.id_commande,
			response.ts,
			channel,
			messageType
		);
	}

	return response;
}

// Modifiez notifyAdminProforma pour mettre à jour le message existant
async function notifyAdminProforma(order, context, proformaIndex) {
	console.log("** notifyAdminProforma");
	context.log(
		`notifyTeams called for order ${
			order.id_commande
		} at ${new Date().toISOString()}`
	);
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
										text: `:white_check_mark: Validée ${
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
										text: `:white_check_mark: Validée ${
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
		// D'abord, mise à jour du message dans le canal achat
		try {
			// Récupérer la référence du message existant pour l'équipe achat
			const achatMessageRef = await getMessageReference(
				order.id_commande,
				"achat"
			);
			console.log("achatMessageRef", achatMessageRef);

			if (achatMessageRef && achatMessageRef.messageTs) {
				console.log(
					`Updating existing achat message for order ${order.id_commande}.`
				);
				// Mettre à jour le message existant
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.update",
					{
						channel: achatMessageRef.channelId,
						ts: achatMessageRef.messageTs,
						text: `Proformas pour ${order.id_commande} (Mis à jour)`,
						blocks: achatBlocks,
					},
					process.env.SLACK_BOT_TOKEN,
					context
				);
			} else {
				console.log(
					`No existing achat message found for order ${order.id_commande}, creating a new one.`
				);
				// Si aucun message existant n'est trouvé, créer un nouveau message
				const achatResponse = await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: process.env.SLACK_ACHAT_CHANNEL_ID,
						text: `Proformas pour ${order.id_commande}`,
						blocks: achatBlocks,
					},
					process.env.SLACK_BOT_TOKEN,
					context
				);

				// Sauvegarder la référence au nouveau message achat
				if (achatResponse.ok) {
					await saveMessageReference(
						order.id_commande,
						achatResponse.ts,
						process.env.SLACK_ACHAT_CHANNEL_ID,
						"achat"
					);
				}
			}
		} catch (achatError) {
			context.log(
				`Warning: Failed to update achat channel: ${achatError.message}`
			);
		}

		// Maintenant, gérer la notification admin
		// const adminMessageRef = await getMessageReference(
		//   order.id_commande,
		//   "admin"
		// );
		// Find the correct Slack message in the array
		const adminMessage = order.slackMessages.find(
			(msg) => msg.messageType === "notification"
		);
		const adminMessageRef = adminMessage ? adminMessage : undefined;

		if (adminMessageRef && adminMessageRef.ts) {
			// Mettre à jour le message admin existant
			try {
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.update",
					{
						channel: adminMessageRef.channel,
						ts: adminMessageRef.ts,
						text: `Proformas pour ${order.id_commande} (Mis à jour)`,
						blocks: adminBlocks,
					},
					process.env.SLACK_BOT_TOKEN,
					context
				);
			} catch (updateError) {
				context.log(`❌ Error updating admin message: ${updateError.message}`);
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
				context
			);

			// Sauvegarder la référence au nouveau message admin
			if (postResponse.ok) {
				await saveMessageReference(
					order.id_commande,
					postResponse.ts,
					process.env.SLACK_ADMIN_ID,
					"admin"
				);
			}
		}

		return { success: true };
	} catch (error) {
		context.log(
			`❌ Error in notifyAdminProforma: ${error.message}\nStack: ${error.stack}`
		);
		return { success: false, error: error.message };
	}
}
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
		inferredType = "proforma";
		console.log(
			`Overriding type from 'admin' to 'proforma' for order ${order.id_commande}, reminderId: ${reminderId}`
		);
	} else if (
		order.statut === "Validé" &&
		order.payments.length === 0 &&
		order.proformas.length > 0 &&
		normalizedType === "admin"
	) {
		inferredType = "payment";
		console.log(
			`Overriding type from 'admin' to 'payment' for order ${order.id_commande}, reminderId: ${reminderId}`
		);
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
								text: { type: "plain_text", text: "Autoriser", emoji: true },
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
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel,
				text: `⏰ Commande en attente dépassant 24h (${inferredType}) [reminderId: ${reminderId}]`,
				blocks,
			},
			process.env.SLACK_BOT_TOKEN,
			console
		);
		console.log(
			`Successfully sent reminder for ${order.id_commande} to ${channel}, reminderId: ${reminderId}`
		);
	} catch (error) {
		console.log(
			`Failed to send reminder for ${order.id_commande} to ${channel}: ${error.message}, reminderId: ${reminderId}`
		);
		throw error;
	}

	await Order.findOneAndUpdate(
		{ id_commande: order.id_commande },
		{
			$set: { [`${inferredType}_reminder_sent`]: true },
			$push: {
				delay_history: {
					type: `${inferredType}_reminder`,
					timestamp: new Date(),
					reminderId, // Store reminderId for traceability
				},
			},
		}
	);
}
// Fonction pour générer les blocs d'affichage des photos (à ajouter dans notificationService.js)
function generateProductPhotosBlocks(productPhotos) {
	if (!productPhotos || productPhotos.length === 0) {
		return [];
	}

	const blocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: "*Photos*",
			},
		},
	];

	// Grouper les photos par blocs de 5 (limite Slack)
	for (let i = 0; i < productPhotos.length; i += 5) {
		const photoGroup = productPhotos.slice(i, i + 5);
		const photoElements = photoGroup.map((photo, index) => ({
			type: "mrkdwn",
			text: `<${photo.permalink}| Photo ${i + index + 1}>`,
		}));

		blocks.push({
			type: "section",
			fields: photoElements,
		});
	}
	blocks.push({ type: "divider" });

	return blocks;
}
async function notifyAdmin(
	order,
	context,
	isEdit = false,
	admin_action = false,
	status
) {
	console.log("** notifyAdmin");
	// Ajouter les blocs des photos après les articles
	// const productPhotoBlocks = generateProductPhotosBlocks(order.productPhotos);
	const requestDate =
		order.date_requete || new Date(order.date).toISOString().split("T")[0];
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
		...getOrderBlocks(order, requestDate),
		// ...productPhotoBlocks,
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
							text: `Demande ${status}e avec succués`,
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
				text: `Commande reçue: ${order.id_commande}`,
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

// Database helpers (unchanged from your original)
async function saveOrderMessageToDB(orderId, messageDetails) {
	console.log("** saveOrderMessageToDB");
	try {
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) return false;
		if (!order.slackMessages) order.slackMessages = [];
		order.slackMessages = [
			{
				channel: messageDetails.channel,
				ts: messageDetails.ts,
				messageType: "notification",
				createdAt: new Date(),
			},
		];
		await order.save();
		return true;
	} catch (error) {
		console.error("Error saving order message to DB:", error);
		return false;
	}
}

async function getOrderMessageFromDB(orderId) {
	console.log("** getOrderMessageFromDB");
	try {
		const order = await Order.findOne({ id_commande: orderId });
		if (!order || !order.slackMessages?.length) return null;
		return {
			channel: order.slackMessages[0].channel,
			ts: order.slackMessages[0].ts,
			orderId,
		};
	} catch (error) {
		console.error("Error retrieving order message from DB:", error);
		return null;
	}
}
// If notifyUserAI exists, define it properly
// Improved notifyUserAI function with better error handling
// Make sure your notifyUserAI function is properly structured
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
		logger.log(`Notification error: ${error.message}`);
		return { success: false, error: error.message };
	}
}

module.exports = {
	notifyAdmin,
	getOrderBlocks,
	getProformaBlocks,
	notifyUserAI,
	notifyUser,
	notifyAdminProforma,
	getProformaBlocks1,
	notifyTeams,
	notifyPayment: (
		entityId,
		notifyPaymentData,
		totalAmountDue,
		remainingAmount,
		paymentStatus,
		context,
		target,
		userId
	) =>
		notifyPayment(
			entityId,
			notifyPaymentData,
			totalAmountDue,
			remainingAmount,
			paymentStatus,
			context,
			target,
			userId
		),
	sendDelayReminder: (order, type) => sendDelayReminder(order, type),
	postSlackMessageWithRetry,
	notifyPaymentRequest,
	getPaymentRequestBlocks,
	getPaymentBlocks,
	getMessageReference,
};
