// src/orderUtils.js
const mongoose = require("mongoose");
const {
	Order,
	PaymentRequest,
	FormData1,
	CommandSequence,
	PaymentSequence,
	Caisse,
	PaymentCounter,
	DecaissementCounter,
} = require("./db");
const { WebClient } = require("@slack/web-api");

// Initialize the Slack client
const client = new WebClient(process.env.SLACK_BOT_TOKEN);
const {
	processFundingApproval,
	syncCaisseToExcel,
	getProblemTypeText,
	generateFundingDetailsBlocks,
} = require("./caisseService");
const {
	postSlackMessage,
	createSlackResponse,
	getFileInfo,
} = require("./utils");
const querystring = require("querystring");
const {
	notifyPayment,
	notifyPaymentRequest,
	notifyAdmin,
	notifyUser,
	getPaymentBlocks,
	postSlackMessageWithRetry,
	notifyAdminProforma,
	getPaymentRequestBlocks,
} = require("./notificationService"); // Import notification functions
const axios = require("axios");
const { checkFormErrors, suggestAutoCompletions } = require("./aiService");
const {
	updateView,
	handleProformaSubmission,
	executeOrderDeletion,
	postSlackMessage2,
	handleTransferConfirmation,
} = require("./formService"); // Import updateView
const {
	calculateTotalAmountDue,
	handlePayment,
	determinePaymentStatus,
} = require("./paymentService");
const { extractProformas, DEFAULT_EQUIPE_OPTIONS } = require("./form");
const {
	handleFundingRequestSubmission,
	handleProblemSubmission,
} = require("./caisseService");

async function saveToStorage(key, data) {
	try {
		console.log("** saveToStorage");
		const result = await FormData1.create({ key, data });
		console.log(`Stored form data in MongoDB with key: ${key}`);
		return result;
	} catch (err) {
		console.log(`Error saving form data for key ${key}:`, err);
		throw err;
	}
}
// Order List Handling
async function handleOrderList(isAdmin, context) {
	console.log("** handleOrderList");
	if (!isAdmin) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "🚫 Vous n'êtes pas autorisé à voir la liste des commandes.",
		});
	}

	const orders = await Order.find({}).sort({ date: -1 }).limit(10);
	context.log("Orders fetched for handleOrderList:", JSON.stringify(orders));

	if (orders.length === 0) {
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "📭 Aucune commande trouvée.",
		});
	}

	let responseText = "*📋 Rapport des Dernières Commandes*\n\n";

	orders.forEach((order, index) => {
		context.log("Processing order:", JSON.stringify(order));

		responseText += `* Commande #${order.id_commande}*\n`;

		// Order Header Information
		const headerDetails = [
			`👤 *Demandeur:* <@${order.demandeur}>`,
			`📌 *Titre:* ${order.titre}`,
			`#️⃣ *Canal:* #${order.channel || "Non spécifié"}`,
			`👥 *Équipe:* ${order.equipe || "Non spécifié"}`,
			`📅 *Date:* ${order.date.toLocaleString()}`,
			`⚙️ *Statut:* ${order.statut || "Non défini"}`,
			`🔐 *Autorisation Admin:* ${
				order.autorisation_admin ? "✅ Autorisé" : "❌ Non autorisé"
			}`,
		];

		responseText += headerDetails.join("\n") + "\n";

		// Rejection Reason (if applicable)
		if (order.rejection_reason) {
			responseText += `🚫 *Raison du Rejet:* ${order.rejection_reason}\n`;
		}

		// Articles Details
		responseText += "\n*📦 Articles Commandés:*\n";
		if (order.articles.length > 0) {
			order.articles.forEach((article, i) => {
				responseText += `  ${i + 1}. ${article.quantity} ${article.unit} - ${
					article.designation
				}\n`;
			});
		} else {
			responseText += "  - Aucun article\n";
		}

		// Proformas
		responseText += "\n*📝 Proformas:*\n";
		if (order.proformas.length > 0) {
			order.proformas.forEach((proforma, i) => {
				responseText += `  ${i + 1}. `;
				responseText += `*Nom:* <${proforma.urls}|${
					proforma.nom || `Proforma ${i + 1}`
				}> `;
				responseText += `| *Montant:* ${proforma.montant} ${proforma.devise} `;
				responseText += `| *fichiers:* ${proforma.file_ids || "N/A"}\n`;
			});
		} else {
			responseText += "  - Aucun\n";
		}

		// Payments
		responseText += "\n*💰 Détails des Paiements:*\n";
		if (order.payments.length > 0) {
			order.payments.forEach((payment, i) => {
				responseText += `  *Paiement ${i + 1}:*\n`;
				responseText += `    • *Mode:* ${payment.paymentMode}\n`;
				responseText += `    • *Titre:* ${payment.paymentTitle}\n`;
				responseText += `    • *Montant:* ${payment.amountPaid}€\n`;
				responseText += `    • *Statut:* ${
					payment.paymentStatus || "Partiel"
				}\n`;
				responseText += `    • *Date:* ${payment.dateSubmitted.toLocaleString()}\n`;

				// Payment Proof
				if (payment.paymentProofs?.length > 0) {
					responseText += `    • *Preuve:* <${payment.paymentProofs}|Justificatif>\n`;
				} else if (payment.paymentUrl) {
					responseText += `    • *Lien:* <${payment.paymentUrl}|Lien de Paiement>\n`;
				} else {
					responseText += `    • *Preuve:* Aucune\n`;
				}

				// Payment Details
				responseText += "    • *Détails Supplémentaires:*\n";
				if (payment.details && Object.keys(payment.details).length > 0) {
					Object.entries(payment.details).forEach(([key, value]) => {
						responseText += `      - ${key}: ${value}\n`;
					});
				} else {
					responseText += "      - Aucun détail supplémentaire\n";
				}
			});
		} else {
			responseText += "  - Aucun paiement\n";
		}

		// Total Amount Paid
		responseText += `\n*Total Payé:* ${order.amountPaid || 0}€\n`;

		// Separator between orders
		responseText += "\n" + "=".repeat(40) + "\n\n";
	});

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: responseText,
	});
}
// Command ID Generation
async function generateCommandId() {
	console.log("** generateCommandId");
	try {
		const now = new Date();
		const year = now.getFullYear();
		const month = String(now.getMonth() + 1).padStart(2, "0");
		const yearMonth = `${year}-${month}`;

		const seq = await CommandSequence.findOneAndUpdate(
			{ yearMonth },
			{ $inc: { currentNumber: 1 } },
			{ new: true, upsert: true, returnDocument: "after" }
		);

		return `CMD/${year}/${month}/${String(seq.currentNumber).padStart(4, "0")}`;
	} catch (error) {
		console.error("Error generating command ID:", error);
		throw error;
	}
}
async function generatePaymentRequestId() {
	console.log("** generatePaymentRequestId");
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const yearMonth = `${year}-${month}`;

	const seq = await PaymentSequence.findOneAndUpdate(
		{ yearMonth },
		{ $inc: { currentNumber: 1 } },
		{ new: true, upsert: true, returnDocument: "after" }
	);

	return `PAY/${year}/${month}/${String(seq.currentNumber).padStart(4, "0")}`;
}
async function extractArticles(formData) {
	console.log("** extractArticles");
	const articles = [];
	const quantityErrors = {};

	// Get all article indices from form data instead of sequential loop
	const articleIndices = new Set();

	// Find all article indices from form data keys
	Object.keys(formData).forEach((key) => {
		const match = key.match(
			/^(designation|quantity_number|quantity_unit|article_photos)_(\d+)$/
		);
		if (match) {
			articleIndices.add(parseInt(match[2]));
		}
	});

	// Sort indices to process them in order
	const sortedIndices = Array.from(articleIndices).sort((a, b) => a - b);

	console.log("Found article indices:", sortedIndices);

	for (const articleIndex of sortedIndices) {
		const quantityNumberBlock =
			formData[`quantity_number_${articleIndex}`]?.[
				`input_quantity_${articleIndex}`
			];
		const quantityUnitBlock =
			formData[`quantity_unit_${articleIndex}`]?.[
				`select_unit_${articleIndex}`
			];

		if (!quantityNumberBlock || !quantityUnitBlock) {
			console.log(`Skipping article ${articleIndex} - missing quantity data`);
			continue;
		}

		const quantity = Number(quantityNumberBlock.value) || 0;
		const unit = quantityUnitBlock.selected_option?.value || "piece";
		const designation =
			formData[`designation_${articleIndex}`]?.[
				`input_designation_${articleIndex}`
			]?.value || "";

		// Extract photos for this article
		const photoFiles =
			formData[`article_photos_${articleIndex}`]?.[
				`input_article_photos_${articleIndex}`
			]?.files || [];

		const photos = [];

		// Process each photo file
		// for (const file of photoFiles) {
		// 	const userToken = process.env.SLACK_USER_OAUTH_TOKEN;
		// 	let finalUrl =
		// 		file.permalink || file.url_private_download || file.url_private;

		// 	// Try to make file publicly accessible if user token is available
		// 	if (userToken) {
		// 		try {
		// 			const shareResponse = await fetch(
		// 				"https://slack.com/api/files.sharedPublicURL",
		// 				{
		// 					method: "POST",
		// 					headers: {
		// 						Authorization: `Bearer ${userToken}`,
		// 						"Content-Type": "application/json; charset=utf-8",
		// 					},
		// 					body: JSON.stringify({ file: file.id }),
		// 				}
		// 			);
		// 			const shareResult = await shareResponse.json();
		// 			console.log("shareResponse", shareResult);

		// 			if (shareResult.ok) {
		// 				console.log(`File ${file.id} is now publicly shared.`);
		// 				console.log(`Public permalink_public URL: ${shareResult.file.permalink_public}`);
		// 				console.log(`Public URL: ${file.permalink_public}`);
		// 				console.log(`Public permalink URL: ${file.permalink}`);

		// 				// Use the public permalink if available
		// 				finalUrl =
		// 					file.permalink_public ||
		// 					file.permalink ||
		// 					file.url_private_download ||
		// 					file.url_private;
		// 				if (finalUrl == file.url_private_download &&
		// 					finalUrl == file.url_private) {
		// 					console.log(
		// 						`Using fallback URL for file ${file.id}: ${finalUrl}`
		// 					);
		// 				}

		// 			} else {
		// 				console.error(
		// 					`Failed to share file ${file.id}: ${shareResult.error}`
		// 				);
		// 				// Keep the original URL as fallback
		// 				finalUrl =
		// 					file.permalink || file.url_private_download || file.url_private;
		// 			}
		// 		} catch (error) {
		// 			console.error(`Error sharing file ${file.id}: ${error.message}`);
		// 			// Keep the original URL as fallback
		// 			finalUrl =
		// 				file.permalink || file.url_private_download || file.url_private;
		// 		}
		// 	}

		// 	// Add photo to the photos array
		// 	photos.push({
		// 		id: file.id,
		// 		name: file.name,
		// 		url: finalUrl,
		// 		url_private: file.url_private,
		// 		permalink: file.permalink,
		// 		mimetype: file.mimetype,
		// 		size: file.size,
		// 		uploadedAt: new Date(),
		// 	});
		// 	console.log(`Photo ${file.name} processed for article ${articleIndex}`);
		// }

		// console.log(`Processing ${proformaFiles.length} proforma files...`);

		for (const file of photoFiles) {
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
					channel_id: process.env.SLACK_ORDER_LOG_CHANNEL,
					file: buffer,
					filename: filename,
					// title: `Proforma uploaded by <@${userId}>`,
					// initial_comment: `📎 New proforma file shared by <@${userId}>: ${filename}`,
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
						//     text: `📎 New proforma file shared by <@${userId}>: ${filename}`,
						//     attachments: [
						//         {
						//             title: filename,
						//             title_link: filePermalink,
						//             text: "Click to view the uploaded file",
						//             color: "good",
						//         },
						//     ],
						// });
						console.log(`Notification sent to colleague: ${colleagueId}`);
					} catch (dmError) {
						console.error(`Error sending DM to ${colleagueId}:`, dmError);
					}
				}

				// Prepare file data for return (matching your schema)
				// const fileData = {
				//     file_id: uploadedFileId,
				//     filename: filename,
				//     permalink: filePermalink,
				//     url_private: uploadedFileInfo.url_private,
				//     url_private_download: uploadedFileInfo.url_private_download,
				//     size: fileSize,
				//     mimetype: mimeType,
				//     uploaded_by: userId,
				//     uploaded_at: new Date(),
				//     channel_id: process.env.SLACK_ADMIN_ID,
				// };

				// // Store file data for return
				// processedFiles.push(fileData);
				// console.log("File data prepared for return:", fileData);

				// Store file reference for legacy support

				// 	// Add photo to the photos array
				photos.push({
					id: uploadedFileId,
					url: filePermalink,
					uploadedAt: new Date(),
				});
				console.log(`Photo processed for article ${photos}`);

				totalPages += 1;
			} catch (error) {
				console.error("Error processing file:", error.message);
				console.error("Full error:", error);

				// Send error notification to user
			}
		}
		console.log(`aa Photo processed for article ${photos}`);

		console.log(`Processing article ${articleIndex}:`, {
			designation,
			quantity,
			unit,
			photosCount: photos.length,
		});
		console.log(
			`Designation: ${designation}, Quantity: ${quantity}, Unit: ${unit}, Photos: ${photos}`
		);
		articles.push({
			quantity: quantity,
			unit: unit,
			designation: String(designation),
			photos: photos,
		});

		if (!Number.isInteger(quantity) || quantity <= 0) {
			quantityErrors[`quantity_number_${articleIndex}`] =
				"La quantité doit être un nombre entier positif.";
		}
	}

	console.log(
		`Extracted ${articles.length} articles:`,
		articles.map((a) => ({
			designation: a.designation,
			quantity: a.quantity,
			unit: a.unit,
			photosCount: a.photos.length,
		}))
	);

	return { articles, quantityErrors };
}

