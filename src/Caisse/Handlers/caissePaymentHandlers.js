const {
	Caisse,
	DecaissementCounter,
} = require("../../Database/dbModels/Caisse.js");

const {
	createSlackResponse,
	postSlackMessageWithRetry,
} = require("../../Common/slackUtils");
const axios = require("axios");
(async () => {
	fetch = (await import("node-fetch")).default;
})();

const {
	generateFundingDetailsBlocks,
} = require("./caisseFundingRequestHandlers");
const { syncCaisseToExcel } = require("../../Excel/report");
const { bankOptions, getFileInfo, fetchEntity } = require("../../Common/utils");
const { Order } = require("../../Database/dbModels/Order.js");
const PaymentRequest = require("../../Database/dbModels/PaymentRequest.js");

const { WebClient } = require("@slack/web-api");
const { notifyTechSlack } = require("../../Common/notifyProblem.js");
const {
	getPaymentBlocks,
} = require("../../Order/Payment/paymentNotifications.js");
const {
	calculateTotalAmountDue,
	generatePaymentNumber,
} = require("../../Order/Payment/paymentHandlers.js");
const client = new WebClient(process.env.SLACK_BOT_TOKEN);

//* 6 fill_funding_details*
async function handleFillFundingDetails(payload, context) {
	console.log("** fill_funding_details");
	console.log("Message TS:", payload.message?.ts);
	console.log("Channel ID:", payload.channel?.id);
	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		console.log("approve_funding");
		const messageTs = payload.message?.ts;
		const channelId = payload.channel?.id; // Get the current channel ID

		console.log("Processing fill_funding_details");
		console.log(`Message TS: ${messageTs}, Channel ID: ${channelId}`);

		// const requestId = action.value; // e.g., FUND/2025/04/0070
		const { requestId, caisseType } = JSON.parse(payload.actions[0].value);

		await generateFundingApprovalPaymentModal(
			context,
			payload.trigger_id,
			messageTs,
			requestId,
			channelId,
			caisseType
		);
		return createSlackResponse(200, "");
	});

	return context.res;
}
//* 7 fill_funding_details*
async function generateFundingApprovalPaymentModal(
	context,
	trigger_id,
	messageTs,
	requestId,
	channelId,
	caisseType
) {
	console.log(
		`** generateFundingApprovalPaymentModal - messageTs: ${messageTs}, channelId: ${
			channelId || "not provided"
		}`
	);

	// Find the funding request in the database
	const caisse = await Caisse.findOne({
		type: caisseType, // Match by caisseType
		"fundingRequests.requestId": requestId, // Match by requestId within fundingRequests
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return;
	}

	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);

	if (!request) {
		console.error(`Request ${requestId} not found`);
		return;
	}
	const metadata = JSON.stringify({
		requestId: requestId,
		messageTs: messageTs,
		caisseType: caisseType,
		channelId: channelId,
		amount: request.amount, // Include amount
		currency: request.currency, // Include currency
		reason: request.reason, // Include reason
		requestedDate: request.requestedDate, // Include requested date
		submitterName: request.submitterName || request.submittedBy, // Include submitter name
	});
	console.log(`Modal metadata: ${metadata}`);

	// Bank options for dropdown (used later in handlePaymentMethodSelection)

	// Create blocks for the modal
	const blocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Approbation de demande de fonds*\nID: ${requestId}\nMontant: ${
					request.amount
				} ${request.currency}\nMotif: ${request.reason}\nDemandeur: ${
					request.submitterName || request.submittedBy
				}`,
			},
		},
		{
			type: "divider",
		},
		{
			type: "input",
			block_id: "payment_method",
			label: { type: "plain_text", text: "Méthode de paiement" },
			element: {
				type: "radio_buttons",
				action_id: "input_payment_method",
				options: [
					{ text: { type: "plain_text", text: "Espèces" }, value: "cash" },
					{ text: { type: "plain_text", text: "Chèque" }, value: "cheque" },
				],
				initial_option: {
					text: { type: "plain_text", text: "Espèces" },
					value: "cash",
				},
			},
			dispatch_action: true, // Enable block_actions event on selection
		},
		{
			type: "input",
			block_id: "payment_notes",
			optional: true,
			label: { type: "plain_text", text: "Notes (optionnel)" },
			element: {
				type: "plain_text_input",
				action_id: "input_payment_notes",
			},
		},
	];

	const modal = {
		type: "modal",
		callback_id: "submit_finance_details",
		private_metadata: metadata,
		title: { type: "plain_text", text: "Détails financiers" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: blocks,
	};

	try {
		await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id, view: modal },
			process.env.SLACK_BOT_TOKEN
		);
		console.log(`Modal opened for request ${requestId}`);
	} catch (error) {
		await notifyTechSlack(error);

		console.error(`Error opening modal for ${requestId}:`, error);
	}
}
//* 8 callback_id=submit_finance_details && * action_id=input_payment_method
async function handlePaymentMethodSelection(payload, context) {
	console.log("** handlePaymentMethodSelection");
	const selectedValue = payload.actions[0].selected_option?.value;
	console.log("Selected payment method:", selectedValue);

	if (!selectedValue) {
		console.error("No payment method selected in payload");
		return;
	}

	if (selectedValue !== "cheque") {
		console.log("Not cheque, no modal update needed");
		// Optionally, remove cheque fields if previously added
		const viewId = payload.view.id;
		let blocks = payload.view.blocks.filter(
			(block) =>
				![
					"cheque_number",
					"cheque_bank",
					"cheque_date",
					"cheque_order",
				].includes(block.block_id)
		);

		try {
			await postSlackMessageWithRetry(
				"https://slack.com/api/views.update",
				{
					view_id: viewId,
					view: {
						type: "modal",
						callback_id: "submit_finance_details",
						private_metadata: payload.view.private_metadata,
						title: { type: "plain_text", text: "Détails financiers" },
						submit: { type: "plain_text", text: "Soumettre" },
						close: { type: "plain_text", text: "Annuler" },
						blocks: blocks,
					},
				},
				process.env.SLACK_BOT_TOKEN
			);
			console.log("Modal updated to remove cheque fields");
		} catch (error) {
			await notifyTechSlack(error);

			console.error("Error removing cheque fields:", error);
		}
		return;
	}

	const viewId = payload.view.id;
	const requestId = payload.view.private_metadata;

	// Get current blocks and remove existing cheque fields to avoid duplicates
	let blocks = payload.view.blocks.filter(
		(block) =>
			!["cheque_number", "cheque_bank", "cheque_date", "cheque_order"].includes(
				block.block_id
			)
	);

	// Add cheque detail blocks
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
				type: "number_input",
				action_id: "input_cheque_number",
				is_decimal_allowed: false,
				min_value: "0",
			},
			label: { type: "plain_text", text: "Numéro du Chèque" },
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
		},
		// Add new file upload field
		{
			type: "input",
			block_id: "cheque_files",
			optional: true,
			element: {
				type: "file_input",
				action_id: "input_cheque_files",
				filetypes: ["pdf", "png", "jpg", "jpeg"],
				max_files: 3,
			},
			label: { type: "plain_text", text: "Fichiers" },
		},
		// Add URL input field for external links
		{
			type: "input",
			block_id: "cheque_urls",
			optional: true,
			element: {
				type: "plain_text_input",
				action_id: "input_cheque_urls",
				placeholder: {
					type: "plain_text",
					text: "URLs séparées par des virgules",
				},
			},
			// label: { type: "plain_text", text: "Liens vers les documents (séparés par des virgules)" },
			label: { type: "plain_text", text: "Lien " },
		}
	);

	// Update the modal
	try {
		await postSlackMessageWithRetry(
			"https://slack.com/api/views.update",
			{
				view_id: viewId,
				view: {
					type: "modal",
					callback_id: "submit_finance_details",
					private_metadata: requestId,
					title: { type: "plain_text", text: "Détails financiers" },
					submit: { type: "plain_text", text: "Soumettre" },
					close: { type: "plain_text", text: "Annuler" },
					blocks: blocks,
				},
			},
			process.env.SLACK_BOT_TOKEN
		);
		console.log("Modal updated with cheque fields for request:", requestId);
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error updating modal with cheque fields:", error);
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

//* 9 submit_finance_details
async function FinanceDetailsSubmission(payload, context) {
	console.log("** handleFinanceDetailsSubmission");

	// Immediate response to close modal
	context.res = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		console.log("** handleFinanceDetailsSubmission - START");

		const formData = payload.view.state.values;
		const userId = payload.user.id;
		const userName = payload.user.username || userId;

		// Log metadata to verify values
		const metadata = JSON.parse(payload.view.private_metadata);
		console.log("METADATA:", metadata);
		const requestId = metadata.requestId;
		const caisseType = metadata.caisseType;

		const originalMessageTs = metadata.messageTs;
		const originalChannelId = metadata.channelId;
		// const channelId = process.env.SLACK_FINANCE_CHANNEL_ID;
		// const messageTs = metadata.messageTs;

		console.log(
			`MessageTs: ${originalMessageTs}, ChannelId: ${originalChannelId}`
		);

		// Find the funding request
		const caisse = await Caisse.findOne({
			type: caisseType, // Match by caisseType
			"fundingRequests.requestId": requestId, // Match by requestId within fundingRequests
		});
		if (!caisse) {
			console.error(`Caisse not found for request ${requestId}`);
			return createSlackResponse(200, {
				response_action: "errors",
				errors: { payment_method: "Demande introuvable" },
			});
		}

		const requestIndex = caisse.fundingRequests.findIndex(
			(r) => r.requestId === requestId
		);
		if (requestIndex === -1) {
			console.error(`Request ${requestId} not found`);
			return createSlackResponse(200, {
				response_action: "errors",
				errors: { payment_method: "Demande introuvable" },
			});
		}

		const request = caisse.fundingRequests[requestIndex];

		// Extract form data
		const paymentMethod =
			formData.payment_method.input_payment_method.selected_option.value;
		const paymentNotes =
			formData.payment_notes?.input_payment_notes?.value || "";
		console.log("Payment Method:", paymentMethod);
		const disbursementType = paymentMethod === "cash" ? "Espèces" : "Chèque";

		// Build payment details object
		const paymentDetails = {
			method: paymentMethod,
			notes: paymentNotes,
			approvedBy: userId,
			approvedAt: new Date(),
			filledBy: userId,
			filledByName: userName,
			filledAt: new Date(),
		};

		// Add cheque details if method is cheque
		if (paymentMethod === "cheque") {
			if (
				!formData.cheque_number ||
				!formData.cheque_bank ||
				!formData.cheque_date ||
				!formData.cheque_order
			) {
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: process.env.SLACK_ADMIN_ID,
						text: "❌ Veuillez remplir tous les champs requis pour le chèque (numéro, banque, date, ordre).",
					},
					process.env.SLACK_BOT_TOKEN
				);
				return createSlackResponse(200, "");
			}
			// // Extract file IDs from file_input
			// const fileIds =
			// 	formData.cheque_files?.input_cheque_files?.files?.map(
			// 		(file) => file.url_private
			// 	) || [];
			// console.log("File IDs:", fileIds);
			const proofFiles = formData.cheque_files?.input_cheque_files?.files || [];
			console.log(
				"proofFiles.length",
				proofFiles.length,
				"proofFiles",
				proofFiles
			);
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

						filePermalink = uploadedFileInfo.permalink;
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

						// Store the permalink for payment proofs
						paymentProofs.push(filePermalink);
					} catch (error) {
						await notifyTechSlack(error);

						console.error(
							"Error processing payment proof file:",
							error.message
						);
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
			// Process URLs (comma-separated string to array)
			const urlsString = formData.cheque_urls?.input_cheque_urls?.value || "";
			const urls = urlsString
				? urlsString
						.split(",")
						.map((url) => url.trim())
						.filter((url) => /^https?:\/\/[^\s,]+$/.test(url))
				: [];
			console.log("URLs:", urls);
			paymentDetails.cheque = {
				number: formData.cheque_number.input_cheque_number.value,
				bank: formData.cheque_bank.input_cheque_bank.selected_option.value,
				date: formData.cheque_date.input_cheque_date.selected_date,
				order: formData.cheque_order.input_cheque_order.value,
				urls: urls,
				file_ids: paymentProofs,
			};
		}

		request.paymentDetails = paymentDetails;
		request.disbursementType = disbursementType;

		// Update workflow status
		request.status = "Détails fournis";
		request.workflow.stage = "details_submitted";
		request.workflow.history.push({
			stage: "details_submitted",
			timestamp: new Date(),
			actor: userId,
			details: "Détails financiers fournis",
		});

		await caisse.save();

		// Log the message update attempt
		console.log("Attempting to update message...");
		console.log(`Channel: ${originalChannelId}, TS: ${originalMessageTs}`);
		// Build cheque details text for display if applicable
		let chequeDetailsText = "";

		// Generate blocks for Slack message
		const block = generateFundingDetailsBlocks(
			request,
			paymentMethod,
			paymentNotes,
			paymentDetails,
			userId,
			caisseType
		);

		//! const additionalDetails =
		//   paymentMethod === "cheque" && paymentDetails.cheque
		//     ? [
		//         {
		//           type: "mrkdwn",
		//           text: `*Numéro de chèque:*\n${
		//             paymentDetails.cheque.number || "N/A"
		//           }`,
		//         },
		//         {
		//           type: "mrkdwn",
		//           text: `*Banque:*\n${paymentDetails.cheque.bank || "N/A"}`,
		//         },
		//         {
		//           type: "mrkdwn",
		//           text: `*Date du chèque:*\n${paymentDetails.cheque.date || "N/A"}`,
		//         },
		//         {
		//           type: "mrkdwn",
		//           text: `*Ordre:*\n${paymentDetails.cheque.order || "N/A"}`,
		//         },
		//       ]
		// !    : [];

		//! const block = [
		//   {
		//     type: "divider",
		//   },
		//   {
		//     type: "section",
		//     fields: [
		//       {
		//         type: "mrkdwn",
		//         text: `*Montant:*\n${request.amount} ${request.currency}`,
		//       },
		//       {
		//         type: "mrkdwn",
		//         text: `*Motif:*\n${request.reason}`,
		//       },
		//     ],
		//   },
		//   {
		//     type: "section",
		//     fields: [
		//       {
		//         type: "mrkdwn",
		//         text: `*Date requise:*\n${new Date(
		//           request.requestedDate
		//         ).toLocaleString("fr-FR", {
		//           weekday: "long",
		//           year: "numeric",
		//           month: "long",
		//           day: "numeric",
		//         })}`,
		//       },
		//       {
		//         type: "mrkdwn",
		//         text: `*Demandeur:*\n${request.submitterName || request.submittedBy}`,
		//       },
		//     ],
		//   },

		//   {
		//     type: "section",
		//     fields: [
		//       {
		//         type: "mrkdwn",
		//         text: `*Méthode:* ${getPaymentMethodText(paymentMethod)}`,
		//       },
		//       { type: "mrkdwn", text: `*Notes:* ${paymentNotes || "Aucune"}` },
		//     ],
		//   },
		//   {
		//     type: "section",
		//     fields: additionalDetails.slice(0, 2), // First 2 fields
		//   },
		//   ...(additionalDetails.length > 2
		//     ? [
		//         {
		//           type: "section",
		//           fields: additionalDetails.slice(2), // Remaining fields
		//         },
		//       ]
		//     : []),
		//   ...(paymentMethod === "cheque" && (paymentDetails.cheque.file_ids.length > 0 ||
		//   paymentDetails.cheque.urls.length > 0)
		//     ? [
		//         { type: "divider" },
		//         {
		//           type: "section",
		//           text: { type: "mrkdwn", text: `*Justificatif(s)*` },
		//         },
		//       ]
		//     : []),
		//   ...(paymentMethod === "cheque" && paymentDetails.cheque.file_ids.length > 0
		//     ? [
		//         {
		//           type: "section",
		//           text: {
		//             type: "mrkdwn",
		//             text: `${paymentDetails.cheque.file_ids
		//               .map((proof, index) => `<${proof}|Preuve ${index + 1}>`)
		//               .join("\n")}`,
		//           },
		//         },
		//       ]
		//     : []),
		//   ...(paymentMethod === "cheque" && paymentDetails.cheque.urls.length > 0
		//     ? [
		//         {
		//           type: "section",
		//           text: {
		//             type: "mrkdwn",
		//             text: `${paymentDetails.cheque.urls
		//               .map(
		//                 (proof) =>
		//                   `<${proof}|Preuve ${
		//                     paymentDetails.cheque.file_ids.length + 1
		//                   }>`
		//               )
		//               .join("\n")}`,
		//           },
		//         },
		//       ]
		//     : []),
		//   {
		//     type: "context",
		//     elements: [
		//       {
		//         type: "mrkdwn",
		//         text: `✅ *Détails fournis par <@${userId}>* le ${new Date().toLocaleString(
		//           "fr-FR",
		//           {
		//             weekday: "long",
		//             year: "numeric",
		//             month: "long",
		//             day: "numeric",
		//             hour: "2-digit",
		//             minute: "2-digit",
		//             timeZoneName: "short",
		//           }
		//         )} `,
		//       },
		//     ],
		//   },
		//! ];

		// Update finance team message - IMPORTANT: Remove the button from the message
		if (originalMessageTs && originalChannelId) {
			try {
				const updatedMessage = {
					channel: originalChannelId,
					ts: originalMessageTs,
					blocks: [
						{
							type: "header",
							text: {
								type: "plain_text",
								text: `:heavy_dollar_sign: Demande de fonds: ${
									requestId || "N/A"
								}`,
								emoji: true,
							},
						},
						...block,

						{
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
									action_id: "report_fund_problem",
									value: JSON.stringify({ requestId, caisseType }), // Include caisseType in the value
								},
							],
						},
					],

					text: `Demande de fonds ${
						requestId || "N/A"
					} - Détails fournis, en attente d'approbation finale`,
				};

				console.log("Update message payload:", JSON.stringify(updatedMessage));

				const response = await postSlackMessageWithRetry(
					"https://slack.com/api/chat.update",
					updatedMessage,
					process.env.SLACK_BOT_TOKEN
				);

				console.log("Slack update response:", JSON.stringify(response));

				if (!response.ok) {
					console.error(`Failed to update message: ${response.error}`);
				}
			} catch (error) {
				await notifyTechSlack(error);

				console.error(`Error updating message: ${error.message}`);
			}
		} else {
			console.log("Missing messageTs or channelId - cannot update message");
		}

		// Sync to Excel
		try {
			await syncCaisseToExcel(caisse, requestId);
		} catch (error) {
			await notifyTechSlack(error);

			console.error(`Excel sync failed: ${error.message}`);
		}

		// Create rich notification for admin final approval
		console.log("Sending admin notification...");
		try {
			const adminResponse = await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					blocks: [
						{
							type: "header",
							text: {
								type: "plain_text",
								text: `:heavy_dollar_sign: Demande de fonds - Approbation Finale : ${requestId}`,
								emoji: true,
							},
						},

						...block,
						// {
						//   type: "section",
						//   fields: [
						//     {
						//       type: "mrkdwn",
						//       text: `*Montant:*\n${request.amount} ${request.currency}`,
						//     },
						//     {
						//       type: "mrkdwn",
						//       text: `*Motif:*\n${request.reason}` ,
						//     },
						//   ],
						// },
						// {
						//   type: "section",
						//   fields: [
						//     {
						//       type: "mrkdwn",
						//       text: `*Demandeur:*\n${
						//         request.submitterName || request.submittedBy
						//       }`,
						//     },
						//     {
						//       type: "mrkdwn",
						//       text: `*Méthode:*\n${getPaymentMethodText(
						//         paymentMethod
						//       )}\n${chequeDetailsText}`,
						//     },
						//   ],
						// },
						// {
						//   type: "section",
						//   fields: [
						//     {
						//       type: "mrkdwn",
						//       text: `*Notes:*\n${paymentNotes || "Aucune"}`,
						//     },
						//     {
						//       type: "mrkdwn",
						//       text: `*Détails fournis par:*\n<@${userId}>`,
						//     },
						//   ],
						// },

						{
							type: "actions",
							elements: [
								{
									type: "button",
									text: { type: "plain_text", text: "Approuver", emoji: true },
									style: "primary",
									value: JSON.stringify({ requestId, caisseType }), // Include caisseType in the value

									action_id: "funding_approval_payment",
								},
								{
									type: "button",
									text: { type: "plain_text", text: "Rejeter", emoji: true },
									style: "danger",
									value: JSON.stringify({ requestId, caisseType }), // Include caisseType in the value

									action_id: "reject_fund",
								},
							],
						},
					],
					text: `Demande de fonds ${requestId} - Approbation finale requise`,
				},
				process.env.SLACK_BOT_TOKEN
			);
			console.log(
				"Admin notification response:",
				JSON.stringify(adminResponse)
			);
		} catch (error) {
			await notifyTechSlack(error);

			console.error(`Error sending admin notification: ${error.message}`);
		}

		console.log("** handleFinanceDetailsSubmission - END");
		return createSlackResponse(200, { response_action: "clear" });
	});

	return context.res;
}

