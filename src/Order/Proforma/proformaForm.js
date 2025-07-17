const { getFournisseurOptions } = require("../../Configurations/config");
const { Order } = require("../../Database/dbModels/Order");
const {
	createSlackResponse,
	postSlackMessage,
} = require("../../Common/slackUtils");
const { notifyTechSlack } = require("../../Common/notifyProblem");

async function proforma_form(payload, context) {
	console.log("** proforma_form");
	const orderId = payload.actions[0].value; // Extract order ID from the button
	console.log("payloadmmm", payload);
	const msgts = payload.container.message_ts;
	console.log("msgtsmm", msgts);
	//  context.log(`Opening proforma form for order: ${orderId}`);
	// Fetch the order from the database
	const order = await Order.findOne({ id_commande: orderId });
	if (!order) {
		console.log(`❌ Order not found: ${orderId}`);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "Erreur : Commande non trouvée.",
		});
	}

	// Check the number of proformas (assuming proformas is an array in the order document)
	const proformaCount = order.proformas ? order.proformas.length : 0;
	console.log(`Order ${orderId} has ${proformaCount} proformas`);
	// Check if any proforma is validated by admin
	const hasValidatedProforma =
		order.proformas && order.proformas.some((proforma) => proforma.validated);
	console.log(
		`Order ${orderId} has validated proforma: ${hasValidatedProforma}`
	);
	if (proformaCount >= 5) {
		console.log(`❌ Proforma limit reached for order: ${orderId}`);
		return await postSlackMessage(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ACHAT_CHANNEL_ID,
				text: "❌ Limite atteinte : Vous ne pouvez pas ajouter plus de 5 proformas à cette commande.",
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
	if (hasValidatedProforma) {
		console.log(
			`❌ Admin has already validated a proforma for order: ${orderId}`
		);

		return await postSlackMessage(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ACHAT_CHANNEL_ID,
				text: "⚠️ Une proforma a déjà été validé par l'admin pour cette commande.",
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
	// Get fournisseur options with error handling
	let FOURNISSEUR_OPTIONS;
	try {
		FOURNISSEUR_OPTIONS = await getFournisseurOptions();
		console.log("Fournisseur options loaded:", FOURNISSEUR_OPTIONS.length);
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error loading fournisseur options:", error);
		// Provide default options if database fetch fails
		FOURNISSEUR_OPTIONS = [
			{
				text: { type: "plain_text", text: "Fournisseur A" },
				value: "fournisseur_a",
			},
			{
				text: { type: "plain_text", text: "Fournisseur B" },
				value: "fournisseur_b",
			},
			{
				text: { type: "plain_text", text: "Fournisseur C" },
				value: "fournisseur_c",
			},
			{ text: { type: "plain_text", text: "Autre" }, value: "autre" },
		];
	}

	// Ensure we have at least one option
	if (!FOURNISSEUR_OPTIONS || FOURNISSEUR_OPTIONS.length === 0) {
		FOURNISSEUR_OPTIONS = [
			{
				text: { type: "plain_text", text: "Fournisseur par défaut" },
				value: "default",
			},
		];
	}
	// Define the modal view with both file upload and URL input
	const modalView = {
		type: "modal",
		callback_id: "proforma_submission",
		title: {
			type: "plain_text",
			text: "Ajouter des Proformas",
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
		blocks: [
			{
				type: "input",
				block_id: "proforma_designation",
				element: {
					type: "plain_text_input",
					action_id: "designation_input",
					placeholder: {
						type: "plain_text",
						text: "N° proforma fournisseur ou autre.",
					},
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
					initial_option: FOURNISSEUR_OPTIONS[0], // Set default option
				},
				label: {
					type: "plain_text",
					text: "Fournisseur",
				},
			},
			{
				type: "input",
				block_id: `proforma_amount`,
				label: { type: "plain_text", text: "💰 Montant" },
				element: {
					type: "plain_text_input",
					action_id: `input_proforma_amount`,
					placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
				},
				hint: {
					type: "plain_text",
					text: "Entrez un montant suivi de la devise (XOF, USD, EUR)",
				},
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Choisissez une option:* Télécharger des fichiers ou saisir l'URL de la proforma",
				},
			},
			{
				type: "input",
				block_id: `proforma_file`,
				optional: true,
				label: {
					type: "plain_text",
					text: `📎 Fichier(s) Proforma`,
				},
				element: {
					type: "file_input",
					action_id: `file_upload`,
					filetypes: ["pdf", "jpg", "png"],
					max_files: 5,
				},
			},
			{
				type: "input",
				block_id: `proforma_url`,
				optional: true,
				label: {
					type: "plain_text",
					text: `🔗 URL Proforma`,
				},
				element: {
					type: "plain_text_input",
					action_id: `input_proforma_url`,
					placeholder: { type: "plain_text", text: "https://..." },
				},
			},
		],
		private_metadata: JSON.stringify({ orderId, msgts: msgts }), // Pass orderId to submission handler
	};

	try {
		const response = await postSlackMessage(
			"https://slack.com/api/views.open",
			{
				trigger_id: payload.trigger_id,
				view: modalView,
			},
			process.env.SLACK_BOT_TOKEN
		);

		if (!response.ok) {
			//  context.log(`❌ views.open failed: ${response.error}`);
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: `Erreur: ${response.error}`,
			});
		}

		//  context.log("Proforma form with file upload and URL input opened successfully");
		return {
			statusCode: 200,
			headers: { "Content-Type": "application/json" },
			body: "",
		};
	} catch (error) {
		await notifyTechSlack(error);

		return {
			statusCode: 500,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				response_type: "ephemeral",
				text: "Erreur lors de l'ouverture du formulaire.",
			}),
		};
	}
}
module.exports = {
	proforma_form,
};