// Order Creation
async function createAndSaveOrder(
	id,
	userId,
	channelName,
	channelId,
	formData,
	articles,
	date,
	proformas,
	context
) {
	console.log("** createAndSaveOrder");
	try {
		// context.log("createAndSaveOrder function");
		// Get the selected date string from the form data
		let requestDate;
		// console.log("formData.request_date?.input_request_date?.selected_date",formData.request_date?.input_request_date?.selected_date);
		if (formData.request_date?.input_request_date?.selected_date) {
			// Get just the date part (YYYY-MM-DD) and create a date at 00:00:00 UTC
			const dateStr = formData.request_date.input_request_date.selected_date;
			// Create a date object and then format it back to YYYY-MM-DD to remove time portion
			requestDate = dateStr.split("T")[0];
			// console.log("requestDate11",requestDate);
		} else {
			// Use current date, formatted as YYYY-MM-DD
			requestDate = new Date().toISOString().split("T")[0];
			// console.log("requestDate22",requestDate);
		}

		// Extract the team value from the selected option
		let teamValue = "Non spécifié";
		if (formData.equipe_selection?.select_equipe?.selected_option?.text?.text) {
			teamValue =
				formData.equipe_selection.select_equipe.selected_option.text.text;
		} else if (formData.equipe) {
			teamValue = formData.equipe;
		} else if (typeof formData.equipe_selection === "string") {
			teamValue = formData.equipe_selection;
		}
		const productPhotos = [];
		if (formData.product_photos?.input_product_photos?.files?.length > 0) {
			formData.product_photos.input_product_photos.files.forEach((file) => {
				productPhotos.push({
					id: file.id,
					name: file.name,
					url: file.permalink || file.url_private_download || file.url_private, // Use permalink first
					url_private: file.url_private, // Keep private URL as backup
					permalink: file.permalink,
					mimetype: file.mimetype,
					size: file.size,
					uploadedAt: new Date(),
				});
			});
		}
		const orderData = {
			id_commande: await generateCommandId(),
			channel: channelName || channelId || "N/A",
			channelId: channelId || "N/A",
			titre: formData.request_title?.input_request_title?.value,
			demandeur: userId,
			demandeurId: id,
			articles: articles,
			equipe: teamValue,
			proformas: proformas,
			productPhotos: productPhotos,
			statut: "En attente",
			date: new Date(), // This is the creation date (with time)
			date_requete: requestDate, // This is just the date string YYYY-MM-DD
			autorisation_admin: false,
			payment: { status: "En attente" },
		};

		// context.log(`Order data before save: ${JSON.stringify(orderData)}`);

		const order = new Order(orderData);
		const savedOrder = await order.save();
		return savedOrder;
	} catch (error) {
		console.error("Error creating and saving order:", error);
		throw error;
	}
}

// Form Submission Handling
// ... Existing imports ...
function validateBaseForm(formData) {
	console.log("** validateBaseForm");
	const errors = {};
	const requiredFields = [
		"request_title",
		"equipe_selection",
		"request_date",
		"designation_1",
	];

	requiredFields.forEach((field) => {
		if (!formData[field]?.value) {
			errors[field] = "Ce champ est obligatoire";
		}
	});

	return errors;
}
async function handleFormErrors({
	payload,
	context,
	errors,
	suggestions,
	needsProforma,
}) {
	console.log("** handleFormErrors");
	const errorBlocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: "⚠️ *Erreurs détectées dans votre commande*",
			},
		},
		...Object.entries(errors).map(([field, message]) => ({
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*${fieldLabelMap[field]}*: ${message}`,
			},
		})),
		{
			type: "actions",
			block_id: "error_actions",

			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Corriger" },
					action_id: "return_to_form",
					value: JSON.stringify({
						viewId: payload.view.id,
						formData: payload.view.state.values,
					}),
				},
			],
		},
	];

	await updateSlackView(payload.view.id, errorBlocks);
	return { response_action: "update" };
}

const fieldLabelMap = {
	request_title: "Titre",
	equipe_selection: "Équipe",
	request_date: "Date",
	designation_1: "Désignation",
};

async function postSlackMessage1(url, data, token) {
	console.log("** postSlackMessage1");
	try {
		const response = await axios.post(url, data, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});
		return response; // Return the full response object
	} catch (error) {
		console.error(`Failed to post to Slack API: ${error.message}`);
		throw new Error(`Slack API error: ${error.message}`);
	}
}

// Handler for the payment problem submission
async function handlePaymentProblemSubmission(payload, context) {
	try {
		console.log("===+ 4 handlePaymentProblemSubmission");
		const formData = payload.view.state.values;
		const metadata = JSON.parse(payload.view.private_metadata);
		console.log("===+ metadata", metadata);
		console.log("===+ payload", payload);
		const entityId = metadata.entityId;
		const selectedCaisseId = metadata.selectedCaisseId;

		let targetChannelId = process.env.SLACK_FINANCE_CHANNEL_ID;

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

		const paymentIndex = metadata.paymentIndex;
		console.log("m== Payment index:", paymentIndex);
		// Extract problem details
		const problemType =
			formData.problem_type.select_problem_type.selected_option.value;
		console.log("m== Problem type:", problemType);
		const problemDescription =
			formData.problem_description.input_problem_description.value;
		console.log("m== Problem description:", problemDescription);
		// Fetch the entity
		const entity = await fetchEntity(entityId, context);
		if (!entity) {
			throw new Error(`Entity ${entityId} not found`);
		}
		console.log("entity111", entity);

		if (entityId.startsWith("CMD/")) {
			const updateResult = await Order.updateOne(
				{ id_commande: entityId },
				{
					$set: {
						blockPayment: true,
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);

			if (updateResult.modifiedCount === 0) {
				throw new Error(
					`Failed to update entity ${entityId} - no documents modified`
				);
			}
		} else if (entityId.startsWith("PAY/")) {
			await PaymentRequest.findOneAndUpdate(
				{ id_paiement: entityId },
				{
					$set: {
						blockPayment: true,
					},
				}
			);
		}
		// Get payment data
		const paymentData = entity.payments[paymentIndex];

		// Create blocks for admin notification
		const blocks = [
			{
				type: "header",
				text: {
					type: "plain_text",
					text: `⚠️ Problème de paiement signalé: ${entityId}`,
					emoji: true,
				},
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*ID:*\n${entityId}`,
					},
					{
						type: "mrkdwn",
						text: `*Signalé par:*\n<@${payload.user.id}>`,
					},
				],
			},
			{
				type: "section",
				fields: [
					{
						type: "mrkdwn",
						text: `*Type de problème:*\n${getProblemTypeText(problemType)}`,
					},
					{
						type: "mrkdwn",
						text: `*Date du signalement:*\n${new Date().toLocaleString(
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
						)}
            `,
					},
				],
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Description du problème:*\n${problemDescription}`,
				},
			},
			{
				type: "divider",
			},
		];

		// Add payment details to blocks
		const paymentBlocks = await getPaymentBlocks(
			entity,
			{
				title: paymentData.paymentTitle || paymentData.title,
				mode: paymentData.paymentMode || paymentData.mode,
				amountPaid: paymentData.amountPaid,
				date: paymentData.dateSubmitted || paymentData.date,
				url: paymentData.paymentUrl || paymentData.url,
				proofs: paymentData.paymentProofs || paymentData.proofs || [],

				details: paymentData.details,
			},
			entity.remainingAmount,
			entity.paymentStatus || entity.statut
		);

		// Add all payment details except header (which is blocks[0])
		blocks.push(...paymentBlocks.slice(1));

		// Add modify payment button for admin
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					text: {
						type: "plain_text",
						text: "Modifier paiement",
						emoji: true,
					},
					style: "primary",
					action_id: "modify_payment",
					value: JSON.stringify({
						entityId: entityId,
						paymentIndex: paymentIndex,
						problemType: problemType,
						problemDescription: problemDescription,
						reporterId: payload.user.id,
						selectedCaisseId: selectedCaisseId,
					}),
				},
			],
		});

		// Send notification to admin channel
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `⚠️ Problème de paiement signalé pour ${entityId}`,
				blocks,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		// Also notify the finance channel that the problem has been reported
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: targetChannelId,
				text: `✅ Le problème de paiement pour ${entityId} a été signalé aux administrateurs`,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		return { response_action: "clear" };
	} catch (error) {
		context.log(`Error handling payment problem submission: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				problem_description: `Une erreur s'est produite: ${error.message}`,
			},
		};
	}
}

// Helper function to fetch an entity (order or payment request)
async function fetchEntity(entityId, context) {
	console.log("** fetchEntity");
	try {
		if (entityId.startsWith("CMD/")) {
			return await Order.findOne({ id_commande: entityId });
		} else if (entityId.startsWith("PAY/")) {
			return await PaymentRequest.findOne({ id_paiement: entityId });
		} else {
			context.log(`Invalid entity ID format: ${entityId}`);
			return null;
		}
	} catch (error) {
		context.log(`Error fetching entity ${entityId}: ${error.message}`);
		return null;
	}
}

