const {
	postSlackMessage,
	postSlackMessageWithRetry,
	postSlackMessage2,
} = require("../../Common/slackUtils");
const { WebClient } = require("@slack/web-api");
const { syncCaisseToExcel } = require("../../Excel/report");
const { notifyPayment } = require("./paymentNotifications");
const {
	bankOptions,
	isValidUrl,
	getFileInfo,
	fetchEntity,
} = require("../../Common/utils");
const {
	notifyPaymentRequest,
} = require("../../Payment Request/Handlers/paymentRequestNotification");
const {
	generatePaymentRequestId,
} = require("../../Payment Request/PaymentSubcommands");

const {
	DecaissementCounter,
	PaymentCounter,
	Caisse,
} = require("../../Database/dbModels/Caisse");

const { Order } = require("../../Database/dbModels/Order");
const PaymentRequest = require("../../Database/dbModels/PaymentRequest");
const {
	getProblemTypeText,
} = require("../../Caisse/Handlers/caisseProblemHandlers");
const { notifyTechSlack } = require("../../Common/notifyProblem");

// Initialize the Slack client
const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// Initialize fetch
let fetch;
(async () => {
	fetch = (await import("node-fetch")).default;
})();
async function handlePaymentRequestSubmission(
	payload,
	context,
	formData,
	userId,
	channelId,
	slackToken
) {
	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		const project = channelId;
		const title = formData.request_title?.input_request_title?.value;
		const date = formData.request_date?.input_request_date?.selected_date;
		const reason = formData.payment_reason?.input_payment_reason?.value;

		const amountInput = formData.amount_to_pay.input_amount_to_pay.value;
		console.log("amountInput", amountInput);

		// Parse amount and currency
		const amountMatch = amountInput.match(/(\d+(?:\.\d+)?)\s*([A-Z]{3})/);
		if (!amountMatch) {
			return await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: userId,

					text: "⚠️ Le format du montant est incorrect. Exemple attendu: 1000 XOF",
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		const amount = parseFloat(amountMatch[1]);
		const currency = amountMatch[2];
		console.log("111111");

		if (!["XOF", "EUR", "USD"].includes(currency)) {
			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: userId,
					text: "⚠️ Erreur: Devise non reconnue. Les devises acceptées sont: XOF, USD, EUR. Veuillez modifier votre demande.",
				},
				process.env.SLACK_BOT_TOKEN
			);

			return { response_action: "clear" };
		}
		console.log("currency", currency);
		console.log("amount", amount);

		const poNumber = formData.po_number?.input_po_number?.value || null;

		// Extract multiple justificatifs
		const justificatifs = await extractJustificatifs(
			formData,
			context,
			userId,
			slackToken
		);
		console.log("justificatifs", justificatifs);
		// Check if justificatifs are provided
		const hasFiles =
			formData.justificatif?.input_justificatif?.files?.length > 0;
		const hasUrl =
			formData.justificatif_url?.input_justificatif_url?.value?.trim();

		if (!hasFiles && !hasUrl) {
			await postSlackMessage(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: channelId,
					user: payload.user.id,
					text: `❌ Veuillez ajouter un justificatif (fichier ou URL).`,
				},
				process.env.SLACK_BOT_TOKEN
			);
			return { response_action: "clear" };
		}
		// Validation
		const errors = {};
		if (!title) errors.request_title = "Titre requis";
		if (!date || new Date(date) < new Date().setHours(0, 0, 0, 0)) {
			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: userId, // This sends a DM to the user
					text: "⚠️ *Erreur*: La date sélectionnée est dans le passé. Veuillez rouvrir le formulaire et sélectionner une date d'aujourd'hui ou future.",
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "⚠️ *Erreur*: La date sélectionnée est dans le passé.",
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "Veuillez créer une nouvelle commande et sélectionner une date d'aujourd'hui ou future.",
							},
						},
					],
				},
				process.env.SLACK_BOT_TOKEN
			);
			errors.request_date = "Date invalide ou dans le passé";
		}
		if (!reason) errors.payment_reason = "Motif requis";
		if (!amount || isNaN(amount) || amount <= 0)
			errors.amount_to_pay = "Montant invalide";

		if (Object.keys(errors).length > 0) {
			return { response_action: "errors", errors };
		}

		// Generate payment ID
		const paymentId = await generatePaymentRequestId();
		console.log("ùjustificatifs", justificatifs);
		// Save to database
		const paymentRequest = new PaymentRequest({
			id_paiement: paymentId,
			project: channelId,
			id_projet: channelId, // Add this required field

			titre: title,
			demandeur: userId,
			demandeurId: userId, // Add demandeurId if required

			date_requete: new Date(date),
			motif: reason,
			montant: amount,
			bon_de_commande: poNumber,
			justificatif: justificatifs, // Save array of justificatifs
			devise: currency,
			status: "En attente",
		});
		await paymentRequest.save();

		// Notify admin and demandeur
		await notifyPaymentRequest(paymentRequest, context, payload.user.id);
	});

	return context.res;
}
async function handlePaymentProblemModal(
	payload,
	context,
	messageTs,
	callback_id,
	entityId,
	selectedCaisseId,
	entity
) {
	console.log("===+ 2 callback_id == payment_problem_submission");
	console.log("entityId", entityId);
	console.log("selectedCaisseId", selectedCaisseId);
	console.log("entity", entity);
	console.log("messageTs", messageTs);
	console.log("payload", payload);
	console.log("callback_id", callback_id);
	if (!entity) {
		entity = await fetchEntity(entityId, context);
		if (!entity) {
			throw new Error(`Entity not found for ID: ${entityId}`);
		}
	}
	// Open confirmation modal
	const view = {
		type: "modal",
		callback_id: callback_id,
		private_metadata: JSON.stringify({
			entityId: entityId,
			paymentIndex:
				callback_id === "payment_problem_submission"
					? entity.payments.length - 1
					: undefined,
			channelId: payload.channel.id,
			userId: payload.user.username,
			messageTs: messageTs,
			selectedCaisseId: selectedCaisseId,
		}),
		title: {
			type: "plain_text",
			text: "Signaler un problème",
			emoji: true,
		},
		submit: {
			type: "plain_text",
			text: "Envoyer",
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
					text: `*Signalement d'un problème pour ${entityId}*`,
				},
			},
			{
				type: "divider",
			},
			{
				type: "input",
				block_id: "problem_type",
				element: {
					type: "static_select",
					action_id: "select_problem_type",
					options: [
						{
							text: {
								type: "plain_text",
								text: "Montant incorrect",
							},
							value: "wrong_amount",
						},
						{
							text: {
								type: "plain_text",
								text: "Mode de paiement incorrect",
							},
							value: "wrong_payment_mode",
						},
						{
							text: {
								type: "plain_text",
								text: "Justificatif manquant ou incorrect",
							},
							value: "wrong_proof",
						},
						{
							text: {
								type: "plain_text",
								text: "Détails bancaires incorrects",
							},
							value: "wrong_bank_details",
						},
						{
							text: {
								type: "plain_text",
								text: "Autre problème",
							},
							value: "other",
						},
					],
				},
				label: {
					type: "plain_text",
					text: "Type de problème",
					emoji: true,
				},
			},
			{
				type: "input",
				block_id: "problem_description",
				element: {
					type: "plain_text_input",
					action_id: "input_problem_description",
					multiline: true,
				},
				label: {
					type: "plain_text",
					text: "Description du problème",
					emoji: true,
				},
			},
		],
	};

	const response = await postSlackMessage2(
		"https://slack.com/api/views.open",
		{ trigger_id: payload.trigger_id, view },
		process.env.SLACK_BOT_TOKEN
	);
	if (!response.data.ok) {
		throw new Error(`Slack API error: ${response.data.error}`);
	}
	return { response_action: "update" };
}
async function extractJustificatifs(formData, context, userId, slackToken) {
	try {
		console.log("** extractJustificatifs");
		const justificatifs = [];

		// Extract file uploads
		// if (formData.justificatif?.input_justificatif?.files?.length > 0) {
		// 	formData.justificatif.input_justificatif.files.forEach((file) => {
		// 		justificatifs.push({
		// 			url: file.permalink || file.url_private_download || file.url_private, // Use permalink first
		// 			url_private: file.url_private, // Keep private URL as backup
		// 			type: "file",
		// 			createdAt: new Date(),
		// 		});
		// 	});
		// }
		const proofFiles = formData.justificatif?.input_justificatif?.files || [];
		console.log(
			"proofFiles.length",
			proofFiles.length,
			"proofFiles",
			proofFiles
		);
		// const userId = payload.user.id;
		// Array to store processed payment proof URLs
		const paymentProofs = [];

		if (proofFiles.length > 0) {
			console.log(`Processing ${proofFiles.length} payment proof files...`);

			for (const file of proofFiles) {
				try {
					console.log(`Fetching file info for file ID: ${file.id}`);
					const fileInfo = await getFileInfo(
						file.id,
						process.env.SLACK_BOT_TOKEN
					);
					console.log("File info retrieved:", fileInfo);

					const privateUrl = fileInfo.url_private_download;
					const filename = fileInfo.name;
					const mimeType = fileInfo.mimetype;

					console.log(`Downloading file from URL: ${privateUrl}`);

					// Download the file from Slack
					const response = await fetch(privateUrl, {
						headers: {
							Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
						},
					});

					const arrayBuffer = await response.arrayBuffer();
					const buffer = Buffer.from(arrayBuffer);
					const fileSize = buffer.length;
					console.log(`File downloaded. Size: ${fileSize} bytes`);

					// Upload file directly using uploadV2
					console.log(`Uploading file to channel: ${filename}`);
					const uploadResult = await client.files.uploadV2({
						channel_id: process.env.SLACK_ORDER_LOG_FINANCE_CHANNEL, // Same channel as proforma
						file: buffer,
						filename: filename,
						// title: `Payment proof uploaded by <@${userId}>`,
						// initial_comment: `📎 New payment proof shared by <@${userId}>: ${filename}`,
					});

					console.log("File uploaded successfully:", uploadResult);

					// Extract the uploaded file ID from the response
					let uploadedFileId = null;
					if (uploadResult.files && uploadResult.files.length > 0) {
						// Handle nested files array structure
						const firstFile = uploadResult.files[0];
						if (firstFile.files && firstFile.files.length > 0) {
							uploadedFileId = firstFile.files[0].id;
						} else if (firstFile.id) {
							uploadedFileId = firstFile.id;
						}
					}

					if (!uploadedFileId) {
						throw new Error("Could not extract file ID from upload response");
					}

					console.log("Uploaded file ID:", uploadedFileId);

					// Fetch the file info to get permalink and other details
					const uploadedFileInfo = await getFileInfo(
						uploadedFileId,
						process.env.SLACK_BOT_TOKEN
					);
					console.log("Uploaded file info:", uploadedFileInfo);

					const filePermalink = uploadedFileInfo.permalink;
					console.log("File permalink:", filePermalink);

					// Optional: Send to specific colleagues via DM
					const colleagueUserIds = ["U08CYGSDBNW"]; // Replace with actual user IDs

					for (const colleagueId of colleagueUserIds) {
						try {
							// await client.chat.postMessage({
							//     channel: colleagueId, // Send as DM
							//     text: `📎 New payment proof shared by <@${userId}>: ${filename}`,
							//     attachments: [
							//         {
							//             title: filename,
							//             title_link: filePermalink,
							//             text: "Click to view the uploaded payment proof",
							//             color: "good",
							//         },
							//     ],
							// });
							console.log(`Notification sent to colleague: ${colleagueId}`);
						} catch (dmError) {
							await notifyTechSlack(dmError);

							console.error(`Error sending DM to ${colleagueId}:`, dmError);
						}
					}

					// Store the permalink for justificatifs
					justificatifs.push({
						url: filePermalink,
						type: "file",
						createdAt: new Date(),
					});
				} catch (error) {
					await notifyTechSlack(error);

					console.error("Error processing justificatif file:", error.message);
					console.error("Full error:", error);

					// // Send error notification to user
					// await postSlackMessage(
					// 	"https://slack.com/api/chat.postMessage",
					// 	{
					// 		channel: userId,
					// 		text: `⚠️ Erreur lors du traitement du fichier de preuve de paiement: ${error.message}`,
					// 	},
					// 	process.env.SLACK_BOT_TOKEN
					// );
				}
			}
		}
		// Process URL justificatif if provided
		const justificatifUrl =
			formData?.justificatif_url?.input_justificatif_url?.value;
		console.log("justificatifs URL:", justificatifUrl);

		if (justificatifUrl) {
			let validURL = await extractAndValidateUrl(
				justificatifUrl,
				justificatifs,
				userId,
				slackToken
			);

			if (!validURL) {
				// Send error message to user via Slack
				await postSlackMessage(
					"https://slack.com/api/chat.postMessage",
					{
						channel: userId,
						text: "⚠️ L'URL du justificatif n'est pas valide. Votre demande a été enregistrée sans l'URL.",
					},
					slackToken
				);
			}
		}

		// Return the collected justificatifs, even if empty
		return justificatifs;
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`Error extracting justificatifs: ${error}`);
		return [];
	}
}
async function handlePaymentFormModeSelection(payload, context) {
	console.log("** handlePaymentFormModeSelection");
	const selectedValue = payload.actions[0].selected_option?.value;
	console.log("Selected payment mode:", selectedValue);

	if (!selectedValue) {
		console.error("No payment mode selected in payload");
		return;
	}

	const viewId = payload.view.id;
	const privateMetadata = payload.view.private_metadata;
	console.log("::== Private metadata:", privateMetadata);
	const metadata = JSON.parse(privateMetadata);
	console.log("::== Parsed metadata:", metadata);
	// Extract selectedCaisseId from metadata
	const selectedCaisseId = metadata.selectedCaisseId;
	console.log("::== Selected caisse ID:", selectedCaisseId);

	// Get current blocks and remove existing payment method specific fields
	let blocks = payload.view.blocks.filter((block, index) => {
		// Keep base blocks and remove payment method specific blocks
		return (
			![
				"cheque_number",
				"cheque_bank",
				"cheque_date",
				"cheque_order",
				"virement_number",
				"virement_bank",
				"virement_date",
				"virement_order",
				"mobilemoney_recipient_phone",
				"mobilemoney_sender_phone",
				"mobilemoney_fees",
				"mobilemoney_date",
				"julaya_recipient",
				"julaya_date",
				"julaya_transaction_number",
				"accounting_required",
			].includes(block.block_id) &&
			!(block.type === "divider" && index > 4) &&
			!(block.type === "section" && block.text?.text?.includes("Détails"))
		);
	});

	// Add payment method specific blocks based on selection
	if (selectedValue === "Chèque") {
		blocks.push(
			{ type: "divider" },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Détails du chèque*",
				},
			},
			{
				type: "input",
				block_id: "cheque_number",
				label: { type: "plain_text", text: "Numéro du chèque" },
				element: {
					action_id: "input_cheque_number",
					type: "number_input",
					is_decimal_allowed: true,
					min_value: "0",
				},
			},
			{
				type: "input",
				block_id: "cheque_bank",
				label: { type: "plain_text", text: "Banque" },
				element: {
					type: "static_select",
					action_id: "input_cheque_bank",
					options: bankOptions,
				},
			},
			{
				type: "input",
				block_id: "cheque_date",
				label: { type: "plain_text", text: "Date du chèque" },
				element: { type: "datepicker", action_id: "input_cheque_date" },
			},
			{
				type: "input",
				block_id: "cheque_order",
				label: { type: "plain_text", text: "Ordre" },
				element: { type: "plain_text_input", action_id: "input_cheque_order" },
			}
		);
	} else if (selectedValue === "Virement") {
		blocks.push(
			{ type: "divider" },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Détails du virement*",
				},
			},
			{
				type: "input",
				block_id: "virement_number",
				label: { type: "plain_text", text: "Numéro de virement" },
				element: {
					type: "number_input",
					is_decimal_allowed: true,
					min_value: "0",
					action_id: "input_virement_number",
				},
			},
			{
				type: "input",
				block_id: "virement_bank",
				label: { type: "plain_text", text: "Banque" },
				element: {
					type: "static_select",
					action_id: "input_virement_bank",
					options: bankOptions,
				},
			},
			{
				type: "input",
				block_id: "virement_date",
				label: { type: "plain_text", text: "Date" },
				element: { type: "datepicker", action_id: "input_virement_date" },
			},
			{
				type: "input",
				block_id: "virement_order",
				label: { type: "plain_text", text: "Ordre" },
				element: {
					type: "plain_text_input",
					action_id: "input_virement_order",
				},
			}
		);
	} else if (selectedValue === "Mobile Money") {
		blocks.push(
			{ type: "divider" },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Détails du Mobile Money*",
				},
			},
			{
				type: "input",
				block_id: "mobilemoney_recipient_phone",
				label: { type: "plain_text", text: "Numéro de téléphone bénéficiaire" },
				element: {
					type: "number_input",
					is_decimal_allowed: true,
					min_value: "0",
					action_id: "input_mobilemoney_recipient_phone",
				},
			},
			{
				type: "input",
				block_id: "mobilemoney_sender_phone",
				label: { type: "plain_text", text: "Numéro envoyeur" },
				element: {
					type: "number_input",
					is_decimal_allowed: true,
					min_value: "0",
					action_id: "input_mobilemoney_sender_phone",
				},
			},
			{
				type: "input",
				block_id: "mobilemoney_fees",
				label: { type: "plain_text", text: "Frais" },
				element: {
					type: "number_input",
					is_decimal_allowed: true,
					min_value: "0",
					action_id: "input_mobilemoney_fees",
					placeholder: {
						type: "plain_text",
						text: "Montant des frais",
					},
				},
			},
			{
				type: "input",
				block_id: "mobilemoney_date",
				label: { type: "plain_text", text: "Date" },
				element: { type: "datepicker", action_id: "input_mobilemoney_date" },
			},
			{
				type: "input",
				block_id: "accounting_required",
				label: { type: "plain_text", text: "Comptabilisation requise ?" },
				element: {
					type: "radio_buttons",
					action_id: "input_accounting_required",
					options: [
						{
							text: {
								type: "plain_text",
								text: "Oui - Générer un numéro de pièce de caisse",
							},
							value: "yes",
						},
						{
							text: {
								type: "plain_text",
								text: "Non",
							},
							value: "no",
						},
					],
					// No initial_option here
				},
				optional: false, // This makes the field required
			}
		);
	} else if (selectedValue === "Julaya") {
		blocks.push(
			{ type: "divider" },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Détails Julaya*",
				},
			},
			{
				type: "input",
				block_id: "julaya_recipient",
				label: { type: "plain_text", text: "Bénéficiaire" },
				element: {
					type: "plain_text_input",
					action_id: "input_julaya_recipient",
				},
			},
			{
				type: "input",
				block_id: "julaya_date",
				label: { type: "plain_text", text: "Date" },
				element: { type: "datepicker", action_id: "input_julaya_date" },
			},
			{
				type: "input",
				block_id: "julaya_transaction_number",
				label: { type: "plain_text", text: "Numéro de transaction" },
				element: {
					type: "number_input",
					is_decimal_allowed: true,
					min_value: "0",
					action_id: "input_julaya_transaction_number",
				},
			}
		);
	} else if (selectedValue === "Espèces") {
		// NOUVEAU: Champ pour la comptabilisation (Espèces)
		blocks.push(
			{ type: "divider" },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Options de comptabilisation*",
				},
			},
			{
				type: "input",
				block_id: "accounting_required",
				label: { type: "plain_text", text: "Comptabilisation requise ?" },
				element: {
					type: "radio_buttons",
					action_id: "input_accounting_required",
					options: [
						{
							text: {
								type: "plain_text",
								text: "Oui - Générer un numéro de pièce de caisse",
							},
							value: "yes",
						},
						{
							text: {
								type: "plain_text",
								text: "Non",
							},
							value: "no",
						},
					],
					// No initial_option here
				},
				optional: false, // This makes the field required
			}
		);
	}

	// Update the modal
	try {
		await postSlackMessageWithRetry(
			"https://slack.com/api/views.update",
			{
				view_id: viewId,
				view: {
					type: "modal",
					callback_id: "payment_form_submission",
					private_metadata: privateMetadata,
					title: { type: "plain_text", text: "Formulaire Paiement" },
					submit: { type: "plain_text", text: "Soumettre" },
					close: { type: "plain_text", text: "Annuler" },
					blocks: blocks,
				},
			},
			process.env.SLACK_BOT_TOKEN
		);
		console.log("Payment form modal updated with payment method fields");
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error updating payment form modal:", error);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.user.id,
				user: payload.user.id,
				text: "❌ Erreur lors de la mise à jour du formulaire. Veuillez réessayer.",
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
}
async function calculateTotalAmountDue(orderId, context) {
	console.log("** calculateTotalAmountDue");
	// Check if this is a payment request or an order
	if (orderId.startsWith("PAY/")) {
		// This is a payment request
		const paymentRequest = await PaymentRequest.findOne({
			id_paiement: orderId,
		});
		if (!paymentRequest) {
			context.log(`Payment request not found: ${orderId}`);
			throw new Error("Commande non trouvée.");
		}
		// For payment requests, the total amount is simply the montant field
		return paymentRequest.montant;
	} else {
		// This is a regular order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			context.log(`Order not found: ${orderId}`);
			throw new Error("Commande non trouvée.");
		}
		// Calculate total from proformas for orders
		const validatedProforma = order.proformas.find((p) => p.validated);
		const totalAmountDue = validatedProforma.montant || 0;
		context.log(`Calculated totalAmountDue: ${totalAmountDue}`);
		return totalAmountDue;
	}
}
async function fetchDocument(orderId) {
	try {
		if (orderId.startsWith("CMD/")) {
			return await Order.findOne({ id_commande: orderId });
		} else if (orderId.startsWith("PAY/")) {
			return await PaymentRequest.findOne({ id_paiement: orderId });
		}
		return null;
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error fetching document:", error);
		return null;
	}
}