//* ? payload.type === "view_submission" && payload.view.callback_id === "payment_modification_modal"
// async function handlePaymentModificationSubmission(payload, context) {
// 	console.log(
// 		'** ? payload.type === "view_submission" && payload.view.callback_id === "payment_modification_modal"'
// 	);
// 	console.log("handlePaymentModificationSubmission1");
// 	const { WebClient } = require("@slack/web-api");
// 	const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// 	try {
// 		console.log("Handling payment modification submission");

// 		// Extract metadata and submitted values
// 		const privateMetadata = JSON.parse(payload.view.private_metadata);
// 		console.log(";; Private metadata:", privateMetadata);

// 		const { entityId, paymentIndex } = privateMetadata;
// 		const values = payload.view.state.values;
// 		console.log("Submitted payload values:", JSON.stringify(values, null, 2));
// 		console.log("Order ID:", entityId, "Payment Index:", paymentIndex);

// 		// Extract form data from the modal
// 		const paymentTitle = values.payment_title?.payment_title_input?.value || "";
// 		const paymentDate =
// 			values.payment_date?.payment_date_input?.selected_date || "";
// 		const paymentAmount =
// 			parseFloat(values.payment_amount?.payment_amount_input?.value) || 0;
// 		const paymentMode =
// 			values.payment_mode?.payment_mode_input?.selected_option?.value || "";
// 		const paymentStatus =
// 			values.payment_status?.payment_status_input?.selected_option?.value || "";
// 		const paymentUrl = values.payment_url?.payment_url_input?.value || "";