async function handlePaymentModificationSubmission(payload, context) {
	console.log("** handlePaymentModificationSubmission");

	const { Order, PaymentRequest, Caisse } = require("./db");

	// Slack API configuration
	const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
	const SLACK_API_URL = "https://slack.com/api";

	// Helper function to post Slack messages
	async function postSlackMessage(channel, text, blocks) {
		try {
			const response = await axios.post(
				`${SLACK_API_URL}/chat.postMessage`,
				{
					channel,
					text,
					blocks,
				},
				{
					headers: {
						Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
						"Content-Type": "application/json",
					},
				}
			);
			if (!response.data.ok) {
				throw new Error(`Slack API error: ${response.data.error}`);
			}
			console.log(`Slack message posted to channel ${channel}`);
		} catch (error) {
			console.error(`Error posting Slack message: ${error.message}`);
			throw error;
		}
	}

	// Helper function to post ephemeral Slack messages
	async function postSlackEphemeral(channel, user, text) {
		try {
			const response = await axios.post(
				`${SLACK_API_URL}/chat.postEphemeral`,
				{
					channel,
					user,
					text,
				},
				{
					headers: {
						Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
						"Content-Type": "application/json",
					},
				}
			);
			if (!response.data.ok) {
				throw new Error(`Slack API error: ${response.data.error}`);
			}
			console.log(
				`Ephemeral Slack message posted to user ${user} in channel ${channel}`
			);
		} catch (error) {
			console.error(`Error posting ephemeral Slack message: ${error.message}`);
			throw error;
		}
	}

	try {
		console.log("Handling payment modification submission");
		const metadata = JSON.parse(payload.view.private_metadata);
		console.log("Metadata$:", metadata);
		// Extract metadata and submitted values
		const privateMetadata = JSON.parse(payload.view.private_metadata);
		const entityId = metadata.entityId;
		const orderId = metadata.entityId;
		const paymentIndex = metadata.paymentIndex;
		const selectedCaisseId = metadata.selectedCaisseId;
		console.log("$$/ selectedCaisseId", selectedCaisseId);

		console.log("$$ existingProofs", metadata.existingProofs);
		console.log("$$ existingUrls", metadata.existingUrls);

		const values = payload.view.state.values;

		console.log("Submitted payload values:", JSON.stringify(values, null, 2));
		// console.log("Order ID:", orderId, "Payment Index:", paymentIndex);

		// Extract form data from the modal
		const paymentTitle = values.payment_title?.input_payment_title?.value || "";
		const paymentAmount =
			parseFloat(values.amount_paid?.input_amount_paid?.value) || 0;
		const paymentMode =
			values.payment_mode?.select_payment_mode?.selected_option?.value || "";
		let paymentUrl = values.paiement_url?.input_paiement_url?.value || "";
		const paymentDate = new Date();
		let paymentStatus = paymentAmount > 0 ? "Partiel" : "Non payé";
		paymentStatus = paymentAmount == 0 ? "Payé" : paymentStatus;

		console.log("$$ paymentStatus", paymentStatus);

		// // If new payment URL was provided, use that instead
		// if (values.new_payment_url?.input_new_payment_url?.value) {
		//   paymentUrl = values.new_payment_url.input_new_payment_url.value;
		// }
		// console.log(
		//   "Payment URL:",
		//   values.new_payment_url?.input_new_payment_url?.value
		// );

		console.log("Extracted payment data:", {
			paymentTitle,
			paymentAmount,
			paymentMode,
			paymentUrl,
			paymentDate,
			paymentStatus,
		});

		// Prepare payment details based on mode
		let paymentDetails = {};
		if (paymentMode === "Chèque") {
			paymentDetails = {
				cheque_number: values.cheque_number?.input_cheque_number?.value || "",
				cheque_bank:
					values.cheque_bank?.input_cheque_bank?.selected_option?.value || "",
				cheque_date: values.cheque_date?.input_cheque_date?.selected_date || "",
				cheque_order: values.cheque_order?.input_cheque_order?.value || "",
			};
		} else if (paymentMode === "Virement") {
			paymentDetails = {
				virement_number:
					values.virement_number?.input_virement_number?.value || "",
				virement_bank:
					values.virement_bank?.input_virement_bank?.selected_option?.value ||
					"",
				virement_date:
					values.virement_date?.input_virement_date?.selected_date || "",
				virement_order:
					values.virement_order?.input_virement_order?.value || "",
			};
		} else if (paymentMode === "Mobile Money") {
			paymentDetails = {
				mobilemoney_recipient_phone:
					values.mobilemoney_recipient_phone?.input_mobilemoney_recipient_phone
						?.value,
				mobilemoney_sender_phone:
					values.mobilemoney_sender_phone?.input_mobilemoney_sender_phone
						?.value,
				mobilemoney_fees:
					values.mobilemoney_fees?.input_mobilemoney_fees?.value,
				mobilemoney_date:
					values.mobilemoney_date?.input_mobilemoney_date?.selected_date,
			};
		} else if (paymentMode === "Julaya") {
			paymentDetails = {
				julaya_recipient:
					values.julaya_recipient?.input_julaya_recipient?.value,
				julaya_date: values.julaya_date?.input_julaya_date?.selected_date,
				julaya_transaction_number:
					values.julaya_transaction_number?.input_julaya_transaction_number
						?.value,
			};
		}
		// Find the entity and get the original payment
		let entity;
		let originalPayment;
		let currency = "USD";

		if (orderId.startsWith("CMD/")) {
			entity = await Order.findOne({ id_commande: orderId });
			if (!entity || !entity.payments) {
				throw new Error(`Commande ${orderId} non trouvée ou sans paiements`);
			}

			if (paymentIndex < 0 || paymentIndex >= entity.payments.length) {
				throw new Error(
					`Index de paiement ${paymentIndex} invalide pour la commande ${orderId}`
				);
			}

			originalPayment = entity.payments[paymentIndex];

			console.log("Original payment:", originalPayment);

			if (
				entity.proformas &&
				entity.proformas.length > 0 &&
				entity.proformas[0].validated === true
			) {
				currency = entity.proformas[0].devise;
			}
		} else if (orderId.startsWith("PAY/")) {
			entity = await PaymentRequest.findOne({ id_paiement: orderId });
			if (!entity || !entity.payments) {
				throw new Error(
					`Demande de paiement ${orderId} non trouvée ou sans paiements`
				);
			}

			if (paymentIndex < 0 || paymentIndex >= entity.payments.length) {
				throw new Error(
					`Index de paiement ${paymentIndex} invalide pour la demande ${orderId}`
				);
			}

			originalPayment = entity.payments[paymentIndex];
			console.log("Original payment:", originalPayment);

			if (entity.devise) {
				currency = entity.devise;
			}
		} else {
			throw new Error(`Format d'ID non reconnu: ${orderId}`);
		}

		// Check caisse balance for cash payments
		if (paymentMode.trim() === "Espèces") {
			const originalAmount =
				originalPayment && originalPayment.paymentMode === "Espèces"
					? originalPayment.amountPaid || 0
					: 0;
			const amountChange = paymentAmount - originalAmount;
			console.log("Caisse check:", {
				originalAmount,
				paymentAmount,
				amountChange,
			});

			if (amountChange !== 0) {
				const caisse = await Caisse.findById(selectedCaisseId);

				if (!caisse) {
					throw new Error("Caisse document not found");
				}

				const currentBalance = caisse.balances[currency] || 0;
				const projectedBalance = currentBalance - amountChange;
				console.log("Caisse balance check:", {
					currentBalance,
					amountChange,
					projectedBalance,
				});

				if (projectedBalance < 0) {
					console.log(
						`❌ Error: Insufficient funds in Caisse for ${currency}. Current: ${currentBalance}, Required: ${amountChange}`
					);
					await postSlackMessage(
						process.env.SLACK_FINANCE_CHANNEL_ID || "C08KS4UH5HU",
						`❌ MODIFICATION DE PAIEMENT BLOQUÉE : Solde insuffisant dans la caisse pour ${currency}. Solde actuel: ${currentBalance}, Montant supplémentaire nécessaire: ${amountChange}. Veuillez recharger la caisse avant de procéder.`,
						[]
					);
					await postSlackEphemeral(
						payload.channel?.id || "C08KS4UH5HU",
						payload.user.id,
						`❌ Modification de paiement en espèces refusée pour ${orderId} : Solde insuffisant dans la caisse pour ${currency}. L'équipe des finances a été notifiée.`
					);
					return {
						status: 200,
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ response_action: "clear" }),
					};
				}

				// Update Caisse balance
				const caisseUpdate = {
					$inc: { [`balances.${currency}`]: -amountChange },
					$push: {
						transactions: {
							type: "payment_modification",
							amount: -amountChange,
							currency,
							orderId,
							details: `Modification du paiement pour ${paymentTitle} (Order: ${orderId})`,
							timestamp: new Date(),
							paymentMethod: "Espèces",
							paymentDetails,
						},
					},
				};

				console.log("Caisse update:", caisseUpdate);
				const updatedCaisse = await Caisse.findOneAndUpdate(
					{ _id: selectedCaisseId },
					caisseUpdate,
					{ new: true }
				).catch((err) => {
					console.error(`Error updating Caisse: ${err.message}`);
					throw new Error(`Failed to update Caisse: ${err.message}`);
				});

				// Sync Caisse to Excel
				if (updatedCaisse.latestRequestId) {
					await syncCaisseToExcel(
						updatedCaisse,
						updatedCaisse.latestRequestId
					).catch((err) => {
						console.error(`Error syncing Caisse to Excel: ${err.message}`);
					});
					console.log(
						`Excel file updated for latest request ${updatedCaisse.latestRequestId} with new balance for ${currency}`
					);
				} else {
					console.log(
						"No latestRequestId found in Caisse, skipping Excel sync"
					);
				}

				// Notify finance team
				await postSlackMessage(
					process.env.SLACK_FINANCE_CHANNEL_ID || "C08KS4UH5HU",
					`✅ Modification de paiement en espèces traitée pour ${orderId}. Changement: ${amountChange} ${currency}. Nouveau solde de la caisse: ${updatedCaisse.balances[currency]}.`,
					[]
				);
			} else {
				console.log("No Caisse update needed: amountChange is 0");
			}
		}
		// FIX: Handle payment proofs properly
		// FIXED: Handle payment proofs properly
		let paymentProofs = [];

		// Extract existing_proof_${index} values
		const existingProofsFromForm = [];
		if (metadata.existingProofs && Array.isArray(metadata.existingProofs)) {
			metadata.existingProofs.forEach((_, index) => {
				const proofValue =
					values[`existing_proof_${index}`]?.[`edit_proof_${index}`]?.value;
				if (proofValue && typeof proofValue === "string" && proofValue.trim()) {
					existingProofsFromForm.push(proofValue.trim());
				}
			});
		}
		console.log("$$ Existing Proofs from Form:", existingProofsFromForm);

		// Start with existing proofs from form (non-deleted)
		paymentProofs = [...existingProofsFromForm];

		// Add existing URLs from metadata if available and not already included
		// if (metadata.existingUrls && typeof metadata.existingUrls === "string") {
		//   if (!paymentProofs.includes(metadata.existingUrls)) {
		//     paymentProofs.push(metadata.existingUrls);
		//     console.log(
		//       "$$ Added existing URL from metadata:",
		//       metadata.existingUrls
		//     );
		//   }
		// }

		// Add new URL as a proof if provided
		if (values.new_payment_url?.input_new_payment_url?.value) {
			const newUrl = values.new_payment_url.input_new_payment_url.value;
			if (!paymentProofs.includes(newUrl)) {
				paymentProofs.push(newUrl);
				console.log("$$ Added new payment URL as proof:", newUrl);
			}
		}
		console.log("$$ url", values.new_payment_url?.input_new_payment_url?.value);
		// Add file uploads if provided
		if (
			values.payment_proof_file?.file_upload_proof?.files &&
			values.payment_proof_file.file_upload_proof.files.length > 0
		) {
			const fileUrls = values.payment_proof_file.file_upload_proof.files
				.map(
					(file) =>
						file.permalink || file.url_private_download || file.url_private
				) // Use permalink first
				.filter(
					(url) =>
						url && typeof url === "string" && !paymentProofs.includes(url)
				);

			paymentProofs = paymentProofs.concat(fileUrls);
			console.log("$$ Added file upload proofs:", fileUrls);
		}

		// Remove any undefined/null values and duplicates
		paymentProofs = [
			...new Set(
				paymentProofs.filter(
					(proof) => proof && typeof proof === "string" && proof.trim()
				)
			),
		];
		console.log("$$ Final Payment proofs:", paymentProofs);
		// if (

		//   originalPayment &&
		//   originalPayment.paymentProofs
		// ) {
		//   paymentProofs = [...originalPayment.paymentProofs];
		// }

		// // Add new URL as a proof if provided
		// if (values.new_payment_url?.input_new_payment_url?.value) {
		//   paymentProofs.push(values.new_payment_url.input_new_payment_url.value);

		// }
		// console.log("$$ url", values.new_payment_url?.input_new_payment_url?.value);

		// // Add file uploads if provided
		// if (
		//   values.payment_proof_file?.file_upload_proof?.files &&
		//   values.payment_proof_file.file_upload_proof.files.length > 0
		// ) {
		//   paymentProofs = paymentProofs.concat(
		//     values.payment_proof_file.file_upload_proof.files.map(
		//       (file) => file.url
		//     )
		//   );
		// }Z
		console.log("$$ Payment proof:", paymentProofs);

		// Prepare the updated payment object
		const updatedPayment = {
			paymentMode,
			amountPaid: paymentAmount,
			paymentTitle,
			paymentUrl,
			paymentProofs,
			details: paymentDetails,
			status: paymentStatus,
			dateSubmitted: paymentDate,
		};

		console.log("Updated payment data:", updatedPayment);

		// Update the payment in the database
		if (orderId.startsWith("CMD/")) {
			entity.payments[paymentIndex] = {
				...entity.payments[paymentIndex],
				...updatedPayment,
				_id: entity.payments[paymentIndex]._id,
			};

			// Update total amount paid and remaining amount
			const totalAmountPaid = entity.payments.reduce(
				(sum, payment) => sum + (payment.amountPaid || 0),
				0
			);
			const totalAmountDue = await calculateTotalAmountDue(entityId, context);
			entity.amountPaid = totalAmountPaid;
			entity.remainingAmount = totalAmountDue - totalAmountPaid;
			entity.paymentDone = entity.remainingAmount <= 0;
			console.log("entity.remainingAmount:", entity.remainingAmount);
			entity.payments.paymentStatus =
				entity.remainingAmount == 0 ? "Payé" : paymentStatus;
			paymentStatus = entity.payments.paymentStatus;
			console.log("$$ paymentStatus", paymentStatus);

			await entity.save();
			console.log(`Payment ${paymentIndex} updated in order ${orderId}`);
		} else if (orderId.startsWith("PAY/")) {
			entity.payments[paymentIndex] = {
				...entity.payments[paymentIndex],
				...updatedPayment,
				_id: entity.payments[paymentIndex]._id,
			};

			// Update total amount paid and remaining amount
			const totalAmountPaid = entity.payments.reduce(
				(sum, payment) => sum + (payment.amountPaid || 0),
				0
			);
			const totalAmountDue = await calculateTotalAmountDue(entityId, context);
			// Validate to prevent negative remaining amount
			const remainingAmount = totalAmountDue - totalAmountPaid;
			if (remainingAmount < 0) {
				throw new Error(
					`Overpayment detected: Payment of ${totalAmountPaid} exceeds total amount due of ${totalAmountDue}.`
				);
			}

			entity.amountPaid = totalAmountPaid;
			entity.remainingAmount = remainingAmount;
			entity.paymentDone = entity.remainingAmount <= 0;
			entity.payments.paymentStatus =
				entity.remainingAmount == 0 ? "Payé" : paymentStatus;

			console.log("$$ paymentStatus", paymentStatus);

			await entity.save();
			console.log(
				`Payment ${paymentIndex} updated in payment request ${orderId}. Total paid: ${totalAmountPaid}, Remaining: ${entity.remainingAmount}`
			);
		}
		console.log("C");
		if (entityId.startsWith("CMD/")) {
			updateResult = await Order.updateOne(
				{ id_commande: entityId },
				{
					$set: {
						blockPayment: false,
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);
			// Refresh entity to ensure latest data
			updatedEntity = await fetchEntity(entityId, context);
			// console.log("Updated entity:", updatedEntity);
		} else if (entityId.startsWith("PAY/")) {
			updateResult = await PaymentRequest.findOneAndUpdate(
				{ id_paiement: entityId },
				{
					$set: {
						blockPayment: false,
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);
			// Refresh entity to ensure latest data
			updatedEntity = await fetchEntity(entityId, context);
			// console.log("Updated entity:", updatedEntity);
		}
		// Notify the user via Slack
		const channelId = privateMetadata.channelId || "C08KS4UH5HU";
		const userId = payload.user.id;
		const channels = [
			process.env.SLACK_FINANCE_CHANNEL_ID,
			entity.demandeurId, // Assuming this is a Slack user ID for DM
			channelId, // Original channel ID
		];
		console.log("°°° paymentUrl", paymentUrl);
		console.log("°°° paymentProofs", paymentProofs);
		console.log("Channels to notify:", channels);
		console.log("paymentDetails", paymentDetails);

		for (const Channel of channels) {
			const isFinanceChannel = Channel === process.env.SLACK_FINANCE_CHANNEL_ID;

			// Build the base fields array
			// const baseFields = [
			//   { type: "mrkdwn", text: `*Titre:*\n${paymentTitle}` },
			//   {
			//     type: "mrkdwn",
			//     text: `*Date:*\n${new Date(paymentDate).toLocaleString("fr-FR", {
			//       weekday: "long",
			//       year: "numeric",
			//       month: "long",
			//       day: "numeric",
			//       hour: "2-digit",
			//       minute: "2-digit",
			//       timeZoneName: "short",
			//     })}`,
			//   },
			//   {
			//     type: "mrkdwn",
			//     text: `*Montant payé:*\n${paymentAmount} ${currency}`,
			//   },
			//   { type: "mrkdwn", text: `*Mode de paiement:*\n${paymentMode}` },
			//   { type: "mrkdwn", text: `*Statut:*\n${paymentStatus}` },
			// ];

			// Add payment proof fields
			// const proofFields = [];

			// // Add first proof if paymentUrl exists and is not empty
			// if (paymentUrl && paymentUrl.trim()) {
			//   proofFields.push({
			//     type: "mrkdwn",
			//     text: `*Preuve 1:*\n<${paymentUrl}|Voir le justificatif>`,
			//   });
			// }

			// Add additional proofs from paymentProofs array
			// if (paymentProofs && Array.isArray(paymentProofs)) {
			//   paymentProofs.forEach((proof, index) => {
			//     if (proof && proof.trim()) {
			//       const proofNumber =
			//         paymentUrl && paymentUrl.trim() ? index + 2 : index + 1;
			//       proofFields.push({
			//         type: "mrkdwn",
			//         text: `*Preuve ${proofNumber}:*\n<${proof}|Voir le justificatif>`,
			//       });
			//     }
			//   });
			// }

			// Add payment method specific fields
			// const paymentMethodFields = [];
			// if (paymentMode === "Chèque" && paymentDetails) {
			//   paymentMethodFields.push(
			//     {
			//       type: "mrkdwn",
			//       text: `*Numéro de chèque:*\n${
			//         paymentDetails.cheque_number || "N/A"
			//       }`,
			//     },
			//     {
			//       type: "mrkdwn",
			//       text: `*Banque:*\n${paymentDetails.cheque_bank || "N/A"}`,
			//     },
			//     {
			//       type: "mrkdwn",
			//       text: `*Date du chèque:*\n${paymentDetails.cheque_date || "N/A"}`,
			//     },
			//     {
			//       type: "mrkdwn",
			//       text: `*Ordre:*\n${paymentDetails.cheque_order || "N/A"}`,
			//     }
			//   );
			// } else if (paymentMode === "Virement" && paymentDetails) {
			//   paymentMethodFields.push(
			//     {
			//       type: "mrkdwn",
			//       text: `*Numéro de virement:*\n${
			//         paymentDetails.virement_number || "N/A"
			//       }`,
			//     },
			//     {
			//       type: "mrkdwn",
			//       text: `*Banque:*\n${paymentDetails.virement_bank || "N/A"}`,
			//     }
			//   );
			// }

			// // Combine all fields (Slack has a limit of 10 fields per section)
			// const allFields = [...baseFields, ...proofFields, ...paymentMethodFields];

			// // Split fields into chunks if there are too many (max 10 per section)
			// const fieldChunks = [];
			// for (let i = 0; i < allFields.length; i += 10) {
			//   fieldChunks.push(allFields.slice(i, i + 10));
			// }

			// Build the blocks array
			const blocks = [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `💲 🔄 Paiement Modifié: ${orderId}`,
						emoji: true,
					},
				},
			];

			// Add section blocks for each chunk of fields
			// fieldChunks.forEach((fields) => {
			//   blocks.push({
			//     type: "section",
			//     fields: fields,
			//   });
			// });

			// Add payment details to blocks
			console.log("à entity", entity);
			console.log("entity.paymentStatus", entity.paymentStatus);
			console.log("entity.statut", entity.statut);
			console.log("paymentUrl", paymentUrl);
			console.log("paymentProofs", paymentProofs);
			console.log("paymentDetails", paymentDetails);

			const paymentBlocks = await getPaymentBlocks(
				entity,
				{
					title: paymentTitle || "",
					mode: paymentMode || "",
					amountPaid: paymentAmount || "",
					date: paymentDate || "",
					url: paymentUrl || [],
					proofs: paymentProofs || [],

					details: paymentDetails,
				},
				entity.remainingAmount,
				paymentStatus || entity.statut
			);

			// Add all payment details except header (which is blocks[0])
			blocks.push(...paymentBlocks.slice(1));

			// Add action buttons for finance channel
			if (isFinanceChannel) {
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
					],
				});
			}

			// Post the message
			await postSlackMessage(
				Channel,
				`✅ Paiement modifié avec succès pour ${orderId}`,
				blocks
			);
		}
		console.log(`Notification sent to channel ${channelId} for user ${userId}`);

		// Return response to clear the modal
		return {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
	} catch (error) {
		console.error(`Error in handlePaymentModificationSubmission: ${error}`);

		try {
			await postSlackEphemeral(
				payload.channel?.id || "C08KS4UH5HU",
				payload.user.id,
				`❌ Erreur lors de la modification du paiement: ${error.message}`
			);
		} catch (slackError) {
			console.error(`Error sending error notification: ${slackError}`);
		}

		throw error;
	}
}

