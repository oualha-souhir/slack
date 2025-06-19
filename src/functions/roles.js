const { UserRole } = require("./db");
const axios = require("axios");
const { postSlackMessageWithRetry } = require("./notificationService");
async function getUserRoles(userId) {
	const user = await UserRole.findOne({ userId });
	return user ? user.roles : [];
}

async function isAdminUser(userId) {
	const roles = await getUserRoles(userId);
	return roles.includes("admin");
}
async function isFinanceUser(userId) {
	const roles = await getUserRoles(userId);
	return roles.includes("finance");
}
async function isPurchaseUser(userId) {
	const roles = await getUserRoles(userId);
	return roles.includes("achat");
}

async function addUserRole(userId, role, username) {
	await UserRole.updateOne(
		{ userId, username: username },
		{ $addToSet: { roles: role } },
		{ upsert: true }
	);
	// Notify the user via Slack DM
	try {
		await axios.post(
			"https://slack.com/api/chat.postMessage",
			{
				channel: userId,
				text: `Bonjour <@${userId}> ! Vous avez reçu le rôle *${role}* dans le système.\n\nTapez \`/order help\` pour voir les commandes disponibles pour votre rôle.`,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					"Content-Type": "application/json",
				},
			}
		);
	} catch (err) {
		console.error("Erreur lors de la notification Slack :", err);
	}
}

async function removeUserRole(userId, role) {
	await UserRole.updateOne({ userId }, { $pull: { roles: role } });
}

module.exports = {
	getUserRoles,
	isAdminUser,
	isFinanceUser,
	isPurchaseUser,
	addUserRole,
	removeUserRole,
};