// 		// Prepare payment details based on mode
// 		let paymentDetails = {};
// 		if (paymentMode === "Chèque") {
// 			paymentDetails = {
// 				cheque_number: values.cheque_number?.cheque_number_input?.value || "",
// 				cheque_bank: values.cheque_bank?.cheque_bank_input?.value || "",
// 			};
// 		} else if (paymentMode === "Virement") {
// 			paymentDetails = {
// 				virement_number:
// 					values.virement_number?.virement_number_input?.value || "",
// 				virement_bank: values.virement_bank?.virement_bank_input?.value || "",
// 			};
// 		} // No details for "Espèces" or "Carte bancaire"

// 		// Prepare the updated payment object
// 		const updatedPayment = {
// 			paymentMode,
// 			amountPaid: paymentAmount,
// 			paymentTitle,
// 			paymentUrl,
// 			details: paymentDetails,
// 			status: paymentStatus,
// 			dateSubmitted: paymentDate ? new Date(paymentDate) : new Date(), // Use submitted date or current date
// 		};

// 		console.log("Updated payment data:", updatedPayment);

// 		// Update the payment in the database
// 		let entity;
// 		if (entityId.startsWith("CMD/")) {
// 			entity = await Order.findOne({ id_commande: entityId });
// 			if (!entity || !entity.payments) {
// 				throw new Error(`Commande ${entityId} non trouvée ou sans paiements`);
// 			}

