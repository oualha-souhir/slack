const { Order } = require("../../Database/dbModels/Order");
const { postSlackMessage } = require("../../Common/slackUtils");
const { notifyAdminProforma } = require("./proformaNotificationService");
const { getCurrencies } = require("../../Configurations/config");
const { isValidUrl, getFileInfo } = require("../../Common/utils");
const { WebClient } = require("@slack/web-api");
const { notifyTechSlack } = require("../../Common/notifyProblem");

const client = new WebClient(process.env.SLACK_BOT_TOKEN);
let fetch;
(async () => {
	fetch = (await import("node-fetch")).default;
})();

async function validateProformaAmount(value) {
	console.log("** validateProformaAmount");
	// If value is undefined, null, or an empty string, treat it as valid with no amount
	if (!value || typeof value !== "string" || value.trim() === "") {
		return { valid: true, normalizedValue: null }; // No amount provided, still valid
	}

	// Extract the amount and currency
	const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/);

	if (!match) {
		return {
			valid: false,
			error:
				"⚠️ Format invalide. Veuillez entrer un montant suivi d'une devise (ex: 1000 XOF).",
		};
	}

	const [, amount, currency] = match;
	// Fetch valid currencies from DB
	const currencyOptions = await getCurrencies();
	if (!currencyOptions || currencyOptions.length === 0) {
		return {
			valid: false,
			error: "⚠️ Aucune devise valide trouvée dans la base de données.",
		};
	}

	const validCurrencies = currencyOptions.map((opt) => opt.value.toUpperCase());

	if (!validCurrencies.includes(currency.toUpperCase())) {
		return {
			valid: false,
			error: `⚠️ Devise non reconnue. Les devises acceptées sont: ${validCurrencies.join(
				", "
			)}.`,
		};
	}

	// Check if the amount is a valid number
	const numericAmount = parseFloat(amount);
	if (isNaN(numericAmount) || numericAmount <= 0) {
		return {
			valid: false,
			error: "⚠️ Le montant doit être un nombre positif.",
		};
	}

	return {
		valid: true,
		normalizedValue: `${numericAmount} ${currency.toUpperCase()}`,
	};
}

