//src/form.js
const { postSlackMessage, createSlackResponse } = require("./utils");
const { getFileInfo } = require("./utils");
const { Order } = require("./db"); // Import Order model
const {
	getEquipeOptions,
	getUnitOptions,
	getCurrencies,
	getFournisseurOptions,
} = require("./config");

const UNIT_OPTIONS = [
	{ text: { type: "plain_text", text: "Pièce" }, value: "piece" },
	{ text: { type: "plain_text", text: "m²" }, value: "m2" },
	{ text: { type: "plain_text", text: "Pots" }, value: "pots" },
	{ text: { type: "plain_text", text: "Rouleaux" }, value: "rouleaux" },
	{ text: { type: "plain_text", text: "Cartons" }, value: "cartons" },
	{ text: { type: "plain_text", text: "Sac" }, value: "sac" },
	{ text: { type: "plain_text", text: "kg" }, value: "kg" },
	{ text: { type: "plain_text", text: "Bottes" }, value: "bottes" },
	{ text: { type: "plain_text", text: "Tonnes" }, value: "tonnes" },
];
const DEFAULT_EQUIPE_OPTIONS = [
	{ text: { type: "plain_text", text: "Maçons" }, value: "macons" },
	{ text: { type: "plain_text", text: "Carreleur" }, value: "carreleur" },
	{ text: { type: "plain_text", text: "Peintre" }, value: "peintre" },
	{ text: { type: "plain_text", text: "Coffreur" }, value: "coffreur" },
];