// Handler for final deletion of proforma
async function handleDeleteProforma(payload, context) {
	try {
		console.log("** handleDeleteProforma");
		// Extract data from the modal submission
		const { orderId, proformaIndex, msgts } = JSON.parse(
			payload.view.private_metadata
		);

		// Get the order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			throw new Error(`Order ${orderId} not found`);
		}

		// Check if the proforma exists
		if (!order.proformas || !order.proformas[proformaIndex]) {
			throw new Error(
				`Proforma index ${proformaIndex} not found in order ${orderId}`
			);
		}

		// Check if the proforma is already validated
		if (order.proformas[proformaIndex].validated) {
			return {
				response_action: "errors",
				errors: {
					delete_proforma_confirmation:
						"Cette proforma a déjà été validée et ne peut pas être supprimée.",
				},
			};
		}

		// Store the proforma details for the notification
		const deletedProforma = order.proformas[proformaIndex];

		// Remove the proforma from the array
		order.proformas.splice(proformaIndex, 1);

		// Save the updated order
		await order.save();
		console.log("Notifying admin about proforma submission... 2");

		// Notify admin about the deletion
		await notifyAdminProforma(context, order, msgts);

		// Post confirmation message to achat channel
		await postSlackMessage(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ACHAT_CHANNEL_ID,
				text: `✅ Proforma supprimée par <@${payload.user.id}>: *${deletedProforma.nom}* - ${deletedProforma.montant} ${deletedProforma.devise} pour la commande ${orderId}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		return { response_action: "clear" };
	} catch (error) {
		context.log(`Error in handleDeleteProforma: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				delete_proforma_confirmation: `❌ Erreur lors de la suppression: ${error.message}`,
			},
		};
	}
}

// Handler for edit_proforma_submission

