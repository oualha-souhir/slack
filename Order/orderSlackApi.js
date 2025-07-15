async function handleOrderSlackApi(request, context) {
	console.log("** handleOrderSlackApi");
	const logger = {
		log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
	};
	// Initialize OpenAI client
	const openai = new OpenAI({
		apiKey: process.env.OPENAI_API_KEY,
	});

	try {
		// const body = await request.json();
		// if (body.type === "url_verification") {
		//   return { status: 200, body: body.challenge };
		// }

		const body = await request.text();

		const params = new URLSearchParams(body);
		const command = params.get("command");
		const text = params.get("text") || "";
		const userId = params.get("user_id");
		const userName = params.get("user_name");
		const channelId = params.get("channel_id");

		context.log(
			`Command: ${command}, Text: ${text}, User ID: ${userId}, User Name: ${userName}, Channel ID: ${channelId}`
		);
		const isUserAdmin = await isAdminUser(userId);
		// Environment-based command mapping
		const getCommandsForEnvironment = () => {
			const env = process.env.NODE_ENV;
			console.log(`**** Environment: ${env}`);

			if (env === "staging") {
				return {
					caisse: "/caisse-test",
					payment: "/payment-test",
					order: "/order-test",
				};
			} else if (env === "dev") {
				return {
					caisse: "/caisset",
					payment: "/paymentt",
					order: "/ordert",
				};
			} else {
				// production
				return {
					caisse: "/caisse",
					payment: "/payment",
					order: "/order",
				};
			}
		};

		const commands = getCommandsForEnvironment();
		console.log("Commands:", commands);
		// ********************* $$$ ******************************************* */

		if (command === commands.caisse) {
			const isUserAdmin = await isAdminUser(userId);
			const isUserFinance = await isFinanceUser(userId);
			if (!isUserAdmin && !isUserFinance) {
				return createSlackResponse(200, {
					text: "🚫 Seuls les utilisateurs de la finance peuvent gérer les demandes de fonds.",
				});
			}
			if (text.toLowerCase().includes("devise")) {
				context.log(`Received refund request text: "${text}"`);
				context.log("Starting AI parsing for refund request...");

				setImmediate(async () => {
					try {
						const parsedRequest = await parseRefundFromText(text, logger);
						logger.log(
							`Parsed refund request: ${JSON.stringify(parsedRequest)}`
						);

						if (parsedRequest.montant && parsedRequest.devise) {
							const channelId = params.get("channel_id");
							const channelName = params.get("channel_name");
							logger.log(`Channel name resolved: ${channelName}`);
							const requestedDate = new Date(parsedRequest.date_requise);
							const currentDate = new Date();

							const normalizeDate = (date) =>
								new Date(date.toISOString().split("T")[0]);

							const normalizedRequestedDate = normalizeDate(requestedDate);
							const normalizedCurrentDate = normalizeDate(currentDate);

							if (normalizedRequestedDate < normalizedCurrentDate) {
								logger.log(
									"Invalid order request - requested date is in the past."
								);
								await notifyUserAI(
									{ id: "N/A" },
									channelId,
									logger,
									"⚠️ *Erreur*: La date sélectionnée est dans le passé."
								);
								return;
							}

							const newRefundRequest = await createAndSaveRefundRequest(
								userId,
								userName,
								channelName,
								parsedRequest,
								logger
							);

							logger.log(
								`Refund request created: ${JSON.stringify(newRefundRequest)}`
							);

							await Promise.all([
								notifyAdminRefund(newRefundRequest, logger),
								notifyUserRefund(newRefundRequest, userId, logger),
							]);
						} else {
							logger.log(
								"Invalid refund request - missing amount or currency."
							);
							await notifyUserAI(
								{ id: "N/A" },
								userId,
								logger,
								"Montant ou devise manquant dans votre demande de remboursement."
							);
						}
					} catch (error) {
						logger.log(
							`Background refund request creation error: ${error.stack}`
						);
						// await notifyUserAI(
						// 	{ id: "N/A" },
						// 	channelId,
						// 	logger,
						// 	`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
						// );
					}
				});

				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Demande de fonds en cours de traitement... Vous serez notifié(e) bientôt !",
				});
			}
			if (text.trim() === "balance") {
				const caisse = await Caisse.findOne().sort({ _id: -1 });

				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: channelId,
						text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
					},

					process.env.SLACK_BOT_TOKEN
				);
				return (context.res = {
					status: 200,
					body: "", // Empty response acknowledges receipt
				});
			}
			const args = text.split(" ");
			const subCommand = args[0];
			// /caisse create admin-caisse #dept-admin 100000 200 300
			if (subCommand === "create") {
				console.log("Creating new caisse...");
				const args = text.split(" ");
				if (args.length < 3) {
					return createSlackResponse(200, {
						text: "❌ Usage: `/caisse create [name] [@channel]`",
					});
				}

				const name = args[1];
				const channel = args[2].replace(/[<@#>]/g, ""); // Extract channel ID

				try {
					const channelInfo = await slackClient.conversations.info({ channel });
					const channelName = channelInfo.channel?.name || "unknown";

					const caisse = await createCaisse(
						name,
						channel,
						{
							XOF: 0,
							USD: 0,
							EUR: 0,
						},
						channelName
					); // ✅ Pass it here

					return createSlackResponse(
						200,
						`✅ Caisse "${name}" créée avec succès et associée au canal <#${channel}>.`
					);
				} catch (error) {
					console.error("Error creating caisse:", error.message);
					return createSlackResponse(200, {
						text: `❌ Erreur lors de la création de la caisse: ${error.message}`,
					});
				}
			}
			// /caisse delete #dept-admin
			if (subCommand === "delete") {
				console.log("Deleting a caisse...");
				const args = text.split(" ");
				if (args.length < 3) {
					return createSlackResponse(200, {
						text: "❌ Usage: `/caisse delete [type] [#channel]`",
					});
				}

				const type = args[1];
				const channel = args[2].replace(/[<@#>]/g, ""); // Extract channel ID

				try {
					const caisse = await Caisse.findOneAndDelete({
						type,
						channelId: channel,
					});
					if (!caisse) {
						return createSlackResponse(200, {
							text: `❌ Aucun caisse trouvé avec le type "${type}" et le canal <#${channel}>.`,
						});
					}

					return createSlackResponse(200, {
						text: `✅ Caisse "${type}" associée au canal <#${channel}> supprimée avec succès.`,
					});
				} catch (error) {
					console.error("Error deleting caisse:", error.message);
					return createSlackResponse(200, {
						text: `❌ Erreur lors de la suppression de la caisse: ${error.message}`,
					});
				}
			}
			// /caisse list

			if (subCommand === "list") {
				console.log("Fetching all caisses...");
				try {
					const caisses = await Caisse.find({});
					if (!caisses.length) {
						return createSlackResponse(200, {
							text: "❌ Aucun caisse trouvé dans la base de données.",
						});
					}

					let responseText = "*📋 Liste des Caisses:*\n";
					caisses.forEach((caisse) => {
						responseText += `• *Caisse:* ${caisse.type}\n`;
						responseText += `  *Channel:* <#${caisse.channelId}>\n`;
						responseText += `  *Balances:* XOF: ${caisse.balances.XOF}, USD: ${caisse.balances.USD}, EUR: ${caisse.balances.EUR}\n`;
					});

					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: responseText,
					});
				} catch (error) {
					console.error("Error fetching caisses:", error.message);
					return createSlackResponse(200, {
						text: `❌ Erreur lors de la récupération des caisses: ${error.message}`,
					});
				}
			}
			// /caisse transfer #dept-admin #dept-finance XOF 20
			// if (subCommand === "transfer") {
			// 	console.log("Processing fund transfer request...");
			// 	const args = text.split(" ");
			// 	if (args.length < 5) {
			// 		return createSlackResponse(200, {
			// 			text: "❌ Usage: `/caisset transfer [#from-channel] [#to-channel] [currency] [amount]`",
			// 		});
			// 	}

			// 	const fromChannel = args[1].replace(/[<@#>]/g, ""); // Extract from-channel ID
			// 	const toChannel = args[2].replace(/[<@#>]/g, ""); // Extract to-channel ID
			// 	const currency = args[3].toUpperCase();
			// 	const amount = parseFloat(args[4]);

			// 	if (isNaN(amount) || amount <= 0) {
			// 		return createSlackResponse(200, {
			// 			text: "❌ Montant invalide. Veuillez entrer un montant positif.",
			// 		});
			// 	}

			// 	try {
			// 		const fromCaisse = await Caisse.findOne({ channelId: fromChannel });
			// 		const toCaisse = await Caisse.findOne({ channelId: toChannel });

			// 		if (!fromCaisse) {
			// 			return createSlackResponse(200, {
			// 				text: `❌ Aucun caisse trouvé pour le canal <#${fromChannel}>.`,
			// 			});
			// 		}

			// 		if (!toCaisse) {
			// 			return createSlackResponse(200, {
			// 				text: `❌ Aucun caisse trouvé pour le canal <#${toChannel}>.`,
			// 			});
			// 		}

			// 		if (fromCaisse.balances[currency] < amount) {
			// 			return createSlackResponse(200, {
			// 				text: `❌ Solde insuffisant dans la caisse associée au canal <#${fromChannel}>.`,
			// 			});
			// 		}

			// 		// Perform the transfer
			// 		fromCaisse.balances[currency] -= amount;
			// 		toCaisse.balances[currency] += amount;

			// 		await fromCaisse.save();
			// 		await toCaisse.save();

			// 		return createSlackResponse(200, {
			// 			text: `✅ Transfert de ${amount} ${currency} effectué avec succès de <#${fromChannel}> à <#${toChannel}>.`,
			// 		});
			// 	} catch (error) {
			// 		console.error("Error processing fund transfer:", error.message);
			// 		return createSlackResponse(200, {
			// 			text: `❌ Erreur lors du transfert de fonds: ${error.message}`,
			// 		});
			// 	}
			// }
			// ...existing code...
			if (subCommand === "transfer") {
				console.log("Processing fund transfer request...");

				// Show transfer form instead of processing directly
				try {
					const triggerId = params.get("trigger_id");
					if (!triggerId) {
						return createSlackResponse(200, {
							text: "❌ Trigger ID manquant. Veuillez réessayer la commande.",
						});
					}

					// Get available caisses for dropdown options
					const caisses = await Caisse.find({});
					const caisseOptions = caisses.map((caisse) => ({
						text: {
							type: "plain_text",
							text: `${caisse.type} (#${caisse.channelId})`,
							emoji: true,
						},
						value: caisse.channelId,
					}));

					if (caisseOptions.length < 2) {
						return createSlackResponse(200, {
							text: "❌ Au moins 2 caisses sont nécessaires pour effectuer un transfert.",
						});
					}

					// Open transfer form modal
					const modalResponse = await postSlackMessage(
						"https://slack.com/api/views.open",
						{
							trigger_id: triggerId,
							view: {
								type: "modal",
								callback_id: "transfer_form",
								title: {
									type: "plain_text",
									text: "Transfert de fonds",
									emoji: true,
								},
								submit: {
									type: "plain_text",
									text: "Soumettre",
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
										block_id: "from_caisse_block",
										label: {
											type: "plain_text",
											text: "Caisse source",
											emoji: true,
										},
										element: {
											type: "static_select",
											action_id: "from_caisse_select",
											placeholder: {
												type: "plain_text",
												text: "Sélectionnez la caisse source",
												emoji: true,
											},
											options: caisseOptions,
										},
									},
									{
										type: "input",
										block_id: "to_caisse_block",
										label: {
											type: "plain_text",
											text: "Caisse destination",
											emoji: true,
										},
										element: {
											type: "static_select",
											action_id: "to_caisse_select",
											placeholder: {
												type: "plain_text",
												text: "Sélectionnez la caisse destination",
												emoji: true,
											},
											options: caisseOptions,
										},
									},
									{
										type: "input",
										block_id: "currency_block",
										label: {
											type: "plain_text",
											text: "Devise",
											emoji: true,
										},
										element: {
											type: "static_select",
											action_id: "currency_select",
											placeholder: {
												type: "plain_text",
												text: "Sélectionnez la devise",
												emoji: true,
											},
											options: [
												{
													text: {
														type: "plain_text",
														text: "XOF",
														emoji: true,
													},
													value: "XOF",
												},
												{
													text: {
														type: "plain_text",
														text: "USD",
														emoji: true,
													},
													value: "USD",
												},
												{
													text: {
														type: "plain_text",
														text: "EUR",
														emoji: true,
													},
													value: "EUR",
												},
											],
										},
									},
									{
										type: "input",
										block_id: "amount_block",
										label: {
											type: "plain_text",
											text: "Montant",
											emoji: true,
										},
										element: {
											type: "plain_text_input",
											action_id: "amount_input",
											placeholder: {
												type: "plain_text",
												text: "Entrez le montant à transférer",
												emoji: true,
											},
										},
									},
									{
										type: "input",
										block_id: "motif_block",
										label: {
											type: "plain_text",
											text: "Motif du transfert",
											emoji: true,
										},
										element: {
											type: "plain_text_input",
											action_id: "motif_input",
											multiline: true,
											placeholder: {
												type: "plain_text",
												text: "Expliquez la raison du transfert",
												emoji: true,
											},
										},
									},
									{
										type: "input",
										block_id: "payment_mode_block",
										label: {
											type: "plain_text",
											text: "Mode de paiement",
											emoji: true,
										},
										element: {
											type: "static_select",
											action_id: "payment_mode_select",
											placeholder: {
												type: "plain_text",
												text: "Sélectionnez le mode de paiement",
												emoji: true,
											},
											options: [
												{
													text: {
														type: "plain_text",
														text: "Espèce",
														emoji: true,
													},
													value: "espece",
												},
											],
										},
									},
								],
							},
						},
						process.env.SLACK_BOT_TOKEN
					);

					if (!modalResponse.ok) {
						throw new Error(
							`Erreur lors de l'ouverture du formulaire: ${modalResponse.error}`
						);
					}

					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "📋 Formulaire de transfert ouvert !",
					});
				} catch (error) {
					console.error("Error opening transfer form:", error.message);
					return createSlackResponse(200, {
						text: `❌ Erreur lors de l'ouverture du formulaire: ${error.message}`,
					});
				}
			}
			// ...existing code...

			context.res = {
				status: 200,
				body: "",
			};

			setImmediate(async () => {
				try {
					// const financeUsers = process.env.FINANCE_USER_IDS?.split(",") || [];
					// if (!financeUsers.includes(userId)) {
					// 	console.log("userId", userId);
					// 	await postSlackMessageWithRetry(
					// 		"https://slack.com/api/chat.postEphemeral",
					// 		{
					// 			channel: userId,
					// 			user: userId,
					// 			text: "Erreur: Seuls les membres de Finance peuvent demander des fonds.",
					// 		},
					// 		process.env.SLACK_BOT_TOKEN
					// 	);
					// 	return;
					// }

					// Check if there's text after the command (for text-based creation)
					if (text && text.trim() && text.toLowerCase().includes("montant")) {
						// Handle text-based refund request
						context.log(`Received refund request text: "${text}"`);
						context.log("Starting AI parsing for refund request...");

						try {
							const parsedRequest = await parseRefundFromText(text, context);
							context.log(
								`Parsed refund request: ${JSON.stringify(parsedRequest)}`
							);

							if (
								parsedRequest.montant &&
								parsedRequest.devise &&
								parsedRequest.motif
							) {
								const channelId = params.get("channel_id");
								const channelName = params.get("channel_name");
								context.log(`Channel name resolved: ${channelName}`);

								const newRefundRequest = await createAndSaveRefundRequest(
									userId,
									userName,
									channelName,
									parsedRequest,
									context
								);

								context.log(
									`Refund request created: ${JSON.stringify(newRefundRequest)}`
								);

								await Promise.all([
									notifyAdminRefund(newRefundRequest, context),
									notifyUserRefund(newRefundRequest, userId, context),
								]);

								// Send success confirmation
								await postSlackMessageWithRetry(
									"https://slack.com/api/chat.postEphemeral",
									{
										channel: userId,
										user: userId,
										text: `✅ Demande de fonds ${newRefundRequest.requestId} créée avec succès !`,
									},
									process.env.SLACK_BOT_TOKEN
								);
							} else {
								context.log(
									"Invalid refund request - missing required fields."
								);
								await postSlackMessageWithRetry(
									"https://slack.com/api/chat.postEphemeral",
									{
										channel: userId,
										user: userId,
										text: "❌ Erreur: Montant, devise ou motif manquant dans votre demande de remboursement.",
									},
									process.env.SLACK_BOT_TOKEN
								);
							}
						} catch (error) {
							context.log(
								`Background refund request creation error: ${error.stack}`
							);
							// await postSlackMessageWithRetry(
							// 	"https://slack.com/api/chat.postEphemeral",
							// 	{
							// 		channel: channelId,
							// 		user: userId,
							// 		text: `❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`,
							// 	},
							// 	process.env.SLACK_BOT_TOKEN
							// );
						}
						return;
					}

					// If no text or doesn't contain "montant", show options
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postEphemeral",
						{
							channel: channelId,
							user: userId,
							blocks: [
								{
									type: "header",
									text: {
										type: "plain_text",
										text: "💰 Demande de fonds",
										emoji: true,
									},
								},
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `Bonjour <@${userId}> ! Voici comment créer une demande de remboursement :`,
									},
								},
								{
									type: "divider",
								},
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: "*Option 1:* Créez une demande rapide avec la syntaxe suivante:",
									},
								},
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: "```\n/caisse montant: [montant] devise: [XOF/USD/EUR] motif: [raison] date requise: yyyy-mm-dd\n```",
									},
								},
								{
									type: "context",
									elements: [
										{
											type: "mrkdwn",
											text: "💡 *Exemple:* `/caisse montant: 15000 devise: XOF motif: Solde XOF insuffisant date requise: 2025-12-12`",
										},
									],
								},

								{
									type: "divider",
								},
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: "*Option 2:* Utilisez le formulaire interactif ci-dessous",
									},
								},
								{
									type: "actions",
									elements: [
										{
											type: "button",
											text: {
												type: "plain_text",
												text: "📋 Ouvrir le formulaire",
												emoji: true,
											},
											style: "primary",
											action_id: "open_funding_form",
											value: "open_form",
										},
									],
								},
								{
									type: "context",
									elements: [
										{
											type: "mrkdwn",
											text: "ℹ️ *Devises acceptées:* XOF, USD, EUR",
										},
									],
								},
							],
							text: `💰 Bonjour <@${userId}> ! Pour créer une demande de remboursement, utilisez la commande directe ou le formulaire.`,
						},
						process.env.SLACK_BOT_TOKEN
					);
				} catch (error) {
					console.error("Error in async processing:", error);
					// Send error notification to user
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postEphemeral",
						{
							channel: userId,
							user: userId,
							text: "❌ Une erreur inattendue s'est produite. Veuillez réessayer plus tard.",
						},
						process.env.SLACK_BOT_TOKEN
					);
				}
			});

			return;
			// ********************* $$$ ******************************************* */
		} else if (command === commands.payment) {
			if (text.toLowerCase().includes("montant")) {
				context.log(`Received payment text: "${text}"`);
				context.log("Starting AI payment parsing...");

				setImmediate(async () => {
					try {
						const parsedPayment = await parsePaymentFromText(text, logger);
						logger.log(`Parsed payment: ${JSON.stringify(parsedPayment)}`);

						if (parsedPayment.montant && parsedPayment.montant > 0) {
							const channelId = params.get("channel_id");
							const channelName = params.get("channel_name");
							logger.log(`Channel name resolved: ${channelId}`);
							console.log("params.get", params.get("user_id"));
							const requestedDate = new Date(parsedPayment.date_requise);
							const currentDate = new Date();

							if (requestedDate < currentDate) {
								logger.log(
									"Invalid refund request - requested date is in the past."
								);
								await notifyUserAI(
									{ id: "N/A" },
									channelId,
									logger,
									"⚠️ *Erreur*: La date sélectionnée est dans le passé."
								);
								return createSlackResponse(200, {
									response_type: "ephemeral",
									text: "❌ Erreur : La date requise ne peut pas être dans le passé.",
								});
							}
							const newPaymentRequest = await createAndSavePaymentRequest(
								userId,
								userName,
								channelId,
								channelName,
								{
									request_title: {
										input_request_title: {
											value:
												parsedPayment.titre || "Demande de paiement sans titre",
										},
									},
									request_date: {
										input_request_date: {
											selected_date:
												parsedPayment.date_requise ||
												new Date().toISOString().split("T")[0],
										},
									},
									payment_reason: {
										input_payment_reason: {
											value: parsedPayment.motif || "Motif non spécifié",
										},
									},
									amount_to_pay: {
										input_amount_to_pay: {
											value: `${parsedPayment.montant} ${
												parsedPayment.devise || "XOF"
											}`,
										},
									},
									po_number: {
										input_po_number: {
											value: parsedPayment.bon_de_commande || null,
										},
									},
								},
								logger
							);

							logger.log(
								`Payment request created: ${JSON.stringify(newPaymentRequest)}`
							);

							await Promise.all([
								notifyPaymentRequest(newPaymentRequest, logger, userId),
								// notifyUserPayment(newPaymentRequest, userId, logger),
							]);
						} else {
							logger.log("No valid payment amount found in parsed request.");
							await notifyUserAI(
								{ id_paiement: "N/A" },
								userId,
								logger,
								"Aucun montant valide détecté dans votre demande de paiement."
							);
						}
					} catch (error) {
						logger.log(
							`Background payment request creation error: ${error.stack}`
						);
						// await notifyUserAI(
						// 	{ id_paiement: "N/A" },
						// 	channelId,
						// 	logger,
						// 	`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
						// );
					}
				});

				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Demande de paiement en cours de traitement... Vous serez notifié(e) bientôt !",
				});
			}
			// Updated command handler for payment reports
			if (text.trim().startsWith("report")) {
				if (!isUserAdmin) {
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postEphemeral",
						{
							channel: userId,
							user: userId,
							text: "🚫 Seuls les administrateurs peuvent générer des rapports.",
						},
						process.env.SLACK_BOT_TOKEN
					);
					return { status: 200, body: "" };
				}

				setImmediate(async () => {
					const args = text.trim().split(" ").slice(1); // Remove "report" from args
					if (args.length < 2) {
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: userId,
								user: userId,
								text: "❌ Usage: /payment report [payment|project|date|status|user] [value]\nExemples:\n• /payment report payment PAY/2025/03/0001\n• /payment report project general\n• /payment report date 2025-03-01\n• /payment report status 'En attente'\n• /payment report user U1234567890",
							},
							process.env.SLACK_BOT_TOKEN
						);
						return { status: 200, body: "" };
					}

					const [reportType, ...valueParts] = args;
					const value = valueParts.join(" ");

					try {
						console.log("dddd");
						await exportPaymentReport(
							context,
							reportType,
							value,
							userId,
							channelId
						);
						return { status: 200, body: "" };
					} catch (error) {
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: userId,
								user: userId,
								text: `❌ Erreur lors de la génération du rapport de paiement : ${error.message}`,
							},
							process.env.SLACK_BOT_TOKEN
						);
						return { status: 200, body: "" };
					}
				});
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Génération du rapport en cours... Vous recevrez le fichier Excel dans quelques instants.",
				});
			}
			// } else if (command == "/payment-test") {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: "👋 Bienvenue",
							emoji: true,
						},
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `Bonjour <@${userId}> ! Voici comment passer une nouvelle demande de paiement :`,
						},
					},
					{
						type: "divider",
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "*Option 1:* Créez une demande de paiement rapide avec la syntaxe suivante :",
						},
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "```\n/payment titre: [Titre de la demande] date requise: yyyy-mm-dd motif: [Raison du paiement] montant: [Montant] [Devise] bon de commande: [Numéro de bon, optionnel]\n```",
						},
					},
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: "💡 *Exemple:* `/payment titre: Achat de matériel informatique date requise: 2025-12-12 motif: Remplacement ordinateurs défaillants montant: 50000 XOF bon de commande: PO-2025-001A`",
							},
						],
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "*Option 2:* Utilisez le formulaire ci-dessous",
						},
					},
				],
				// Fallback for older Slack clients that don't support blocks
				text: `👋 Bonjour <@${userId}> ! Pour passer une demande, vous pouvez utiliser le formulaire ci-dessous.`,
				attachments: [
					{
						callback_id: "finance_payment_form",
						actions: [
							{
								name: "finance_payment_form",
								type: "button",
								text: "💰 Demande de paiement",
								value: "open",
								action_id: "finance_payment_form",
								style: "primary",
							},
						],
					},
				],
			});

			// ********************* $$$ ******************************************* */
		} else if (command === commands.order) {
			if (!text.trim()) {
				console.log("** no text");
				return createSlackResponse(200, {
					response_type: "ephemeral",
					blocks: [
						{
							type: "header",
							text: {
								type: "plain_text",
								text: "👋 Bienvenue",
								emoji: true,
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: `Bonjour <@${userId}> ! Voici comment passer une nouvelle commande:`,
							},
						},
						{
							type: "divider",
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "*Option 1:* Créez une commande rapide avec la syntaxe suivante:",
							},
						},
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "```\n/order titre: [Votre titre] equipe: [Nom de l'équipe] date requise: yy-mm-jj articles: [quantité] [unité] Désignation: [désignation]\n```",
							},
						},
						{
							type: "context",
							elements: [
								{
									type: "mrkdwn",
									text: "💡 *Exemple:* `/order titre: Matériel Électrique equipe: Maçons date requise: 2025-12-12 articles: 10 piece Désignation: rouleaux de câble souple VGV de 2×2,5 bleu-marron`",
								},
							],
						},

						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "*Option 2:* Utilisez la formulaires ci-dessous",
							},
						},
					],
					// Fallback for older Slack clients that don't support blocks
					text: `👋 Bonjour <@${userId}> ! Pour passer une demande, vous pouvez utiliser les formulaires ou les commandes directes.`,
					attachments: [
						{
							callback_id: "order_form",
							actions: [
								{
									name: "open_form",
									type: "button",
									text: "📋 Nouvelle commande",
									value: "open",
									action_id: "open_form",
									style: "primary",
								},
							],
						},
					],
				});
			}
			if (text.trim().startsWith("report")) {
				console.log("** report");
				if (!isUserAdmin) {
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postEphemeral",
						{
							channel: userId,
							user: userId,
							text: "🚫 Seuls les administrateurs peuvent générer des rapports.",
						},
						process.env.SLACK_BOT_TOKEN
					);
					return { status: 200, body: "" };
				}
				setImmediate(async () => {
					const args = text.trim().split(" ").slice(1); // Remove "report" from args
					if (args.length < 2) {
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: userId,
								user: userId,
								text: "❌ Usage: /order report [order|team|date] [value]\nExemple: /order report order CMD/2025/03/0001 ou /order report team Maçons ou /order report date 2025-03-01",
							},
							process.env.SLACK_BOT_TOKEN
						);
						return { status: 200, body: "" };
					}

					const [reportType, ...valueParts] = args;
					const value = valueParts.join(" ");

					try {
						await exportReport(context, reportType, value, userId, channelId);
						return { status: 200, body: "" };
					} catch (error) {
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: userId,
								user: userId,
								text: `❌ Erreur lors de la génération du rapport : ${error.message}`,
							},
							process.env.SLACK_BOT_TOKEN
						);
						return { status: 200, body: "" };
					}
				});
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Génération du rapport en cours... Vous recevrez le fichier Excel dans quelques instants.",
				});
			}
			//? changed from report to summary
			if (text.trim() === "summary") {
				console.log("** summary");
				await generateReport(context);
				await analyzeTrends(context);

				return createSlackResponse(200, "summary completed!");
			}

			if (text.trim().startsWith("add-role")) {
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						text: "🚫 Seuls les admins peuvent gérer les rôles.",
					});
				}
				const [, mention, role] = text.trim().split(" ");
				if (role !== "admin" && role !== "finance" && role !== "achat") {
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postMessage",
						{
							channel: channelId,
							text: "🚫 Invalid role. Only 'admin', 'finance', or 'achat' are allowed.",
						},
						process.env.SLACK_BOT_TOKEN
					);
					return (context.res = {
						status: 200,
						body: "", // Empty response acknowledges receipt
					});
				}
				// const userIdToAdd = mention.replace(/[<@>]/g, "");
				// const userNameToAdd = await getSlackUserName(userIdToAdd);
				// If mention is not in <@Uxxxx> format, try to resolve by display name
				// ...existing code...
				let userIdToAdd, userNameToAdd;
				if (mention.startsWith("<@")) {
					userIdToAdd = mention.replace(/[<@>]/g, "");
					userNameToAdd = await getSlackUserName(userIdToAdd);
				} else {
					// Remove leading @ if present
					const identifier = mention.replace(/^@/, "");
					const resolved = await resolveUserIdAndName(identifier);
					userIdToAdd = resolved.userId;
					userNameToAdd = resolved.userName;
				}
				// ...existing code...
				console.log(
					`Adding role ${role} to user ${userIdToAdd} (${userNameToAdd})`
				);
				await addUserRole(userIdToAdd, role, userNameToAdd); // Update your addUserRole to accept and store the name
				return createSlackResponse(200, {
					text: `✅ Rôle ${role} ajouté à <@${userIdToAdd}>.`,
				});
			}
			if (text.trim().startsWith("rm-role")) {
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						text: "🚫 Seuls les admins peuvent gérer les rôles.",
					});
				}
				const [, mention, role] = text.trim().split(" ");
				// const userIdToRemove = mention.replace(/[<@>]/g, "");
				let userIdToRemove;
				if (mention.startsWith("<@")) {
					userIdToRemove = mention.replace(/[<@>]/g, "");
				} else {
					// Remove leading @ if present
					const identifier = mention.replace(/^@/, "");
					const resolved = await resolveUserIdAndName(identifier);
					userIdToRemove = resolved.userId;
				}
				await removeUserRole(userIdToRemove, role);
				return createSlackResponse(200, {
					text: `✅ Rôle ${role} retiré de <@${userIdToRemove}>.`,
				});
			}
			const textArgs = text.trim().split(" ");
			const subCommand = textArgs[0];
			if (subCommand === "list-users") {
				console.log("** listusers");
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "🚫 Seuls les administrateurs peuvent voir la liste des utilisateurs et rôles.",
					});
				}

				// Fetch all users and their roles
				const users = await require("./db").UserRole.find({});
				if (!users.length) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "Aucun utilisateur avec des rôles trouvés.",
					});
				}

				let text = "*👥 Liste des utilisateurs et rôles assignés:*\n";
				users.forEach((user) => {
					text += `• <@${user.userId}> : ${user.roles.join(", ")}\n`;
				});

				return createSlackResponse(200, {
					response_type: "ephemeral",
					text,
				});
			}

			// // Configuration management command
			if (subCommand === "config") {
				console.log("** config");
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "🚫 Seuls les administrateurs peuvent configurer les options.",
					});
				}
				setImmediate(async () => {
					try {
						// Fetch current config from DB
						const equipeOptions = await getConfigValues("equipe_options", [
							"IT",
							"Finance",
							"Achat",
							"RH",
						]);
						const unitOptions = await getConfigValues("unit_options", [
							"pièce",
							"kg",
							"litre",
							"mètre",
						]);
						const currencies = await getConfigValues("currencies", [
							"TND",
							"EUR",
							"USD",
						]);
						const fournisseurOptions = await getConfigValues(
							"fournisseur_options",
							["Fournisseur A", "Fournisseur B", "Fournisseur C"]
						);

						console.log("equipeOptions", equipeOptions);
						console.log("unitOptions", unitOptions);
						console.log("currencies", currencies);
						console.log("fournisseurOptions", fournisseurOptions);

						// Send configuration as a message visible to all
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: channelId,
								text: `*Configuration actuelle:*\n\n*👥 Équipes:*\n${
									equipeOptions.length > 0
										? equipeOptions.map((e) => `• ${e}`).join("\n")
										: "Aucune équipe configurée"
								}\n\n*📏 Unités:*\n${
									unitOptions.length > 0
										? unitOptions.map((u) => `• ${u}`).join("\n")
										: "Aucune unité configurée"
								}\n\n*💰 Devises:*\n${
									currencies.length > 0
										? currencies.map((c) => `• ${c}`).join("\n")
										: "Aucune devise configurée"
								}\n\n*🏢 Fournisseurs:*\n${
									fournisseurOptions.length > 0
										? fournisseurOptions.map((f) => `• ${f}`).join("\n")
										: "Aucun fournisseur configuré"
								}\n\n_Utilisez les commandes add/remove pour modifier._`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					} catch (error) {
						console.error("Error fetching configuration:", error);
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: channelId,
								text: "❌ Erreur lors de la récupération de la configuration. Veuillez réessayer.",
							},
							process.env.SLACK_BOT_TOKEN
						);
					}
				});
				// Return immediate response to avoid timeout
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Récupération de la configuration en cours...",
				});
			}
			// // Add configuration items
			if (subCommand === "add") {
				console.log("** add");
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "🚫 Seuls les administrateurs peuvent ajouter des configurations.",
					});
				}

				if (textArgs.length < 3) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "Usage: `/order add [equipe|unit|currency] <valeur>`",
					});
				}

				const configType = textArgs[1];
				const value = textArgs.slice(2).join(" ");

				let configKey;
				let displayName;

				switch (configType) {
					case "equipe":
						configKey = "equipe_options";
						displayName = "équipe";
						break;
					case "unit":
						configKey = "unit_options";
						displayName = "unité";
						break;
					case "currency":
						configKey = "currencies";
						displayName = "devise";
						break;
					case "fournisseur":
						configKey = "fournisseur_options";
						displayName = "fournisseur";
						break;
					default:
						return createSlackResponse(200, {
							response_type: "ephemeral",
							text: "❌ Type invalide. Utilisez: equipe, unit, ou currency",
						});
				}

				setImmediate(async () => {
					try {
						await addConfigValue(configKey, value);
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: channelId,
								text: `✅ ${
									displayName.charAt(0).toUpperCase() + displayName.slice(1)
								} "${value}" ajoutée avec succès.`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					} catch (error) {
						console.error("Error adding config value:", error);
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: channelId,
								text: `❌ Erreur lors de l'ajout de la ${displayName}: ${error.message}`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					}
				});
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: channelId,
						text: "⌛ Operation en cours...",
					},
					process.env.SLACK_BOT_TOKEN
				);
			}

			// Remove configuration items
			if (subCommand === "rm") {
				console.log("** rm");
				if (!(await isAdminUser(userId))) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "🚫 Seuls les administrateurs peuvent supprimer des configurations.",
					});
				}

				if (textArgs.length < 3) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "Usage: `/order rm [equipe|unit|currency] <valeur>`",
					});
				}

				const configType = textArgs[1];
				const value = textArgs.slice(2).join(" ");

				let configKey;
				let displayName;

				switch (configType) {
					case "equipe":
						configKey = "equipe_options";
						displayName = "équipe";
						break;
					case "unit":
						configKey = "unit_options";
						displayName = "unité";
						break;
					case "currency":
						configKey = "currencies";
						displayName = "devise";
						break;
					case "fournisseur":
						configKey = "fournisseur_options";
						displayName = "fournisseur";
						break;
					default:
						return createSlackResponse(200, {
							response_type: "ephemeral",
							text: "❌ Type invalide. Utilisez: equipe, unit, ou currency",
						});
				}
				setImmediate(async () => {
					try {
						await removeConfigValue(configKey, value);
						await postSlackMessageWithRetry(
							"https://slack.com/api/chat.postMessage",
							{
								channel: channelId,
								text: `✅ ${
									displayName.charAt(0).toUpperCase() + displayName.slice(1)
								} "${value}" supprimée avec succès.`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					} catch (error) {
						console.error("Error removing config value:", error);
						return createSlackResponse(200, {
							response_type: "ephemeral",
							text: `❌ Erreur lors de la suppression de la ${displayName}.`,
						});
					}
				});
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: channelId,
						text: "⌛ Operation en cours...",
					},
					process.env.SLACK_BOT_TOKEN
				);
			}

			// Help command
			if (subCommand === "help" || !subCommand) {
				console.log("** help");
				const isUserAdmin = await isAdminUser(userId);
				const isUserFinance = await isFinanceUser(userId);
				const isUserPurchase = await isPurchaseUser(userId);

				let helpText = "*🛠️ Commandes disponibles:*\n\n";

				if (isUserAdmin) {
					helpText += "*Commandes pour les administrateurs:*\n";
					helpText += "*Configuration:*\n";
					helpText +=
						"• `/order config` - Ouvrir le panneau de configuration\n";
					// helpText += "• `/order list` - Lister toutes les configurations\n";
					helpText +=
						"• `/order add [equipe|unit|currency|fournisseur] <valeur>` - Ajouter une option\n";
					helpText +=
						"• `/order rm [equipe|unit|currency|fournisseur] <valeur>` - Supprimer une option\n\n";
					helpText += "*Gestion des rôles:*\n";
					helpText += "• `/order list-users` - Lister tous les utilisateurs\n";
					helpText +=
						"• `/order add-role @user [admin|finance|achat]` - Ajouter un rôle\n";
					helpText +=
						"• `/order rm-role @user [admin|finance|achat]` - Retirer un rôle\n\n";
					helpText += "• `/order delete <order_id>` - Supprimer une commande\n";
				}
				if (isUserAdmin || isUserFinance || isUserPurchase) {
					helpText +=
						"*Commandes pour les administrateurs, les équipes financières et les équipes d'achat:*\n";

					helpText += "• `/order summary` - Générer un résumé global\n";
					helpText +=
						"• `/order report [order|channel|date|status|user|team] <valeur>` - Générer un rapport de commandes\n";
					helpText +=
						"• `/payment report [payment|channel|date|status|user] <valeur>` - Générer un rapport de paiements\n";
					helpText += "• `/order check-delays` - Vérifier les retards\n";
					helpText +=
						"• `/order list detailed` - Liste détaillée des commandes\n";
					helpText += "• `/order list` - Liste des commandes récentes\n";
					helpText +=
						"• `/order filterby [titre|status|demandeur|équipe]:<valeur>` - Filtrer les commandes\n";
					helpText += "• `/order resume` - Résumé IA des commandes\n";
				}
				if (isUserAdmin || isUserFinance) {
					helpText += "*Commandes pour les finances:*\n";
					helpText += "• `/caisse balance` - Afficher le solde de la caisse\n";
					helpText += "• `/caisse` - Créer une demande de fonds\n";
				}

				// Add general commands for all users
				helpText += "*Commandes générales:*\n";

				helpText +=
					"• `/order ask ai: <question>` - Poser une question à l'IA\n";
				helpText += "• `/order my order` - Voir votre dernière commande\n";
				helpText += "• `/payment` - Créer une demande de paiement\n";
				helpText += "• `/order` - Créer une commande\n";

				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: helpText,
				});
			}

			// !
			if (text.trim() === "my order") {
				console.log("** my order");
				const summary = await getOrderSummary(userId);
				console.log("summary", summary);
				if (summary) {
					const response = `📋 **Résumé de votre dernière commande**
 ID: ${summary.id}
📝 Titre: ${summary.title}
👥 Équipe: ${summary.team}
📊 Statut: ${summary.status}
💰 Total: ${summary.totalAmount}€
✅ Payé: ${summary.amountPaid}€
⏳ Restant: ${summary.remainingAmount}€
📄 Proformas: ${summary.validatedProformasCount}/${summary.proformasCount}`;
					// return { response };
					await postSlackMessageWithRetry(
						"https://slack.com/api/chat.postMessage",
						{
							channel: channelId,
							text: response,
						},

						process.env.SLACK_BOT_TOKEN
					);
					return (context.res = {
						status: 200,
						body: "", // Empty response acknowledges receipt
					});
				}
			}
			// !
			// Simplified AI command handling
			if (textArgs[0].toLowerCase() === "resume") {
				console.log("** resume");
				await postSlackMessage(
					"https://slack.com/api/chat.postMessage",
					{
						channel: process.env.SLACK_ADMIN_ID,
						text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
					},
					process.env.SLACK_BOT_TOKEN
				);
				// Process in background
				setImmediate(async () => {
					await handleAICommand(
						logger, // Assuming logger is correctly defined
						openai, // OpenAI client instance
						Order, // Mongoose model for orders
						notifyUserAI, // Function for sending notifications
						createSlackResponse // Function for formatting Slack responses
					);
				});
				return createSlackResponse(200, "AI command processed successfully.");
			}

			if (textArgs[0] === "list" || textArgs[0] === "filterby") {
				try {
					if (textArgs[0] === "list") {
						if (textArgs[1] === "detailed") {
							// Handle "/order list brief"
							return await orderService.handleOrderList(isUserAdmin, context);
						}
						// Default "/order list" (detailed version)
						return await handleOrderListSlack(isUserAdmin, context);
					} else if (textArgs[0] === "filterby") {
						const argsToParse = textArgs.slice(1);
						context.log(`🧩 Args to parse: ${JSON.stringify(argsToParse)}`);
						const filters = parseFilters(argsToParse);
						context.log(`🔍 Filters parsed: ${JSON.stringify(filters)}`);
						const response = await handleOrderOverview(
							isUserAdmin,
							filters,
							context
						);
						context.log(`📤 Response to Slack: ${JSON.stringify(response)}`);
						return response; // Ensure the response is returned
					}
				} catch (error) {
					logger.log(`Background list processing error: ${error.stack}`);
					await notifyUserAI(
						{ id_commande: "N/A" },
						userId,
						logger,
						`Erreur : ${error.message}`
					);
				}

				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Liste en cours de génération... Vous recevrez un résumé bientôt !",
				});
			}

			if (text.toLowerCase().includes("equipe")) {
				context.log(`Received text: "${text}"`);
				context.log("Starting AI parsing...");
				setImmediate(async () => {
					try {
						const parsedOrder = await parseOrderFromText(text, logger);
						logger.log(`Parsed order: ${JSON.stringify(parsedOrder)}`);
						if (parsedOrder.articles && parsedOrder.articles.length > 0) {
							const channelId = params.get("channel_id");
							const channelName = params.get("channel_name");
							logger.log(`Channel name resolved: ${channelId}`);
							logger.log(`Channel name resolved: ${channelName}`);
							const requestedDate = new Date(parsedOrder.date_requise);
							const currentDate = new Date();

							if (requestedDate < currentDate) {
								logger.log(
									"Invalid refund request - requested date is in the past."
								);

								await notifyUserAI(
									{ id: "N/A" },
									channelId,
									logger,
									"⚠️ *Erreur*: La date sélectionnée est dans le passé."
								);
								return createSlackResponse(200, {
									response_type: "ephemeral",
									text: "❌ Erreur : La date requise ne peut pas être dans le passé.",
								});
							}
							console.log("parsedOrder ", parsedOrder);
							// Normalize the team name before using it
							const normalizedEquipe = normalizeTeamName(parsedOrder.equipe);

							const newOrder = await createAndSaveOrder(
								userId,
								userName,
								channelName,
								channelId,
								{
									request_title: {
										input_request_title: {
											value: parsedOrder.titre || "Commande sans titre",
										},
									},
									equipe_selection: {
										select_equipe: {
											selected_option: {
												text: {
													text: parsedOrder.equipe, // Ensure `normalizedEquipe` is assigned to the nested `text` property
												},
											},
										},
									},
									request_date: {
										input_request_date: {
											selected_date:
												parsedOrder.date_requise ||
												new Date().toISOString().split("T")[0],
										},
									},
								},
								parsedOrder.articles.map((article) => ({
									quantity: article.quantity || 1, // Default to 1 if missing
									unit: article.unit || undefined,
									designation: article.designation || "Article non spécifié", // Default if missing
								})),
								[],
								[],
								logger
							);

							logger.log(`Order created: ${JSON.stringify(newOrder)}`);
							await Promise.all([
								notifyAdmin(newOrder, logger),
								notifyUser(newOrder, userId, logger),
							]);
						} else {
							logger.log("No articles found in parsed order.");
							await notifyUserAI(
								{ id_commande: "N/A" },
								channelId,
								logger,
								"Aucun article détecté dans votre commande."
							);
						}
					} catch (error) {
						logger.log(`Background order creation error: ${error.stack}`);
						// await notifyUserAI(
						// 	{ id_commande: "N/A" },
						// 	channelId,
						// 	logger,
						// 	`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
						// );
					}
				});
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
				});
			}
			if (text.toLowerCase().includes("ask ai:")) {
				// Acknowledge Slack within 3 seconds
				setImmediate(async () => {
					try {
						const faqResponse = await handleFrequentQuestions(
							text,
							userId,
							context
						);
						if (faqResponse.response) {
							// Format the JSON response into a readable string
							const formattedResponse =
								typeof faqResponse.response === "string"
									? faqResponse.response
									: Object.entries(faqResponse.response)
											.map(([key, value]) => `*${key}:* ${value}`)
											.join("\n");

							await postSlackMessageWithRetry(
								"https://slack.com/api/chat.postMessage",
								{ channel: channelId, text: formattedResponse },

								process.env.SLACK_BOT_TOKEN
							);

							context.log(`FAQ response sent: ${formattedResponse}`);
						}
					} catch (error) {
						context.log(`FAQ processing error: ${error.stack}`);
						await postSlackMessage(
							"https://slack.com/api/chat.postEphemeral",
							{
								user: userId,
								text: `Erreur: ${error.message}`,
							},
							process.env.SLACK_BOT_TOKEN
						);
					}
				});

				// Immediate acknowledgment
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "⌛ Vérification en cours... Réponse bientôt !",
				});
			}
			if (text.trim() === "check-delays") {
				console.log("** check-delays 1");
				// await checkPendingOrderDelays();
				// await checkPaymentDelays();
				await checkProformaDelays();
				return createSlackResponse(200, "Delay check completed!");
			}

			// Add delete command handler
			if (text.trim().startsWith("delete")) {
				const orderId = text.trim().split(" ")[1];
				console.log("orderId1", orderId);
				if (!orderId) {
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "❌ Usage: /order delete [order_id]\nExemple: /order delete CMD/2025/03/0001",
					});
				}
				const existingOrder = await Order.findOne({ id_commande: orderId });

				if (!existingOrder) {
					throw new Error(`Commande ${orderId} non trouvée`);
				}

				if (existingOrder.deleted === true) {
					// Send notification that order is already deleted
					await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: channelId,
							text: `⚠️ La commande ${orderId} a déjà été supprimée.`,
							blocks: [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `⚠️ La commande ${orderId} a déjà été supprimée.`,
									},
								},
							],
						},
						process.env.SLACK_BOT_TOKEN
					);
					return createSlackResponse(200);
				}

				// Check if user is admin
				if (!isUserAdmin) {
					return createSlackMessage(
						"https://slack.com/api/chat.postEphemeral",
						{
							channel: channelId,
							user: userId,
							text: "🚫 Seuls les administrateurs peuvent supprimer des commandes.",
						},
						process.env.SLACK_BOT_TOKEN
					);
				}

				// Show confirmation dialog
				try {
					const triggerId = params.get("trigger_id");
					if (!triggerId) {
						throw new Error("Trigger ID is required for opening the dialog");
					}

					const dialogResponse = await postSlackMessage(
						"https://slack.com/api/views.open",
						{
							trigger_id: triggerId,
							view: {
								type: "modal",
								callback_id: "delete_order_confirmation",
								title: {
									type: "plain_text",
									text: "Suppression de commande",
									emoji: true,
								},
								submit: {
									type: "plain_text",
									text: "Supprimer",
									emoji: true,
								},
								close: {
									type: "plain_text",
									text: "Annuler",
									emoji: true,
								},
								blocks: [
									{
										type: "section",
										text: {
											type: "mrkdwn",
											text: `:warning: *Êtes-vous sûr de vouloir supprimer la commande ${orderId} ?*\n\nCette action est irréversible.`,
										},
									},
									{
										type: "input",
										block_id: "delete_reason_block",
										label: {
											type: "plain_text",
											text: "Raison de la suppression",
											emoji: true,
										},
										element: {
											type: "plain_text_input",
											action_id: "delete_reason_input",
											multiline: true,
											placeholder: {
												type: "plain_text",
												text: "Entrez la raison de la suppression (optionnel)",
												emoji: true,
											},
										},
									},
								],
								private_metadata: JSON.stringify({
									orderId: orderId,
									channelId: channelId,
								}),
							},
						},
						process.env.SLACK_BOT_TOKEN
					);

					console.log("dialogResponse", dialogResponse);
					if (!dialogResponse.ok) {
						throw new Error(
							`Unable to open confirmation dialog: ${dialogResponse.error}`
						);
					}

					// Send notification to channel about pending deletion
					await postSlackMessage(
						"https://slack.com/api/chat.postMessage",
						{
							channel: channelId,
							text: `:hourglass: *Demande de suppression en cours*\nLa commande ${orderId} est en cours de suppression par <@${userId}>.`,
							blocks: [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `:hourglass: *Demande de suppression en cours*\nLa commande ${orderId} est en cours de suppression par <@${userId}>.`,
									},
								},
							],
						},
						process.env.SLACK_BOT_TOKEN
					);

					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "⌛ Ouverture de la confirmation de suppression...",
					});
				} catch (error) {
					context.log(`Error in delete command: ${error.message}`);
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: `❌ Erreur: ${error.message}`,
					});
				}
			}
		} else if (
			command !== "/order" &&
			command !== "/payment" &&
			command !== "/caisse"
		) {
			// Default response for unknown commands
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❓ Commande inconnue. Utilisez `/order help` pour voir les commandes disponibles.",
			});
			// return createSlackResponse(400, "Commande inconnue");
		}

		// Add this condition to handle payment request text parsing
	} catch (error) {
		context.log(`❌ Erreur: ${error.stack}`);
		return createSlackResponse(500, "Erreur interne");
	}
}