// 			// // Find and update the specific payment
// 			// const paymentIndex = entity.payments.findIndex(
// 			// 	(p) => String(p._id) === paymentId || String(p.id) === paymentId
// 			// );
// 			// if (paymentIndex === -1) {
// 			// 	throw new Error(
// 			// 		`Paiement ${paymentId} non trouvé dans la commande ${entityId}`
// 			// 	);
// 			// }

// 			entity.payments[paymentIndex] = {
// 				...entity.payments[paymentIndex], // Preserve existing fields not in the modal
// 				...updatedPayment,
// 				_id: entity.payments[paymentIndex]._id, // Ensure _id remains unchanged
// 			};

// 			await entity.save();
// 			console.log(`Payment ${paymentIndex} updated in order ${entityId}`);
// 		} else if (entityId.startsWith("PAY/")) {
// 			entity = await PaymentRequest.findOne({ id_paiement: entityId });
// 			if (!entity || !entity.payments) {
// 				throw new Error(
// 					`Demande de paiement ${entityId} non trouvée ou sans paiements`
// 				);
// 			}

// 			// const paymentIndex = entity.payments.findIndex(
// 			// 	(p) => String(p._id) === paymentId || String(p.id) === paymentId
// 			// );
// 			// if (paymentIndex === -1) {
// 			// 	throw new Error(
// 			// 		`Paiement ${paymentId} non trouvé dans la demande ${entityId}`
// 			// 	);
// 			// }