async function generateOrderForm(
	proformas = [],
	suggestions = {},
	formData = {}
) {
	console.log("** generateOrderForm");
	const today = new Date().toISOString().split("T")[0];

	console.log("Form data reçu:", JSON.stringify(formData, null, 2));
	console.log("Suggestions reçu:", JSON.stringify(suggestions, null, 2));
	console.log("Proformas reçu:", JSON.stringify(proformas, null, 2));
	// Get dynamic options from database
	const EQUIPE_OPTIONS = await getEquipeOptions();
	const UNIT_OPTIONS = await getUnitOptions();
	const FOURNISSEUR_OPTIONS = await getFournisseurOptions(); // Add this line
	console.log("Fournisseur options:", FOURNISSEUR_OPTIONS);

	const blocks = [
		{
			type: "input",
			block_id: "request_title",
			label: { type: "plain_text", text: "📝 Titre de la commande" },
			element: {
				type: "plain_text_input",
				action_id: "input_request_title",

				initial_value: formData.request_title?.input_request_title?.value || "",
			},
		},
		{
			type: "input",
			block_id: "equipe_selection",
			label: { type: "plain_text", text: "Équipe" },
			element: {
				type: "static_select",
				action_id: "select_equipe",
				options: EQUIPE_OPTIONS,
				initial_option: (() => {
					const storedEquipe =
						formData.equipe_selection?.select_equipe?.selected_option?.value;
					if (storedEquipe) {
						const matchingOption = EQUIPE_OPTIONS.find(
							(opt) => opt.value === storedEquipe
						);
						return matchingOption || EQUIPE_OPTIONS[0];
					}
					return EQUIPE_OPTIONS[0];
				})(),
			},
		},
		{
			type: "input",
			block_id: "request_date",
			label: { type: "plain_text", text: "Date de la requête" },
			element: {
				type: "datepicker",
				action_id: "input_request_date",
				initial_date:
					formData.request_date?.input_request_date?.selected_date || today,
			},
			hint: {
				type: "plain_text",
				text: "La date doit être aujourd'hui ou une date dans le futur.",
			},
		},
		// {
		//     type: "input",
		//     block_id: "product_photos",
		//     optional: true,
		//     label: {
		//         type: "plain_text",
		//         text: "Photos des produits recherchés",
		//     },
		//     element: {
		//         type: "file_input",
		//         action_id: "input_product_photos",
		//         filetypes: ["jpg", "jpeg", "png", "gif", "webp"],
		//         max_files: 10,
		//     },
		//     hint: {
		//         type: "plain_text",
		//         text: "Ajoutez des photos pour aider à identifier les produits que vous recherchez (max 10 fichiers).",
		//     },
		// },
		{
			type: "actions",
			block_id: "add_proforma_1",
			elements: [
				{
					type: "button",
					action_id: "add_proforma_1",
					text: { type: "plain_text", text: "📎 Ajouter des proformas" },
					value: "add_proforma_1",
				},
			],
		},
		{ type: "divider" },
	];

	// Add existing proformas if available
	if (proformas && proformas.length > 0) {
		blocks.push({
			type: "section",
			block_id: "existing_proformas",
			text: {
				type: "mrkdwn",
				text: "*Proformas existants:*",
			},
		});

		// Add each proforma as a section with a "Remove" button
		proformas.forEach((proforma, index) => {
			blocks.push({
				type: "section",
				block_id: `proforma_item_${index}`,
				text: {
					type: "mrkdwn",
					text: `*${proforma.nom || "Proforma"}*\n${
						proforma.montant
							? `Montant: ${proforma.montant} ${proforma.devise || ""}`
							: "Montant non spécifié"
					}`,
				},
				accessory: {
					type: "overflow",
					action_id: `proforma_options_${index}`,
					options: [
						{
							text: { type: "plain_text", text: "Supprimer" },
							value: `remove_proforma_${index}`,
						},
					],
				},
			});
		});

		blocks.push({ type: "divider" });
	}

	let articleIndex = 1;
	const hasArticlesInFormData = Object.keys(formData).some((key) =>
		key.startsWith("quantity_number_")
	);

	if (
		!hasArticlesInFormData &&
		(!suggestions.designations || suggestions.designations.length === 0)
	) {
		// Add a default empty article if none exist
		blocks.push(
			{
				type: "section",
				block_id: `article_group_1`,
				text: { type: "mrkdwn", text: `*Article 1*` },
			},
			{
				type: "input",
				block_id: `designation_1`,
				label: { type: "plain_text", text: "Désignation" },
				element: {
					type: "plain_text_input",
					action_id: `input_designation_1`,
					initial_value: "",
				},
			},
			{
				type: "input",
				block_id: `quantity_number_1`,
				label: { type: "plain_text", text: "Quantité" },
				element: {
					type: "number_input",
					is_decimal_allowed: false,
					action_id: `input_quantity_1`,
					min_value: "0",
					// initial_value: "1",
				},
			},
			{
				type: "input",
				block_id: `quantity_unit_1`,
				label: { type: "plain_text", text: "Unité" },
				element: {
					type: "static_select",
					action_id: `select_unit_1`,
					options: UNIT_OPTIONS,
					initial_option: UNIT_OPTIONS[0],
				},
			},
			{
				type: "input",
				block_id: `article_photos_1`,
				optional: true,
				label: {
					type: "plain_text",
					text: "Photos de l'article",
				},
				element: {
					type: "file_input",
					action_id: `input_article_photos_1`,
					filetypes: ["jpg", "jpeg", "png", "gif", "webp"],
					max_files: 5,
				},
				hint: {
					type: "plain_text",
					text: "Ajoutez des photos pour aider à identifier cet article (max 5 fichiers).",
				},
			}
		);
	} else {
		// Process existing articles from formData
		while (
			formData[`quantity_number_${articleIndex}`] ||
			(articleIndex === 1 &&
				suggestions.designations &&
				suggestions.designations.length > 0)
		) {
			blocks.push(
				{
					type: "section",
					block_id: `article_${articleIndex}`,
					text: { type: "mrkdwn", text: `*Article ${articleIndex}*` },
					accessory:
						articleIndex > 1
							? {
									// Add "Remove" button for articles beyond the first
									type: "button",
									action_id: `remove_article_${articleIndex}`,
									text: { type: "plain_text", text: "Supprimer" },
									value: `remove_article_${articleIndex}`,
									style: "danger",
							  }
							: undefined,
				},
				{
					type: "input",
					block_id: `designation_${articleIndex}`,
					label: { type: "plain_text", text: "Désignation" },
					element: {
						type: "plain_text_input",
						action_id: `input_designation_${articleIndex}`,

						placeholder: {
							type: "plain_text",
							text:
								suggestions.designations?.[articleIndex - 1] ||
								"Entrez la désignation",
						},
						initial_value:
							formData[`designation_${articleIndex}`]?.[
								`input_designation_${articleIndex}`
							]?.value || "",
					},
				},
				{
					type: "input",
					block_id: `quantity_number_${articleIndex}`,
					label: { type: "plain_text", text: "Quantité" },
					element: {
						type: "number_input",
						is_decimal_allowed: false,
						action_id: `input_quantity_${articleIndex}`,
						min_value: "0",
						initial_value:
							formData[`quantity_number_${articleIndex}`]?.[
								`input_quantity_${articleIndex}`
							]?.value || "0",
					},
				}
			);

			// Ensure unit matches an option from UNIT_OPTIONS
			let unitInitialOption;
			const selectedUnitValue =
				formData[`quantity_unit_${articleIndex}`]?.[
					`select_unit_${articleIndex}`
				]?.selected_option?.value;
			if (selectedUnitValue) {
				unitInitialOption =
					UNIT_OPTIONS.find((opt) => opt.value === selectedUnitValue) ||
					UNIT_OPTIONS[0];
			} else {
				unitInitialOption = UNIT_OPTIONS[0];
			}

			blocks.push({
				type: "input",
				block_id: `quantity_unit_${articleIndex}`,
				label: { type: "plain_text", text: "Unité" },
				element: {
					type: "static_select",
					action_id: `select_unit_${articleIndex}`,
					options: UNIT_OPTIONS,
					initial_option: unitInitialOption,
				},
			});
			// Add photo upload for each article
			blocks.push({
				type: "input",
				block_id: `article_photos_${articleIndex}`,
				optional: true,
				label: {
					type: "plain_text",
					text: "Photos de l'article",
				},
				element: {
					type: "file_input",
					action_id: `input_article_photos_${articleIndex}`,
					filetypes: ["jpg", "jpeg", "png", "gif", "webp"],
					max_files: 5,
				},
				hint: {
					type: "plain_text",
					text: "Ajoutez des photos pour aider à identifier cet article (max 5 fichiers).",
				},
			});
			articleIndex++;
		}
	}

	blocks.push({
		type: "actions",
		block_id: "add_article",
		elements: [
			{
				type: "button",
				action_id: "add_article",
				text: { type: "plain_text", text: "➕ Ajouter un autre article" },
				value: "add_article",
			},
		],
	});

	const view = {
		type: "modal",
		callback_id: "order_form_submission",
		title: { type: "plain_text", text: "Formulaire Commande" },
		submit: { type: "plain_text", text: "Enregistrer" },
		close: { type: "plain_text", text: "Annuler" },
		blocks,
	};

	console.log("Generated view blocks count:", view.blocks.length);
	return view;
}