async function handleEditProformaSubmission(payload, context, userId) {
	try {
		console.log("** handleEditProformaSubmission");
		const { view } = payload;
		const { orderId, proformaIndex, existingUrls, existingFileIds, msgts } =
			JSON.parse(view.private_metadata);
		console.log("msgts", msgts);
		console.log("view.private_metadata", view.private_metadata);

		// Extract form values
		const designation =
			view.state.values.proforma_designation.designation_input.value;
		const amountInput =
			view.state.values.proforma_amount.input_proforma_amount.value;

		const fournisseurOption =
			view.state.values.proforma_fournisseur.fournisseur_input.selected_option;
		const fournisseur = fournisseurOption ? fournisseurOption.text.text : "";

		console.log("fournisseur", fournisseur);
		console.log("amountInput", amountInput);

		// Parse amount and currency
		const amountMatch = amountInput.match(/(\d+(?:\.\d+)?)\s*([A-Z]{3})/);
		if (!amountMatch) {
			return await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ACHAT_CHANNEL_ID,

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
					channel: process.env.SLACK_ACHAT_CHANNEL_ID,
					text: "⚠️ Erreur: Devise non reconnue. Les devises acceptées sont: XOF, USD, EUR. Veuillez modifier votre demande.",
				},
				process.env.SLACK_BOT_TOKEN
			);

			return { response_action: "clear" };
		}
		console.log("currency", currency);
		console.log("amount", amount);

		const montant = parseFloat(amountMatch[1]);
		const devise = amountMatch[2].toUpperCase();

		// Check if we should keep existing files/URLs
		const keepExistingCheckbox =
			view.state.values.keep_existing_files?.input_keep_existing
				?.selected_options || [];
		const keepExisting = keepExistingCheckbox.some(
			(option) => option.value === "keep"
		);

		// Collect all URLs and file IDs
		let updatedUrls = [];
		let updatedFileIds = [];

		// If keeping existing, start with the existing values
		if (keepExisting) {
			existingUrls.forEach((_, index) => {
				const blockId = `existing_url_${index}`;
				if (view.state.values[blockId]?.[`edit_url_${index}`]) {
					const updatedUrl =
						view.state.values[blockId][`edit_url_${index}`].value;
					if (updatedUrl && updatedUrl.trim()) {
						updatedUrls.push(updatedUrl.trim());
					}
				}
			});
			updatedFileIds = [...existingFileIds];
		}

		// Handle new URL
		const newUrl =
			view.state.values.new_proforma_url?.input_new_proforma_url?.value;
		if (newUrl && newUrl.trim()) {
			updatedUrls.push(newUrl.trim());
		}

		// Handle new file upload
		const newFiles = view.state.values.proforma_file?.file_upload?.files || [];
		if (newFiles.length > 0) {
			for (const file of newFiles) {
				updatedUrls.push(
					file.permalink || file.url_private_download || file.url_private
				); // Use permalink first
				updatedFileIds.push(file.id);
			}
		}

		// Initialize updateData with base values
		const updateData = {
			nom: designation,
			montant: montant,
			devise: devise,
			fournisseur: fournisseur,
			pages: updatedUrls.length, // Update page count based on total URLs
		};

		// Only set URLs and file_ids if they changed or we're not keeping existing
		if (updatedUrls.length > 0 || !keepExisting) {
			updateData.urls = updatedUrls;
		}
		if (updatedFileIds.length > 0 || !keepExisting) {
			updateData.file_ids = updatedFileIds;
		}

		// Update the proforma in the database
		const updatedOrder = await Order.findOneAndUpdate(
			{ id_commande: orderId },
			{ $set: { [`proformas.${proformaIndex}`]: updateData } },
			{ new: true }
		);

		if (!updatedOrder) {
			throw new Error(`Failed to update proforma for order ${orderId}`);
		}
		console.log("Notifying admin about proforma submission... 3");

		// Update the Slack message with the new proforma details
		await notifyAdminProforma(context, updatedOrder, msgts);

		return {
			response_action: "clear",
		};
	} catch (error) {
		context.log(`Error in handleEditProformaSubmission: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				proforma_amount: error.message,
			},
		};
	}
}
// Helper function to update the proforma message in Slack
async function updateProformaMessage(order, context) {
	try {
		console.log("** updateProformaMessage");
		// Find the message reference in your database
		const messageRef = await MessageReference.findOne({
			orderId: order.id_commande,
			messageType: "achat",
		});

		if (!messageRef) {
			context.log(`Message reference not found for order ${order.id_commande}`);
			return;
		}

		// Generate the updated message blocks
		const blocks = generateProformaMessageBlocks(order);

		// Update the message in Slack
		const response = await postSlackMessage(
			"https://slack.com/api/chat.update",
			{
				channel: messageRef.channel,
				ts: messageRef.ts,
				blocks: blocks,
				text: `Proformas pour ${order.id_commande} (Mis à jour)`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		if (!response.ok) {
			throw new Error(`Failed to update Slack message: ${response.error}`);
		}
	} catch (error) {
		context.log(`Error in updateProformaMessage: ${error.message}`);
		throw error;
	}
}
async function getChannelName(channelId, context) {
	console.log("** getChannelName");
	if (!channelId) {
		context.log("No channelId provided, returning 'unknown'");
		return "unknown";
	}

	context.log(`Fetching channel name for channelId: ${channelId}`);
	let channelName = "unknown"; // Default fallback

	try {
		const result = await axios.post(
			"https://slack.com/api/conversations.info",
			querystring.stringify({ channel: channelId }),
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
			}
		);

		context.log(`Slack API response: ${JSON.stringify(result.data)}`);

		if (result.data.ok) {
			channelName = result.data.channel.name;
			context.log(`Channel name retrieved: ${channelName}`);
			return channelName;
		} else {
			context.log(`Slack API error: ${result.data.error}`);
			return "unknown";
		}
	} catch (error) {
		context.log(`Failed to get channel name: ${error.message}`);
		return "unknown";
	}
}

// Helper function to convert payment method codes to readable text
function getPaymentMethodText(method) {
	const methodMap = {
		cash: "Espèces",
		cheque: "Chèque",
		transfer: "Virement",
	};
	return methodMap[method] || method;
}

async function handleCorrectionSubmission(payload, context) {
	console.log("** handleCorrectionSubmission");
	const metadata = JSON.parse(payload.view.private_metadata);
	const requestId = metadata.entityId;
	const channelId = metadata.channelId;
	const messageTs = metadata.messageTs;
	const userId = payload.user.username;

	const formData = payload.view.state.values;

	// Fetch caisse from database
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	// Find the specific funding request
	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	const request = caisse.fundingRequests[requestIndex];
	// Retrieve amount, currency, and paymentNotes from the database
	const amount = request.amount;
	const currency = request.currency?.toUpperCase();
	const paymentNotes = request.paymentDetails?.notes || "";

	// Validate amount and currency
	if (!amount || !currency) {
		return createSlackResponse(200, {
			response_action: "errors",
			errors: {
				general: "Montant ou devise manquant dans la base de données.",
			},
		});
	}

	if (amount <= 0) {
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Le montant doit être supérieur à zéro." },
		});
	}

	// Validate payment method from form
	let paymentMethod =
		formData.payment_method?.input_payment_method?.selected_option?.value;
	console.log("paymentMethod", paymentMethod);
	if (!paymentMethod) {
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { payment_method: "La méthode de paiement est requise." },
		});
	}
	const paymentMethod1 = getPaymentMethodText(paymentMethod);
	console.log("paymentMethod", paymentMethod1);

	// Update request details
	request.amount = amount; // Already set, but kept for clarity

	request.disbursementType = paymentMethod1; // Already set, but kept for clarity

	request.currency = currency; // Already set, but kept for clarity
	request.paymentDetails = {
		method: paymentMethod1,
		notes: paymentNotes, // Use database value
		approvedBy: userId,
		approvedAt: new Date(),
		filledBy: userId,
		filledAt: new Date(),
	};
	console.log("paymentMethod2", paymentMethod);
	if (paymentMethod !== "cheque") {
		delete request.paymentDetails.cheque; // Remove cheque details if method changes
	}
	if (paymentMethod === "cheque") {
		console.log("111");
		if (
			!formData.cheque_number?.input_cheque_number?.value ||
			!formData.cheque_bank?.input_cheque_bank?.selected_option?.value ||
			!formData.cheque_date?.input_cheque_date?.selected_date ||
			!formData.cheque_order?.input_cheque_order?.value
		) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					text: "⚠️ Veuillez remplir tous les champs requis pour le chèque.",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		}
		// Extract file IDs from file_input
		const fileIds =
			formData.cheque_files?.input_cheque_files?.files?.map(
				(file) => file.url_private
			) || [];
		console.log("File IDs:", fileIds);
		// Process URLs (comma-separated string to array)
		const urlsString = formData.cheque_urls?.input_cheque_urls?.value || "";
		const urls = urlsString
			? urlsString
					.split(",")
					.map((url) => url.trim())
					.filter((url) => /^https?:\/\/[^\s,]+$/.test(url))
			: [];
		console.log("URLs:", urls);
		request.paymentDetails.cheque = {
			number: formData.cheque_number.input_cheque_number.value,
			bank: formData.cheque_bank.input_cheque_bank.selected_option.value,
			date: formData.cheque_date.input_cheque_date.selected_date,
			order: formData.cheque_order.input_cheque_order.value,
			urls: urls.length > 0 ? urls : [],
			file_ids: fileIds.length > 0 ? fileIds : [],
		};
	}

	if (paymentMethod !== "cheque") {
		console.log("222");
		request.paymentDetails.cheque = null;
	}
	request.status = "Validé";
	request.approvedBy = userId;
	request.approvedAt = new Date(); // Approved At

	request.workflow.stage = "approved";
	request.workflow.history.push({
		stage: "approved",
		timestamp: new Date(),
		actor: userId,
		details: "Détails corrigés et approuvés",
	});
	// Consolidate database update
	const update = {
		$set: { [`fundingRequests.${requestIndex}`]: request },
		$push: {
			transactions: {
				type: "Funding",
				amount: amount,
				currency: currency,
				requestId,
				details: `Corrigé et approuvé par <@${userId}> `,
				timestamp: new Date(),
			},
		},
	};
	console.log("request.changed", request.changed);
	// Increment balance only if not previously updated
	if (request.changed == false) {
		update.$inc = { [`balances.${currency}`]: amount };
		console.log(
			`[Balance Update] Incrementing balances.${currency} by ${amount}`
		);
	}
	request.changed = true; // Already set, but kept for clarity

	// Perform atomic update and fetch updated document
	const updatedCaisse = await Caisse.findOneAndUpdate(
		{ "fundingRequests.requestId": requestId },
		update,
		{ new: true }
	);

	// Log the updated balance
	console.log(
		`[Balance Update] Updated caisse balances:`,
		JSON.stringify(updatedCaisse.balances, null, 2)
	);

	// Sync to Excel
	try {
		await syncCaisseToExcel(updatedCaisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `Erreur lors de la synchronisation Excel pour ${requestId}. Contactez l'administrateur.`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}

	// Notify finance team
	const chequeDetailsText =
		paymentMethod === "cheque"
			? `\n• Numéro: ${request.paymentDetails.cheque.number}\n• Banque: ${request.paymentDetails.cheque.bank}\n• Date: ${request.paymentDetails.cheque.date}\n• Ordre: ${request.paymentDetails.cheque.order}`
			: "";
	const block = generateFundingDetailsBlocks(
		request,
		request.paymentDetails.method,
		request.paymentDetails.notes,
		request.paymentDetails,
		userId,
		caisse.type
	);
	console.log("request.paymentDetails.method", request.paymentDetails.method);
	console.log("request", request);
	console.log("request.paymentDetails", request.paymentDetails);

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_FINANCE_CHANNEL_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: ✅ Demande de fonds - Corrigée et Approuvée : ${requestId}`,
						emoji: true,
					},
				},
				...block,
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
						},
					],
				},
			],
			text: `Demande ${requestId} corrigée et approuvée`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: ✅ Demande de fonds - Corrigée et Approuvée : ${requestId}`,
						emoji: true,
					},
				},
				...block,
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
						},
					],
				},
			],
			text: `Demande ${requestId} corrigée et approuvée`,
		},
		process.env.SLACK_BOT_TOKEN
	);
	return createSlackResponse(200, { response_action: "clear" });
}
async function handlePaymentModifSubmission(payload, context) {
	console.log("** handlePaymentFormSubmission");

	try {
		const view = payload.view;

		// Parse private metadata
		const metadata = JSON.parse(view.private_metadata || "{}");
		const { paymentId, originalMessage } = metadata;

		if (!paymentId || !originalMessage) {
			throw new Error("Missing paymentId or originalMessage in metadata");
		}

		context.log(`Processing submission for payment ID: ${paymentId}`);

		// Extract form values
		const stateValues = view.state.values;
		const formData = {
			request_title: stateValues.request_title?.input_request_title?.value,
			request_date: stateValues.request_date?.input_request_date?.selected_date,
			payment_reason: stateValues.payment_reason?.input_payment_reason?.value,
			amount_to_pay: stateValues.amount_to_pay?.input_amount_to_pay?.value,
			po_number: stateValues.po_number?.input_po_number?.value,
			justificatif_url:
				stateValues.justificatif_url?.input_justificatif_url?.value,
			justificatif_files:
				stateValues.justificatif?.input_justificatif?.files || [],
			existing_justificatifs: Object.keys(stateValues)
				.filter((key) => key.startsWith("existing_justificatif_"))
				.map((key) => stateValues[key][`input_${key}`]?.value)
				.filter((url) => url && url.trim()), // Filter out empty or null values
		};

		// Validate required fields
		if (
			!formData.request_title ||
			!formData.request_date ||
			!formData.payment_reason ||
			!formData.amount_to_pay ||
			!formData.po_number
		) {
			throw new Error("Missing required fields in form submission");
		}

		// Extract amount and currency
		const amountMatch = formData.amount_to_pay.match(
			/^(\d+(\.\d+)?)\s*([A-Z]{3})$/
		);
		if (!amountMatch) {
			throw new Error(
				"Invalid amount format. Expected: 'number CURRENCY' (e.g., 1000 USD)"
			);
		}
		const amount = parseFloat(amountMatch[1]);
		const currency = amountMatch[3];

		// Fetch existing payment
		const payment = await PaymentRequest.findOne({ id_paiement: paymentId });
		if (!payment) {
			throw new Error(`Payment with ID ${paymentId} not found`);
		}

		if (payment.statut !== "En attente") {
			await axios.post(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: originalMessage.channel,
					user: payload.user.id,
					text: `⚠️ Demande de paiement traitée par l'Administrateur, vous ne pouvez pas la modifier.`,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);
			return { statusCode: 200, body: "" };
		}

		// Prepare justificatifs: combine existing files, new files, and new URL
		const existingFiles = payment.justificatif.filter((j) => j.type === "file");
		const existingUrl =
			payment.justificatif.find((j) => j.type === "url") || null;
		const newFiles = formData.justificatif_files.map((file) => ({
			url: file.permalink,
			type: "file",
			createdAt: new Date(),
		}));
		const newUrl = formData.justificatif_url
			? { url: formData.justificatif_url, type: "url", createdAt: new Date() }
			: null;
		const existingUrls = formData.existing_justificatifs.map((url) => ({
			url,
			type: payment.justificatif.find((j) => j.url === url)?.type || "url", // Preserve original type if exists
			createdAt:
				payment.justificatif.find((j) => j.url === url)?.createdAt ||
				new Date(),
		}));
		const updatedJustificatifs = [
			...existingUrls, // Keep URLs from input fields
			...newFiles, // Add new files
			...(newUrl ? [newUrl] : []), // Add new URL if provided
		];

		// Update payment in database
		const updatedPayment = await PaymentRequest.findOneAndUpdate(
			{ id_paiement: paymentId },
			{
				titre: formData.request_title,
				date_requete: new Date(formData.request_date),
				motif: formData.payment_reason,
				montant: amount,
				devise: currency,
				bon_de_commande: formData.po_number,
				justificatif: updatedJustificatifs,
				updatedAt: new Date(),
			},
			{ new: true }
		);

		context.log(`Updated payment: ${JSON.stringify(updatedPayment)}`);

		// Generate updated blocks for both messages using getPaymentRequestBlocks
		const demandeurBlocks = [
			...getPaymentRequestBlocks(updatedPayment, null),
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Modifier", emoji: true },
						style: "primary",
						action_id: "edit_payment",
						value: paymentId,
					},
				],
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "✅ Votre demande de paiement a été mise à jour. En attente de validation par un administrateur.",
					},
				],
			},
		];
		const adminBlocks = [
			...getPaymentRequestBlocks(updatedPayment, null),
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Approuver", emoji: true },
						style: "primary",
						action_id: "payment_verif_accept",
						value: paymentId,
					},
					{
						type: "button",
						text: { type: "plain_text", text: "Rejeter", emoji: true },
						style: "danger",
						action_id: "reject_order",
						value: paymentId,
					},
				],
			},
			{
				type: "context",
				elements: [{ type: "mrkdwn", text: "⏳ En attente de validation" }],
			},
		];

		// Update Demandeur's message
		const demandeurUpdateResponse = await axios.post(
			"https://slack.com/api/chat.update",
			{
				channel: originalMessage.channel,
				ts: originalMessage.ts,
				text: `Demande de paiement *${paymentId}* mise à jour`,
				blocks: demandeurBlocks,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			}
		);

		if (!demandeurUpdateResponse.data.ok) {
			throw new Error(
				`Failed to update demandeur message: ${demandeurUpdateResponse.data.error}`
			);
		}
		context.log(
			`Updated demandeur message: ${JSON.stringify(
				demandeurUpdateResponse.data
			)}`
		);

		// Update Admin message
		if (
			updatedPayment.admin_message?.channel &&
			updatedPayment.admin_message?.ts
		) {
			const adminUpdateResponse = await axios.post(
				"https://slack.com/api/chat.update",
				{
					channel: updatedPayment.admin_message.channel,
					ts: updatedPayment.admin_message.ts,
					text: `Demande de paiement *${paymentId}* mise à jour par <@${updatedPayment.demandeur}>`,
					blocks: adminBlocks,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);

			if (!adminUpdateResponse.data.ok) {
				throw new Error(
					`Failed to update admin message: ${adminUpdateResponse.data.error}`
				);
			}

			context.log(
				`Updated admin message: ${JSON.stringify(adminUpdateResponse.data)}`
			);
		} else {
			context.log(
				"⚠️ Admin message details not found, skipping admin message update"
			);
		}

		return { statusCode: 200, body: "" };
	} catch (error) {
		context.log(
			`❌ Error in handlePaymentFormSubmission: ${error.message}\nStack: ${error.stack}`
		);

		await axios.post(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.channel?.id || payload.user.id,
				user: payload.user.id,
				text: `🛑 Échec de la soumission du formulaire: ${error.message}`,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			}
		);

		return {
			statusCode: 400,
			body: JSON.stringify({
				response_type: "ephemeral",
				text: `Erreur lors de la soumission: ${error.message}`,
			}),
			headers: { "Content-Type": "application/json" },
		};
	}
}
// Helper function to fetch document
async function fetchDocument(orderId) {
	if (orderId.startsWith("CMD/")) {
		return await Order.findOne({ id_commande: orderId });
	} else if (orderId.startsWith("PAY/")) {
		return await PaymentRequest.findOne({ id_paiement: orderId });
	} else {
		throw new Error("Invalid orderId format");
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
		console.error(`Error generating payment number: ${error.message}`);
		throw new Error(`Failed to generate payment number: ${error.message}`);
	}
}
// MODIFIED: Main payment processing logic
// Move validation BEFORE database update
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
								text: `❌ Le montant payé (${amountPaid}) dépasse le montant restant dû (${originalRemainingAmount}) même en incluant les frais (${fees}).`,
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
							text: `❌ Le montant payé (${amountPaid}) dépasse le montant restant dû (${originalRemainingAmount}).`,
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
						cheque_number: formData.cheque_number?.input_cheque_number?.value,
						cheque_bank:
							formData.cheque_bank?.input_cheque_bank?.selected_option?.value,
						cheque_date: formData.cheque_date?.input_cheque_date?.selected_date,
						cheque_order: formData.cheque_order?.input_cheque_order?.value,
					};
					break;
				case "Virement":
					paymentDetails = {
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
					};
					break;
				case "Julaya":
					paymentDetails = {
						julaya_recipient:
							formData.julaya_recipient?.input_julaya_recipient?.value,
						julaya_date: formData.julaya_date?.input_julaya_date?.selected_date,
						julaya_transaction_number:
							formData.julaya_transaction_number
								?.input_julaya_transaction_number?.value,
					};
					break;
				case "Espèces":
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
// ...existing code...

// Add these functions after the existing functions

// Create and save transfer request function
async function createAndSaveTransferRequest(
	userId,
	userName,
	formData,
	context
) {
	console.log("** createAndSaveTransferRequest");

	// Get or create caisse for storing transfer requests
	let caisse = await Caisse.findOne();
	if (!caisse) {
		caisse = new Caisse({
			balances: { XOF: 0, USD: 0, EUR: 0 },
			currency: "XOF",
			fundingRequests: [],
			transferRequests: [], // Add this field to store transfer requests
		});
	}

	// Generate transferId in format TRANS/YYYY/MM/XXXX
	const now = new Date();
	const year = now.getFullYear();
	const month = (now.getMonth() + 1).toString().padStart(2, "0");
	const existingTransfers =
		caisse.transferRequests?.filter((req) =>
			req.transferId.startsWith(`TRANS/${year}/${month}/`)
		) || [];
	const sequence = existingTransfers.length + 1;
	const sequenceStr = sequence.toString().padStart(4, "0");
	const transferId = `TRANS/${year}/${month}/${sequenceStr}`;

	// Create transfer request object
	const transferRequestData = {
		transferId,
		fromCaisse:
			formData.from_caisse_block.from_caisse_select.selected_option.value,
		toCaisse: formData.to_caisse_block.to_caisse_select.selected_option.value,
		currency: formData.currency_block.currency_select.selected_option.value,
		amount: parseFloat(formData.amount_block.amount_input.value),
		motif: formData.motif_block.motif_input.value,
		paymentMode:
			formData.payment_mode_block.payment_mode_select.selected_option.value,
		submittedBy: userName,
		submittedByID: userId,
		status: "En attente",
		submittedAt: new Date(),
		workflow: {
			stage: "initial_request",
			history: [
				{
					stage: "initial_request",
					timestamp: new Date(),
					actor: userName,
					details: "🔀 Demande de transfert soumise",
				},
			],
		},
	};

	// Validate the transfer request
	const fromCaisse = await Caisse.findOne({
		channelId: transferRequestData.fromCaisse,
	});
	const toCaisse = await Caisse.findOne({
		channelId: transferRequestData.toCaisse,
	});

	if (!fromCaisse) {
		throw new Error(`Caisse source non trouvée`);
	}

	if (!toCaisse) {
		throw new Error(`Caisse destination non trouvée`);
	}

	if (transferRequestData.fromCaisse === transferRequestData.toCaisse) {
		throw new Error(
			`La caisse source et destination ne peuvent pas être identiques`
		);
	}

	if (
		fromCaisse.balances[transferRequestData.currency] <
		transferRequestData.amount
	) {
		throw new Error(`Solde insuffisant dans la caisse source`);
	}

	// Initialize transferRequests array if it doesn't exist
	if (!caisse.transferRequests) {
		caisse.transferRequests = [];
	}

	// Add to caisse
	caisse.transferRequests.push(transferRequestData);
	await caisse.save();

	// Sync to Excel if needed
	try {
		await syncCaisseToExcel(caisse, transferId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		context.log(
			`Excel sync failed for transfer ${transferId}: ${error.message}`
		);
	}

	// Return the created request
	const request = caisse.transferRequests.find(
		(r) => r.transferId === transferId
	);
	return request;
}

// Notify admin about transfer request
async function notifyAdminTransfer(request, context) {
	console.log("** notifyAdminTransfer");

	// Get current caisse balances
	const fromCaisse = await Caisse.findOne({ channelId: request.fromCaisse });
	const toCaisse = await Caisse.findOne({ channelId: request.toCaisse });

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `🔀 Demande de transfert: ${request.transferId}`,
						emoji: true,
					},
				},
				{
					type: "divider",
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*ID:*\n${request.transferId}`,
						},
						{
							type: "mrkdwn",
							text: `*Montant:*\n${request.amount} ${request.currency}`,
						},
					],
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*De:*\n<#${request.fromCaisse}>`,
						},
						{
							type: "mrkdwn",
							text: `*Vers:*\n<#${request.toCaisse}>`,
						},
					],
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*Motif:*\n${request.motif}`,
						},
						{
							type: "mrkdwn",
							text: `*Mode de paiement:*\n${request.paymentMode}`,
						},
					],
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*Demandeur:*\n${request.submittedBy}`,
						},
						{
							type: "mrkdwn",
							text: `*Statut:*\n${request.status}`,
						},
					],
				},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `*Soumis le:*\n${new Date(request.submittedAt).toLocaleString(
							"fr-FR"
						)}`,
					},
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Solde source actuel: ${
								fromCaisse?.balances[request.currency] || 0
							} ${request.currency} | Solde cible actuel: ${
								toCaisse?.balances[request.currency] || 0
							} ${request.currency}`,
						},
					],
				},
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: { type: "plain_text", text: "Approuver", emoji: true },
							style: "primary",
							value: request.transferId,
							action_id: "approve_transfer",
						},
						{
							type: "button",
							text: { type: "plain_text", text: "Rejeter", emoji: true },
							style: "danger",
							value: request.transferId,
							action_id: "reject_transfer",
						},
					],
				},
			],
			text: `Nouvelle demande de transfert: ${request.amount} ${request.currency} de <#${request.fromCaisse}> vers <#${request.toCaisse}> (ID: ${request.transferId})`,
		},
		process.env.SLACK_BOT_TOKEN,
		context
	);
}