// 			entity.payments[paymentIndex] = {
// 				...entity.payments[paymentIndex],
// 				...updatedPayment,
// 				_id: entity.payments[paymentIndex]._id,
// 			};

// 			await entity.save();
// 			console.log(
// 				`Payment ${paymentIndex} updated in payment request ${entityId}`
// 			);
// 		} else {
// 			throw new Error(`Format d'ID non reconnu: ${entityId}`);
// 		}

// 		// Notify the user via Slack
// 		const channelId = payload.channel?.id || "C08KS4UH5HU"; // Fallback to a default channel if needed
// 		const userId = payload.user.id;
// 		const channels = [
// 			process.env.SLACK_FINANCE_CHANNEL_ID,
// 			entity.demandeurId, // Assuming this is a Slack user ID for DM
// 			channelId, // Original channel ID
// 		];
// 		console.log("Channels to notify:", channels);
// 		for (const Channel of channels) {
// 			await slack.chat.postMessage({
// 				channel: Channel,
// 				text: `✅ Paiement modifié avec succès pour ${entityId}`,
// 				blocks: [
// 					{
// 						type: "header",
// 						text: {
// 							type: "plain_text",
// 							text: `Paiement Modifié: ${entityId}`,
// 							emoji: true,
// 						},
// 					},
// 					{
// 						type: "section",
// 						fields: [
// 							{ type: "mrkdwn", text: `*Titre:*\n${paymentTitle}` },
// 							{ type: "mrkdwn", text: `*Date:*\n${paymentDate}` },
// 							{
// 								type: "mrkdwn",
// 								text: `*Montant payé:*\n${paymentAmount} ${
// 									entity.devise || "USD"
// 								}`,
// 							},
// 							{ type: "mrkdwn", text: `*Mode de paiement:*\n${paymentMode}` },
// 							{ type: "mrkdwn", text: `*Statut:*\n${paymentStatus}` },
// 							...(paymentUrl
// 								? [
// 										{
// 											type: "mrkdwn",
// 											text: `*URL:*\n<${paymentUrl}|Voir le lien>`,
// 										},
// 								  ]
// 								: []),
// 							...(paymentProofs
// 								? [
// 										{
// 											type: "mrkdwn",
// 											text: `*Fichiers:*\n<${paymentProofs}|Voir le lien>`,
// 										},
// 								  ]
// 								: []),
// 							...(paymentMode === "Chèque"
// 								? [
// 										{
// 											type: "mrkdwn",
// 											text: `*Numéro de chèque:*\n${paymentDetails.cheque_number}`,
// 										},
// 										{
// 											type: "mrkdwn",
// 											text: `*Banque:*\n${paymentDetails.cheque_bank}`,
// 										},
// 								  ]
// 								: []),
// 							...(paymentMode === "Virement"
// 								? [
// 										{
// 											type: "mrkdwn",
// 											text: `*Numéro de virement:*\n${paymentDetails.virement_number}`,
// 										},
// 										{
// 											type: "mrkdwn",
// 											text: `*Banque:*\n${paymentDetails.virement_bank}`,
// 										},
// 								  ]
// 								: []),
// 						],
// 					},
// 				],
// 			});
// 		}