function generateArticleBlocks(index) {
	console.log("** generateArticleBlocks");
	return [
		{ type: "divider", block_id: `divider_${index}` },
		{
			type: "section",
			block_id: `article_${index}`,
			text: { type: "mrkdwn", text: `*Article ${index}*` },
		},
		{
			type: "input",
			block_id: `designation_${index}`,
			label: { type: "plain_text", text: "Désignation" },
			element: {
				type: "plain_text_input",

				action_id: `input_designation_${index}`,
			},
		},
		{
			type: "input",
			block_id: `quantity_number_${index}`,
			label: { type: "plain_text", text: "Quantité" },
			element: {
				type: "number_input",
				is_decimal_allowed: false,
				action_id: `input_quantity_${index}`,

				min_value: "0",
			},
		},
		{
			type: "input",
			block_id: `quantity_unit_${index}`,
			label: { type: "plain_text", text: "Unité" },
			element: {
				type: "static_select",
				action_id: `select_unit_${index}`,
				options: UNIT_OPTIONS,
				initial_option: UNIT_OPTIONS[0], // Default to "Pièce"
			},
		},
		{
			type: "input",
			block_id: `article_photos_${index}`,
			optional: true,
			label: {
				type: "plain_text",
				text: "Photos de l'article",
			},
			element: {
				type: "file_input",
				action_id: `input_article_photos_${index}`,
				filetypes: ["jpg", "jpeg", "png", "gif", "webp"],
				max_files: 5,
			},
			hint: {
				type: "plain_text",
				text: "Ajoutez des photos pour aider à identifier cet article (max 5 fichiers).",
			},
		},
		{
			type: "actions",
			block_id: `add_proforma_${index}`,
			elements: [
				{
					type: "button",
					action_id: `remove_article_${index}`,
					text: { type: "plain_text", text: "🗑️ Supprimer l'article" },
					value: `remove_article_${index}`,
					style: "danger", // Make the button red to indicate a destructive action
				},
			],
		},
	];
	blocks.push({
		type: "actions",
		block_id: "add_article",
		elements: [
			{
				type: "button",
				action_id: "add_article",
				text: { type: "plain_text", text: "➕ Ajouter un autre article" },
				value: "add_article",
			},
		],
	});
}

