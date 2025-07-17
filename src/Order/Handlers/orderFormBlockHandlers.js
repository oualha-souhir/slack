const {
	getEquipeOptions,
	getUnitOptions,
	getFournisseurOptions,
} = require("../../Configurations/config");


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
					filetypes: ["jpg", "jpeg", "png", "gif", "webp", "pdf"],
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
					filetypes: ["jpg", "jpeg", "png", "gif", "webp", "pdf"],
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
function handleAddProforma(actionId, updatedBlocks) {
	console.log("**^ handleAddProforma");
	const articleIndex = actionId.split("_").pop();
	const insertIndex = updatedBlocks.findIndex(
		(b) => b.block_id === `add_proforma_${articleIndex}`
	);
	updatedBlocks.splice(insertIndex, 1, ...generateProformaBlocks(articleIndex));
	return updatedBlocks;
}
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
async function generateArticleBlocks(index) {
	console.log("** generateArticleBlocks");
	const UNIT_OPTIONS = await getUnitOptions();

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
				filetypes: ["jpg", "jpeg", "png", "gif", "webp", "pdf"],
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
async function handleAddArticle(updatedBlocks) {
	console.log("**^ handleAddArticle");
	const newArticleIndex = updatedBlocks.filter((b) =>
		b.block_id?.startsWith("article_")
	).length;
	console.log("newArticleIndex", newArticleIndex);
	const articleBlocks = await generateArticleBlocks(newArticleIndex);
	updatedBlocks.splice(-1, 0, ...articleBlocks);
	return updatedBlocks;
}

function handleCancelProforma(actionId, updatedBlocks) {
	console.log("**^ handleCancelProforma");
	const articleIndex = actionId.split("_").pop();
	const insertIndex = updatedBlocks.findIndex(
		(b) => b.block_id === `cancel_proforma_${articleIndex}`
	);

	if (insertIndex !== -1) {
		// Add check to ensure block was found
		updatedBlocks.splice(insertIndex, 4, {
			// Change 3 to 4 to match all proforma blocks
			type: "actions",
			block_id: `add_proforma_${articleIndex}`,
			elements: [
				{
					type: "button",
					action_id: `add_proforma_${articleIndex}`,
					text: { type: "plain_text", text: "📎 Ajouter une proforma" },
					value: `add_proforma_${articleIndex}`,
				},
			],
		});
	}
	return updatedBlocks;
}

function handleRemoveArticle(actionId, updatedBlocks) {
	console.log("**^ handleRemoveArticle");
	const index = actionId.split("_").pop();
	return updatedBlocks.filter(
		(block) =>
			!block.block_id?.startsWith(`article_${index}`) &&
			!block.block_id?.startsWith(`quantity_${index}`) &&
			!block.block_id?.startsWith(`input_quantity_${index}`) &&
			!block.block_id?.startsWith(`quantity_unit_${index}`) &&
			!block.block_id?.startsWith(`quantity_number_${index}`) &&
			!block.block_id?.startsWith(`designation_${index}`) &&
			!block.block_id?.startsWith(`add_proforma_${index}`) &&
			!block.block_id?.startsWith(`divider_${index}`) &&
			!block.block_id?.startsWith(`article_photos_${index}`)
	);
}

module.exports = {
	generateOrderForm,
	handleAddProforma,
	generateProformaBlocks,
	handleAddArticle,
	handleCancelProforma,
	handleRemoveArticle,
	generateArticleBlocks,
};