// Notify user about transfer request
async function notifyUserTransfer(request, userId, context) {
	console.log("** notifyUserTransfer");

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: userId,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: "🔀 Demande de transfert soumise",
						emoji: true,
					},
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*ID:*\n${request.transferId}`,
						},
						{
							type: "mrkdwn",
							text: `*Montant:*\n${request.amount} ${request.currency}`,
						},
					],
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*De:*\n<#${request.fromCaisse}>`,
						},
						{
							type: "mrkdwn",
							text: `*Vers:*\n<#${request.toCaisse}>`,
						},
					],
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*Motif:*\n${request.motif}`,
						},
						{
							type: "mrkdwn",
							text: `*Statut:*\n${request.status}`,
						},
					],
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: "✅ Votre demande de transfert a été soumise. Vous serez notifié lorsqu'elle sera traitée.",
						},
					],
				},
			],
		},
		process.env.SLACK_BOT_TOKEN,
		context
	);
}

// Function to handle transfer approval confirmation submission
async function handleTransferApprovalConfirmation(payload, context) {
	console.log("** handleTransferApprovalConfirmation");

	try {
		const metadata = JSON.parse(payload.view.private_metadata);
		const transferId = metadata.transferId;
		const comment =
			payload.view.state.values.approval_comment_block?.approval_comment_input
				?.value || "";

		// Create a modified payload for the existing handleApproveTransfer function
		const modifiedPayload = {
			...payload,
			actions: [{ value: transferId }],
			channel: { id: metadata.channelId },
			message: { ts: metadata.messageTs },
		};

		// Call the existing approve transfer function
		const result = await handleApproveTransfer(
			modifiedPayload,
			context,
			comment
		);

		return result;
	} catch (error) {
		console.error(
			"Error handling transfer approval confirmation:",
			error.message
		);
		return createSlackResponse(200, {
			text: `❌ Erreur lors de l'approbation du transfert: ${error.message}`,
		});
	}
}

// Function to handle transfer rejection reason submission
async function handleTransferRejectionReason(payload, context) {
	console.log("** handleTransferRejectionReason");

	try {
		const metadata = JSON.parse(payload.view.private_metadata);
		const transferId = metadata.transferId;
		const rejectionReason =
			payload.view.state.values.rejection_reason_block.rejection_reason_input
				.value;

		if (!rejectionReason || rejectionReason.trim() === "") {
			return {
				response_action: "errors",
				errors: {
					rejection_reason_block: "Le motif du rejet est requis",
				},
			};
		}

		// Create a modified payload for the existing handleRejectTransfer function
		const modifiedPayload = {
			...payload,
			actions: [{ value: transferId }],
			channel: { id: metadata.channelId },
			message: { ts: metadata.messageTs },
		};

		// Call the existing reject transfer function with the rejection reason
		const result = await handleRejectTransfer(
			modifiedPayload,
			context,
			rejectionReason
		);

		return result;
	} catch (error) {
		console.error("Error handling transfer rejection reason:", error.message);
		return createSlackResponse(200, {
			text: `❌ Erreur lors du rejet du transfert: ${error.message}`,
		});
	}
}

// Modified handleApproveTransfer to accept optional comment
async function handleApproveTransfer(payload, context, approvalComment = null) {
	console.log("** handleApproveTransfer");

	try {
		const transferId = payload.actions[0].value;
		const userId = payload.user.id;
		const userName = payload.user.username;

		// Find the caisse containing the transfer request
		const caisse = await Caisse.findOne({
			"transferRequests.transferId": transferId,
		});

		if (!caisse) {
			console.error(`Caisse not found for transfer ${transferId}`);
			return createSlackResponse(200, {
				text: "❌ Demande de transfert introuvable",
			});
		}

		// Find the specific transfer request
		const transferIndex = caisse.transferRequests.findIndex(
			(r) => r.transferId === transferId
		);

		if (transferIndex === -1) {
			console.error(`Transfer ${transferId} not found`);
			return createSlackResponse(200, {
				text: "❌ Demande de transfert introuvable",
			});
		}

		const transferRequest = caisse.transferRequests[transferIndex];

		// Check if already processed
		if (transferRequest.status !== "En attente") {
			return createSlackResponse(200, {
				text: `❌ Cette demande de transfert a déjà été ${transferRequest.status.toLowerCase()}`,
			});
		}

		// Get source and destination caisses
		const fromCaisse = await Caisse.findOne({
			channelId: transferRequest.fromCaisse,
		});
		const toCaisse = await Caisse.findOne({
			channelId: transferRequest.toCaisse,
		});

		if (!fromCaisse || !toCaisse) {
			return createSlackResponse(200, {
				text: "❌ Caisse source ou destination introuvable",
			});
		}

		// Check if source caisse has sufficient balance
		const currentBalance = fromCaisse.balances[transferRequest.currency] || 0;
		if (currentBalance < transferRequest.amount) {
			return createSlackResponse(200, {
				text: `❌ Solde insuffisant dans la caisse source. Solde actuel: ${currentBalance} ${transferRequest.currency}`,
			});
		}

		// Perform the transfer
		const transferUpdate = {
			$inc: {
				[`balances.${transferRequest.currency}`]: -transferRequest.amount,
			},
			$push: {
				transactions: {
					type: "transfer_out",
					amount: -transferRequest.amount,
					currency: transferRequest.currency,
					transferId: transferId,
					details: `Transfert sortant vers <#${transferRequest.toCaisse}> - ${transferRequest.motif}`,
					timestamp: new Date(),
					transferDetails: {
						to: transferRequest.toCaisse,
						motif: transferRequest.motif,
						approvedBy: userName,
						approvalComment: approvalComment,
					},
				},
			},
		};

		const receiveUpdate = {
			$inc: {
				[`balances.${transferRequest.currency}`]: transferRequest.amount,
			},
			$push: {
				transactions: {
					type: "transfer_in",
					amount: transferRequest.amount,
					currency: transferRequest.currency,
					transferId: transferId,
					details: `Transfert entrant de <#${transferRequest.fromCaisse}> - ${transferRequest.motif}`,
					timestamp: new Date(),
					transferDetails: {
						from: transferRequest.fromCaisse,
						motif: transferRequest.motif,
						approvedBy: userName,
						approvalComment: approvalComment,
					},
				},
			},
		};

		// Update both caisses
		await Promise.all([
			Caisse.findOneAndUpdate(
				{ channelId: transferRequest.fromCaisse },
				transferUpdate,
				{ new: true }
			),
			Caisse.findOneAndUpdate(
				{ channelId: transferRequest.toCaisse },
				receiveUpdate,
				{ new: true }
			),
		]);

		// Update transfer request status
		transferRequest.status = "Approuvé";
		transferRequest.approvedBy = userName;
		transferRequest.approvedAt = new Date();
		if (approvalComment) {
			transferRequest.approvalComment = approvalComment;
		}
		transferRequest.workflow.stage = "approved";
		transferRequest.workflow.history.push({
			stage: "approved",
			timestamp: new Date(),
			actor: userName,
			details: `Demande de transfert approuvée et exécutée${
				approvalComment ? ` - Commentaire: ${approvalComment}` : ""
			}`,
		});

		// Save the updated caisse with transfer request
		await Caisse.findOneAndUpdate(
			{ "transferRequests.transferId": transferId },
			{ $set: { [`transferRequests.${transferIndex}`]: transferRequest } },
			{ new: true }
		);

		// Get updated balances for notifications
		const updatedFromCaisse = await Caisse.findOne({
			channelId: transferRequest.fromCaisse,
		});
		const updatedToCaisse = await Caisse.findOne({
			channelId: transferRequest.toCaisse,
		});

		// Sync to Excel
		try {
			await syncCaisseToExcel(updatedFromCaisse, transferId);
			await syncCaisseToExcel(updatedToCaisse, transferId);
		} catch (error) {
			console.error(`Excel sync failed: ${error.message}`);
		}

		// Update the original message
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: payload.channel.id,
				ts: payload.message.ts,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `✅ Transfert approuvé: ${transferRequest.transferId}`,
							emoji: true,
						},
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*ID:*\n${transferRequest.transferId}`,
							},
							{
								type: "mrkdwn",
								text: `*Montant:*\n${transferRequest.amount} ${transferRequest.currency}`,
							},
						],
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*De:*\n<#${transferRequest.fromCaisse}>`,
							},
							{
								type: "mrkdwn",
								text: `*Vers:*\n<#${transferRequest.toCaisse}>`,
							},
						],
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*Approuvé par:*\n<@${userName}>`,
							},
							{
								type: "mrkdwn",
								text: `*Date d'approbation:*\n${new Date().toLocaleString(
									"fr-FR"
								)}`,
							},
						],
					},
					...(approvalComment
						? [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `*Commentaire:*\n${approvalComment}`,
									},
								},
						  ]
						: []),
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `Nouveau solde source: ${
									updatedFromCaisse.balances[transferRequest.currency]
								} ${transferRequest.currency} | Nouveau solde destination: ${
									updatedToCaisse.balances[transferRequest.currency]
								} ${transferRequest.currency}`,
							},
						],
					},
				],
				text: `Transfert ${transferId} approuvé par ${userName}`,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		// Notify the requester
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: transferRequest.submittedByID,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: "✅ Demande de transfert approuvée",
							emoji: true,
						},
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*ID:*\n${transferRequest.transferId}`,
							},
							{
								type: "mrkdwn",
								text: `*Montant:*\n${transferRequest.amount} ${transferRequest.currency}`,
							},
						],
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*De:*\n<#${transferRequest.fromCaisse}>`,
							},
							{
								type: "mrkdwn",
								text: `*Vers:*\n<#${transferRequest.toCaisse}>`,
							},
						],
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*Approuvé par:*\n<@${userName}> le ${new Date().toLocaleString(
								"fr-FR"
							)}`,
						},
					},
					...(approvalComment
						? [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `*Commentaire:*\n${approvalComment}`,
									},
								},
						  ]
						: []),
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: "✅ Votre demande de transfert a été approuvée et exécutée avec succès.",
							},
						],
					},
				],
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		// Notify both caisse channels
		const notifications = [
			{
				channel: transferRequest.fromCaisse,
				text: `📤 Transfert sortant exécuté: ${transferRequest.amount} ${
					transferRequest.currency
				} vers <#${transferRequest.toCaisse}>. Nouveau solde: ${
					updatedFromCaisse.balances[transferRequest.currency]
				} ${transferRequest.currency}${
					approvalComment ? `\nCommentaire: ${approvalComment}` : ""
				}`,
			},
			{
				channel: transferRequest.toCaisse,
				text: `📥 Transfert entrant reçu: ${transferRequest.amount} ${
					transferRequest.currency
				} de <#${transferRequest.fromCaisse}>. Nouveau solde: ${
					updatedToCaisse.balances[transferRequest.currency]
				} ${transferRequest.currency}${
					approvalComment ? `\nCommentaire: ${approvalComment}` : ""
				}`,
			},
		];

		for (const notification of notifications) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: notification.channel,
					text: notification.text,
				},
				process.env.SLACK_BOT_TOKEN,
				context
			);
		}

		return createSlackResponse(200, {
			text: `✅ Transfert ${transferId} approuvé et exécuté avec succès`,
		});
	} catch (error) {
		console.error("Error approving transfer:", error.message);
		return createSlackResponse(200, {
			text: `❌ Erreur lors de l'approbation du transfert: ${error.message}`,
		});
	}
}

