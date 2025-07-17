const { Caisse } = require("../Database/dbModels/Caisse");
const { Order } = require("../Database/dbModels/Order");
const PaymentRequest = require("../Database/dbModels/PaymentRequest");
const { notifyTechSlack } = require("./notifyProblem");

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
async function fetchEntity(entityId, context) {
	console.log("** fetchEntity");

	try {
		// Ensure entityId is a string
		if (typeof entityId !== "string") {
			if (entityId && typeof entityId === "object" && entityId.id_paiement) {
				entityId = entityId.id_paiement;
			} else {
				console.log(`❌ Invalid entityId provided: ${entityId}`);
				return null;
			}
		}

		// For orders (CMD/xxx)
		if (entityId.startsWith("CMD/")) {
			const entity = await Order.findOne({ id_commande: entityId });
			if (!entity) console.log(`❌ Order ${entityId} not found`);
			return entity;
		}
		// For payment requests (PAY/xxx)
		else if (entityId.startsWith("PAY/")) {
			const entity = await PaymentRequest.findOne({ id_paiement: entityId });
			if (!entity) console.log(`❌ Payment request ${entityId} not found`);
			return entity;
		}
		// For funding requests (FUND/xxx)
		else if (entityId.startsWith("FUND/")) {
			const entity = await Caisse.findOne({
				"fundingRequests.requestId": entityId,
			});
			if (!entity) console.log(`❌ Funding request ${entityId} not found`);
			return entity;
		}
		// Invalid entity ID format
		else {
			console.log(`❌ Invalid entity ID format: ${entityId}`);
			return null;
		}
	} catch (error) {
		await notifyTechSlack(error);

		console.log(`Error fetching entity ${entityId}: ${error.message}`);
		throw new Error(`Failed to fetch entity: ${error.message}`);
	}
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
async function getFileInfo(fileId, token) {
	console.log("** getFileInfo");
	const response = await fetch(
		`https://slack.com/api/files.info?file=${fileId}`,
		{
			headers: {
				Authorization: `Bearer ${token}`,
			},
		}
	);
	const json = await response.json();
	if (!json.ok) {
		throw new Error(json.error);
	}
	return json.file;
}
module.exports = {
	fetchEntity,
	bankOptions,
	isValidUrl,
	getFileInfo,
};
