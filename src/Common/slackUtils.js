//src/utils
const axios = require("axios");
const crypto = require("crypto");
const { notifyTechSlack } = require("./notifyProblem");

require("dotenv").config();
function createSlackResponse(statusCode, body) {
	// console.log("** createSlackResponse");
	if (typeof body === "string") {
		return {
			statusCode,
			body: JSON.stringify({
				response_type: "ephemeral",
				text: body,
			}),
			headers: {
				"Content-Type": "application/json",
			},
		};
	}
	return {
		statusCode,
		body: JSON.stringify(body),
		headers: {
			"Content-Type": "application/json",
		},
	};
}

function verifySlackSignature(request, body) {
	// console.log("** verifySlackSignature");
	const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
	const requestSignature = request.headers.get("x-slack-signature");
	const requestTimestamp = request.headers.get("x-slack-request-timestamp");

	const sigBasestring = `v0:${requestTimestamp}:${body}`;
	const mySignature =
		"v0=" +
		crypto
			.createHmac("sha256", slackSigningSecret)
			.update(sigBasestring)
			.digest("hex");

	return crypto.timingSafeEqual(
		Buffer.from(mySignature, "utf8"),
		Buffer.from(requestSignature, "utf8")
	);
}

async function postSlackMessage(url, data, token) {
	console.log("** postSlackMessage");
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s timeout

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(data),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);
		const result = await response.json();
		return result;
	} catch (error) {
		await notifyTechSlack(error);

		throw new Error(`Slack API call failed: ${error.message}`);
	}
}
async function postSlackMessage9(url, data, token) {
	console.log("** postSlackMessage");
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s timeout

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8", // Add charset
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(data),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);
		const result = await response.json();
		console.log("** postSlackMessage response:", JSON.stringify(result));
		return result;
	} catch (error) {
		await notifyTechSlack(error);

		console.log("** postSlackMessage error:", error.message);
		throw new Error(`Slack API call failed: ${error.message}`);
	}
}
async function postSlackMessage2(url, data, token) {
	console.log("** postSlackMessage2");
	if (!token) {
		console.log("❌ SLACK_BOT_TOKEN is missing");
		throw new Error("Slack bot token is missing");
	}

	// console.log(
	// 	`Calling Slack API: ${url} with data: ${JSON.stringify(data, null, 2)}`
	// );
	try {
		const response = await axios.post(url, data, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			timeout: 10000, // 10-second timeout
		});
		console.log(`postSlackMessage2 success: ${JSON.stringify(response.data)}`);
		return response;
	} catch (error) {
		await notifyTechSlack(error);

		console.log(`Failed to post to Slack API: ${error.message}`);
		if (error.response) {
			console.log(`Slack API response: ${JSON.stringify(error.response.data)}`);
		} else if (error.request) {
			console.log(`No response received: ${error.request}`);
		} else {
			console.log(`Request setup error: ${error.message}`);
		}
		throw error; // Re-throw for caller to handle
	}
}
async function updateSlackMessage1(payload, paymentId, status) {
	console.log("** updateSlackMessage1");
	const updatedBlocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `Commande *${paymentId}* a été *${status}* par <@${payload.user.id}>`,
			},
		},
		// No actions block here, so buttons disappear
		{
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: `✅ Traitement terminé le ${new Date().toLocaleDateString()}`,
				},
			],
		},
	];

	await postSlackMessage(
		"https://slack.com/api/chat.update",
		{
			channel: payload.channel?.id || process.env.SLACK_ADMIN_ID, // Use the original channel
			ts: payload.message?.ts, // Use the original message timestamp
			blocks: updatedBlocks,
			text: `Commande ${paymentId} mise à jour`,
		},
		process.env.SLACK_BOT_TOKEN
	);
}
async function postSlackMessageWithRetry(
	url,
	body,
	token,
	context,
	retries = 3
) {
	let lastError = null;
	console.log(`Sending Slack message: ${JSON.stringify(body)}`);
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			const response = await axios.post(url, body, {
				headers: { Authorization: `Bearer ${token}` },
			});

			// Log successful response for debugging
			if (attempt > 1) {
				console.log(`Success on retry attempt ${attempt}`);
			}

			// Return the actual response.data, not the full axios response
			return response.data;
		} catch (error) {
			await notifyTechSlack(error);

			lastError = error;
			console.log(`Attempt ${attempt} failed: ${error.message}`);

			if (attempt < retries) {
				// Wait with exponential backoff before retrying (100ms, 200ms, 400ms, etc.)
				await new Promise((resolve) =>
					setTimeout(resolve, 100 * Math.pow(2, attempt - 1))
				);
			}
		}
	}

	// All retries failed
	throw lastError || new Error("All retries failed with unknown error");
}
module.exports = {
	createSlackResponse,
	verifySlackSignature,
	postSlackMessage,
	postSlackMessage9,
	postSlackMessage2,
	postSlackMessageWithRetry,
	updateSlackMessage1,
};
