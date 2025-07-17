function getOrderBlocks(order, requestDate, isNewOrder = false) {
	console.log("** getOrderBlocks");
	return [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: isNewOrder
					? `➡️ Nouvelle Commande: ${order.id_commande}`
					: `📦 Commande: ${order.id_commande}`,
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
				{ type: "mrkdwn", text: `*Canal:*\n<#${order.channelId}>` },
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
		// // Add order ID section for new orders
		// ...(isNewOrder
		// 	? [
		// 			{
		// 				type: "section",
		// 				fields: [
		// 					{
		// 						type: "mrkdwn",
		// 						text: `*ID Commande:*\n${order.id_commande}`,
		// 					},
		// 				],
		// 			},
		// 	  ]
		// 	: []),
		{ type: "divider" },
		{ type: "section", text: { type: "mrkdwn", text: `*Articles*` } },
		...generateArticleBlocks(order.articles),
		{ type: "divider" },
	];
}
function generateArticlePhotosBlocks(articlePhotos, articleNumber) {
	if (!articlePhotos || articlePhotos.length === 0) {
		return [];
	}

	// Create photo links with better URL handling
	const photoLinks = articlePhotos
		.map((photo, index) => {
			// Prioritize public URLs
			let photoUrl =
				photo.url ||
				photo.public_url ||
				photo.permalink_public ||
				photo.permalink ||
				photo.url_private_download;

			return `<${photoUrl}|Photo ${index + 1}>`;
		})
		.join(" | ");

	return [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: ` • Photo(s): ${photoLinks}`,
			},
		},
	];
}
function getProformaBlocks1(order) {
	console.log("** getProformaBlocks1");
	const proformas = order.proformas || [];
	const relevantProformas =
		proformas.length > 0
			? proformas.filter((p) => p.validated === true)
			: proformas;

	return relevantProformas.length > 0
		? relevantProformas
				.map((p) => ({
					type: "section",
					text: {
						type: "mrkdwn",
						text: `*${p.nom}*${
							p.fournisseur ? ` - Fournisseur: *${p.fournisseur}*` : ""
						} - Montant: *${p.montant}* ${p.devise}\n   *URLs:*\n${p.urls
							.map((url, j) => {
								// If url is an object with file properties, extract the public URL
								const displayUrl =
									typeof url === "object" && url.permalink
										? url.url ||
										  url.permalink ||
										  url.url_private_download ||
										  url.url_private
										: url;
								return `     ${j + 1}. <${displayUrl}|Page ${j + 1}>`;
							})
							.join("\n")}`,
					},
				}))
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
function getProformaBlocks(order) {
	console.log("** getProformaBlocks");

	const proformas = order.proformas || [];
	return proformas.length > 0
		? proformas
				.map((p) => ({
					type: "section",
					text: {
						type: "mrkdwn",
						text: `*${p.nom}*${
							p.fournisseur ? ` - Fournisseur: *${p.fournisseur}*` : ""
						} - Montant: *${p.montant}* ${p.devise}\n   *URLs:*\n${p.urls
							.map((url, j) => {
								// If url is an object with file properties, extract the public URL
								const displayUrl =
									typeof url === "object" && url.permalink
										? url.url ||
										  url.permalink ||
										  url.url_private_download ||
										  url.url_private
										: url;
								return `     ${j + 1}. <${displayUrl}|Page ${j + 1}>`;
							})
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
function generateArticleBlocks(articles) {
	if (!articles || articles.length === 0) {
		return [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "📋 *Aucun article spécifié*",
				},
			},
		];
	}

	return articles.flatMap((article, index) => {
		const articleNumber = index + 1;
		const blocks = [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text:
						` *${articleNumber}.* ${
							article.designation || "Article sans nom"
						}\n` +
						` • *Quantité:* ${article.quantity || 1} ${
							article.unit || "unité(s)"
						}`,
				},
			},
		];

		// Add photos for this specific article if they exist
		if (article.photos && article.photos.length > 0) {
			blocks.push(
				...generateArticlePhotosBlocks(article.photos, articleNumber)
			);
		}

		return blocks;
	});
}
module.exports = {
	getOrderBlocks,
	getProformaBlocks1,
	getProformaBlocks,
	generateArticlePhotosBlocks,
	generateArticleBlocks,
};