// Define valid currencies
const VALID_CURRENCIES = ["XOF", "USD", "EUR"];

// Modify your existing proforma amount input block to include validation
function generateProformaBlocks(index) {
	return [
		{
			type: "actions",
			block_id: `cancel_proforma_${index}`,
			elements: [
				{
					type: "button",
					action_id: `cancel_proforma_${index}`,
					text: { type: "plain_text", text: "❌ Annuler la proforma" },
					value: `cancel_proforma_${index}`,
				},
			],
		},
		{
			type: "input",
			block_id: `proforma_file`,
			optional: true,
			label: {
				type: "plain_text",
				text: `📎 Proforma(s)`,
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
		{
			type: "input",
			block_id: `proforma_amount`,
			label: { type: "plain_text", text: "💰 Montant" },
			element: {
				type: "plain_text_input",
				action_id: `input_proforma_amount`,
				placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
				focus_on_load: true,
			},
			hint: {
				type: "plain_text",
				text: "Entrez un montant suivi de la devise (XOF, USD, EUR)",
			},
		},
	];
}

const bankOptions = [
	{ text: { type: "plain_text", text: "AFGBANK CI" }, value: "AFGBANK_CI" },
	{
		text: { type: "plain_text", text: "AFRILAND FIRST BANK CI" },
		value: "AFRILAND_FIRST_BANK_CI",
	},
	{
		text: { type: "plain_text", text: "BOA - CÔTE D’IVOIRE" },
		value: "BOA_CI",
	},
	{
		text: { type: "plain_text", text: "BANQUE ATLANTIQUE CI (BACI)" },
		value: "BACI",
	},
	{
		text: { type: "plain_text", text: "BANQUE D’ABIDJAN" },
		value: "BANQUE_D_ABIDDAJAN",
	},
	{ text: { type: "plain_text", text: "BHCI" }, value: "BHCI" },
	{ text: { type: "plain_text", text: "BDU-CI" }, value: "BDU_CI" },
	{ text: { type: "plain_text", text: "BICICI" }, value: "BICICI" }, // Shortened from "BANQUE INTERNATIONALE POUR LE COMMERCE ET L’INDUSTRIE DE LA CÔTE D’IVOIRE"
	{ text: { type: "plain_text", text: "BNI" }, value: "BNI" },
	{
		text: { type: "plain_text", text: "BANQUE POPULAIRE CI" },
		value: "BANQUE_POPULAIRE",
	},
	{
		text: { type: "plain_text", text: "BSIC - CÔTE D’IVOIRE" },
		value: "BSIC_CI",
	}, // Shortened from "BANQUE SAHÉLO-SAHARIENNE POUR L’INVESTISSEMENT ET LE COMMERCE - CÔTE D’IVOIRE"
	{ text: { type: "plain_text", text: "BGFIBANK-CI" }, value: "BGFIBANK_CI" },
	{
		text: { type: "plain_text", text: "BRIDGE BANK GROUP CI" },
		value: "BBG_CI",
	},
	{ text: { type: "plain_text", text: "CITIBANK CI" }, value: "CITIBANK_CI" },
	{ text: { type: "plain_text", text: "CORIS BANK INTL CI" }, value: "CBI_CI" },
	{ text: { type: "plain_text", text: "ECOBANK CI" }, value: "ECOBANK_CI" },
	{ text: { type: "plain_text", text: "GTBANK-CI" }, value: "GTBANK_CI" },
	{ text: { type: "plain_text", text: "MANSA BANK" }, value: "MANSA_BANK" },
	{
		text: { type: "plain_text", text: "NSIA BANQUE CI" },
		value: "NSIA_BANQUE_CI",
	},
	{ text: { type: "plain_text", text: "ORABANK CI" }, value: "ORABANK_CI" },
	{
		text: { type: "plain_text", text: "ORANGE BANK AFRICA" },
		value: "ORANGE_BANK",
	},
	{
		text: { type: "plain_text", text: "SOCIETE GENERALE CI" },
		value: "SOCIETE_GENERALE_CI",
	},
	{ text: { type: "plain_text", text: "SIB" }, value: "SIB" },
	{ text: { type: "plain_text", text: "STANBIC BANK" }, value: "STANBIC_BANK" },
	{
		text: { type: "plain_text", text: "STANDARD CHARTERED CI" },
		value: "STANDARD_CHARTERED_CI",
	},
	{ text: { type: "plain_text", text: "UBA" }, value: "UBA" },
	{ text: { type: "plain_text", text: "VERSUS BANK" }, value: "VERSUS_BANK" },
	{ text: { type: "plain_text", text: "BMS CI" }, value: "BMS_CI" },
	{ text: { type: "plain_text", text: "BRM CI" }, value: "BRM_CI" },
	{ text: { type: "plain_text", text: "Autre" }, value: "Autre" },
];
async function generatePaymentForm({
	payload,
	action,
	context,
	selectedPaymentMode,
	orderId,
}) {
	console.log("** ''generatePaymentForm");
	context.log("Opening payment modal for order:", action.value);
	context.log("Génération du formulaire pour le mode:", selectedPaymentMode);

	// Parse private_metadata if available (for updates from modal)
	const privateMetadata = payload.view
		? JSON.parse(payload.view.private_metadata || "{}")
		: {};
	const effectiveOrderId = orderId || privateMetadata.orderId || action.value;
	const originalChannel =
		privateMetadata.originalChannel || (payload.channel && payload.channel.id);

	// Determine payment method code
	const validPaymentMethods = [
		"Espèces",
		"Chèque",
		"Virement",
		"Mobile Money",
		"Julaya",
	];
	let paymentMethod = selectedPaymentMode || "Espèces"; // Default

	// Normalize the method to a valid system code
	const getPaymentMethodDisplayText = (method) => {
		const methodMap = {
			Espèces: "Espèces",
			Chèque: "Chèque",
			Virement: "Virement",
			"Mobile Money": "Mobile Money",
			Julaya: "Julaya",
		};
		return methodMap[method] || method;
	};
	const baseBlocks = [
		{
			type: "input",
			block_id: "payment_mode",
			label: { type: "plain_text", text: "Mode de paiement" },
			element: {
				type: "static_select",
				action_id: "select_payment_mode",
				options: [
					{ text: { type: "plain_text", text: "Espèces" }, value: "Espèces" },
					{ text: { type: "plain_text", text: "Chèque" }, value: "Chèque" },
					{ text: { type: "plain_text", text: "Virement" }, value: "Virement" },
					{
						text: { type: "plain_text", text: "Mobile Money" },
						value: "Mobile Money",
					},
					{ text: { type: "plain_text", text: "Julaya" }, value: "Julaya" },
				],
				...(selectedPaymentMode && {
					initial_option: {
						text: { type: "plain_text", text: selectedPaymentMode },
						value: selectedPaymentMode,
					},
				}),
			},
			dispatch_action: true, // Enable block_actions event on selection
		},

		// {
		// 	type: "actions",
		// 	block_id: "confirm_payment_mode",
		// 	elements: [
		// 		{
		// 			type: "button",
		// 			action_id: "confirm_payment_mode",
		// 			text: { type: "plain_text", text: "Ajouter les détails " },
		// 			value: "confirm_payment_mode",
		// 		},
		// 	],
		// },

		{
			type: "input",
			block_id: "payment_proof_unique",
			optional: true,
			label: {
				type: "plain_text",
				text: "📎 Justificatif de paiement ",
			},
			element: {
				type: "file_input",
				action_id: "input_payment_proof",
				filetypes: ["pdf", "png", "jpg", "jpeg"],
				max_files: 5,
			},
		},
		{
			type: "input",
			block_id: "paiement_url",
			optional: true,
			label: { type: "plain_text", text: "🔗 URL paiement" },
			element: {
				type: "plain_text_input",
				action_id: "input_paiement_url",
				placeholder: { type: "plain_text", text: "https://..." },
			},
		},
		{
			type: "input",
			block_id: "payment_title",
			label: { type: "plain_text", text: "Intitulé du paiement" },
			element: {
				type: "plain_text_input",
				action_id: "input_payment_title",
				// initial_value: "Acompte 1",
			},
		},
		{
			type: "input",
			block_id: "amount_paid",
			label: { type: "plain_text", text: "Montant payé" },
			element: {
				type: "number_input",
				action_id: "input_amount_paid",
				is_decimal_allowed: true,
				min_value: "0",
			},
		},
	];
	// Payment method specific blocks
	const getPaymentMethodBlocks = (method) => {
		if (method === "Chèque") {
			return [
				{ type: "divider" },

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
					element: {
						type: "plain_text_input",
						action_id: "input_cheque_order",
					},
				},
			];
		} else if (method === "Virement") {
			return [
				{ type: "divider" },
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
				},
			];
		} else if (method === "Mobile Money") {
			return [
				{ type: "divider" },
				{
					type: "input",
					block_id: "mobilemoney_recipient_phone",
					label: {
						type: "plain_text",
						text: "Numéro de téléphone bénéficiaire",
					},
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
					block_id: "mobilemoney_date",
					label: { type: "plain_text", text: "Date" },
					element: { type: "datepicker", action_id: "input_mobilemoney_date" },
				},
			];
		} else if (method === "Julaya") {
			return [
				{ type: "divider" },
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
				},
			];
		}
		return [];
	};
	// // Add dynamic fields based on selected payment mode
	// if (selectedPaymentMode === "Chèque") {
	// 	blocks.push(
	// 		{ type: "divider" },

	// 		{
	// 			type: "input",
	// 			block_id: "cheque_number",
	// 			label: { type: "plain_text", text: "Numéro du chèque" },
	// 			element: {
	// 				action_id: "input_cheque_number",
	// 				type: "number_input",
	// 				is_decimal_allowed: true,
	// 				min_value: "0",
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "cheque_bank",
	// 			label: { type: "plain_text", text: "Banque" },
	// 			element: {
	// 				type: "static_select",
	// 				action_id: "input_cheque_bank",
	// 				options: bankOptions,
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "cheque_date",
	// 			label: { type: "plain_text", text: "Date du chèque" },
	// 			element: { type: "datepicker", action_id: "input_cheque_date" },
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "cheque_order",
	// 			label: { type: "plain_text", text: "Ordre" },
	// 			element: { type: "plain_text_input", action_id: "input_cheque_order" },
	// 		}
	// 	);
	// } else if (selectedPaymentMode === "Virement") {
	// 	blocks.push(
	// 		{ type: "divider" },
	// 		{
	// 			type: "input",
	// 			block_id: "virement_number",
	// 			label: { type: "plain_text", text: "Numéro de virement" },
	// 			element: {
	// 				type: "number_input",
	// 				is_decimal_allowed: true,
	// 				min_value: "0",
	// 				action_id: "input_virement_number",
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "virement_bank",
	// 			label: { type: "plain_text", text: "Banque" },
	// 			element: {
	// 				type: "static_select",
	// 				action_id: "input_virement_bank",
	// 				options: bankOptions,
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "virement_date",
	// 			label: { type: "plain_text", text: "Date" },
	// 			element: { type: "datepicker", action_id: "input_virement_date" },
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "virement_order",
	// 			label: { type: "plain_text", text: "Ordre" },
	// 			element: {
	// 				type: "plain_text_input",
	// 				action_id: "input_virement_order",
	// 			},
	// 		}
	// 	);
	// } else if (selectedPaymentMode === "Mobile Money") {
	// 	blocks.push(
	// 		{ type: "divider" },
	// 		{
	// 			type: "input",
	// 			block_id: "mobilemoney_recipient_phone",
	// 			label: { type: "plain_text", text: "Numéro de téléphone bénéficiaire" },
	// 			element: {
	// 				type: "number_input",
	// 				is_decimal_allowed: true,
	// 				min_value: "0",
	// 				action_id: "input_mobilemoney_recipient_phone",
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "mobilemoney_sender_phone",
	// 			label: { type: "plain_text", text: "Numéro envoyeur" },
	// 			element: {
	// 				type: "number_input",
	// 				is_decimal_allowed: true,
	// 				min_value: "0",
	// 				action_id: "input_mobilemoney_sender_phone",
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "mobilemoney_date",
	// 			label: { type: "plain_text", text: "Date" },
	// 			element: { type: "datepicker", action_id: "input_mobilemoney_date" },
	// 		}
	// 	);
	// } else if (selectedPaymentMode === "Julaya") {
	// 	blocks.push(
	// 		{ type: "divider" },
	// 		{
	// 			type: "input",
	// 			block_id: "julaya_recipient",
	// 			label: { type: "plain_text", text: "Bénéficiaire" },
	// 			element: {
	// 				type: "plain_text_input",
	// 				action_id: "input_julaya_recipient",
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "julaya_date",
	// 			label: { type: "plain_text", text: "Date" },
	// 			element: { type: "datepicker", action_id: "input_julaya_date" },
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "julaya_transaction_number",
	// 			label: { type: "plain_text", text: "Numéro de transaction" },
	// 			element: {
	// 				type: "number_input",
	// 				is_decimal_allowed: true,
	// 				min_value: "0",
	// 				action_id: "input_julaya_transaction_number",
	// 			},
	// 		}
	// 	);
	// }
	// Get payment method specific blocks
	const paymentMethodBlocks = getPaymentMethodBlocks(selectedPaymentMode);
	// Combine all blocks
	let blocks = [...baseBlocks, ...paymentMethodBlocks];

	const view = {
		type: "modal",
		callback_id: "payment_form_submission",
		title: { type: "plain_text", text: "Formulaire Paiement" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: blocks,
		private_metadata: JSON.stringify({
			orderId: effectiveOrderId,
			originalChannel: originalChannel,
		}),
	};

	// context.log("Final view structure:", JSON.stringify(view, null, 2));

	// Use views.update if called from a modal, views.open if initial call
	const apiEndpoint = payload.view
		? "https://slack.com/api/views.update"
		: "https://slack.com/api/views.open";
	const requestBody = payload.view
		? { view_id: payload.view.id, hash: payload.view.hash, view }
		: { trigger_id: payload.trigger_id, view };

	const response = await postSlackMessage(
		apiEndpoint,
		requestBody,
		process.env.SLACK_BOT_TOKEN
	);

	if (!response.ok) {
		context.log(
			`❌ ${apiEndpoint.split("/").pop()} failed: ${JSON.stringify(
				response,
				null,
				2
			)}`
		);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `Erreur: ${response.error}`,
		});
	}

	return {
		statusCode: 200,
		headers: { "Content-Type": "application/json" },
		body: "",
	};
}

