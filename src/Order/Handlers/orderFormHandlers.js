const {
	postSlackMessage,
	createSlackResponse,
	postSlackMessage2,
} = require("../../Common/slackUtils");
const { checkFormErrors } = require("../../Common/aiService");
const axios = require("axios");
const querystring = require("querystring");

const {
	generateOrderForm,
	handleAddProforma,
	handleAddArticle,
	handleCancelProforma,
	handleRemoveArticle,
} = require("./orderFormBlockHandlers");
const { notifyUser, notifyAdmin } = require("./orderNotificationService");
const { extractProformas } = require("../Proforma/proformaSubmission");
const { getFileInfo } = require("../../Common/utils");
const CommandSequence = require("../../Database/dbModels/CommandSequence");
const { getFromStorage } = require("../../Database/databaseUtils");
const { WebClient } = require("@slack/web-api");
const { notifyTechSlack } = require("../../Common/notifyProblem");
const client = new WebClient(process.env.SLACK_BOT_TOKEN);

//*
async function handleOpenOrderForm(payload, context) {
	try {
		const autoSuggestions = [];
		// await require("./aiService").suggestAutoCompletions(
		//   payload.user.id,
		//   context
		// );

		const view = await generateOrderForm([], {
			titre: autoSuggestions.titre,
			equipe: autoSuggestions.equipe,
			quantity: autoSuggestions.quantity,
			unit: autoSuggestions.unit,
			designations: autoSuggestions.designations,
		});

		if (payload.channel && payload.channel.id) {
			view.private_metadata = JSON.stringify({
				channelId: payload.channel.id,
			});
		}

		const response = await postSlackMessage2(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);

		context.log(`views.open response: ${JSON.stringify(response.data)}`);
		if (!response.data.ok) {
			context.log(`views.open error: ${response.data.error}`);
			return {
				statusCode: 200,
				body: JSON.stringify({
					response_type: "ephemeral",
					text: `❌ Erreur: ${response.data.error}`,
				}),
				headers: { "Content-Type": "application/json" },
			};
		}
		return { statusCode: 200, body: "" };
	} catch (error) {
		await notifyTechSlack(error);

		context.log(
			`❌ Error opening form: ${error.message}\nStack: ${error.stack}`
		);
		return {
			statusCode: 200,
			body: JSON.stringify({
				response_type: "ephemeral",
				text: `❌ Erreur: Impossible d'ouvrir le formulaire (${error.message})`,
			}),
			headers: { "Content-Type": "application/json" },
		};
	}

	return context.res;
}
async function saveToStorage(key, data) {
	try {
		console.log("** saveToStorage");
		const result = await FormData1.create({ key, data });
		console.log(`Stored form data in MongoDB with key: ${key}`);
		return result;
	} catch (err) {
		await notifyTechSlack(err);

		console.log(`Error saving form data for key ${key}:`, err);
		throw err;
	}
}
async function handleOrderFormSubmission(
	payload,
	context,
	formData,
	userId,
	userName,
	channelId,
	existingMetadata,
	submissionSource,
	orderId
) {
	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

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
					await notifyTechSlack(error);

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
			const { Order } = require("../../Database/dbModels/Order");

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
				await new Promise((resolve) => setTimeout(resolve, 500)); // 500ms delay

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

			const newProformas = await extractProformas(formData, context, i, userId);
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
						url_private: proforma.url_private || proforma.fileData?.url_private,
						url_private_download:
							proforma.url_private_download ||
							proforma.fileData?.url_private_download,
						size: proforma.size || proforma.fileData?.size,
						mimetype: proforma.mimetype || proforma.fileData?.mimetype,
						uploaded_by:
							proforma.uploaded_by || proforma.fileData?.uploaded_by || userId,
						uploaded_at: new Date(),
						channel_id:
							proforma.channel_id || proforma.fileData?.channel_id || channelId,
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
							formData.equipe_selection.select_equipe.selected_option.text.text,
						date_requete:
							formData.request_date.input_request_date.selected_date,
						articles,
						proformas,
						date: new Date(), // Update modification date
					},
					{ new: true }
				);

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
					await notifyTechSlack(error);

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
						await notifyTechSlack(error);

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
			await notifyTechSlack(error);

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
		await notifyTechSlack(error);

		console.error("Error generating command ID:", error);
		throw error;
	}
}
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

		context.log(`lll Order data before save: ${JSON.stringify(orderData)}`);
		const { Order } = require("../../Database/dbModels/Order");
		const order = new Order(orderData);
		const savedOrder = await order.save();
		return savedOrder;
		// const savedOrder = await Order.create(orderData);
		// return savedOrder;
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error creating and saving order:", error);
		throw error;
	}
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

				// 	// Add photo to the photos array
				photos.push({
					id: uploadedFileId,
					url: filePermalink,
					uploadedAt: new Date(),
				});
				console.log(`Photo processed for article ${photos}`);

				totalPages += 1;
			} catch (error) {
				await notifyTechSlack(error);
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

async function handleDynamicFormUpdates(payload, action, context) {
	console.log("** handleDynamicFormUpdates");
	if (!payload.view || !payload.view.blocks) {
		context.log("❌ Payload invalide: view.blocks manquant");
		return createSlackResponse(400, "Payload invalide");
	}
	if (
		payload.actions[0].type === "overflow" &&
		payload.actions[0].selected_option
	) {
		const selectedValue = payload.actions[0].selected_option.value;
		if (selectedValue.startsWith("remove_proforma_")) {
			try {
				console.log("remove_proforma");
				const indexToRemove = parseInt(selectedValue.split("_")[2], 10);
				const metadata = JSON.parse(payload.view.private_metadata);
				let { formData, suggestions, proformas } = metadata;

				// Remove the proforma at the specified index
				proformas = proformas.filter((_, i) => i !== indexToRemove);

				// Regenerate the form view
				const updatedView = await generateOrderForm(
					proformas,
					suggestions,
					formData
				);

				// Update metadata
				metadata.proformas = proformas;
				updatedView.private_metadata = JSON.stringify(metadata);

				// Update the modal
				const response = await postSlackMessage2(
					"https://slack.com/api/views.update",
					{
						view_id: payload.view.id,
						view: updatedView,
					},
					process.env.SLACK_BOT_TOKEN
				);

				context.log(
					`Remove proforma response: ${JSON.stringify(response.data)}`
				);
				if (!response.data.ok) {
					throw new Error(`Slack API error: ${response.data.error}`);
				}
			} catch (error) {
				await notifyTechSlack(error);

				context.log(
					`❌ Error in remove_proforma: ${error.message}\nStack: ${error.stack}`
				);
				await axios.post(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: payload.channel?.id || payload.user.id,
						user: payload.user.id,
						text: `🛑 Échec de la suppression du proforma: ${error.message}`,
					},
					{
						headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
					}
				);
			}
		}
	}
	const actionId = action.action_id;
	let updatedBlocks = [...payload.view.blocks];
	if (actionId === "add_article") {
		updatedBlocks = await handleAddArticle(updatedBlocks);
	} else if (actionId.startsWith("add_proforma_")) {
		updatedBlocks = handleAddProforma(actionId, updatedBlocks);
	} else if (actionId.startsWith("cancel_proforma_")) {
		updatedBlocks = handleCancelProforma(actionId, updatedBlocks);
	} else if (actionId.startsWith("remove_article_")) {
		updatedBlocks = handleRemoveArticle(actionId, updatedBlocks);
	}
	const originalPrivateMetadata = payload.view.private_metadata;
	await postSlackMessage(
		"https://slack.com/api/views.update",
		{
			view_id: payload.view.id,
			hash: payload.view.hash,
			view: {
				type: "modal",
				callback_id: "order_form_submission",
				title: { type: "plain_text", text: "Nouvelle Commande" },
				submit: { type: "plain_text", text: "Envoyer" },
				close: { type: "plain_text", text: "Annuler" },
				blocks: updatedBlocks,
				private_metadata: originalPrivateMetadata,
			},
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, "");
}

module.exports = {
	handleOrderFormSubmission,
	handleDynamicFormUpdates,
	handleOpenOrderForm,
	createAndSaveOrder,
};