// 		console.log(`Notification sent to channel ${channelId} for user ${userId}`);
// 	} catch (error) {
// 		await notifyTechSlack(error);

// 		console.error(`Error in handlePaymentModificationSubmission: ${error}`);

// 		// Notify the user of the error
// 		try {
// 			await slack.chat.postEphemeral({
// 				channel: payload.channel?.id || "C08KS4UH5HU",
// 				user: payload.user.id,
// 				text: `❌ Erreur lors de la modification du paiement: ${error.message}`,
// 			});
// 		} catch (slackError) {
// 			await notifyTechSlack(slackError);

// 			console.error(`Error sending error notification: ${slackError}`);
// 		}

// 		// Re-throw the error to ensure the modal doesn't close silently on failure
// 		throw error;
// 	}
// }

async function handlePaymentModificationSubmission(payload, context) {
	console.log("** handlePaymentModificationSubmission");

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
		console.log("Payload view:", JSON.stringify(payload.view, null, 2));
		const selectedCaisseId = metadata.selectedCaisseId || "";
		console.log("Selected caisse ID:", selectedCaisseId);
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
				await notifyTechSlack(error);

				console.log("::== Error fetching caisse:", error.message);
				console.log("::== using default targetChannelId", targetChannelId);
			}
		} else {
			console.log("::== selectedCaisseId is null/undefined, using default");
			console.log("::== using default targetChannelId", targetChannelId);
		}
		let caisse = null;
		if (selectedCaisseId) {
			caisse = await Caisse.findById(selectedCaisseId);
		}
		if (!caisse && targetChannelId) {
			caisse = await Caisse.findOne({ channelId: targetChannelId });
		}

		if (!caisse) {
			throw new Error("Caisse document not found");
		}
		console.log("Caisse found:", caisse);
		// Extract metadata and submitted values
		const privateMetadata = JSON.parse(payload.view.private_metadata);
		const entityId = metadata.entityId;
		const orderId = metadata.entityId;
		const paymentIndex = metadata.paymentIndex;
		console.log("$$ paymentIndex", paymentIndex);

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
			// ...existing code...

			// After fetching originalPayment and before updating the payment
			if (
				originalPayment &&
				originalPayment.paymentMode === "Espèces" &&
				paymentMode !== "Espèces"
			) {
				const originalAmount = originalPayment.amountPaid || 0;
				if (originalAmount > 0) {
					const currentBalance = caisse.balances[currency] || 0;
					const caisseUpdate = {
						$inc: { [`balances.${currency}`]: originalAmount },
						$push: {
							transactions: {
								type: "payment_mode_change_refund",
								amount: originalAmount,
								currency,
								orderId,
								details: `Remboursement suite changement mode de paiement Espèces -> ${paymentMode} pour ${paymentTitle} (Order: ${orderId})`,
								timestamp: new Date(),
								paymentMethod: "Espèces",
								paymentDetails: originalPayment.details,
							},
						},
					};
					const updatedCaisse = await Caisse.findOneAndUpdate(
						{},
						caisseUpdate,
						{
							new: true,
						}
					).catch((err) => {
						console.error(`Error updating Caisse: ${err.message}`);
						throw new Error(`Failed to update Caisse: ${err.message}`);
					});
					// Optionally sync to Excel
					if (updatedCaisse.latestRequestId) {
						await syncCaisseToExcel(
							updatedCaisse,
							updatedCaisse.latestRequestId
						).catch((err) => {
							console.error(`Error syncing Caisse to Excel: ${err.message}`);
						});
					}
					// Notify finance team
					await postSlackMessage(
						process.env.SLACK_FINANCE_CHANNEL_ID,
						`🔴 Remboursement automatique: ${originalAmount} ${currency} retourné à la caisse suite au changement du mode de paiement (Espèces -> ${paymentMode}) pour ${orderId}. Nouveau solde: ${updatedCaisse.balances[currency]}.`,
						[]
					);
				}
			}

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
			if (
				originalPayment &&
				originalPayment.paymentMode === "Espèces" &&
				paymentMode !== "Espèces"
			) {
				const originalAmount = originalPayment.amountPaid || 0;
				if (originalAmount > 0) {
					const currentBalance = caisse.balances[currency] || 0;
					const caisseUpdate = {
						$inc: { [`balances.${currency}`]: originalAmount },
						$push: {
							transactions: {
								type: "payment_mode_change_refund",
								amount: originalAmount,
								currency,
								orderId,
								details: `Remboursement suite changement mode de paiement Espèces -> ${paymentMode} pour ${paymentTitle} (Order: ${orderId})`,
								timestamp: new Date(),
								paymentMethod: "Espèces",
								paymentDetails: originalPayment.details,
							},
						},
					};
					const updatedCaisse = await Caisse.findOneAndUpdate(
						{},
						caisseUpdate,
						{
							new: true,
						}
					).catch((err) => {
						console.error(`Error updating Caisse: ${err.message}`);
						throw new Error(`Failed to update Caisse: ${err.message}`);
					});
					// Optionally sync to Excel
					if (updatedCaisse.latestRequestId) {
						await syncCaisseToExcel(
							updatedCaisse,
							updatedCaisse.latestRequestId
						).catch((err) => {
							console.error(`Error syncing Caisse to Excel: ${err.message}`);
						});
					}
					// Notify finance team
					await postSlackMessage(
						process.env.SLACK_FINANCE_CHANNEL_ID,
						`🔴 Remboursement automatique: ${originalAmount} ${currency} retourné à la caisse suite au changement du mode de paiement (Espèces -> ${paymentMode}) pour ${orderId}. Nouveau solde: ${updatedCaisse.balances[currency]}.`,
						[]
					);
				}
			}
			if (entity.devise) {
				currency = entity.devise;
			}
		} else {
			throw new Error(`Format d'ID non reconnu: ${orderId}`);
		}
		// Extract the new value from the form
		let newAccountingRequired = null;
		if (paymentMode === "Espèces" || paymentMode === "Mobile Money") {
			newAccountingRequired =
				values.accounting_required?.input_accounting_required?.selected_option
					?.value;
		}

		// Get the previous value from metadata (set this when opening the modal)
		const previousAccountingRequired =
			originalPayment.details?.accountingRequired;
		console.log("Previous accountingRequired:", previousAccountingRequired);
		console.log("New accountingRequired:", newAccountingRequired);
		let decaissementNumber;
		if (
			(previousAccountingRequired === true ||
				previousAccountingRequired === "yes") &&
			newAccountingRequired === "no"
		) {
			// Decrement the decaissement counter for the current period
			const year = paymentDate.getFullYear();
			const month = String(paymentDate.getMonth() + 1).padStart(2, "0");
			const periodId = `${year}${month}`;

			try {
				await DecaissementCounter.findOneAndUpdate(
					{ periodId },
					{ $inc: { sequence: -1 } }
				);
				console.log(`DecaissementCounter decremented for period ${periodId}`);
			} catch (error) {
				await notifyTechSlack(error);
				console.error(
					`Error decrementing decaissement counter: ${error.message}`
				);
			}
		} else if (
			(previousAccountingRequired === false ||
				previousAccountingRequired === "no") &&
			(newAccountingRequired === true || newAccountingRequired === "yes")
		) {
			// Increment the decaissement counter for the current period
			const year = paymentDate.getFullYear();
			const month = String(paymentDate.getMonth() + 1).padStart(2, "0");
			const periodId = `${year}${month}`;

			try {
				decaissementNumber = await generatePaymentNumber("decaissement");
				console.log("Generated decaissement number:", decaissementNumber);
			} catch (error) {
				await notifyTechSlack(error);
				console.error(
					`Error incrementing decaissement counter: ${error.message}`
				);
			}
		}
		// Prepare payment details based on mode
		let paymentDetails = {};
		if (paymentMode === "Chèque") {
			paymentDetails = {
				paymentNumber: originalPayment.details?.paymentNumber,
				cheque_number: values.cheque_number?.input_cheque_number?.value || "",
				cheque_bank:
					values.cheque_bank?.input_cheque_bank?.selected_option?.value || "",
				cheque_date: values.cheque_date?.input_cheque_date?.selected_date || "",
				cheque_order: values.cheque_order?.input_cheque_order?.value || "",
			};
		} else if (paymentMode === "Virement") {
			paymentDetails = {
				paymentNumber: originalPayment.details?.paymentNumber,

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
				paymentNumber: originalPayment.details?.paymentNumber,
				accountingRequired:
					newAccountingRequired === "yes" || newAccountingRequired === true,
				...(newAccountingRequired === "yes" || newAccountingRequired === true
					? {
							decaissementNumber:
								originalPayment.details?.decaissementNumber ||
								decaissementNumber ||
								"",
					  }
					: {}),
				mobilemoney_recipient_phone:
					values.mobilemoney_recipient_phone?.input_mobilemoney_recipient_phone
						?.value,
				mobilemoney_sender_phone:
					values.mobilemoney_sender_phone?.input_mobilemoney_sender_phone
						?.value,
				mobilemoney_date:
					values.mobilemoney_date?.input_mobilemoney_date?.selected_date,
			};
		} else if (paymentMode === "Julaya") {
			paymentDetails = {
				paymentNumber: originalPayment.details?.paymentNumber,

				julaya_recipient:
					values.julaya_recipient?.input_julaya_recipient?.value,
				julaya_date: values.julaya_date?.input_julaya_date?.selected_date,
				julaya_transaction_number:
					values.julaya_transaction_number?.input_julaya_transaction_number
						?.value,
			};
		} else if (paymentMode === "Espèces") {
			paymentDetails = {
				paymentNumber: originalPayment.details?.paymentNumber,
				accountingRequired:
					newAccountingRequired === "yes" || newAccountingRequired === true,
				...(newAccountingRequired === "yes" || newAccountingRequired === true
					? {
							decaissementNumber:
								originalPayment.details?.decaissementNumber ||
								decaissementNumber ||
								"",
					  }
					: {}),
			};
			console.log("details:", {
				paymentNumber: originalPayment.details?.paymentNumber,
				accountingRequired: originalPayment.details?.accountingRequired,
				decaissementNumber:
					originalPayment.details?.decaissementNumber ||
					decaissementNumber ||
					"",
			});
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
						process.env.SLACK_ADMIN_ID,
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
				let caisseQuery = {};
				if (selectedCaisseId) {
					caisseQuery = { _id: selectedCaisseId };
				} else if (targetChannelId) {
					caisseQuery = { channelId: targetChannelId };
				}
				const updatedCaisse = await Caisse.findOneAndUpdate(
					caisseQuery,
					caisseUpdate,
					{
						new: true,
					}
				).catch((err) => {
					console.error(`Error updating Caisse: ${err.message}`);
					throw new Error(`Failed to update Caisse: ${err.message}`);
				});
				console.log(
					`New caisse balance for ${currency}: ${updatedCaisse.balances[currency]}`
				);

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
			slackFinanceMessageTs: originalPayment?.slackFinanceMessageTs || null,
			slackAdminMessageTs: originalPayment?.slackAdminMessageTs || null,
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
			entity.amountPaid = totalAmountPaid;
			entity.remainingAmount = totalAmountDue - totalAmountPaid;
			entity.paymentDone = entity.remainingAmount <= 0;
			entity.payments.paymentStatus =
				entity.remainingAmount == 0 ? "Payé" : paymentStatus;

			console.log("$$ paymentStatus", paymentStatus);

			await entity.save();
			console.log(
				`Payment ${paymentIndex} updated in payment request ${orderId}`
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
			const isAdminChannel = Channel === process.env.SLACK_ADMIN_ID;

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
			let originalMessageTs;
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

				// Post the message
				originalMessageTs =
					entity.payments[paymentIndex]?.slackFinanceMessageTs;
				console.log(
					`Original message TS for payment ${paymentIndex}: ${originalMessageTs}`
				);
			}
			if (isAdminChannel) {
				originalMessageTs = entity.payments[paymentIndex]?.slackAdminMessageTs;
				console.log(
					`Original message TS for payment ${paymentIndex}: ${originalMessageTs}`
				);
			}
			if (originalMessageTs != null && originalMessageTs != undefined) {
				console.log(
					`Updating existing message in channel ${Channel} with ts ${originalMessageTs}`
				);
				// Update the existing message
				try {
					const response = await axios.post(
						"https://slack.com/api/chat.update",
						{
							channel: Channel,
							ts: originalMessageTs,
							text: `✅ Paiement modifié avec succès pour ${orderId}`,
							blocks,
						},
						{
							headers: {
								Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
								"Content-Type": "application/json",
							},
						}
					);
					if (!response.data.ok) {
						throw new Error(`Slack API error: ${response.data.error}`);
					}
					console.log(`Slack message updated in channel ${Channel}`);
				} catch (error) {
					console.error(`Error updating Slack message: ${error.message}`);
					throw error;
				}
			} else {
				console.log(
					`No existing message found in channel ${Channel}, posting new message`
				);
				// Fallback: post a new message if no ts is found
				await postSlackMessage(
					Channel,
					`✅ Paiement modifié avec succès pour ${orderId}`,
					blocks
				);
			}
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
				process.env.SLACK_ADMIN_ID,
				payload.user.id,
				`❌ Erreur lors de la modification du paiement: ${error.message}`
			);
		} catch (slackError) {
			console.error(`Error sending error notification: ${slackError}`);
		}

		throw error;
	}
}
module.exports = {
	handleFillFundingDetails,
	generateFundingApprovalPaymentModal,
	FinanceDetailsSubmission,
	handlePaymentMethodSelection,
	handlePaymentModificationSubmission,
};