// Conceptual handler for the "Ajouter des proformas" button action
async function proforma_form(payload, context) {
	console.log("** proforma_form");
	const orderId = payload.actions[0].value; // Extract order ID from the button
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
		private_metadata: JSON.stringify({ orderId }), // Pass orderId to submission handler
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
// Add validation for the proforma amount and currency
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
function isValidUrl(string) {
	console.log("** isValidUrl");
	try {
		new URL(string);
		return true;
	} catch (_) {
		return false;
	}
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
	if (proformaFiles.length > 0) {
		for (const file of proformaFiles) {
			const fileInfo = await getFileInfo(file.id, process.env.SLACK_BOT_TOKEN);
			urls.push(fileInfo.url_private);
			file_ids.push(file.id);
		}
		totalPages += proformaFiles.length;
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
	if (urls.length === 0) {
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
	// Return single proforma entry with all pages
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

function generatePaymentRequestForm(existingData = {}) {
	console.log("** generatePaymentRequestForm");
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
				optional: false,
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
					text: "URL du justificatif (optionnel)",
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

module.exports = {
	generateOrderForm,
	generateArticleBlocks,
	generateProformaBlocks,
	generatePaymentForm,
	proforma_form,
	extractProformas,
	generatePaymentRequestForm,
	bankOptions,
	DEFAULT_EQUIPE_OPTIONS,
};