async function generatePaymentNumber(type = "generic", date = new Date()) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");

	let prefix, CounterModel;

	if (type === "decaissement") {
		prefix = "PC";
		CounterModel = DecaissementCounter;
	} else {
		prefix = "T";
		CounterModel = PaymentCounter;
	}

	// Identifiant unique pour le mois/année
	const periodId = `${year}${month}`;

	try {
		// Utilise Mongoose findOneAndUpdate avec upsert pour gérer l'atomicité
		const counter = await CounterModel.findOneAndUpdate(
			{ periodId: periodId },
			{ $inc: { sequence: 1 } },
			{
				upsert: true,
				new: true,
				returnDocument: "after",
			}
		);

		const sequenceNumber = String(counter.sequence).padStart(4, "0");
		const paymentNumber = `${prefix}/${year}/${month}/${sequenceNumber}`;

		console.log(`Generated ${type} payment number: ${paymentNumber}`);
		return paymentNumber;
	} catch (error) {
		await notifyTechSlack(error);

		console.error(`Error generating payment number: ${error.message}`);
		throw new Error(`Failed to generate payment number: ${error.message}`);
	}
}

function determinePaymentStatus(totalAmountDue, amountPaid) {
	console.log("** determinePaymentStatus");
	if (totalAmountDue < 0 || amountPaid < 0) {
		throw new Error(
			"Invalid amounts: totalAmountDue or amountPaid cannot be negative"
		);
	}
	if (amountPaid === 0) return "En attente";
	if (amountPaid < totalAmountDue) return "Non payé";
	return "Payé";
}
async function extractAndValidateUrl(url, justificatifs, userId, slackToken) {
	console.log("** extractAndValidateUrl");
	console.log("url1", url);

	// First check if url is null or undefined
	if (!url) {
		return true; // URL is optional, so null/undefined is valid
	}

	// Now we know url is not null/undefined, we can trim it
	const trimmedUrl = url.trim();

	if (trimmedUrl) {
		// Validate URL format
		if (isValidUrl(trimmedUrl)) {
			justificatifs.push({
				url: trimmedUrl,
				type: "url",
				createdAt: new Date(),
			});
			return true;
		} else {
			return false; // Invalid URL format
		}
	}

	return true; // Empty string after trimming is also valid
}

