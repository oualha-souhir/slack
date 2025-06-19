//src/utils
const axios = require("axios");
const crypto = require("crypto");
require("dotenv").config();
function  createSlackResponse(statusCode, body) {
  console.log("** createSlackResponse");
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
function  verifySlackSignature(request, body) {
  console.log("** verifySlackSignature");
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


async function  postSlackMessage(url, data, token) {
  console.log("** postSlackMessage");
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s timeout

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(data),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const result = await response.json();
    return result;
  } catch (error) {
    throw new Error(`Slack API call failed: ${error.message}`);
  }
}

async function  getFileInfo(fileId, token) {
  console.log("** getFileInfo");
  const response = await axios.get("https://slack.com/api/files.info", {
    params: { file: fileId },
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data.file;
}

module.exports = { createSlackResponse, verifySlackSignature, postSlackMessage, getFileInfo };