// Modified handleRejectTransfer to accept rejection reason
async function handleRejectTransfer(payload, context, rejectionReason = null) {
	console.log("** handleRejectTransfer");

	try {
		const transferId = payload.actions[0].value;
		const userId = payload.user.id;
		const userName = payload.user.username;

		// Find the caisse containing the transfer request
		const caisse = await Caisse.findOne({
			"transferRequests.transferId": transferId,
		});

		if (!caisse) {
			console.error(`Caisse not found for transfer ${transferId}`);
			return createSlackResponse(200, {
				text: "❌ Demande de transfert introuvable",
			});
		}

		// Find the specific transfer request
		const transferIndex = caisse.transferRequests.findIndex(
			(r) => r.transferId === transferId
		);

		if (transferIndex === -1) {
			console.error(`Transfer ${transferId} not found`);
			return createSlackResponse(200, {
				text: "❌ Demande de transfert introuvable",
			});
		}

		const transferRequest = caisse.transferRequests[transferIndex];

		// Check if already processed
		if (transferRequest.status !== "En attente") {
			return createSlackResponse(200, {
				text: `❌ Cette demande de transfert a déjà été ${transferRequest.status.toLowerCase()}`,
			});
		}

		// Update transfer request status
		transferRequest.status = "Rejeté";
		transferRequest.rejectedBy = userName;
		transferRequest.rejectedAt = new Date();
		if (rejectionReason) {
			transferRequest.rejectionReason = rejectionReason;
		}
		transferRequest.workflow.stage = "rejected";
		transferRequest.workflow.history.push({
			stage: "rejected",
			timestamp: new Date(),
			actor: userName,
			details: `Demande de transfert rejetée${
				rejectionReason ? ` - Motif: ${rejectionReason}` : ""
			}`,
		});

		// Save the updated caisse with transfer request
		await Caisse.findOneAndUpdate(
			{ "transferRequests.transferId": transferId },
			{ $set: { [`transferRequests.${transferIndex}`]: transferRequest } },
			{ new: true }
		);

		// Update the original message
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: payload.channel.id,
				ts: payload.message.ts,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: `❌ Transfert rejeté: ${transferRequest.transferId}`,
							emoji: true,
						},
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*ID:*\n${transferRequest.transferId}`,
							},
							{
								type: "mrkdwn",
								text: `*Montant:*\n${transferRequest.amount} ${transferRequest.currency}`,
							},
						],
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*De:*\n<#${transferRequest.fromCaisse}>`,
							},
							{
								type: "mrkdwn",
								text: `*Vers:*\n<#${transferRequest.toCaisse}>`,
							},
						],
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*Rejeté par:*\n<@${userName}>`,
							},
							{
								type: "mrkdwn",
								text: `*Date de rejet:*\n${new Date().toLocaleString("fr-FR")}`,
							},
						],
					},
					...(rejectionReason
						? [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `*Motif du rejet:*\n${rejectionReason}`,
									},
								},
						  ]
						: []),
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: "❌ Cette demande de transfert a été rejetée",
							},
						],
					},
				],
				text: `Transfert ${transferId} rejeté par ${userName}`,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		// Notify the requester
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: transferRequest.submittedByID,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: "❌ Demande de transfert rejetée",
							emoji: true,
						},
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*ID:*\n${transferRequest.transferId}`,
							},
							{
								type: "mrkdwn",
								text: `*Montant:*\n${transferRequest.amount} ${transferRequest.currency}`,
							},
						],
					},
					{
						type: "section",
						fields: [
							{
								type: "mrkdwn",
								text: `*De:*\n<#${transferRequest.fromCaisse}>`,
							},
							{
								type: "mrkdwn",
								text: `*Vers:*\n<#${transferRequest.toCaisse}>`,
							},
						],
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*Rejeté par:*\n<@${userName}> le ${new Date().toLocaleString(
								"fr-FR"
							)}`,
						},
					},
					...(rejectionReason
						? [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `*Motif du rejet:*\n${rejectionReason}`,
									},
								},
						  ]
						: []),
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: "❌ Votre demande de transfert a été rejetée.",
							},
						],
					},
				],
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);

		return createSlackResponse(200, {
			text: `❌ Transfert ${transferId} rejeté`,
		});
	} catch (error) {
		console.error("Error rejecting transfer:", error.message);
		return createSlackResponse(200, {
			text: `❌ Erreur lors du rejet du transfert: ${error.message}`,
		});
	}
}

// ...existing code...
async function handleViewSubmission(payload, context) {
	console.log("*------------------------------ handleViewSubmission");
	const formData = payload.view.state.values;
	const userId = payload.user.id;
	const userName = payload.user.username;
	let actionId;
	console.log("payload2", payload);
	const slackToken = process.env.SLACK_BOT_TOKEN;
	const existingMetadata = payload.view.private_metadata
		? JSON.parse(payload.view.private_metadata)
		: {};
	const newPrivateMetadata = JSON.stringify({
		channelId: existingMetadata.channelId || payload.channel?.id || "unknown",
		formData: {
			...(existingMetadata.formData || {}),
			...payload.view.state.values,
		},
		originalViewId: existingMetadata.originalViewId || payload.view.id,
	});
	context.log(`New private metadata: ${newPrivateMetadata}`);
	const channelId = existingMetadata.channelId;
	const orderId = existingMetadata.orderId;
	// Determine if this is from an edit operation
	const isFromEdit =
		existingMetadata.isEdit === true && existingMetadata.orderId;
	context.log(`Is this submission from edit_order? ${isFromEdit}`);

	// Optionally set a source variable for clarity
	const submissionSource = isFromEdit ? "edit_order" : "new_submission";
	context.log(`Submission source: ${submissionSource}`);
	let channelName = "unknown";
	console.log("channelId3", channelId);
	if (channelId) {
		try {
			const result = await axios.post(
				"https://slack.com/api/conversations.info",
				querystring.stringify({ channel: channelId }),
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
						"Content-Type": "application/x-www-form-urlencoded",
					},
				}
			);
			if (result.data.ok) channelName = result.data.channel.name;
		} catch (error) {
			context.log(`Failed to get channel name: ${error.message}`);
		}
	}
	if (payload.view.callback_id === "confirm_transfer_modal") {
		console.log("** confirm_transfer_modal submission");
		const client = new WebClient(process.env.SLACK_BOT_TOKEN);

		// Create view object with user information
		const viewForTransfer = {
			...payload.view,
			user: payload.user,
		};

		return await handleTransferConfirmation(viewForTransfer, client);
	}
	context.log(
		"*------------------------------ payload.view.callback_id",
		payload.view.callback_id
	);
	if (payload.view.callback_id === "transfer_approval_confirmation") {
		console.log("** transfer_approval_confirmation");
		return await handleTransferApprovalConfirmation(payload, context);
	}

	if (payload.view.callback_id === "transfer_rejection_reason") {
		console.log("** transfer_rejection_reason");
		return await handleTransferRejectionReason(payload, context);
	}
	// ...existing code...
	if (payload.view.callback_id === "transfer_form") {
		console.log("** transfer_form submission");

		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};

		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id,
				text: "⌛ Demande de transfert en cours de traitement... Vous serez notifié(e) bientôt !",
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Process in background
		setImmediate(async () => {
			try {
				const formData = payload.view.state.values;
				const userId = payload.user.id;
				const userName = payload.user.username;

				// Validate form data
				const errors = {};

				// Check required fields
				if (!formData.from_caisse_block?.from_caisse_select?.selected_option) {
					errors.from_caisse_block = "Caisse source requise";
				}

				if (!formData.to_caisse_block?.to_caisse_select?.selected_option) {
					errors.to_caisse_block = "Caisse destination requise";
				}

				if (!formData.currency_block?.currency_select?.selected_option) {
					errors.currency_block = "Devise requise";
				}

				if (!formData.amount_block?.amount_input?.value) {
					errors.amount_block = "Montant requis";
				}

				if (!formData.motif_block?.motif_input?.value) {
					errors.motif_block = "Motif requis";
				}

				if (
					!formData.payment_mode_block?.payment_mode_select?.selected_option
				) {
					errors.payment_mode_block = "Mode de paiement requis";
				}

				// Validate amount
				const amount = parseFloat(formData.amount_block.amount_input.value);
				if (isNaN(amount) || amount <= 0) {
					errors.amount_block = "Montant invalide";
				}

				// Check if source and destination are different
				const fromCaisse =
					formData.from_caisse_block.from_caisse_select.selected_option.value;
				const toCaisse =
					formData.to_caisse_block.to_caisse_select.selected_option.value;

				if (fromCaisse === toCaisse) {
					errors.to_caisse_block =
						"La caisse source et destination doivent être différentes";
				}

				// If there are validation errors, notify user
				if (Object.keys(errors).length > 0) {
					const errorMessages = Object.values(errors).join(", ");
					await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: userId,
							text: `❌ Erreurs dans le formulaire de transfert: ${errorMessages}`,
						},
						process.env.SLACK_BOT_TOKEN
					);
					return;
				}

				// Create and save transfer request
				const transferRequest = await createAndSaveTransferRequest(
					userId,
					userName,
					formData,
					context
				);

				// Send notifications
				await Promise.all([
					notifyAdminTransfer(transferRequest, context),
					notifyUserTransfer(transferRequest, userId, context),
				]);

				context.log(
					`Transfer request ${transferRequest.transferId} created successfully`
				);
			} catch (error) {
				context.log(`Error processing transfer form: ${error.message}`);

				// Notify user of error
				await postSlackMessage(
					"https://slack.com/api/chat.postMessage",
					{
						channel: payload.user.id,
						text: `❌ Erreur lors du traitement de la demande de transfert: ${error.message}`,
					},
					process.env.SLACK_BOT_TOKEN
				);
			}
		});

		return context.res;
	}
	// ...existing code...
	if (payload.view.callback_id === "payment_modif_submission") {
		console.log("** payment_modif_submission");

		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};

		// Process in background
		setImmediate(async () => {
			await handlePaymentModifSubmission(payload, context);
		});
	}
	if (payload.view.callback_id === "correct_fund") {
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id, // Specify the user ID to make the message ephemeral
				text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
			},
			process.env.SLACK_BOT_TOKEN
		);
		// Process in background
		setImmediate(async () => {
			console.log("** correct_fund");
			return await handleCorrectionSubmission(payload, context);
		});
	}
	// Handle cheque details submission
	if (payload.view.callback_id === "submit_cheque_details") {
		const requestId = payload.view.private_metadata;
		const chequeNumber =
			payload.view.state.values.cheque_number.input_cheque_number.value;
		const bankName =
			payload.view.state.values.bank_name?.input_bank_name?.value || "";

		const chequeDetails = {
			number: chequeNumber,
			bank: bankName,
			date: new Date().toISOString(),
		};
		console.log("userName9", userName);
		await processFundingApproval(
			requestId,
			"approve_cheque",
			userName,
			chequeDetails
		);

		return createSlackResponse(200, "");
	}
	// Handle cheque details submission
	if (payload.view.callback_id === "submit_cheque_details") {
		const requestId = payload.view.private_metadata;
		const chequeNumber =
			payload.view.state.values.cheque_number.input_cheque_number.value;
		const bankName =
			payload.view.state.values.bank_name?.input_bank_name?.value || "";

		const chequeDetails = {
			number: chequeNumber,
			bank: bankName,
			date: new Date().toISOString(),
		};
		console.log("userName9", userName);

		await processFundingApproval(
			requestId,
			"approve_cheque",
			userName,
			chequeDetails
		);

		return createSlackResponse(200, "");
	}
	if (payload.view.callback_id === "reject_funding") {
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};

		// Process in background
		setImmediate(async () => {
			console.log("reject_funding");
			console.log("payload.view", payload.view);

			const privateMetadata = JSON.parse(payload.view.private_metadata);
			const requestId = privateMetadata.requestId;
			const caisseType = privateMetadata.caisseType;
			console.log("caisseType", caisseType);
			console.log("parsed requestId", requestId); // entityId: requestId
			const metadata = JSON.parse(newPrivateMetadata);

			const rejectionReason =
				metadata.formData.rejection_reason_block.rejection_reason_input.value;

			console.log(rejectionReason);

			await processFundingApproval(
				requestId,
				caisseType,
				"reject",
				rejectionReason,
				privateMetadata.message_ts,
				privateMetadata.channel_id,
				userName
			);
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: payload.user.id,
					blocks: [
						{
							type: "header",
							text: {
								type: "plain_text",
								text:
									":heavy_dollar_sign: ❌ Demande de fonds ID: " +
									requestId +
									" - Rejetée" +
									` par <@${userName}> le ${new Date().toLocaleDateString()}, Raison: ${rejectionReason}`,
								emoji: true,
							},
						},
					],
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		});

		return context.res;
	}

	if (payload.view.callback_id === "delete_order_confirmation") {
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id, // Specify the user ID to make the message ephemeral
				text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
			},
			process.env.SLACK_BOT_TOKEN
		);
		// Process in background
		setImmediate(async () => {
			const metadata = JSON.parse(payload.view.private_metadata);
			const values = payload.view.state.values;
			console.log("metadata&", metadata);
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

			console.log("$$ values", values);
			const result = await executeOrderDeletion(
				payload,
				metadata,
				reason,
				context
			);

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
		});
	}
	if (payload.view.callback_id === "order_form_submission") {
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id, // Specify the user ID to make the message ephemeral
				text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
			},
			process.env.SLACK_BOT_TOKEN
		);
		// Process in background
		setImmediate(async () => {
			try {
				// Validate date
				const selectedDate =
					formData.request_date?.input_request_date?.selected_date;
				const selectedDateObj = new Date(selectedDate);
				const todayObj = new Date();
				selectedDateObj.setHours(0, 0, 0, 0);
				todayObj.setHours(0, 0, 0, 0);
				console.log("formData", formData);
				if (!selectedDate || selectedDateObj < todayObj) {
					// Send a direct message to the user explaining the error
					try {
						await postSlackMessage(
							"https://slack.com/api/chat.postMessage",
							{
								channel: channelId, // This sends a DM to the user
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

						context.log("Error notification sent to user");
					} catch (error) {
						context.log(`Failed to send error notification: ${error}`);
					}
					return {
						response_action: "errors",
						errors: {
							request_date: "La date ne peut pas être dans le passé",
						},
					};
				}

				// Extract articles and check quantities
				const { articles, quantityErrors } = await extractArticles(formData);
				if (Object.keys(quantityErrors).length > 0) {
					return { response_action: "errors", errors: quantityErrors };
				}

				// AI-based error checking
				const pastOrders = await Order.find({ demandeur: userId }).limit(5);
				const { errors, suggestions, hasProforma } = await checkFormErrors(
					formData,
					pastOrders,
					context
				);

				const totalQuantity = articles.reduce(
					(sum, a) => sum + parseInt(a.quantity),
					0
				);
				// const needsProforma = totalQuantity > 500; // Example threshold
				const formDataKey = `form_${payload.view.id}_${Date.now()}`;

				// if (errors.length > 0 || (needsProforma && !hasProforma)) {
				if (errors.length > 0) {
					const simpleErrorBlocks = [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "⚠️ *Erreurs détectées dans votre commande*",
							},
						},
						...Object.entries(errors).map(([field, message]) => ({
							type: "section",
							text: {
								type: "mrkdwn",
								text: `*-* ${message}`,
							},
						})),
						{
							type: "actions",
							block_id: "error_actions",

							elements: [
								{
									type: "button",
									text: { type: "plain_text", text: "Corriger" },
									action_id: "return_to_form",
									value: JSON.stringify({
										viewId: payload.view.id,
										formDataKey: formDataKey,
									}),
								},
							],
						},
					];

					context.log(
						`Error blocks being sent: ${JSON.stringify(simpleErrorBlocks)}`
					);

					await new Promise((resolve) => setTimeout(resolve, 500)); // 500ms delay
					context.log(
						"Attempting views.update with:",
						JSON.stringify({
							view_id: payload.view.id,
							view: {
								type: "modal",
								callback_id: "error_modal",
								title: { type: "plain_text", text: "Erreur de soumission" },
								blocks: simpleErrorBlocks,
								close: { type: "plain_text", text: "Fermer" },
							},
						})
					);

					// Log the button value length to verify
					const buttonValue = JSON.stringify({
						viewId: payload.view.id,
						formDataKey: formDataKey,
					});
					context.log(`Button value length: ${buttonValue.length}`);
					await saveToStorage(formDataKey, payload.view.state.values); // Implement this
					const newPrivateMetadata = JSON.stringify({
						channelId: existingMetadata.channelId,
						viewId: payload.view.id,
						orderId: existingMetadata.orderId || null,
						formDataKey: formDataKey,
					});
					context.log(
						`Trimmed private_metadata length: ${newPrivateMetadata.length}`
					);

					if (newPrivateMetadata.length > 3000) {
						throw new Error("private_metadata still exceeds 3000 characters");
					}
					// Fallback to chat.postMessage if retry fails
					const errorsText = errors.length
						? `\n❌ Erreurs:\n- ${errors.join("\n- ")}`
						: "";
					return await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: userId,
							text: `⚠️ Une erreur est survenue. Veuillez réessayer.${errorsText}`,
						},
						process.env.SLACK_BOT_TOKEN
					);
				}
				let proformas = existingMetadata.proformas || [];
				let i = 1;

				const newProformas = await extractProformas(
					formData,
					context,
					i,
					userId
				);
				console.log("newProformas", newProformas);

				if (newProformas.valid == false) {
					console.log("newProformas", newProformas);
					return { response_action: "clear" };
				} else {
					// Add createdAt timestamp to each proforma
					timestampedProformas = newProformas.map((proforma) => ({
						...proforma,
						createdAt: new Date(),
					}));
				}
				// Process new proformas if they exist
				let processedProformas = [];
				if (
					newProformas &&
					Array.isArray(newProformas) &&
					newProformas.length > 0
				) {
					// Convert to proper schema format
					processedProformas = newProformas.map((proforma) => {
						// Handle file data properly
						const proformaData = {
							file_id: proforma.file_id || proforma.fileData?.file_id,
							filename: proforma.filename || proforma.fileData?.filename,
							permalink: proforma.permalink || proforma.fileData?.permalink,
							url_private:
								proforma.url_private || proforma.fileData?.url_private,
							url_private_download:
								proforma.url_private_download ||
								proforma.fileData?.url_private_download,
							size: proforma.size || proforma.fileData?.size,
							mimetype: proforma.mimetype || proforma.fileData?.mimetype,
							uploaded_by:
								proforma.uploaded_by ||
								proforma.fileData?.uploaded_by ||
								userId,
							uploaded_at: new Date(),
							channel_id:
								proforma.channel_id ||
								proforma.fileData?.channel_id ||
								channelId,
						};

						// Remove any undefined fields
						Object.keys(proformaData).forEach((key) => {
							if (proformaData[key] === undefined) {
								delete proformaData[key];
							}
						});

						return proformaData;
					});

					console.log("Processed proformas:", processedProformas);
				}
				console.log("proformas", proformas);
				console.log("newProformas", newProformas);

				// If new proformas are added, use them; otherwise, keep the existing ones
				if (newProformas.length > 0) {
					proformas = newProformas; // Always replace proformas if new ones are provided
					console.log("newProformas", newProformas);

					if (submissionSource === "edit_order") {
						// Only send notification when editing an existing order
						console.log("Sending message to userId:", userId);
						await postSlackMessage(
							"https://slack.com/api/chat.postMessage",
							{
								channel: userId,
								text: `⚠️ La proforma initiale a été remplacée par la nouvelle proforma. Une seule proforma est autorisée par commande.\n `,
							},
							process.env.SLACK_BOT_TOKEN
						);
					} else {
						console.log("New proforma added silently (new submission)");
					}
				}
				let order;
				if (existingMetadata.orderId) {
					// Editing an existing order
					order = await Order.findOneAndUpdate(
						{ id_commande: existingMetadata.orderId },
						{
							titre: formData.request_title.input_request_title.value,
							equipe:
								formData.equipe_selection.select_equipe.selected_option.text
									.text,
							date_requete:
								formData.request_date.input_request_date.selected_date,
							articles,
							proformas,
							date: new Date(), // Update modification date
						},
						{ new: true }
					);
					console.log("actionId1", actionId);

					// Update the original Slack message
					await postSlackMessage(
						"https://slack.com/api/chat.update",
						{
							channel: channelId,
							ts: existingMetadata.messageTs,
							text: `Commande *${order.id_commande}* - Modifiée`,
							blocks: [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `*Commande ID:* ${order.id_commande}\n*Statut:* ${order.statut}`,
									},
								},
								{
									type: "actions",
									elements: [
										{
											type: "button",
											text: { type: "plain_text", text: "Modifier" },
											action_id: "edit_order",
											value: order.id_commande,
										},
									],
								},
							],
						},
						process.env.SLACK_BOT_TOKEN
					);

					await notifyUser(
						order,
						userId,
						context,
						"✅ Votre commande a été modifiée avec succès."
					);
					console.log(`Edited order: ${JSON.stringify(order)}`);

					// Update the original user-facing Slack message
					await postSlackMessage(
						"https://slack.com/api/chat.update",
						{
							channel: channelId,
							ts: existingMetadata.messageTs,
							text: `Commande *${order.id_commande}* - Modifiée`,
							blocks: [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `*Commande ID:* ${order.id_commande}\n*Statut:* ${order.statut}`,
									},
								},
								{
									type: "actions",
									elements: [
										{
											type: "button",
											text: { type: "plain_text", text: "Modifier" },
											action_id: "edit_order",
											value: order.id_commande,
										},
									],
								},
							],
						},
						process.env.SLACK_BOT_TOKEN
					);

					try {
						context.log(
							`Calling notifyAdmin for edited order ${order.id_commande}`
						);
						await notifyAdmin(order, context, true);
						context.log(
							`Successfully notified admin about edit for order ${order.id_commande}`
						);
					} catch (error) {
						context.log.error(
							`Error notifying admin about edit: ${error.message}`
						);
					}
				} else {
					let channelName;
					if (channelId) {
						try {
							const result = await axios.post(
								"https://slack.com/api/conversations.info",
								querystring.stringify({ channel: channelId }),
								{
									headers: {
										Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
										"Content-Type": "application/x-www-form-urlencoded",
									},
								}
							);
							if (result.data.ok) channelName = result.data.channel.name;
						} catch (error) {
							context.log(`Failed to get channel name: ${error.message}`);
						}
					}
					const newOrder = await createAndSaveOrder(
						payload.user.id,
						userName,
						channelName,
						channelId,
						formData,
						articles,
						existingMetadata.date_requete,
						proformas,
						context
					);

					await Promise.all([
						notifyAdmin(newOrder, context),
						notifyUser(newOrder, userId, context),
						// updateView(payload.view.id),
					]);
				}
				return { response_action: "clear" };
			} catch (error) {
				context.log(
					`Background processing error for proforma submission (order: ${orderId}): ${error.message}\nStack: ${error.stack}`
				);
				await postSlackMessage2(
					"https://slack.com/api/chat.postMessage",
					{
						channel: payload.user.id,
						text: `Background processing error for proforma submission (order: ${orderId}): ${error.message}\nStack: ${error.stack}`,
					},
					process.env.SLACK_BOT_TOKEN
				);
			}
		});

		return context.res;
	}
	if (payload.view.callback_id === "submit_funding_request") {
		console.log("**1 submit_funding_request");
		console.log("payload.user.id", payload.user.id);
		const formData = payload.view.state.values;
		// Validate date
		const requestedDate =
			formData.funding_date.input_funding_date.selected_date;

		console.log("requestedDate", requestedDate);
		const selectedDateObj = new Date(requestedDate);
		console.log("selectedDateObj", selectedDateObj);
		const todayObj = new Date();
		selectedDateObj.setHours(0, 0, 0, 0);
		todayObj.setHours(0, 0, 0, 0);
		const Metadata = JSON.parse(payload.view.private_metadata);
		console.log("Metadata", Metadata);

		console.log("Metadata.channelId", Metadata.channelId);
		if (!requestedDate || selectedDateObj < todayObj) {
			// Send a direct message to the user explaining the error
			try {
				await postSlackMessage(
					"https://slack.com/api/chat.postMessage",
					{
						channel: Metadata.channelId, // This sends a DM to the user
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
									text: "Veuillez créer une nouvelle demande et sélectionner une date d'aujourd'hui ou future.",
								},
							},
						],
					},
					process.env.SLACK_BOT_TOKEN
				);

				context.log("Error notification sent to user");
			} catch (error) {
				context.log(`Failed to send error notification: ${error}`);
			}
			return {
				response_action: "errors",
				errors: {
					request_date: "La date ne peut pas être dans le passé",
				},
			};
		}

		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id, // Specify the user ID to make the message ephemeral
				text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
			},
			process.env.SLACK_BOT_TOKEN
		);
		// Process in background
		setImmediate(async () => {
			console.log("userName1", userName);
			return await handleFundingRequestSubmission(payload, context, userName);
		});

		return context.res;
	}
	// if (payload.view.callback_id === "submit_funding_request") {
	//   console.log("userName1",userName);
	//   return await handleFundingRequestSubmission(payload, context, userName);
	// }
	else if (payload.view.callback_id === "approve_funding_request") {
		console.log("userName2", userName);
		return await handleFundingApprovalSubmission(payload, context, userName);
	}
	// Handle payment and proforma submissions as before
	// ... (existing payment_form_submission and proforma_submission logic) ...

	if (payload.view.callback_id === "payment_form_submission") {
		console.log("** payment_form_submission");
		await processPaymentSubmission(payload, context);
	}
	if (payload.view.callback_id === "payment_problem_submission") {
		console.log("===+ 3 payment_modification_submission");
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};

		// Process in background
		setImmediate(async () => {
			return await handlePaymentProblemSubmission(payload, context);
		});
	}
	if (payload.view.callback_id === "fund_problem_submission") {
		console.log("$$ payment_modification_submission");
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id, // Specify the user ID to make the message ephemeral
				text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
			},
			process.env.SLACK_BOT_TOKEN
		);
		// Process in background
		setImmediate(async () => {
			console.log("** fund_problem_submission");
			return await handleProblemSubmission(payload, context);
		});
	}
	if (payload.view.callback_id === "payment_modification_submission") {
		console.log("$$ payment_modification_submission");
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id, // Specify the user ID to make the message ephemeral
				text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
			},
			process.env.SLACK_BOT_TOKEN
		);
		// Process in background
		setImmediate(async () => {
			return await handlePaymentModificationSubmission(
				payload,
				context,
				userId,
				slackToken
			);
		});

		return context.res;
	}
	if (payload.view.callback_id === "proforma_submission") {
		{
			// Immediate response to close modal
			context.res = {
				status: 200,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ response_action: "clear" }),
			};

			// Process in background
			setImmediate(async () => {
				try {
					await handleProformaSubmission(payload, context);
				} catch (error) {
					context.log(
						`Background processing error for proforma submission (order: ${orderId}): ${error.message}\nStack: ${error.stack}`
					);
					await postSlackMessage2(
						"https://slack.com/api/chat.postMessage",
						{
							channel: payload.user.id,
							text: `❌ Erreur lors du traitement de la proforma pour la commande ${orderId}. Veuillez contacter le support.`,
						},
						process.env.SLACK_BOT_TOKEN
					);
				}
			});

			return context.res;
		}
	} else if (payload.view.callback_id === "edit_proforma_submission") {
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		console.log("))))) chanelid", channelId);

		// Process in background
		setImmediate(async () => {
			return await handleEditProformaSubmission(payload, context, userId);
		});

		return context.res;
	} else if (payload.view.callback_id === "delete_proforma_confirmation") {
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id, // Specify the user ID to make the message ephemeral
				text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
			},
			process.env.SLACK_BOT_TOKEN
		);
		// Process in background
		setImmediate(async () => {
			return await handleDeleteProforma(payload, context);
		});
	}
	// 3. Modify your payment request submission handler to use multiple justificatifs
	if (payload.view.callback_id === "payment_request_submission") {
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		await postSlackMessage(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: process.env.SLACK_ADMIN_ID,
				user: payload.user.id, // Specify the user ID to make the message ephemeral
				text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
			},
			process.env.SLACK_BOT_TOKEN
		);
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

	return createSlackResponse(200, { text: "Submission non reconnue" });
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

// Add this helper function to convert private URLs to public permalinks
async function getPublicFileUrl(fileId, slackToken) {
	try {
		const response = await axios.get(
			`https://slack.com/api/files.info?file=${fileId}`,
			{
				headers: {
					Authorization: `Bearer ${slackToken}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
			}
		);

		if (response.data.ok && response.data.file) {
			// Return permalink if available, otherwise fall back to url_private
			return (
				response.data.file.permalink ||
				response.data.file.url_private_download ||
				response.data.file.url_private
			);
		}
		return null;
	} catch (error) {
		console.error(`Error getting file info for ${fileId}:`, error);
		return null;
	}
}

// Update the extractProformas function (this should be in form.js)
// You'll need to modify where proforma files are processed to use permalinks
// 2. Create a function to extract justificatifs from form data
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
		context.log(`Error extracting justificatifs: ${error}`);
		return [];
	}
}

// Helper function to validate URL format
function isValidUrl(string) {
	console.log("** isValidUrl");
	try {
		new URL(string);
		return true;
	} catch (_) {
		return false;
	}
}

module.exports = {
	generateCommandId,
	handleOrderList,
	extractArticles,
	createAndSaveOrder,
	FormData1,
	handleViewSubmission,
	saveToStorage,
	generatePaymentRequestId,
	extractAndValidateUrl,
	fetchEntity,
};
