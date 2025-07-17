const { Order } = require("../../Database/dbModels/Order");
const {
	postSlackMessage,
	postSlackMessageWithRetry,
} = require("../../Common/slackUtils");
const { notifyAdminProforma } = require("./proformaNotificationService");
const { getFournisseurOptions } = require("../../Configurations/config");
const { notifyTechSlack } = require("../../Common/notifyProblem");

//* ??
async function handleEditProforma(payload, context) {
	console.log("** handleEditProforma");
	try {
		// Extract data from the button value
		const { orderId, proformaIndex } = JSON.parse(payload.actions[0].value);
		console.log("payload@@@", payload);
		const msgts = payload.container.message_ts;
		console.log("msgts", msgts);
		// Fetch the order
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

		const proforma = order.proformas[proformaIndex];
		// Check if any proforma in the order is already validated
		const hasValidatedProforma = order.proformas.some((p) => p.validated);
		if (hasValidatedProforma) {
			// Post Slack message to the designated channel
			const slackResponse = await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ACHAT_CHANNEL_ID,
					text: "⚠️ Une proforma a été validée.",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return {
				text: "⚠️ Une proforma a été validée.",
				replace_original: false,
				response_type: "ephemeral",
			};
		} else {
			// Create blocks for the existing URLs
			const urlBlocks = [];
			// Get fournisseur options
			const FOURNISSEUR_OPTIONS = await getFournisseurOptions();
			const currentFournisseur = proforma.fournisseur || "";

			let initialFournisseurOption = FOURNISSEUR_OPTIONS[0]; // default

			// Try to match the current fournisseur value
			const matchingOption = FOURNISSEUR_OPTIONS.find(
				(option) =>
					option.text.text === currentFournisseur ||
					option.value === currentFournisseur.toLowerCase().replace(/\s+/g, "_")
			);

			if (matchingOption) {
				initialFournisseurOption = matchingOption;
			}
			// Add header for existing files/URLs section if there are any
			if (proforma.urls && proforma.urls.length > 0) {
				urlBlocks.push({
					type: "section",
					block_id: "existing_urls_header",
					text: {
						type: "mrkdwn",
						text: "*Pages/URLs existantes:*",
					},
				});

				// Add each existing URL as a separate input field
				proforma.urls.forEach((url, index) => {
					urlBlocks.push({
						type: "input",
						block_id: `existing_url_${index}`,
						optional: true,
						label: {
							type: "plain_text",
							text: `🔗 Page ${index + 1}`,
						},
						element: {
							type: "plain_text_input",
							action_id: `edit_url_${index}`,
							initial_value: url,
						},
					});
				});

				// Add divider after existing URLs
				urlBlocks.push({
					type: "divider",
				});
			}

			// Create the edit form with pre-filled values
			const modalView = {
				type: "modal",
				callback_id: "edit_proforma_submission",
				title: {
					type: "plain_text",
					text: "Modifier la Proforma",
					emoji: true,
				},
				submit: {
					type: "plain_text",
					text: "Mettre à jour",
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
						block_id: "proforma_designation",
						element: {
							type: "plain_text_input",
							action_id: "designation_input",
							initial_value: proforma.nom || "",
						},
						label: {
							type: "plain_text",
							text: "Référence",
						},
					},
					{
						type: "input",
						block_id: "proforma_fournisseur",
						optional: false,
						element: {
							type: "static_select",
							action_id: "fournisseur_input",
							options: FOURNISSEUR_OPTIONS,
							initial_option: initialFournisseurOption,
						},
						label: {
							type: "plain_text",
							text: "Fournisseur",
						},
					},
					{
						type: "input",
						block_id: "proforma_amount",
						label: { type: "plain_text", text: "💰 Montant" },
						element: {
							type: "plain_text_input",
							action_id: "input_proforma_amount",
							initial_value: `${proforma.montant} ${proforma.devise}`,
							placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
						},
						hint: {
							type: "plain_text",
							text: "Entrez un montant suivi de la devise (XOF, USD, EUR)",
						},
					},
					// Add the existing URLs blocks
					...urlBlocks,
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: " Télécharger de nouveaux fichiers ou ajouter de nouvelles URLs",
						},
					},
					{
						type: "input",
						block_id: "proforma_file",
						optional: true,
						label: {
							type: "plain_text",
							text: "📎 Nouveaux fichiers",
						},
						element: {
							type: "file_input",
							action_id: "file_upload",
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
						block_id: "new_proforma_url",
						optional: true,
						label: {
							type: "plain_text",
							text: "🔗 Nouvelle URL",
						},
						element: {
							type: "plain_text_input",
							action_id: "input_new_proforma_url",
							placeholder: { type: "plain_text", text: "https://..." },
						},
						hint: {
							type: "plain_text",
							text: "Ajouter une nouvelle URL à cette proforma.",
						},
					},
					{
						type: "input",
						block_id: "keep_existing_files",
						optional: true,
						label: {
							type: "plain_text",
							text: "Conservation des fichiers existants",
						},
						element: {
							type: "checkboxes",
							action_id: "input_keep_existing",
							initial_options: [
								{
									text: {
										type: "plain_text",
										text: "Conserver les fichiers/URLs existants",
									},
									value: "keep",
								},
							],
							options: [
								{
									text: {
										type: "plain_text",
										text: "Conserver les fichiers/URLs existants",
									},
									value: "keep",
								},
							],
						},
					},
				],
				private_metadata: JSON.stringify({
					orderId,
					proformaIndex,
					existingUrls: proforma.urls || [],
					existingFileIds: proforma.file_ids || [],
					msgts: msgts, // Store the message timestamp for updates
				}),
			};

			const response = await postSlackMessageWithRetry(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: modalView,
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!response.ok) {
				throw new Error(`Failed to open edit form: ${response.error}`);
			}
		}

		return { text: "Chargement du formulaire de modification..." };
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`Error in handleEditProforma: ${error.message}`);
		return {
			text: `❌ Erreur lors de l'ouverture du formulaire: ${error.message}`,
			replace_original: false,
			response_type: "ephemeral",
		};
	}
}
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
		await notifyTechSlack(error);

		context.log(`Error in handleEditProformaSubmission: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				proforma_amount: error.message,
			},
		};
	}
}
module.exports = {
	handleEditProformaSubmission,
	handleEditProforma,
};
