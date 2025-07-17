const axios = require("axios");

async function notifyTechSlack(error) {
	const channel = process.env.SLACK_tech_CHANNEL_ID;
	const webhookUrl = process.env.SLACK_TECH_WEBHOOK_URL;

	if (!webhookUrl || !channel) {
		console.log("Slack webhook URL or channel ID not set");
		return;
	}

	const message = {
		channel,
		text: `❌ *Internal Error*\n\`\`\`${error?.stack || error}\`\`\``,
	};

	try {
		await axios.post(webhookUrl, message);
	} catch (err) {
		console.log("Failed to notify tech Slack channel:", err);
	}
}

module.exports = { notifyTechSlack };
