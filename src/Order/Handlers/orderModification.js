const { postSlackMessage2 } = require("../../Common/slackUtils");
const { Order } = require("../../Database/dbModels/Order");
const axios = require("axios");
const { generateOrderForm } = require("./orderFormBlockHandlers");
const { notifyTechSlack } = require("../../Common/notifyProblem");

async function handleEditOrder(payload, context) {
	console.log("** edit_order");
	try {
		// Get the order ID from the payload
		const orderId = payload.actions[0].value;
		context.log(`Editing order with ID: ${orderId}`);

		// Fetch the order from the database
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			throw new Error(`Order with ID ${orderId} not found`);
		}
		console.log("Order object:", order);

		console.log(`order.status ${order.statut}`);
		if (order.statut == "En attente") {
			// Prepare the form data from the existing order
			const formData = {
				request_title: {
					input_request_title: {
						value: order.titre || "",
					},
				},
				equipe_selection: {
					select_equipe: {
						selected_option: {
							value: order.equipe || "Non spécifié",
							text: {
								type: "plain_text",
								text: order.equipe || "Non spécifié",
							},
						},
					},
				},
				request_date: {
					input_request_date: {
						selected_date: order.date_requete
							? new Date(order.date_requete).toISOString().split("T")[0]
							: new Date().toISOString().split("T")[0],
					},
				},
			};
			console.log("formData:", formData);
			// Add articles data
			if (order.articles && order.articles.length > 0) {
				order.articles.forEach((article, index) => {
					const articleIndex = index + 1;

					// Add designation
					formData[`designation_${articleIndex}`] = {
						[`input_designation_${articleIndex}`]: {
							value: article.designation || "",
						},
					};

					// Add quantity
					formData[`quantity_number_${articleIndex}`] = {
						[`input_quantity_${articleIndex}`]: {
							value: article.quantity ? String(article.quantity) : "0",
						},
					};

					// Add unit - Make sure to include both value and text properties
					const unitValue = article.unit || "piece";
					const unitText = article.unit || "Pièce";

					formData[`quantity_unit_${articleIndex}`] = {
						[`select_unit_${articleIndex}`]: {
							selected_option: {
								value: unitValue,
								text: {
									type: "plain_text",
									text: unitText,
								},
							},
						},
					};
				});
			}

			// Prepare the suggestions object with any proformas
			const suggestions = {
				titre: order.titre || "",
				designations: order.articles?.map((a) => a.designation) || [],
			};

			// Generate the form view with the order data
			const view = await generateOrderForm(
				order.proformas || [],
				suggestions,
				formData
			);

			// Add metadata to track that this is an edit operation
			const metadata = {
				formData: formData,
				originalViewId: payload.trigger_id,
				orderId: orderId,
				isEdit: true,
				proformas: order.proformas || [],
				// Store the original message details
				originalMessage: {
					channel: payload.channel?.id || payload.channel || payload.user.id,
					ts: payload.message?.ts, // Store the timestamp of the original message
				},
			};
			console.log("$ metadata", metadata);

			// Open the modal with the prefilled data
			const response = await postSlackMessage2(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: {
						...view,
						private_metadata: JSON.stringify(metadata),
					},
				},
				process.env.SLACK_BOT_TOKEN
			);

			context.log(`Edit order form response: ${JSON.stringify(response.data)}`);
			if (!response.data.ok) {
				throw new Error(`Slack API error: ${response.data.error}`);
			}
		} else {
			await axios.post(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel?.id || payload.channel || payload.user.id,
					user: payload.user.id,
					//text: `🛑 Échec de l'édition de la commande: ${error.message}`,
					text: `⚠️ Commande ${order.statut}e par l'Administrateur vous ne pouvez pas la modifier`,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);
		}
	} catch (error) {
		await notifyTechSlack(error);

		context.log(
			`❌ Error in edit_order: ${error.message}\nStack: ${error.stack}`
		);
		await axios.post(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.channel?.id || payload.channel || payload.user.id,
				user: payload.user.id,
				text: `🛑 Échec de l'édition de la commande: ${error.message}`,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			}
		);
	}
}
module.exports = { handleEditOrder };
