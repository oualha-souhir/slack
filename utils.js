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
  console.log("SLACK_SIGNING_SECRET", slackSigningSecret);
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

// async function  getFileInfo(fileId, token) {
//   console.log("** getFileInfo");
//   const response = await axios.get("https://slack.com/api/files.info", {
//     params: { file: fileId },
//     headers: { Authorization: `Bearer ${token}` },
//   });
//   return response.data.file;
// }



// async function getFileInfo(fileId, botToken) {
//     try {
//         // Get file information
//         const fileInfoResponse = await axios.get(
//             `https://slack.com/api/files.info?file=${fileId}`,
//             {
//                 headers: {
//                     'Authorization': `Bearer ${botToken}`,
//                     'Content-Type': 'application/json'
//                 }
//             }
//         );

//         if (!fileInfoResponse.data.ok) {
//             throw new Error(`Failed to get file info: ${fileInfoResponse.data.error}`);
//         }

//         const fileInfo = fileInfoResponse.data.file;

//         // Try to make the file public for external sharing
//         try {
//             const publicResponse = await axios.post(
//                 'https://slack.com/api/files.sharedPublicURL',
//                 { file: fileId },
//                 {
//                     headers: {
//                         'Authorization': `Bearer ${botToken}`,
//                         'Content-Type': 'application/json'
//                     }
//                 }
//             );

//             if (publicResponse.data.ok && publicResponse.data.file.permalink_public) {
//                 // Return file info with public URL
//                 return {
//                     ...fileInfo,
//                     public_url: publicResponse.data.file.permalink_public,
//                     is_public: true
//                 };
//             }
//         } catch (publicError) {
//             console.log(`Could not make file public: ${publicError.message}`);
//         }

//         // If public URL creation failed, return original file info
//         return {
//             ...fileInfo,
//             is_public: false
//         };

//     } catch (error) {
//         console.error(`Error getting file info: ${error.message}`);
//         throw error;
//     }
// }
async function getFileInfo(fileId, token) {
  console.log("** getFileInfo");
	const response = await fetch(`https://slack.com/api/files.info?file=${fileId}`, {
		headers: {
			Authorization: `Bearer ${token}`,
		},
	});
	const json = await response.json();
	if (!json.ok) {
		throw new Error(json.error);
	}
	return json.file;
}

module.exports = { createSlackResponse, verifySlackSignature, postSlackMessage, getFileInfo };