//* payment_form_submission
async function processPaymentSubmission(payload, context) {
	console.log("** processPaymentSubmission");

	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		try {
			console.log("WW 1");

			// Extract form data
			const formData = payload.view.state.values;
			const paymentMode =
				formData.payment_mode?.select_payment_mode?.selected_option?.value;
			const paymentTitle = formData.payment_title?.input_payment_title?.value;
			let amountPaid = parseFloat(
				formData.amount_paid?.input_amount_paid?.value
			);
			let fees;
			// NOUVEAU: Extraction du choix de comptabilisation
			const accountingRequired =
				formData.accounting_required?.input_accounting_required?.selected_option
					?.value;
			console.log("Accounting required:", accountingRequired);

			console.log("amountPaid", amountPaid);
			if (paymentMode == "Mobile Money") {
				fees = formData.mobilemoney_fees?.input_mobilemoney_fees?.value;
				console.log("=:: fees", fees);
				amountPaid = amountPaid + parseFloat(fees || 0);
				console.log("=:: amountPaid after fees", amountPaid);
			}
			// Process payment proofs
			const proofFiles =
				formData.payment_proof_unique?.input_payment_proof?.files || [];
			console.log(
				"proofFiles.length",
				proofFiles.length,
				"proofFiles",
				proofFiles
			);
			const userId = payload.user.id;
			const paymentProofs = [];
			console.log("WW 2");
			let targetChannelId = process.env.SLACK_FINANCE_CHANNEL_ID;
			// Get order ID from metadata
			const metadata = JSON.parse(payload.view.private_metadata);
			console.log("::== metadata11", metadata);
			// Extract selectedCaisseId from metadata
			const selectedCaisseId = metadata.selectedCaisseId;
			console.log("::== Selected caisse ID: 2", selectedCaisseId);

			// Add null check and better error handling
			if (selectedCaisseId) {
				try {
					const selectedCaisse = await Caisse.findById(selectedCaisseId);
					if (selectedCaisse && selectedCaisse.channelId) {
						targetChannelId = selectedCaisse.channelId;
						console.log("::== targetChannelId", targetChannelId);
					} else {
						console.log(
							"::== selectedCaisse not found or has no channelId, using default"
						);
						console.log("::== using default targetChannelId", targetChannelId);
					}
				} catch (error) {
					console.log("::== Error fetching caisse:", error.message);
					console.log("::== using default targetChannelId", targetChannelId);
				}
			} else {
				console.log("::== selectedCaisseId is null/undefined, using default");
				console.log("::== using default targetChannelId", targetChannelId);
			}
			if (proofFiles.length > 0) {
				console.log(`Processing ${proofFiles.length} payment proof files...`);

				for (const file of proofFiles) {
					try {
						console.log(`Fetching file info for file ID: ${file.id}`);
						const fileInfo = await getFileInfo(
							file.id,
							process.env.SLACK_BOT_TOKEN
						);
						console.log("File info retrieved:", fileInfo);

						const privateUrl = fileInfo.url_private_download;
						const filename = fileInfo.name;
						const mimeType = fileInfo.mimetype;

						console.log(`Downloading file from URL: ${privateUrl}`);

						// Download the file from Slack
						const response = await fetch(privateUrl, {
							headers: {
								Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
							},
						});

						const arrayBuffer = await response.arrayBuffer();
						const buffer = Buffer.from(arrayBuffer);
						const fileSize = buffer.length;
						console.log(`File downloaded. Size: ${fileSize} bytes`);

						// Upload file directly using uploadV2
						console.log(`Uploading file to channel: ${filename}`);
						const uploadResult = await client.files.uploadV2({
							channel_id: process.env.SLACK_ORDER_LOG_FINANCE_CHANNEL,
							file: buffer,
							filename: filename,
						});

						console.log("File uploaded successfully:", uploadResult);

						// Extract the uploaded file ID from the response
						let uploadedFileId = null;
						if (uploadResult.files && uploadResult.files.length > 0) {
							const firstFile = uploadResult.files[0];
							if (firstFile.files && firstFile.files.length > 0) {
								uploadedFileId = firstFile.files[0].id;
							} else if (firstFile.id) {
								uploadedFileId = firstFile.id;
							}
						}

						if (!uploadedFileId) {
							throw new Error("Could not extract file ID from upload response");
						}

						console.log("Uploaded file ID:", uploadedFileId);

						// Fetch the file info to get permalink and other details
						const uploadedFileInfo = await getFileInfo(
							uploadedFileId,
							process.env.SLACK_BOT_TOKEN
						);
						console.log("Uploaded file info:", uploadedFileInfo);

						const filePermalink = uploadedFileInfo.permalink;
						console.log("File permalink:", filePermalink);

						// Optional: Send to specific colleagues via DM
						const colleagueUserIds = ["U08CYGSDBNW"];

						for (const colleagueId of colleagueUserIds) {
							try {
								console.log(`Notification sent to colleague: ${colleagueId}`);
							} catch (dmError) {
								console.error(`Error sending DM to ${colleagueId}:`, dmError);
							}
						}

						// Store the permalink for payment proofs
						paymentProofs.push(filePermalink);
					} catch (error) {
						console.error(
							"Error processing payment proof file:",
							error.message
						);
						console.error("Full error:", error);

						// Send error notification to user
						await postSlackMessage(
							"https://slack.com/api/chat.postMessage",
							{
								channel: userId,
								text: `⚠️ Erreur lors du traitement du fichier de preuve de paiement: ${error.message}`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					}
				}
			} else {
				// Fallback to the original logic if no files to process
				const fallbackProofs =
					formData.payment_proof_unique?.input_payment_proof?.files?.map(
						(file) =>
							file.permalink || file.url_private_download || file.url_private
					) || [];
				paymentProofs.push(...fallbackProofs);
			}
			console.log("WW 3");

			const paymentUrl =
				formData.paiement_url?.input_paiement_url?.value || null;

			let orderId;
			try {
				// Get orderId from the metadata instead of action.value
				const metadata = JSON.parse(payload.view.private_metadata);
				orderId = metadata.orderId;

				// If orderId is still not found, check if it's in JSON format in the metadata
				if (!orderId && metadata.entityId) {
					if (
						typeof metadata.entityId === "string" &&
						metadata.entityId.startsWith("{")
					) {
						const orderIdData = JSON.parse(metadata.entityId);
						orderId = orderIdData.entityId;
					} else {
						orderId = metadata.entityId;
					}
				}
			} catch (e) {
				// If JSON parsing fails, log the error
				console.log("Failed to parse metadata for orderId:", e.message);
				// Try to get orderId from other sources in the payload if available
				orderId = payload.view?.private_metadata
					? JSON.parse(payload.view.private_metadata).orderId
					: null;
			}

			console.log("Extracted orderId:", orderId);
			console.log("::== Order ID:", orderId);

			const slackToken = process.env.SLACK_BOT_TOKEN;
			console.log("WW 4");

			// Validate inputs for non-cash payments
			if (
				(!paymentProofs || paymentProofs.length === 0) &&
				(!paymentUrl || paymentUrl.trim() === "")
			) {
				console.log("WW 5");
				console.log(
					"❌ Error: No payment proof or URL provided for non-cash payment"
				);
				console.log("paymentMode", paymentMode);
				console.log("paymentProofs", paymentProofs);
				console.log("paymentUrl", paymentUrl);

				await postSlackMessage(
					"https://slack.com/api/chat.postMessage",
					{
						channel: targetChannelId,
						text: "❌ Erreur : Veuillez fournir soit un fichier de preuve de paiement, soit une URL de paiement.",
					},
					slackToken
				);
				return;
			}
			console.log("WW 6");

			// For non-cash payments, validate URL if provided
			let validURL = true;
			if (paymentMode !== "Espèces" && paymentUrl && paymentUrl.trim() !== "") {
				console.log("WW 7");
				validURL = await extractAndValidateUrl(
					paymentUrl,
					[],
					userId,
					slackToken
				);
				if (!validURL) {
					await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: targetChannelId,
							text: "⚠️ L'URL du justificatif n'est pas valide.",
						},
						slackToken
					);
					return;
				}
			}
			console.log("WW 8");

			// STEP 1: Validate payment BEFORE adding to database
			const document = await fetchDocument(orderId);
			if (!document) {
				throw new Error(`Document ${orderId} not found`);
			}

			const currentAmountPaid = document.amountPaid || 0;
			const totalAmountDue = await calculateTotalAmountDue(orderId, context);
			let remainingAmount = totalAmountDue - currentAmountPaid;

			console.log("Payment validation:", {
				currentAmountPaid,
				totalAmountDue,
				remainingAmount,
				newPaymentAmount: amountPaid,
				willExceed: amountPaid > remainingAmount,
			});

			// Validate payment amount
			if (amountPaid > remainingAmount) {
				console.log("❌ Payment exceeds remaining amount:", {
					amountPaid,
					remainingAmount,
					difference: amountPaid - remainingAmount,
				});

				// Store the original remaining amount for the error message
				const originalRemainingAmount = remainingAmount;

				if (paymentMode == "Mobile Money") {
					console.log("WW 10");
					// For Mobile Money, allow payment to exceed remaining amount by the fee amount
					const adjustedRemainingAmount =
						remainingAmount + parseFloat(fees || 0);
					if (amountPaid > adjustedRemainingAmount) {
						await postSlackMessage(
							"https://slack.com/api/chat.postMessage",
							{
								channel: targetChannelId,
								text: `❌ 1 Le montant payé (${amountPaid}) dépasse le montant restant dû (${originalRemainingAmount}) même en incluant les frais (${fees}).`,
							},
							slackToken
						);
						return; // Exit early
					}
				} else {
					// For non-Mobile Money payments, strict validation
					await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: targetChannelId,
							text: `❌ 2 Le montant payé (${amountPaid}) dépasse le montant restant dû (${originalRemainingAmount}).`,
						},
						slackToken
					);
					return; // Exit early
				}
			}

			// Get currency from document
			let currency = "XOF"; // Default currency
			if (orderId.startsWith("CMD/")) {
				if (
					document.proformas &&
					document.proformas.length > 0 &&
					document.proformas[0].validated === true
				) {
					console.log("WW 11");
					currency = document.proformas[0].devise;
					context.log("Currency found:", currency);
				} else {
					context.log("Proforma is not validated or does not exist");
				}
			} else if (orderId.startsWith("PAY/")) {
				console.log("WW 11");
				currency = document.devise;
				context.log("Currency found:", currency);
			}
			console.log("WW 12");

			// For cash payments, check if there's enough balance in the cash register
			if (paymentMode === "Espèces") {
				// Get current caisse state
				const caisse = await Caisse.findById(selectedCaisseId);
				console.log("::== Selected caisse ID:", selectedCaisseId);
				if (!caisse) {
					throw new Error(`Caisse with ID ${selectedCaisseId} not found`);
				}

				// Check if there will be enough balance after transaction
				const currentBalance = caisse.balances[currency] || 0;
				const projectedBalance = currentBalance - amountPaid;
				context.log("Current balance:", currentBalance);
				context.log("Projected balance:", projectedBalance);

				// If balance will be negative, BLOCK the transaction
				if (projectedBalance < 0) {
					context.log(
						`❌ Error: Insufficient funds in Caisse for ${currency}. Current: ${currentBalance}, Required: ${amountPaid}`
					);
					await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: targetChannelId,
							text: `❌ PAIEMENT BLOQUÉ : Solde insuffisant dans la caisse pour ${currency}. Solde actuel: ${currentBalance}, Montant nécessaire: ${amountPaid}. Veuillez recharger la caisse avant de procéder au paiement.`,
						},
						slackToken
					);

					// Also notify the user who submitted the payment
					await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: payload.user.id,
							text: `❌ Paiement en espèces refusé pour ${orderId} : Solde insuffisant dans la caisse pour ${currency}. L'équipe des finances a été notifiée.`,
						},
						slackToken
					);

					// Exit completely - don't process any part of this payment
					return;
				}
			}
			console.log("WW 13");
			let paymentNumber;
			let decaissementNumber = null;

			// Générer toujours un numéro générique
			paymentNumber = await generatePaymentNumber("generic");
			console.log("Generated payment number:", paymentNumber);

			// Pour Espèces et Mobile Money, vérifier si comptabilisation requise
			if (
				(paymentMode === "Espèces" || paymentMode === "Mobile Money") &&
				accountingRequired === "yes"
			) {
				decaissementNumber = await generatePaymentNumber("decaissement");
				console.log("Generated decaissement number:", decaissementNumber);
			}
			// Extract mode-specific details
			let paymentDetails = {};
			switch (paymentMode) {
				case "Chèque":
					paymentDetails = {
						paymentNumber: paymentNumber,

						cheque_number: formData.cheque_number?.input_cheque_number?.value,
						cheque_bank:
							formData.cheque_bank?.input_cheque_bank?.selected_option?.value,
						cheque_date: formData.cheque_date?.input_cheque_date?.selected_date,
						cheque_order: formData.cheque_order?.input_cheque_order?.value,
					};
					break;
				case "Virement":
					paymentDetails = {
						paymentNumber: paymentNumber,

						virement_number:
							formData.virement_number?.input_virement_number?.value,
						virement_bank:
							formData.virement_bank?.input_virement_bank?.selected_option
								?.value,
						virement_date:
							formData.virement_date?.input_virement_date?.selected_date,
						virement_order:
							formData.virement_order?.input_virement_order?.value,
					};
					break;
				case "Mobile Money":
					paymentDetails = {
						paymentNumber: paymentNumber,

						mobilemoney_recipient_phone:
							formData.mobilemoney_recipient_phone
								?.input_mobilemoney_recipient_phone?.value,
						mobilemoney_sender_phone:
							formData.mobilemoney_sender_phone?.input_mobilemoney_sender_phone
								?.value,
						mobilemoney_fees:
							formData.mobilemoney_fees?.input_mobilemoney_fees?.value,
						mobilemoney_date:
							formData.mobilemoney_date?.input_mobilemoney_date?.selected_date,
						accountingRequired: accountingRequired === "yes",
						...(decaissementNumber ? { decaissementNumber } : {}),
					};
					break;
				case "Julaya":
					paymentDetails = {
						paymentNumber: paymentNumber,

						julaya_recipient:
							formData.julaya_recipient?.input_julaya_recipient?.value,
						julaya_date: formData.julaya_date?.input_julaya_date?.selected_date,
						julaya_transaction_number:
							formData.julaya_transaction_number
								?.input_julaya_transaction_number?.value,
					};
					break;
				case "Espèces":
					paymentDetails = {
						paymentNumber: paymentNumber,
						accountingRequired: accountingRequired === "yes",
						...(decaissementNumber ? { decaissementNumber } : {}),
					};
					// No additional fields required
					break;
				default:
					throw new Error("Unknown payment mode");
			}

			// STEP 2: Add payment to database (only after validation)
			const paymentData = {
				paymentNumber,
				decaissementNumber,
				paymentMode,
				amountPaid,
				paymentTitle,
				paymentProofs,
				paymentUrl,
				details: paymentDetails,
				dateSubmitted: new Date(),
				accountingStatus: {
					required:
						paymentMode === "Espèces" || paymentMode === "Mobile Money"
							? accountingRequired === "yes"
							: false,
					processed: false,
					processedAt: null,
					processedBy: null,
				},
			};
			console.log("WW 14");

			const newAmountPaid = currentAmountPaid + amountPaid;
			const newRemainingAmount = Math.max(0, remainingAmount - amountPaid);

			const paymentStatus = determinePaymentStatus(
				totalAmountDue,
				newAmountPaid
			);

			// Update document with payment data
			if (orderId.startsWith("CMD/")) {
				await Order.findOneAndUpdate(
					{ id_commande: orderId },
					{
						$push: { payments: paymentData },
						$set: {
							totalAmountDue,
							amountPaid: newAmountPaid,
							remainingAmount: newRemainingAmount,
							paymentStatus,
							paymentDone: newRemainingAmount === 0 ? "true" : "false",
						},
					},
					{ new: true }
				);
			} else if (orderId.startsWith("PAY/")) {
				await PaymentRequest.findOneAndUpdate(
					{ id_paiement: orderId },
					{
						$push: { payments: paymentData },
						$set: {
							totalAmountDue,
							amountPaid: newAmountPaid,
							remainingAmount: newRemainingAmount,
							paymentStatus,
							paymentDone: newRemainingAmount === 0 ? "true" : "false",
						},
					},
					{ new: true }
				);
			}
			console.log("WW 15");

			// STEP 3: Handle cash payments (Caisse update)
			if (paymentMode === "Espèces") {
				console.log("WW 18");

				// At this point, we've already checked that the balance is sufficient
				const caisseUpdate = {
					$inc: { [`balances.${currency}`]: -amountPaid }, // Subtract amountPaid from the currency balance
					$push: {
						transactions: {
							type: "payment",
							amount: -amountPaid, // Negative to indicate a deduction
							currency,
							orderId,
							paymentNumber,
							decaissementNumber,
							details: `Payment for ${paymentTitle} (Order: ${orderId}, Payment: ${paymentNumber}${
								decaissementNumber
									? ", Decaissement: " + decaissementNumber
									: ""
							})`,
							// details: `Payment for ${paymentTitle} (Order: ${orderId})`,
							timestamp: new Date(),
							paymentMethod: "Espèces",
							paymentDetails,
							accountingRequired: accountingRequired === "yes",
						},
					},
				};

				const updatedCaisse = await Caisse.findOneAndUpdate(
					{ _id: selectedCaisseId }, // Find by the specific caisse ID
					caisseUpdate,
					{ new: true }
				);

				if (!updatedCaisse) {
					throw new Error("Caisse document not found");
				}
				context.log(
					`New caisse balance for ${currency}: ${updatedCaisse.balances[currency]}`
				);

				// After updating the Caisse balance, sync with Excel
				if (updatedCaisse.latestRequestId) {
					await syncCaisseToExcel(updatedCaisse, updatedCaisse.latestRequestId);
					context.log(
						`Excel file updated for latest request ${updatedCaisse.latestRequestId} with new balance for ${currency}`
					);
				} else {
					context.log(
						"No latestRequestId found in Caisse, skipping Excel sync"
					);
				}

				// NOUVEAU: Notification améliorée avec numéros de paiement
				// let notificationText = `✅ Paiement en espèces traité pour ${orderId}.\n`;
				// notificationText += `📋 Numéro de paiement: ${paymentNumber}\n`;
				// if (decaissementNumber) {
				// 	notificationText += `📋 Numéro de pièce de caisse: ${decaissementNumber}\n`;
				// }
				// notificationText += `💰 Nouveau solde de la caisse pour ${currency}: ${updatedCaisse.balances[currency]}`;

				// await postSlackMessage(
				// 	"https://slack.com/api/chat.postMessage",
				// 	{
				// 		channel: targetChannelId,
				// 		text: notificationText,
				// 	},
				// 	slackToken
				// );
			}

			// Prepare notification data
			const notifyPaymentData = {
				paymentNumber,
				decaissementNumber,
				title: paymentData.paymentTitle,
				mode: paymentData.paymentMode,
				amountPaid: paymentData.amountPaid,
				date: paymentData.dateSubmitted,
				url: paymentData.paymentUrl,
				proofs: paymentData.paymentProofs,
				details: paymentData.details,
			};
			console.log("WW 19");

			console.log("payload.user.id", payload.user.id);
			console.log("userId", userId);

			// STEP 4: Send notifications
			await Promise.all([
				notifyPayment(
					orderId,
					notifyPaymentData,
					totalAmountDue,
					newRemainingAmount,
					paymentStatus,
					context,
					"finance",
					payload.user.id,
					targetChannelId,
					selectedCaisseId,
					paymentNumber,
					decaissementNumber
				),
				notifyPayment(
					orderId,
					notifyPaymentData,
					totalAmountDue,
					newRemainingAmount,
					paymentStatus,
					context,
					"user",
					payload.user.id,
					targetChannelId,
					selectedCaisseId,
					paymentNumber,
					decaissementNumber
				),
				notifyPayment(
					orderId,
					notifyPaymentData,
					totalAmountDue,
					newRemainingAmount,
					paymentStatus,
					context,
					"admin",
					payload.user.id,
					targetChannelId,
					selectedCaisseId,
					paymentNumber,
					decaissementNumber
				),
			]).catch((error) =>
				context.log(`❌ Erreur lors des notifications: ${error}`)
			);
			console.log("WW 20");
		} catch (error) {
			context.log(
				`Background processing error for payment submission: ${error.message}\nStack: ${error.stack}`
			);
			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: payload.user.id,
					text: `❌ Erreur lors du traitement du paiement pour la commande. Veuillez contacter le support. Détails : ${error.message}`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
	});

	return context.res;
}
async function handlePayment(orderId, paymentAmount, totalAmountDue, context) {
	console.log("** handlePayment");
	console.log("Input parameters:", { orderId, paymentAmount, totalAmountDue });

	let document;

	if (orderId.startsWith("PAY/")) {
		document = await PaymentRequest.findOne({ id_paiement: orderId });

		// Get the CURRENT amount paid (before this payment)
		const currentAmountPaid = document.amountPaid || 0;
		const remainingAmount = totalAmountDue - currentAmountPaid;

		console.log("Payment validation:", {
			currentAmountPaid,
			totalAmountDue,
			remainingAmount,
			newPaymentAmount: paymentAmount,
			willExceed: paymentAmount > remainingAmount,
		});

		// Validate payment doesn't exceed remaining amount
		if (paymentAmount > remainingAmount) {
			console.log("❌ Payment exceeds remaining amount:", {
				paymentAmount,
				remainingAmount,
				difference: paymentAmount - remainingAmount,
			});

			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_FINANCE_CHANNEL_ID,
					text: `❌ 3 Le montant payé (${paymentAmount}) dépasse le montant restant dû (${remainingAmount}).`,
				},
				process.env.SLACK_BOT_TOKEN
			);

			throw new Error(
				`4 Le montant payé (${paymentAmount}) dépasse le montant restant dû (${remainingAmount}).`
			);
		}

		// Calculate new totals
		const newAmountPaid = currentAmountPaid + paymentAmount;
		const paymentStatus = determinePaymentStatus(totalAmountDue, newAmountPaid);
		const newRemainingAmount = totalAmountDue - newAmountPaid;

		console.log("Payment calculation results:", {
			newAmountPaid,
			paymentStatus,
			newRemainingAmount,
		});

		// Update payment status
		const updateData = {
			paymentDone: newRemainingAmount === 0 ? "true" : "false",
		};

		const updateResult = await PaymentRequest.updateOne(
			{ id_paiement: orderId },
			{ $set: updateData }
		);

		context.log(`Update result: ${JSON.stringify(updateResult)}`);

		if (updateResult.modifiedCount === 0) {
			throw new Error(
				`Failed to update payment request ${orderId} - no documents modified`
			);
		}

		return {
			newAmountPaid,
			paymentStatus,
			totalAmountDue,
			remainingAmount: newRemainingAmount,
		};
	} else if (orderId.startsWith("CMD/")) {
		document = await Order.findOne({ id_commande: orderId });

		if (!document) {
			throw new Error("Commande non trouvée.");
		}

		// Get the CURRENT amount paid (before this payment)
		const currentAmountPaid = document.amountPaid || 0;
		const remainingAmount = totalAmountDue - currentAmountPaid;

		console.log("Payment validation:", {
			currentAmountPaid,
			totalAmountDue,
			remainingAmount,
			newPaymentAmount: paymentAmount,
			willExceed: paymentAmount > remainingAmount,
		});

		// Validate payment doesn't exceed remaining amount
		if (paymentAmount > remainingAmount) {
			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_FINANCE_CHANNEL_ID,
					text: `❌ 5 Le montant payé (${paymentAmount}) dépasse le montant restant dû (${remainingAmount}).`,
				},
				process.env.SLACK_BOT_TOKEN
			);

			throw new Error(
				`6 Le montant payé (${paymentAmount}) dépasse le montant restant dû (${remainingAmount}).`
			);
		}

		// Calculate new totals
		const newAmountPaid = currentAmountPaid + paymentAmount;
		const paymentStatus = determinePaymentStatus(totalAmountDue, newAmountPaid);
		const newRemainingAmount = totalAmountDue - newAmountPaid;

		console.log("Payment calculation results:", {
			newAmountPaid,
			paymentStatus,
			newRemainingAmount,
		});

		// Update payment status
		const updateData = {
			paymentDone: newRemainingAmount === 0 ? "true" : "false",
		};

		const updateResult = await Order.updateOne(
			{ id_commande: orderId },
			{ $set: updateData }
		);

		context.log(`Update result: ${JSON.stringify(updateResult)}`);

		if (updateResult.modifiedCount === 0) {
			throw new Error(
				`Failed to update order ${orderId} - no documents modified`
			);
		}

		return {
			newAmountPaid,
			paymentStatus,
			totalAmountDue,
			remainingAmount: newRemainingAmount,
		};
	} else {
		throw new Error("Invalid orderId format");
	}
}
//* ??
function getBankInitialOption(bank) {
	console.log("** getBankInitialOption");
	if (!bank) {
		return null; // No initial option if bank is undefined or null
	}

	const validBankValues = bankOptions.map((option) => option.value);
	console.log("validBanks", bankOptions);
	console.log("checking bank", bank);

	// Check if the provided bank matches one of the valid options
	if (validBankValues.includes(bank)) {
		const matchedBank = bankOptions.find((option) => option.value === bank);
		return {
			text: { type: "plain_text", text: matchedBank.text.text },
			value: matchedBank.value,
		};
	}

	// If no match, return "Autre" (we'll ensure it's in the options list later)
	return {
		text: { type: "plain_text", text: "Autre" },
		value: "Autre",
	};
}
async function handleRejectPayment(payload, context, action) {
	console.log("sssdd");
	// Open rejection modal (similar to orderStatusService.js)
	const view = {
		type: "modal",
		callback_id: "reject_payment_reason",
		title: { type: "plain_text", text: "Raison du rejet" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: [
			{
				type: "input",
				block_id: "rejection_reason",
				element: {
					type: "plain_text_input",
					action_id: "input_reason",
					multiline: true,
				},
				label: { type: "plain_text", text: "Raison du rejet" },
			},
		],
		private_metadata: JSON.stringify({ paymentId }),
	};
	const response = await postSlackMessage(
		"https://slack.com/api/views.open",
		{ trigger_id: payload.trigger_id, view },
		process.env.SLACK_BOT_TOKEN
	);
	context.log(`Rejection modal response: ${JSON.stringify(response)}`);
	return { statusCode: 200, body: "" };
}
async function handleAcceptPayment(payload, context, action) {
	const paymentRequest = await PaymentRequest.findOneAndUpdate(
		{ id_paiement: paymentId },
		{
			validatedAt: new Date(),
			validatedBy: payload.user.id,
			autorisation_admin: true,
			updatedAt: new Date(),
		},
		{ new: true }
	);
	console.log("paymentRequest1", paymentRequest);
	const {
		notifyFinancePayment,
	} = require("../../Payment Request/Handlers/paymentRequestNotification");

	await notifyFinancePayment(paymentRequest, context, validatedBy);
	// Update Slack message (e.g., via chat.update)
	return { statusCode: 200, body: "" };
}
async function handleModifyPayment(payload, context) {
	console.log("** handleModifyPayment 1");
	const selectedPaymentMode = payload.actions[0].selected_option?.value;
	console.log("Selected payment mode:", selectedPaymentMode);

	// if (!selectedPaymentMode) {
	// 	console.error("No payment mode selected in payload");
	// 	return;
	// }
	console.log("===$ 2 payload", payload);
	try {
		let actionValue;
		// Determine if this is triggered by "confirm_payment_mode_2" or an initial action
		if (
			payload.actions &&
			payload.actions[0]?.action_id === "confirm_payment_mode_2"
		) {
			// For "Ajouter les détails" button, use private_metadata
			actionValue = JSON.parse(payload.view.private_metadata || "{}");
			// Get the selected payment mode from the current form state
			if (!selectedPaymentMode) {
				selectedPaymentMode =
					payload.view.state.values.payment_mode.select_payment_mode
						.selected_option?.value;
			}
		} else if (
			payload.actions &&
			payload.actions[0]?.action_id === "select_payment_mode" &&
			payload.view?.private_metadata
		) {
			// For automatic payment mode changes (dispatch_action), use private_metadata
			actionValue = JSON.parse(payload.view.private_metadata || "{}");
			// Get the selected payment mode from the current form state
			if (!selectedPaymentMode) {
				selectedPaymentMode = payload.actions[0].selected_option?.value;
			}
		} else {
			// For initial action, use actions[0].value
			actionValue = JSON.parse(payload.actions[0]?.value || "{}");
		}
		console.log("===$ actionValue 4", actionValue);
		const {
			entityId,
			paymentIndex,
			problemType,
			problemDescription,
			reporterId,
			selectedCaisseId,
		} = actionValue;
		console.log("===$ selectedCaisseId", selectedCaisseId);

		// Fetch the entity
		const entity = await fetchEntity(entityId, context);
		if (!entity) {
			throw new Error(`Entity ${entityId} not found`);
		}

		// Get payment data
		const paymentData = entity.payments[paymentIndex];
		const details = paymentData.details || {};
		console.log("===$ paymentData", paymentData);
		console.log("===$ paymentIndex", paymentIndex);
		console.log("===$ entity", entity);

		// Determine the payment mode to use
		const paymentMode =
			selectedPaymentMode ||
			paymentData.paymentMode ||
			paymentData.mode ||
			"Chèque";

		// Create blocks for existing payment proofs
		const proofsBlocks = [];
		if (paymentData.paymentProofs?.length > 0) {
			proofsBlocks.push({
				type: "section",
				block_id: "existing_proofs_header",
				text: {
					type: "mrkdwn",
					text: "*Justificatifs de paiement existants:*",
				},
			});
			paymentData.paymentProofs.forEach((proofUrl, index) => {
				const isFile =
					proofUrl.startsWith("https://files.slack.com") ||
					proofUrl.includes("slack-files");
				proofsBlocks.push({
					type: "input",
					block_id: `existing_proof_${index}`,
					optional: true,
					label: {
						type: "plain_text",
						text: isFile ? `📎 Fichier ${index + 1}` : `🔗 URL ${index + 1}`,
					},
					element: {
						type: "plain_text_input",
						action_id: `edit_proof_${index}`,
						initial_value: proofUrl,
					},
				});
			});
			proofsBlocks.push({ type: "divider" });
		}

		// Create modal blocks
		let blocks = [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Modification du paiement pour ${entityId}*\n*Problème signalé:* ${getProblemTypeText(
						problemType
					)}\n*Description du problème:*\n${
						problemDescription || "Non spécifié"
					}`,
				},
			},
			{ type: "divider" },
			{
				type: "input",
				block_id: "payment_title",
				element: {
					type: "plain_text_input",
					action_id: "input_payment_title",
					initial_value: paymentData.paymentTitle || paymentData.title || "",
				},
				label: {
					type: "plain_text",
					text: "Titre du paiement",
					emoji: true,
				},
			},

			// {
			// 	type: "actions",
			// 	block_id: "select_payment_mode",
			// 	elements: [
			// 		{
			// 			type: "button",
			// 			action_id: "select_payment_mode",
			// 			text: { type: "plain_text", text: "Ajouter les détails" },
			// 			value: "select_payment_mode",
			// 		},
			// 	],
			// },
			{
				type: "input",
				block_id: "amount_paid",
				element: {
					type: "number_input",
					action_id: "input_amount_paid",
					initial_value: (paymentData.amountPaid || 0).toString(),
					is_decimal_allowed: true,
					min_value: "0",
				},
				label: {
					type: "plain_text",
					text: "Montant payé",
					emoji: true,
				},
			},
			{
				type: "input",
				block_id: "payment_mode",
				element: {
					type: "static_select",
					action_id: "select_payment_mode",
					options: [
						{ text: { type: "plain_text", text: "Chèque" }, value: "Chèque" },
						{
							text: { type: "plain_text", text: "Virement" },
							value: "Virement",
						},
						{
							text: { type: "plain_text", text: "Mobile Money" },
							value: "Mobile Money",
						},
						{ text: { type: "plain_text", text: "Julaya" }, value: "Julaya" },
						{ text: { type: "plain_text", text: "Espèces" }, value: "Espèces" },
					],
					initial_option: {
						text: { type: "plain_text", text: paymentMode },
						value: paymentMode,
					},
				},
				label: {
					type: "plain_text",
					text: "Mode de paiement",
					emoji: true,
				},
				dispatch_action: true, // Enable automatic updates when selection changes
			},
			{ type: "divider" },
			// {
			// 	type: "input",
			// 	optional: true,
			// 	block_id: "paiement_url",
			// 	element: {
			// 		type: "plain_text_input",
			// 		action_id: "input_paiement_url",
			// 		initial_value: paymentData.paymentUrl || "",
			// 	},
			// 	label: {
			// 		type: "plain_text",
			// 		text: "URL du paiement",
			// 		emoji: true,
			// 	},
			// },
		];
		// Conditionally add payment URL block only if it has a value
		if (paymentData.paymentUrl && paymentData.paymentUrl.trim() !== "") {
			blocks.push({
				type: "input",
				optional: true,
				block_id: "paiement_url",
				element: {
					type: "plain_text_input",
					action_id: "input_paiement_url",
					initial_value: paymentData.paymentUrl,
				},
				label: {
					type: "plain_text",
					text: "URL du paiement",
					emoji: true,
				},
			});
		}
		// Add existing proofs
		blocks = blocks.concat(proofsBlocks);

		// Add options for new proofs
		blocks.push(
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "Télécharger de nouveaux justificatifs ou ajouter de nouvelles URLs",
				},
			},
			{
				type: "input",
				block_id: "payment_proof_file",
				optional: true,
				label: {
					type: "plain_text",
					text: "📎 Nouveaux fichiers",
				},
				element: {
					type: "file_input",
					action_id: "file_upload_proof",
					filetypes: ["pdf", "jpg", "png"],
					max_files: 5,
				},
				hint: {
					type: "plain_text",
					text: "Si vous souhaitez conserver les fichiers existants, ne téléchargez pas de nouveaux fichiers.",
				},
			},
			{
				type: "input",
				block_id: "new_payment_url",
				optional: true,
				label: {
					type: "plain_text",
					text: "🔗 Nouvelle URL",
				},
				element: {
					type: "plain_text_input",
					action_id: "input_new_payment_url",
					placeholder: { type: "plain_text", text: "https://..." },
				},
				hint: {
					type: "plain_text",
					text: "Ajouter une nouvelle URL comme justificatif externe.",
				},
			}
		);

		// Add payment-mode-specific fields with prefill if the mode matches the original
		const isSameMode =
			paymentMode === (paymentData.paymentMode || paymentData.mode);
		if (paymentMode === "Chèque") {
			blocks.push(
				{ type: "divider" },
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Détails du chèque*",
					},
				},
				{
					type: "input",
					block_id: "cheque_number",
					element: {
						type: "plain_text_input",
						action_id: "input_cheque_number",
						initial_value: isSameMode ? details.cheque_number || "" : "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de chèque",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "cheque_bank",
					element: {
						type: "static_select",
						action_id: "input_cheque_bank",
						options: bankOptions,
						initial_option: isSameMode
							? getBankInitialOption(details.cheque_bank) || bankOptions[0]
							: bankOptions[0],
					},
					label: {
						type: "plain_text",
						text: "Banque",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "cheque_date",
					label: {
						type: "plain_text",
						text: "Date du chèque",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_cheque_date",
						initial_date:
							isSameMode && details.cheque_date
								? new Date(details.cheque_date).toISOString().split("T")[0]
								: undefined,
					},
				},
				{
					type: "input",
					block_id: "cheque_order",
					label: { type: "plain_text", text: "Ordre" },
					element: {
						type: "plain_text_input",
						action_id: "input_cheque_order",
						initial_value: isSameMode ? details.cheque_order || "" : "",
					},
				}
			);
		} else if (paymentMode === "Virement") {
			blocks.push(
				{ type: "divider" },
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Détails du virement*",
					},
				},
				{
					type: "input",
					block_id: "virement_number",
					element: {
						type: "plain_text_input",
						action_id: "input_virement_number",
						initial_value: isSameMode ? details.virement_number || "" : "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de virement",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "virement_bank",
					element: {
						type: "static_select",
						action_id: "input_virement_bank",
						options: bankOptions,
						initial_option: isSameMode
							? getBankInitialOption(details.virement_bank) || bankOptions[0]
							: bankOptions[0],
					},
					label: {
						type: "plain_text",
						text: "Banque",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "virement_date",
					label: {
						type: "plain_text",
						text: "Date du virement",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_virement_date",
						initial_date:
							isSameMode && details.virement_date
								? new Date(details.virement_date).toISOString().split("T")[0]
								: undefined,
					},
				},
				{
					type: "input",
					block_id: "virement_order",
					label: { type: "plain_text", text: "Ordre" },
					element: {
						type: "plain_text_input",
						action_id: "input_virement_order",
						initial_value: isSameMode ? details.virement_order || "" : "",
					},
				}
			);
		} else if (paymentMode === "Mobile Money") {
			blocks.push(
				{ type: "divider" },
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Détails du Mobile Money*",
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_recipient_phone",
					element: {
						type: "plain_text_input",
						action_id: "input_mobilemoney_recipient_phone",
						initial_value: isSameMode
							? details.mobilemoney_recipient_phone || ""
							: "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de téléphone bénéficiaire",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_sender_phone",
					element: {
						type: "plain_text_input",
						action_id: "input_mobilemoney_sender_phone",
						initial_value: isSameMode
							? details.mobilemoney_sender_phone || ""
							: "",
					},
					label: {
						type: "plain_text",
						text: "Numéro envoyeur",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_fees",
					label: { type: "plain_text", text: "Frais" },
					element: {
						type: "number_input",
						is_decimal_allowed: true,
						min_value: "0",
						action_id: "input_mobilemoney_fees",
						placeholder: {
							type: "plain_text",
							text: "Montant des frais",
						},
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_date",
					label: {
						type: "plain_text",
						text: "Date",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_mobilemoney_date",
						initial_date:
							isSameMode && details.mobilemoney_date
								? new Date(details.mobilemoney_date).toISOString().split("T")[0]
								: undefined,
					},
				},
				{
					type: "input",
					block_id: "accounting_required",
					label: { type: "plain_text", text: "Comptabilisation requise ?" },
					element: {
						type: "radio_buttons",
						action_id: "input_accounting_required",
						options: [
							{
								text: {
									type: "plain_text",
									text: "Oui - Générer un numéro de pièce de caisse",
								},
								value: "yes",
							},
							{
								text: {
									type: "plain_text",
									text: "Non",
								},
								value: "no",
							},
						],
						// No initial_option here
					},
					optional: false, // This makes the field required
				}
			);
		} else if (paymentMode === "Julaya") {
			blocks.push(
				{ type: "divider" },
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Détails Julaya*",
					},
				},
				{
					type: "input",
					block_id: "julaya_recipient",
					element: {
						type: "plain_text_input",
						action_id: "input_julaya_recipient",
						initial_value: isSameMode ? details.julaya_recipient || "" : "",
					},
					label: {
						type: "plain_text",
						text: "Bénéficiaire",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "julaya_transaction_number",
					element: {
						type: "plain_text_input",
						action_id: "input_julaya_transaction_number",
						initial_value: isSameMode
							? details.julaya_transaction_number || ""
							: "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de transaction",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "julaya_date",
					label: {
						type: "plain_text",
						text: "Date",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_julaya_date",
						initial_date:
							isSameMode && details.julaya_date
								? new Date(details.julaya_date).toISOString().split("T")[0]
								: undefined,
					},
				}
			);
		} else if (paymentMode === "Espèces") {
			// NOUVEAU: Champ pour la comptabilisation (Espèces)
			blocks.push(
				{ type: "divider" },
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Options de comptabilisation*",
					},
				},
				{
					type: "input",
					block_id: "accounting_required",
					label: { type: "plain_text", text: "Comptabilisation requise ?" },
					element: {
						type: "radio_buttons",
						action_id: "input_accounting_required",
						options: [
							{
								text: {
									type: "plain_text",
									text: "Oui - Générer un numéro de pièce de caisse",
								},
								value: "yes",
							},
							{
								text: {
									type: "plain_text",
									text: "Non",
								},
								value: "no",
							},
						],
						// No initial_option here
					},
					optional: false, // This makes the field required
				}
			);
		}

		console.log("paymentData", paymentData);
		console.log("paymentData.paymentProofs", paymentData.paymentProofs);
		console.log("paymentData.paymentUrl", paymentData.paymentUrl);

		const view = {
			type: "modal",
			callback_id: "payment_modification_submission",
			private_metadata: JSON.stringify({
				entityId,
				paymentIndex,
				reporterId,
				channelId: payload.channel?.id || process.env.SLACK_ADMIN_ID,
				existingProofs: paymentData.paymentProofs || [],
				existingUrls: paymentData.paymentUrl ? [paymentData.paymentUrl] : [],
				problemType,
				problemDescription,
				selectedCaisseId: selectedCaisseId,
			}),
			title: {
				type: "plain_text",
				text: "Modifier le paiement",
				emoji: true,
			},
			submit: {
				type: "plain_text",
				text: "Enregistrer",
				emoji: true,
			},
			close: {
				type: "plain_text",
				text: "Annuler",
				emoji: true,
			},
			blocks,
		};

		let response;
		if (payload.view?.id && selectedPaymentMode) {
			// Update existing modal
			console.log("Updating modal with view_id:", payload.view.id);
			response = await postSlackMessage2(
				"https://slack.com/api/views.update",
				{
					view_id: payload.view.id,
					hash: payload.view.hash, // Include hash to prevent conflicts
					view,
				},
				process.env.SLACK_BOT_TOKEN,
				{ headers: { "Content-Type": "application/json; charset=utf-8" } }
			);
		} else {
			// Open new modal
			console.log("Opening new modal with trigger_id:", payload.trigger_id);
			response = await postSlackMessage2(
				"https://slack.com/api/views.open",
				{ trigger_id: payload.trigger_id, view },
				process.env.SLACK_BOT_TOKEN,
				{ headers: { "Content-Type": "application/json; charset=utf-8" } }
			);
		}

		if (!response.data.ok) {
			throw new Error(`Slack API error: ${response.data.error}`);
		}

		context.log(`Payment modification modal opened for ${entityId}`);
		return {
			statusCode: 200,
			headers: { "Content-Type": "application/json" },
			body: "",
		};
		// return { response_action: "update" };
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`Error handling modify payment: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				_error: `Une erreur s'est produite: ${error.message}`,
			},
		};
	}
}
module.exports = {
	handlePaymentFormModeSelection,
	processPaymentSubmission,
	handlePayment,
	handlePaymentRequestSubmission,
	handlePaymentProblemModal,
	handleModifyPayment,
	calculateTotalAmountDue,
	generatePaymentNumber,
};