async function extractProformas(formData, context, i, userId) {
	console.log("** extractProformas");
	// Initialize collections
	const urls = [];
	const file_ids = [];
	let totalPages = 0;

	// Get common fields
	const designation = formData.proforma_designation?.designation_input?.value;
	const amountString = formData.proforma_amount?.input_proforma_amount?.value;
	// Validate the amount and currency
	const validationResult = await validateProformaAmount(amountString);
	console.log("!validationResult.valid", !validationResult.valid);
	let fournisseur = "";
	if (
		formData.proforma_fournisseur?.fournisseur_input?.selected_option?.text
			?.text
	) {
		fournisseur =
			formData.proforma_fournisseur.fournisseur_input.selected_option.text.text;
		console.log("proforma_fournisseur (dropdown):", fournisseur);
	}
	if (!validationResult.valid) {
		let messageText = `${validationResult.error} `;
		let slackResponse = await postSlackMessage(
			"https://slack.com/api/chat.postMessage",
			{ channel: userId, text: messageText },
			process.env.SLACK_BOT_TOKEN
		);

		if (!slackResponse.ok) {
			context.log(`${slackResponse.error}`);
		}

		return validationResult;
	}

	// Process file uploads
	const proformaFiles = formData.proforma_file?.file_upload?.files || [];
	console.log(
		"proformaFiles.length",
		proformaFiles.length,
		"proformaFiles",
		proformaFiles
	);

	// Array to store processed file data for database
	const processedFiles = [];

	if (proformaFiles.length > 0) {
		console.log(`Processing ${proformaFiles.length} proforma files...`);

		for (const file of proformaFiles) {
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
						await notifyTechSlack(dmError);

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
				file_ids.push(uploadedFileId);
				urls.push(filePermalink);
				totalPages += 1;
			} catch (error) {
				await notifyTechSlack(error);

				console.error("Error processing file:", error.message);
				console.error("Full error:", error);

				// Send error notification to user
				await postSlackMessage(
					"https://slack.com/api/chat.postMessage",
					{
						channel: userId,
						text: `⚠️ Erreur lors du traitement du fichier: ${error.message}`,
					},
					process.env.SLACK_BOT_TOKEN
				);
			}
		}
	}

	// Process manual URL
	if (formData.proforma_url?.input_proforma_url?.value) {
		const proformaUrl = formData.proforma_url?.input_proforma_url?.value.trim();
		if (proformaUrl) {
			// Validate URL format
			if (isValidUrl(proformaUrl)) {
				urls.push(proformaUrl);
				totalPages += 1; // Count URL as 1 page
			} else if (!isValidUrl(proformaUrl)) {
				// Send error message to user
				await postSlackMessage(
					"https://slack.com/api/chat.postMessage",
					{
						channel: userId,
						text: "⚠️ L'URL du justificatif n'est pas valide. Votre demande a été enregistrée sans l'URL.",
					},
					process.env.SLACK_BOT_TOKEN
				);
			}
		}
	}

	// If no proforma files or URL were provided, return an empty array
	if (urls.length === 0 && processedFiles.length === 0) {
		return [];
	}

	// Validation
	if (!amountString) {
		context.log("Proforma provided but no amount");
		throw new Error("Veuillez fournir un montant pour la proforma.");
	}

	// Parse amount
	let amount = null;
	let validCurrency = "";
	if (amountString) {
		const match = amountString.match(/(\d+(?:\.\d+)?)\s*([A-Za-z]+)/);
		if (!match) {
			throw new Error(
				`Format de montant invalide: ${amountString}. Utilisez '1000 XOF'.`
			);
		}

		amount = parseFloat(match[1]);
		const currency = match[2].toUpperCase();
		console.log("currency2", currency);
		// Fetch valid currencies from DB
		const currencyOptions = await getCurrencies();
		if (!currencyOptions || currencyOptions.length === 0) {
			return {
				valid: false,
				error: "⚠️ Aucune devise valide trouvée dans la base de données.",
			};
		}

		const validCurrencies = currencyOptions.map((opt) =>
			opt.value.toUpperCase()
		);

		if (!validCurrencies.includes(currency.toUpperCase())) {
			return {
				valid: false,
				error: `⚠️ Devise non reconnue. Les devises acceptées sont: ${validCurrencies.join(
					", "
				)}.`,
			};
		} else {
			validCurrency = currency;
		}
	}

	let validated;
	if (i == 1) {
		validated = true;
	} else if (i == 0) {
		validated = false;
	}

	// Return the processed file data directly for database saving
	// If we have processed files, return them; otherwise return legacy format
	if (processedFiles.length > 0) {
		return processedFiles; // Return array of file objects matching schema
	}

	// Legacy return format for URL-only proformas
	return [
		{
			file_ids,
			urls,
			nom: designation || `Proforma (${urls.length} pages)`,
			montant: amount,
			devise: validCurrency,
			pages: totalPages,
			validated: validated,
			fournisseur: fournisseur,
		},
	];
}
async function handleProformaSubmission(payload, context) {
	console.log("** handleProformaSubmission");
	const { orderId, msgts } = JSON.parse(payload.view.private_metadata);
	console.log("msgts&", msgts);
	const values = payload.view.state.values;
	context.log("payload11112", payload);

	context.log("orderId", orderId);
	context.log("values", JSON.stringify(values));
	let userId = payload.user.id;

	try {
		let timestampedProformas;
		let i = 0;
		// Use the extractProformas function to process all proforma data
		const proformaDataArray = await extractProformas(
			values,
			context,
			0,
			userId
		);
		console.log("proformaDataArray2", proformaDataArray);

		if (proformaDataArray.valid == false) {
			console.log("proformaDataArray1", proformaDataArray);
			return { response_action: "clear" };
		} else {
			// Add createdAt timestamp to each proforma
			timestampedProformas = proformaDataArray.map((proforma) => ({
				...proforma,
				createdAt: new Date(),
			}));
		}

		// Update the order in MongoDB with all proforma entries
		const updatedOrder = await Order.findOneAndUpdate(
			{ id_commande: orderId },
			{ $push: { proformas: { $each: timestampedProformas } } },
			{ new: true }
		);

		if (!updatedOrder) {
			throw new Error(`Order ${orderId} not found`);
		}

		context.log("Updated order with proformas:", JSON.stringify(updatedOrder));

		// Prepare notification message
		let messageText;
		if (proformaDataArray.length === 1) {
			const proforma = proformaDataArray[0];
			const hasFile = !!proforma.file_id;
			messageText = `✅ Proforma ajoutée pour *${orderId}*: ${proforma.nom} - ${
				proforma.montant
			} ${proforma.devise}${
				hasFile ? ` avec fichier <${proforma.url}|voir>` : ` (URL)`
			}`;
		} else {
			messageText = `✅ ${
				proformaDataArray.length
			} proformas ajoutées pour *${orderId}* (Total: ${proformaDataArray.reduce(
				(sum, p) => sum + p.montant,
				0
			)} ${proformaDataArray[0].devise})`;
		}

		// IMPORTANT: Await the notification to complete before returning
		try {
			context.log("Notifying admin about proforma submission...");
			await notifyAdminProforma(context, updatedOrder, msgts);
			context.log("Admin notification completed successfully");
		} catch (notifyError) {
			await notifyTechSlack(notifyError);

			context.log(`WARNING: Admin notification failed: ${notifyError.message}`);
			context.log(`Stack trace: ${notifyError.stack}`);
			// Don't throw here - we want to continue and return success to user
		}

		return { response_action: "clear" };
	} catch (error) {
		await notifyTechSlack(error);

		// Ensure this also waits for any async operations
		try {
			const slackResponse = await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ACHAT_CHANNEL_ID,
					text: `Error in proforma submission: ${error.message}`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		} catch (slackError) {
			await notifyTechSlack(slackError);

			context.log(`Failed to send error notification: ${slackError.message}`);
		}

		context.log(
			`❌ Error in proforma submission: ${error.message}`,
			error.stack
		);

		return {
			response_action: "errors",
			errors: {
				proforma_submission: `❌ Erreur lors de l'enregistrement des proformas: ${error.message}`,
			},
		};
	}
}
module.exports = {
	handleProformaSubmission,
	extractProformas,
};
